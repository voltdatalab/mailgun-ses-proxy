import {
    parseNewsletterRetentionEscrowRecord,
    parseNewsletterRetentionEscrowVerificationResult,
    serializeNewsletterRetentionEscrowRecord,
    type NewsletterRetentionEscrowRecord,
} from './newsletter-retention-escrow.js'
import {
    streamNewsletterRetentionEscrowRecords,
    type NewsletterRetentionEscrowLoaderDelegate,
} from './newsletter-retention-escrow-loader.js'
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
    escrowSource: NewsletterRetentionVerifiedEscrowSource
}

export interface NewsletterRetentionVerifiedEscrowSource {
    readonly verification: unknown
    readBatchRecords(args: { manifestIndex: number }): Promise<readonly unknown[]>
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
    escrowContentHash: string
    schemaFingerprint: string
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
    newsletterBatch: NewsletterRetentionEscrowLoaderDelegate['newsletterBatch'] & {
        deleteMany(args: NewsletterRetentionApplyParentDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyParentCountArgs): Promise<number>
    }
    newsletterMessages: NewsletterRetentionEscrowLoaderDelegate['newsletterMessages'] & {
        deleteMany(args: NewsletterRetentionApplyMessageDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyMessageCountArgs): Promise<number>
    }
    newsletterErrors: NewsletterRetentionEscrowLoaderDelegate['newsletterErrors'] & {
        deleteMany(args: NewsletterRetentionApplyErrorsDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyErrorsCountArgs): Promise<number>
    }
    newsletterNotifications: NewsletterRetentionEscrowLoaderDelegate['newsletterNotifications'] & {
        deleteMany(args: NewsletterRetentionApplyNotificationDeleteManyArgs): Promise<{ count: number }>
        count(args: NewsletterRetentionApplyNotificationCountArgs): Promise<number>
    }
    newsletterNotificationOrphan: NewsletterRetentionEscrowLoaderDelegate['newsletterNotificationOrphan']
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
    const escrowSource = normalizeVerifiedEscrowSource(input.escrowSource, context)
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
            const expectedRecords = await readVerifiedBatchRecords(
                escrowSource,
                binding.manifestIndex,
                manifestBatch,
            )
            const batchResult = await input.database.$transaction(
                async (tx) => applyNewsletterRetentionBatch(
                    tx,
                    context,
                    binding.manifestIndex,
                    manifestBatch,
                    binding.batchRecordId,
                    expectedRecords,
                ),
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
            escrowContentHash: context.artifact.escrow.contentHash,
            schemaFingerprint: context.artifact.escrow.schemaFingerprint,
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

function normalizeVerifiedEscrowSource(
    value: unknown,
    context: NewsletterRetentionApplyContext,
): NewsletterRetentionVerifiedEscrowSource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('verified escrow source must be an object')
    }
    const source = value as Partial<NewsletterRetentionVerifiedEscrowSource>
    if (typeof source.readBatchRecords !== 'function') {
        throw new Error('verified escrow source must provide readBatchRecords')
    }
    const verification = parseNewsletterRetentionEscrowVerificationResult(source.verification)
    if (JSON.stringify(verification) !== JSON.stringify(context.artifact.escrow)) {
        throw new Error('verified escrow source commitment must match apply artifact')
    }
    return value as NewsletterRetentionVerifiedEscrowSource
}

async function readVerifiedBatchRecords(
    source: NewsletterRetentionVerifiedEscrowSource,
    manifestIndex: number,
    manifestBatch: NewsletterRetentionApplyContext['manifest']['batches'][number],
): Promise<readonly NewsletterRetentionEscrowRecord[]> {
    const rows = await source.readBatchRecords({ manifestIndex })
    if (!Array.isArray(rows)) {
        throw new Error('verified escrow source batch records must be an array')
    }
    const expectedRecordCount = safeAddIntegers(
        safeAddIntegers(
            safeAddIntegers(1, manifestBatch.messageCount, 'verified escrow batch record count'),
            manifestBatch.errorCount,
            'verified escrow batch record count',
        ),
        manifestBatch.notificationCount,
        'verified escrow batch record count',
    )
    if (rows.length !== expectedRecordCount) {
        throw new Error('verified escrow source batch record count mismatch')
    }
    return rows.map((row) => {
        const record = parseNewsletterRetentionEscrowRecord(row)
        if (record.manifestIndex !== manifestIndex) {
            throw new Error('verified escrow source manifest index mismatch')
        }
        return record
    })
}

function assertExactEscrowBatchRecords(
    actual: readonly NewsletterRetentionEscrowRecord[],
    expected: readonly NewsletterRetentionEscrowRecord[],
): void {
    if (actual.length !== expected.length) {
        throw new Error('transactional escrow record count mismatch')
    }
    for (let index = 0; index < actual.length; index += 1) {
        if (serializeNewsletterRetentionEscrowRecord(actual[index]) !== serializeNewsletterRetentionEscrowRecord(expected[index])) {
            throw new Error('transactional escrow record mismatch')
        }
    }
}

async function applyNewsletterRetentionBatch(
    tx: NewsletterRetentionApplyTransactionClient,
    context: NewsletterRetentionApplyContext,
    manifestIndex: number,
    manifestBatch: NewsletterRetentionApplyContext['manifest']['batches'][number],
    batchRecordId: string,
    expectedRecords: readonly NewsletterRetentionEscrowRecord[],
): Promise<NewsletterRetentionApplyReceiptBatch> {
    const candidate = {
        siteId: context.manifest.siteId,
        batchRecordId,
        batchId: manifestBatch.batchId,
        createdAt: manifestBatch.createdAt,
        messageCount: manifestBatch.messageCount,
        notificationCount: manifestBatch.notificationCount,
        errorCount: manifestBatch.errorCount,
        orphanCount: 0,
        correlationComplete: true,
    }
    const actualRecords: NewsletterRetentionEscrowRecord[] = []
    for await (const record of streamNewsletterRetentionEscrowRecords(tx, context.policy, [candidate])) {
        actualRecords.push({ ...record, manifestIndex })
    }
    assertExactEscrowBatchRecords(actualRecords, expectedRecords)

    const parentRecord = actualRecords[0]
    if (!parentRecord || parentRecord.kind !== 'newsletterBatch') {
        throw new Error('transactional escrow batch parent is missing')
    }
    const parent = parentRecord.row
    const messageIds = actualRecords.flatMap((record) => (
        record.kind === 'newsletterMessages' ? [record.row.messageId] : []
    ))

    let deletedNotificationCount = 0
    if (messageIds.length > 0) {
        deletedNotificationCount = await deleteAndValidateCount(
            tx.newsletterNotifications.deleteMany({ where: { messageId: { in: messageIds } } }),
            manifestBatch.notificationCount,
            'newsletterNotifications.deleteMany',
        )
    }

    const deletedErrorCount = await deleteAndValidateCount(
        tx.newsletterErrors.deleteMany({ where: { newsletterBatchId: parent.id } }),
        manifestBatch.errorCount,
        'newsletterErrors.deleteMany',
    )
    const deletedMessageCount = await deleteAndValidateCount(
        tx.newsletterMessages.deleteMany({ where: { newsletterBatchId: parent.id } }),
        manifestBatch.messageCount,
        'newsletterMessages.deleteMany',
    )
    const deletedBatchCount = await deleteAndValidateCount(
        tx.newsletterBatch.deleteMany({
            where: {
                id: parent.id,
                siteId: parent.siteId,
                batchId: parent.batchId,
                created: new Date(parent.created),
            },
        }),
        1,
        'newsletterBatch.deleteMany',
    )

    if (await tx.newsletterBatch.count({ where: { id: parent.id, siteId: parent.siteId } }) !== 0) {
        throw new Error('newsletterBatch postcondition failed')
    }
    if (await tx.newsletterMessages.count({ where: { newsletterBatchId: parent.id } }) !== 0) {
        throw new Error('newsletterMessages postcondition failed')
    }
    if (await tx.newsletterErrors.count({ where: { newsletterBatchId: parent.id } }) !== 0) {
        throw new Error('newsletterErrors postcondition failed')
    }
    if (messageIds.length > 0) {
        if (await tx.newsletterNotifications.count({ where: { messageId: { in: messageIds } } }) !== 0) {
            throw new Error('newsletterNotifications postcondition failed')
        }
        if (await tx.newsletterNotificationOrphan.count({
            where: { messageId: { in: messageIds }, reconciledAt: null },
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
