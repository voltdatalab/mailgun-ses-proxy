import {
    type NewsletterRetentionApplyContext,
    type NewsletterRetentionApplyContextInput,
    parseNewsletterRetentionApplyContext,
} from './newsletter-retention-apply.js'

export const NEWSLETTER_RETENTION_APPLY_LOCK_KEY = 'newsletter-retention-apply'

export class NewsletterRetentionApplyError extends Error {
    readonly completedBatchCount: number
    readonly failedManifestIndex: number | null

    constructor(message: string, completedBatchCount: number, failedManifestIndex: number | null) {
        super(message)
        this.name = 'NewsletterRetentionApplyError'
        this.completedBatchCount = completedBatchCount
        this.failedManifestIndex = failedManifestIndex
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

export interface NewsletterRetentionApplyInput extends NewsletterRetentionApplyContextInput {
    lock: NewsletterRetentionApplyLockProvider
    database: NewsletterRetentionApplyDatabase
}

export interface NewsletterRetentionApplyReceiptBatch {
    manifestIndex: number
    batchId: string
    deletedNotificationCount: number
    deletedErrorCount: number
    deletedMessageCount: number
    deletedBatchCount: number
}

export interface NewsletterRetentionApplyReceipt {
    manifestHash: string
    artifactHash: string
    siteId: string
    batches: NewsletterRetentionApplyReceiptBatch[]
}

export interface NewsletterRetentionApplyLockLease {
    release(): void | Promise<void>
}

export interface NewsletterRetentionApplyLockProvider {
    tryAcquire(key: string): NewsletterRetentionApplyLockLease | null | Promise<NewsletterRetentionApplyLockLease | null>
}

export interface NewsletterRetentionApplyDatabase {
    $transaction<T>(callback: (tx: NewsletterRetentionApplyTransactionClient) => Promise<T>, options: {
        isolationLevel: 'Serializable'
    }): Promise<T>
}

export interface NewsletterRetentionApplyTransactionClient {
    newsletterBatch: {
        findFirst(args: NewsletterRetentionApplyParentFindFirstArgs): Promise<NewsletterRetentionApplyParentRow | null>
        deleteMany(args: NewsletterRetentionApplyParentDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyParentCountArgs): Promise<number>
    }
    newsletterMessages: {
        findMany(args: NewsletterRetentionApplyMessageFindManyArgs): Promise<NewsletterRetentionApplyMessageRow[]>
        deleteMany(args: NewsletterRetentionApplyMessageDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyMessageCountArgs): Promise<number>
    }
    newsletterErrors: {
        deleteMany(args: NewsletterRetentionApplyErrorsDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyErrorsCountArgs): Promise<number>
    }
    newsletterNotifications: {
        deleteMany(args: NewsletterRetentionApplyNotificationDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyNotificationCountArgs): Promise<number>
    }
    newsletterNotificationOrphan: {
        count(args: NewsletterRetentionApplyOrphanCountArgs): Promise<number>
    }
}

export interface NewsletterRetentionApplyParentFindFirstArgs {
    where: {
        id: string
        siteId: string
    }
    select: {
        id: true
        siteId: true
        batchId: true
        created: true
        _count: {
            select: {
                NewslettersMessages: true
                NewslettersErrors: true
            }
        }
    }
}

export interface NewsletterRetentionApplyParentRow {
    id: string
    siteId: string
    batchId: string
    created: Date
    _count: {
        NewslettersMessages: number
        NewslettersErrors: number
    }
}

export interface NewsletterRetentionApplyMessageFindManyArgs {
    where: {
        newsletterBatchId: string
    }
    orderBy: Array<{ id: 'asc' | 'desc' }>
    take: number
    select: {
        messageId: true
        _count: {
            select: {
                notificationEvents: true
            }
        }
    }
}

export interface NewsletterRetentionApplyMessageRow {
    messageId: string
    _count: {
        notificationEvents: number
    }
}

export interface NewsletterRetentionApplyNotificationDeleteManyArgs {
    where: {
        messageId: {
            in: string[]
        }
    }
}

export interface NewsletterRetentionApplyErrorsDeleteManyArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyMessageDeleteManyArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyParentDeleteManyArgs {
    where: {
        id: string
        siteId: string
        batchId: string
        created: Date
    }
}

export interface NewsletterRetentionApplyParentCountArgs {
    where: {
        id: string
        siteId: string
    }
}

export interface NewsletterRetentionApplyMessageCountArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyErrorsCountArgs {
    where: {
        newsletterBatchId: string
    }
}

export interface NewsletterRetentionApplyNotificationCountArgs {
    where: {
        messageId: {
            in: string[]
        }
    }
}

export interface NewsletterRetentionApplyOrphanCountArgs {
    where: {
        messageId: {
            in: string[]
        }
        reconciledAt: null
    }
}

export async function executeNewsletterRetentionApply(input: NewsletterRetentionApplyInput): Promise<NewsletterRetentionApplyReceipt> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('newsletter retention apply input must be a plain object')
    }

    const context = parseNewsletterRetentionApplyContext(input)
    const lease = await tryAcquireApplyLease(input.lock)

    let completedBatchCount = 0
    let failure: NewsletterRetentionApplyError | null = null
    let receipt: NewsletterRetentionApplyReceipt | null = null
    let releaseFailure: NewsletterRetentionApplyError | null = null
    let currentManifestIndex: number | null = null

    try {
        const batches: NewsletterRetentionApplyReceiptBatch[] = []

        for (const binding of context.artifact.bindings) {
            const manifestBatch = context.manifest.batches[binding.manifestIndex]
            currentManifestIndex = binding.manifestIndex
            const batchResult = await input.database.$transaction(
                async (tx) => applyNewsletterRetentionBatch(tx, context, binding.manifestIndex, manifestBatch, binding.batchRecordId),
                { isolationLevel: 'Serializable' },
            )

            batches.push({
                manifestIndex: binding.manifestIndex,
                batchId: manifestBatch.batchId,
                deletedNotificationCount: batchResult.deletedNotificationCount,
                deletedErrorCount: batchResult.deletedErrorCount,
                deletedMessageCount: batchResult.deletedMessageCount,
                deletedBatchCount: batchResult.deletedBatchCount,
            })
            completedBatchCount += 1
        }

        receipt = {
            manifestHash: context.manifest.hash,
            artifactHash: context.artifact.hash,
            siteId: context.manifest.siteId,
            batches,
        }
    } catch {
        failure = new NewsletterRetentionApplyError('newsletter retention apply failed', completedBatchCount, currentManifestIndex)
    } finally {
        if (lease) {
            try {
                await Promise.resolve(lease.release())
            } catch {
                releaseFailure = new NewsletterRetentionApplyError(
                    failure
                        ? 'newsletter retention apply failed and lock release failed'
                        : 'newsletter retention apply release failed',
                    completedBatchCount,
                    failure?.failedManifestIndex ?? null,
                )
            }
        }
    }

    if (releaseFailure) {
        throw releaseFailure
    }

    if (failure) {
        throw failure
    }

    return receipt as NewsletterRetentionApplyReceipt
}

async function tryAcquireApplyLease(lock: NewsletterRetentionApplyLockProvider): Promise<NewsletterRetentionApplyLockLease | null> {
    if (!lock || typeof lock !== 'object') {
        throw new NewsletterRetentionApplyError('newsletter retention apply lock provider is invalid', 0, null)
    }

    try {
        const lease = await lock.tryAcquire(NEWSLETTER_RETENTION_APPLY_LOCK_KEY)
        if (!lease) {
            throw new NewsletterRetentionApplyError('newsletter retention apply lock is already held', 0, null)
        }

        return lease
    } catch (error) {
        if (error instanceof NewsletterRetentionApplyError) {
            throw error
        }

        throw new NewsletterRetentionApplyError('newsletter retention apply lock acquisition failed', 0, null)
    }
}

async function applyNewsletterRetentionBatch(
    tx: NewsletterRetentionApplyTransactionClient,
    context: NewsletterRetentionApplyContext,
    manifestIndex: number,
    manifestBatch: NewsletterRetentionApplyContext['manifest']['batches'][number],
    batchRecordId: string,
): Promise<NewsletterRetentionApplyReceiptBatch> {
    const parent = await tx.newsletterBatch.findFirst({
        where: {
            id: batchRecordId,
            siteId: context.manifest.siteId,
        },
        select: {
            id: true,
            siteId: true,
            batchId: true,
            created: true,
            _count: {
                select: {
                    NewslettersMessages: true,
                    NewslettersErrors: true,
                },
            },
        },
    })

    const normalizedParent = normalizeParentRow(parent, batchRecordId, context.manifest.siteId)
    if (normalizedParent.batchId !== manifestBatch.batchId) {
        throw new Error('newsletter batch parent batchId does not match manifest')
    }

    if (normalizedParent.created !== manifestBatch.createdAt) {
        throw new Error('newsletter batch parent created does not match manifest')
    }

    if (Date.parse(normalizedParent.created) >= Date.parse(context.manifest.cutoff)) {
        throw new Error('newsletter batch parent created must be strictly before cutoff')
    }

    if (normalizedParent._count.NewslettersMessages !== manifestBatch.messageCount) {
        throw new Error('newsletter batch message count does not match manifest')
    }

    if (normalizedParent._count.NewslettersErrors !== manifestBatch.errorCount) {
        throw new Error('newsletter batch error count does not match manifest')
    }

    const messageRows = manifestBatch.messageCount === 0
        ? []
        : await tx.newsletterMessages.findMany({
            where: {
                newsletterBatchId: normalizedParent.id,
            },
            orderBy: [{ id: 'asc' }],
            take: manifestBatch.messageCount + 1,
            select: {
                messageId: true,
                _count: {
                    select: {
                        notificationEvents: true,
                    },
                },
            },
        })

    const normalizedMessages = normalizeMessageRows(messageRows, manifestBatch.messageCount)
    const messageIds = normalizedMessages.map((row) => row.messageId)
    const totalNotificationCount = normalizedMessages.reduce(
        (total, row) => safeAddIntegers(total, row._count.notificationEvents, 'newsletterMessages._count.notificationEvents'),
        0,
    )

    if (totalNotificationCount !== manifestBatch.notificationCount) {
        throw new Error('newsletter message notification count does not match manifest')
    }

    if (messageIds.length > 0) {
        const orphanCount = await tx.newsletterNotificationOrphan.count({
            where: {
                messageId: {
                    in: messageIds,
                },
                reconciledAt: null,
            },
        })

        if (!Number.isSafeInteger(orphanCount) || orphanCount < 0) {
            throw new Error('newsletterNotificationOrphan.count must be a non-negative safe integer')
        }

        if (orphanCount !== 0) {
            throw new Error('newsletter notification orphan ledger must be empty before delete')
        }
    }

    let deletedNotificationCount = 0
    if (messageIds.length > 0) {
        deletedNotificationCount = await deleteAndValidateCount(
            tx.newsletterNotifications.deleteMany({
                where: {
                    messageId: {
                        in: messageIds,
                    },
                },
            }),
            manifestBatch.notificationCount,
            'newsletterNotifications.deleteMany',
        )
    }

    const deletedErrorCount = await deleteAndValidateCount(
        tx.newsletterErrors.deleteMany({
            where: {
                newsletterBatchId: normalizedParent.id,
            },
        }),
        normalizedParent._count.NewslettersErrors,
        'newsletterErrors.deleteMany',
    )

    const deletedMessageCount = await deleteAndValidateCount(
        tx.newsletterMessages.deleteMany({
            where: {
                newsletterBatchId: normalizedParent.id,
            },
        }),
        manifestBatch.messageCount,
        'newsletterMessages.deleteMany',
    )

    const deletedBatchCount = await deleteAndValidateCount(
        tx.newsletterBatch.deleteMany({
            where: {
                id: normalizedParent.id,
                siteId: normalizedParent.siteId,
                batchId: normalizedParent.batchId,
                created: new Date(normalizedParent.created),
            },
        }),
        1,
        'newsletterBatch.deleteMany',
    )

    if (await tx.newsletterBatch.count({ where: { id: normalizedParent.id, siteId: normalizedParent.siteId } }) !== 0) {
        throw new Error('newsletterBatch postcondition failed')
    }

    if (await tx.newsletterMessages.count({ where: { newsletterBatchId: normalizedParent.id } }) !== 0) {
        throw new Error('newsletterMessages postcondition failed')
    }

    if (await tx.newsletterErrors.count({ where: { newsletterBatchId: normalizedParent.id } }) !== 0) {
        throw new Error('newsletterErrors postcondition failed')
    }

    if (messageIds.length > 0) {
        if (await tx.newsletterNotifications.count({ where: { messageId: { in: messageIds } } }) !== 0) {
            throw new Error('newsletterNotifications postcondition failed')
        }

        if (await tx.newsletterNotificationOrphan.count({
            where: {
                messageId: { in: messageIds },
                reconciledAt: null,
            },
        }) !== 0) {
            throw new Error('newsletterNotificationOrphan postcondition failed')
        }
    }

    return {
        manifestIndex,
        batchId: manifestBatch.batchId,
        deletedNotificationCount,
        deletedErrorCount,
        deletedMessageCount,
        deletedBatchCount,
    }
}

function normalizeParentRow(
    row: unknown,
    batchRecordId: string,
    siteId: string,
): {
    id: string
    siteId: string
    batchId: string
    created: string
    _count: {
        NewslettersMessages: number
        NewslettersErrors: number
    }
} {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('newsletterBatch.findFirst must return a plain object')
    }

    const candidate = row as {
        id?: unknown
        siteId?: unknown
        batchId?: unknown
        created?: unknown
        _count?: unknown
    }

    if (candidate.id !== batchRecordId) {
        throw new Error('newsletter batch parent id does not match batchRecordId')
    }

    if (candidate.siteId !== siteId) {
        throw new Error('newsletter batch parent siteId does not match policy siteId')
    }

    const created = normalizeDate((candidate.created), 'newsletterBatch.created')
    const counts = normalizeBatchCounts(candidate._count)

    return {
        id: normalizeExactNonBlankString(candidate.id, 'newsletterBatch.id'),
        siteId: normalizeExactNonBlankString(candidate.siteId, 'newsletterBatch.siteId'),
        batchId: normalizeExactNonBlankString(candidate.batchId, 'newsletterBatch.batchId'),
        created,
        _count: counts,
    }
}

function normalizeBatchCounts(value: unknown): { NewslettersMessages: number; NewslettersErrors: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('newsletterBatch row must include aggregate child counts')
    }

    const candidate = value as { NewslettersMessages?: unknown; NewslettersErrors?: unknown }
    return {
        NewslettersMessages: normalizeCount(candidate.NewslettersMessages, 'newsletterBatch._count.NewslettersMessages'),
        NewslettersErrors: normalizeCount(candidate.NewslettersErrors, 'newsletterBatch._count.NewslettersErrors'),
    }
}

function normalizeMessageRows(rows: unknown, expectedCount: number): NewsletterRetentionApplyMessageRow[] {
    if (!Array.isArray(rows)) {
        throw new Error('newsletterMessages.findMany must return an array')
    }

    if (rows.length !== expectedCount) {
        throw new Error('newsletterMessages.findMany returned unexpected number of rows')
    }

    const seen = new Set<string>()
    return rows.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error(`newsletterMessages.findMany[${index}] must be a plain object`)
        }

        const candidate = row as { messageId?: unknown; _count?: unknown }
        const messageId = normalizeMessageId(candidate.messageId)
        if (seen.has(messageId)) {
            throw new Error('newsletterMessages.findMany returned duplicate messageId')
        }

        seen.add(messageId)
        return {
            messageId,
            _count: normalizeMessageCount(candidate._count),
        }
    })
}

function normalizeMessageCount(value: unknown): { notificationEvents: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('newsletterMessages row must include notification event counts')
    }

    const candidate = value as { notificationEvents?: unknown }
    return {
        notificationEvents: normalizeCount(candidate.notificationEvents, 'newsletterMessages._count.notificationEvents'),
    }
}

function normalizeMessageId(value: unknown): string {
    if (typeof value !== 'string' || !/\S/.test(value)) {
        throw new Error('newsletterMessages.messageId must be a non-empty string')
    }

    return value
}

function normalizeExactNonBlankString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || !/\S/.test(value)) {
        throw new Error(`${field} must be a non-empty string`)
    }

    return value
}

function normalizeDate(value: unknown, field: string): string {
    if (!(value instanceof Date)) {
        throw new Error(`${field} must be a Date`)
    }

    const timestamp = value.getTime()
    if (!Number.isFinite(timestamp)) {
        throw new Error(`${field} must be a Date`)
    }

    return value.toISOString()
}

function normalizeCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }

    return value
}

function safeAddIntegers(left: number, right: number, field: string): number {
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
        throw new Error(`${field} must be a non-negative integer`)
    }

    if (left > Number.MAX_SAFE_INTEGER - right) {
        throw new Error(`${field} sum exceeds Number.MAX_SAFE_INTEGER`)
    }

    return left + right
}

async function deleteAndValidateCount(result: Promise<{ count: number }>, expected: number, field: string): Promise<number> {
    const resolved = await result
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
        throw new Error(`${field} must return a {count} object`)
    }

    if (normalizeCount(resolved.count, `${field}.count`) !== expected) {
        throw new Error(`${field} deleted unexpected number of rows`)
    }

    return resolved.count
}
