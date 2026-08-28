import {
    NEWSLETTER_RETENTION_MAX_BATCH_LIMIT,
    NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT,
    type NewsletterRetentionPolicy,
} from '@/service/newsletter-retention'
import { type NewsletterRetentionSelectionPlanCandidateInput } from '@/service/newsletter-retention-plan'

export interface NewsletterRetentionCandidateLoaderMessageRow {
    messageId: string
    _count: {
        notificationEvents: number
    }
}

export interface NewsletterRetentionCandidateLoaderRecord {
    siteId: string
    batchRecordId: string
    batchId: string
    createdAt: string
    messageCount: number
    notificationCount: number
    errorCount: number
    orphanCount: number
    correlationComplete: boolean
}

export interface NewsletterRetentionCandidateLoaderRow {
    id: string
    batchId: string
    created: Date
    _count: {
        NewslettersErrors: number
        NewslettersMessages: number
    }
}

export interface NewsletterRetentionCandidateLoaderBatchFindManyArgs {
    where: {
        siteId: string
        created: {
            lt: Date
        }
    }
    orderBy: Array<{ created: 'asc' | 'desc' } | { id: 'asc' | 'desc' }>
    take: number
    select: {
        id: true
        batchId: true
        created: true
        _count: {
            select: {
                NewslettersErrors: true
                NewslettersMessages: true
            }
        }
    }
}

export interface NewsletterRetentionCandidateLoaderMessageFindManyArgs {
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

export interface NewsletterRetentionCandidateLoaderOrphanCountArgs {
    where: {
        messageId: {
            in: string[]
        }
    }
}

export interface NewsletterRetentionCandidateLoaderDelegate {
    newsletterBatch: {
        findMany(args: NewsletterRetentionCandidateLoaderBatchFindManyArgs): Promise<NewsletterRetentionCandidateLoaderRow[]>
    }
    newsletterMessages: {
        findMany(args: NewsletterRetentionCandidateLoaderMessageFindManyArgs): Promise<NewsletterRetentionCandidateLoaderMessageRow[]>
    }
    newsletterNotificationOrphan: {
        count(args: NewsletterRetentionCandidateLoaderOrphanCountArgs): Promise<number>
    }
}

const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

interface NormalizedBatchAggregateRow {
    batchRecordId: string
    batchId: string
    createdAt: string
    messageCount: number
    errorCount: number
}

interface NormalizedCandidateState {
    batchId: string
    batchRecordId: string
    createdAt: string
    messageCount: number
    notificationCount: number
    errorCount: number
    messageIds: string[]
}

export async function loadNewsletterRetentionCandidates(
    delegate: NewsletterRetentionCandidateLoaderDelegate,
    policy: NewsletterRetentionPolicy,
): Promise<NewsletterRetentionSelectionPlanCandidateInput[]> {
    const records = await loadNewsletterRetentionCandidateRecords(delegate, policy)

    return records.map((record) => ({
        siteId: record.siteId,
        batchId: record.batchId,
        createdAt: record.createdAt,
        messageCount: record.messageCount,
        notificationCount: record.notificationCount,
        errorCount: record.errorCount,
        orphanCount: record.orphanCount,
        correlationComplete: record.correlationComplete,
    }))
}

export async function loadNewsletterRetentionCandidateRecords(
    delegate: NewsletterRetentionCandidateLoaderDelegate,
    policy: NewsletterRetentionPolicy,
): Promise<NewsletterRetentionCandidateLoaderRecord[]> {
    const siteId = normalizeSiteId(policy?.siteId)
    const cutoff = parseStrictUtcIso(policy?.cutoff, 'cutoff')
    const maxBatches = normalizeLimitedPositiveInteger(
        normalizePositiveInteger(policy?.maxBatches, 'maxBatches'),
        'maxBatches',
        NEWSLETTER_RETENTION_MAX_BATCH_LIMIT,
    )
    const maxMessages = normalizeLimitedPositiveInteger(
        normalizePositiveInteger(policy?.maxMessages, 'maxMessages'),
        'maxMessages',
        NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT,
    )

    const batchRows = await delegate.newsletterBatch.findMany({
        where: {
            siteId,
            created: {
                lt: cutoff,
            },
        },
        orderBy: [{ created: 'asc' }, { id: 'asc' }],
        take: maxBatches + 1,
        select: {
            id: true,
            batchId: true,
            created: true,
            _count: {
                select: {
                    NewslettersErrors: true,
                    NewslettersMessages: true,
                },
            },
        },
    })

    const batchPayload = ensureBatchRows(batchRows)
    if (batchPayload.length > maxBatches) {
        throw new Error('newsletterBatch.findMany returned more batches than maxBatches')
    }

    const batchSummaries = batchPayload.map((row) => normalizeBatchAggregateRow(row))
    const totalMessages = batchSummaries.reduce(
        (total, row) => safeAddIntegers(total, row.messageCount, 'newsletterBatch._count.NewslettersMessages'),
        0,
    )
    if (totalMessages > maxMessages) {
        throw new Error('sum of newsletterBatch._count.NewslettersMessages exceeds maxMessages')
    }

    const loadedCandidates: Array<NormalizedCandidateState & { orphanCount: number }> = []

    for (const summary of batchSummaries) {
        if (summary.messageCount === 0) {
            loadedCandidates.push({
                batchRecordId: summary.batchRecordId,
                batchId: summary.batchId,
                createdAt: summary.createdAt,
                messageCount: 0,
                notificationCount: 0,
                errorCount: summary.errorCount,
                messageIds: [],
                orphanCount: 0,
            })
            continue
        }

        const messageRows = await delegate.newsletterMessages.findMany({
            where: {
                newsletterBatchId: summary.batchRecordId,
            },
            orderBy: [{ id: 'asc' }],
            take: summary.messageCount + 1,
            select: {
                messageId: true,
                _count: {
                    select: {
                        notificationEvents: true,
                    },
                },
            },
        })

        const messageRowsNormalized = normalizeMessageRows(messageRows, summary.messageCount)
        const messageIds = messageRowsNormalized.map((row) => row.messageId)
        const notificationCount = messageRowsNormalized.reduce(
            (total, row) => safeAddIntegers(
                total,
                row.notificationEvents,
                'newsletterMessages._count.notificationEvents',
            ),
            0,
        )
        const orphanCount = await countBatchLinkedOrphans(delegate, messageIds)

        loadedCandidates.push({
            batchRecordId: summary.batchRecordId,
            batchId: summary.batchId,
            createdAt: summary.createdAt,
            messageCount: summary.messageCount,
            notificationCount,
            errorCount: summary.errorCount,
            messageIds,
            orphanCount,
        })
    }

    return [...loadedCandidates]
        .sort(compareNormalizedCandidates)
        .map((candidate) => ({
            siteId,
            batchRecordId: candidate.batchRecordId,
            batchId: candidate.batchId,
            createdAt: candidate.createdAt,
            messageCount: candidate.messageCount,
            notificationCount: candidate.notificationCount,
            errorCount: candidate.errorCount,
            orphanCount: candidate.orphanCount,
            correlationComplete: candidate.orphanCount === 0,
        }))
}

function normalizeBatchAggregateRow(row: NewsletterRetentionCandidateLoaderRow): NormalizedBatchAggregateRow {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('newsletterBatch row must be a plain object')
    }

    const counts = normalizeCountAggregate((row as { _count?: unknown })._count)

    return {
        batchRecordId: normalizeRowId((row as { id?: unknown }).id),
        batchId: normalizeBatchId((row as { batchId?: unknown }).batchId),
        createdAt: normalizeCreatedAt((row as { created?: unknown }).created),
        messageCount: counts.NewslettersMessages,
        errorCount: counts.NewslettersErrors,
    }
}

function ensureBatchRows(value: unknown): NewsletterRetentionCandidateLoaderRow[] {
    if (!Array.isArray(value)) {
        throw new Error('newsletterBatch.findMany must return an array')
    }

    return value
}

function normalizeMessageRows(
    value: unknown,
    expectedMessageCount: number,
): Array<{ messageId: string; notificationEvents: number }> {
    if (!Array.isArray(value)) {
        throw new Error('newsletterMessages.findMany must return an array')
    }

    if (value.length !== expectedMessageCount) {
        throw new Error('newsletterMessages.findMany returned unexpected number of rows')
    }

    const seenMessageIds = new Set<string>()

    return value.map((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
            throw new Error(`newsletterMessages.findMany[${index}] must be a plain object`)
        }

        const messageId = normalizeMessageId((row as { messageId?: unknown }).messageId)
        if (seenMessageIds.has(messageId)) {
            throw new Error('newsletterMessages.findMany returned duplicate messageId')
        }

        seenMessageIds.add(messageId)
        const counts = normalizeMessageCountAggregate((row as { _count?: unknown })._count)

        return {
            messageId,
            notificationEvents: counts.notificationEvents,
        }
    })
}

function normalizeCountAggregate(value: unknown): { NewslettersErrors: number; NewslettersMessages: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('newsletterBatch row must include aggregate child counts')
    }

    return {
        NewslettersErrors: normalizeCount((value as { NewslettersErrors?: unknown }).NewslettersErrors, 'newsletterBatch._count.NewslettersErrors'),
        NewslettersMessages: normalizeCount(
            (value as { NewslettersMessages?: unknown }).NewslettersMessages,
            'newsletterBatch._count.NewslettersMessages',
        ),
    }
}

function normalizeMessageCountAggregate(value: unknown): { notificationEvents: number } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('newsletterMessages row must include notification event counts')
    }

    return {
        notificationEvents: normalizeCount(
            (value as { notificationEvents?: unknown }).notificationEvents,
            'newsletterMessages._count.notificationEvents',
        ),
    }
}

function normalizeCreatedAt(value: unknown): string {
    if (!(value instanceof Date)) {
        throw new Error('newsletterBatch.created must be a Date')
    }

    const timestamp = value.getTime()
    if (!Number.isFinite(timestamp)) {
        throw new Error('newsletterBatch.created must be a Date')
    }

    return value.toISOString()
}

function normalizeRowId(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('newsletterBatch.id must be a non-empty string')
    }

    return value
}

function normalizeBatchId(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('newsletterBatch.batchId must be a non-empty string')
    }

    if (value.length === 0 || value.trim().length === 0) {
        throw new Error('newsletterBatch.batchId must be a non-empty string')
    }

    return value
}

function normalizeMessageId(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('newsletterMessages.messageId must be a non-empty string')
    }

    if (value.length === 0 || value.trim().length === 0) {
        throw new Error('newsletterMessages.messageId must be a non-empty string')
    }

    return value
}

function normalizeSiteId(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('siteId must be a non-empty string')
    }

    if (value !== value.trim() || value.length === 0) {
        throw new Error('siteId must be a non-empty string')
    }

    return value
}

function parseStrictUtcIso(value: unknown, field: string): Date {
    if (typeof value !== 'string' || !UTC_ISO_8601_MS.test(value)) {
        throw new Error(`${field} must be a strict UTC ISO-8601 string`)
    }

    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
        throw new Error(`${field} must be a strict UTC ISO-8601 string`)
    }

    const canonical = new Date(timestamp).toISOString()
    if (canonical !== value) {
        throw new Error(`${field} must be a strict UTC ISO-8601 string`)
    }

    return new Date(timestamp)
}

function normalizePositiveInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer`)
    }

    return value
}

function normalizeCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative integer`)
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

function compareNormalizedCandidates(
    left: (NormalizedCandidateState & { orphanCount: number; batchRecordId: string }),
    right: (NormalizedCandidateState & { orphanCount: number; batchRecordId: string }),
): number {
    return compareStrings(left.createdAt, right.createdAt)
        || compareStrings(left.batchId, right.batchId)
        || left.messageCount - right.messageCount
        || left.notificationCount - right.notificationCount
        || left.errorCount - right.errorCount
        || compareStrings(left.batchRecordId, right.batchRecordId)
}

function normalizeLimitedPositiveInteger(value: number, field: string, max: number): number {
    if (value > max) {
        throw new Error(`${field} must not exceed ${max}`)
    }

    return value
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

async function countBatchLinkedOrphans(
    delegate: NewsletterRetentionCandidateLoaderDelegate,
    messageIds: string[],
): Promise<number> {
    const orphanCount = await delegate.newsletterNotificationOrphan.count({
        where: {
            messageId: {
                in: messageIds,
            },
        },
    })

    return normalizeCount(orphanCount, 'newsletterNotificationOrphan.count')
}
