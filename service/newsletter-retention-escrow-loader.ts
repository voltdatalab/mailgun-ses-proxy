import {
    NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS,
    type NewsletterRetentionEscrowRecord,
} from './newsletter-retention-escrow.js'
import {
    parseNewsletterRetentionPolicy,
    type NewsletterRetentionPolicy,
    type NewsletterRetentionPolicyInput,
} from './newsletter-retention.js'
import type { NewsletterRetentionCandidateLoaderRecord } from './newsletter-retention-candidate-loader.js'

const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const CANDIDATE_KEYS = [
    'siteId',
    'batchRecordId',
    'batchId',
    'createdAt',
    'messageCount',
    'notificationCount',
    'errorCount',
    'orphanCount',
    'correlationComplete',
] as const
const BATCH_ROW_KEYS = ['id', 'siteId', 'fromEmail', 'contents', 'batchId', 'created'] as const
const MESSAGE_ROW_KEYS = ['id', 'messageId', 'toEmail', 'newsletterBatchId', 'created', 'formatedContents', 'recipientData'] as const
const ERROR_ROW_KEYS = ['id', 'toEmail', 'error', 'created', 'newsletterBatchId', 'messageId', 'formatedContents', 'recipientData'] as const
const NOTIFICATION_ROW_KEYS = ['id', 'type', 'notificationId', 'messageId', 'rawEvent', 'timestamp', 'created'] as const
const MAX_STREAM_RECORDS = NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS

export interface NewsletterRetentionEscrowLoaderBatchFindFirstArgs {
    where: {
        id: string
        siteId: string
    }
    select: {
        id: true
        siteId: true
        fromEmail: true
        contents: true
        batchId: true
        created: true
    }
}

export interface NewsletterRetentionEscrowLoaderMessageFindManyArgs {
    where: {
        newsletterBatchId: string
    }
    orderBy: Array<{ id: 'asc' }>
    take: number
    select: {
        id: true
        messageId: true
        toEmail: true
        newsletterBatchId: true
        created: true
        formatedContents: true
        recipientData: true
    }
}

export interface NewsletterRetentionEscrowLoaderErrorFindManyArgs {
    where: {
        newsletterBatchId: string
    }
    orderBy: Array<{ id: 'asc' }>
    take: number
    select: {
        id: true
        toEmail: true
        error: true
        created: true
        newsletterBatchId: true
        messageId: true
        formatedContents: true
        recipientData: true
    }
}

export interface NewsletterRetentionEscrowLoaderNotificationFindManyArgs {
    where: {
        newsletter: {
            newsletterBatchId: string
        }
    }
    orderBy: Array<{ id: 'asc' }>
    take: number
    select: {
        id: true
        type: true
        notificationId: true
        messageId: true
        rawEvent: true
        timestamp: true
        created: true
    }
}

export interface NewsletterRetentionEscrowLoaderOrphanCountArgs {
    where: {
        messageId: {
            in: string[]
        }
        reconciledAt: null
    }
}

export interface NewsletterRetentionEscrowLoaderBatchDatabaseRow {
    id: string
    siteId: string
    fromEmail: string
    contents: string
    batchId: string
    created: Date
}

export interface NewsletterRetentionEscrowLoaderMessageDatabaseRow {
    id: string
    messageId: string
    toEmail: string
    newsletterBatchId: string
    created: Date
    formatedContents: string
    recipientData: string | null
}

export interface NewsletterRetentionEscrowLoaderErrorDatabaseRow {
    id: string
    toEmail: string
    error: string
    created: Date
    newsletterBatchId: string
    messageId: string
    formatedContents: string
    recipientData: string | null
}

export interface NewsletterRetentionEscrowLoaderNotificationDatabaseRow {
    id: string
    type: string
    notificationId: string
    messageId: string
    rawEvent: string
    timestamp: Date
    created: Date
}

export interface NewsletterRetentionEscrowLoaderDelegate {
    newsletterBatch: {
        findFirst(args: NewsletterRetentionEscrowLoaderBatchFindFirstArgs): Promise<NewsletterRetentionEscrowLoaderBatchDatabaseRow | null>
    }
    newsletterMessages: {
        findMany(args: NewsletterRetentionEscrowLoaderMessageFindManyArgs): Promise<NewsletterRetentionEscrowLoaderMessageDatabaseRow[]>
    }
    newsletterErrors: {
        findMany(args: NewsletterRetentionEscrowLoaderErrorFindManyArgs): Promise<NewsletterRetentionEscrowLoaderErrorDatabaseRow[]>
    }
    newsletterNotifications: {
        findMany(args: NewsletterRetentionEscrowLoaderNotificationFindManyArgs): Promise<NewsletterRetentionEscrowLoaderNotificationDatabaseRow[]>
    }
    newsletterNotificationOrphan: {
        count(args: NewsletterRetentionEscrowLoaderOrphanCountArgs): Promise<number>
    }
}

interface NormalizedCandidate {
    siteId: string
    batchRecordId: string
    batchId: string
    createdAt: string
    createdAtMs: number
    messageCount: number
    notificationCount: number
    errorCount: number
    orphanCount: number
    correlationComplete: boolean
}

interface NormalizedBatchRow {
    id: string
    siteId: string
    fromEmail: string
    contents: string
    batchId: string
    created: string
}

interface NormalizedMessageRow {
    id: string
    messageId: string
    toEmail: string
    newsletterBatchId: string
    created: string
    formatedContents: string
    recipientData: string | null
}

interface NormalizedErrorRow {
    id: string
    toEmail: string
    error: string
    created: string
    newsletterBatchId: string
    messageId: string
    formatedContents: string
    recipientData: string | null
}

interface NormalizedNotificationRow {
    id: string
    type: string
    notificationId: string
    messageId: string
    rawEvent: string
    timestamp: string
    created: string
}

interface SnapshotUniqueKeys {
    messageIds: Set<string>
    messageRowIds: Set<string>
    errorMessageIds: Set<string>
    errorRowIds: Set<string>
    notificationIds: Set<string>
    notificationRowIds: Set<string>
}

export async function* streamNewsletterRetentionEscrowRecords(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    policy: NewsletterRetentionPolicyInput | NewsletterRetentionPolicy,
    candidates: NewsletterRetentionCandidateLoaderRecord[],
): AsyncGenerator<NewsletterRetentionEscrowRecord> {
    const normalizedPolicy = parseNewsletterRetentionPolicy(policy)
    const normalizedCandidates = normalizeCandidates(candidates, normalizedPolicy)
    const uniqueKeys: SnapshotUniqueKeys = {
        messageIds: new Set<string>(),
        messageRowIds: new Set<string>(),
        errorMessageIds: new Set<string>(),
        errorRowIds: new Set<string>(),
        notificationIds: new Set<string>(),
        notificationRowIds: new Set<string>(),
    }

    for (let manifestIndex = 0; manifestIndex < normalizedCandidates.length; manifestIndex += 1) {
        const candidate = normalizedCandidates[manifestIndex]
        const batchRow = await loadBatchRow(delegate, candidate, normalizedPolicy)
        const messageRows = await loadMessageRows(delegate, candidate)
        const errorRows = await loadErrorRows(delegate, candidate)
        const notificationRows = candidate.messageCount > 0
            ? await loadNotificationRows(delegate, candidate, messageRows)
            : []

        assertSnapshotUniqueKeys(messageRows, errorRows, notificationRows, uniqueKeys)

        if (candidate.messageCount > 0) {
            await validateOrphanCount(delegate, candidate, messageRows)
        } else if (candidate.notificationCount !== 0) {
            throw new Error('candidate with zero messages must have zero notifications')
        }

        yield {
            kind: 'newsletterBatch',
            manifestIndex,
            row: batchRow,
        }

        for (const row of messageRows) {
            yield {
                kind: 'newsletterMessages',
                manifestIndex,
                row,
            }
        }

        for (const row of errorRows) {
            yield {
                kind: 'newsletterErrors',
                manifestIndex,
                row,
            }
        }

        for (const row of notificationRows) {
            yield {
                kind: 'newsletterNotifications',
                manifestIndex,
                row,
            }
        }
    }
}

function normalizeCandidates(
    candidates: NewsletterRetentionCandidateLoaderRecord[],
    policy: NewsletterRetentionPolicy,
): NormalizedCandidate[] {
    if (!Array.isArray(candidates)) {
        throw new Error('candidates must be an array')
    }

    if (candidates.length > policy.maxBatches) {
        throw new Error('candidate count exceeds policy maxBatches')
    }

    const cutoffMs = parseStrictUtcIso(policy.cutoff, 'cutoff')
    const seenBatchRecordIds = new Set<string>()
    const normalized: NormalizedCandidate[] = []
    let totalMessages = 0
    let totalYieldedRecords = 0

    for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        const normalizedCandidate = normalizeCandidate(candidate, index, policy.siteId, cutoffMs)

        if (seenBatchRecordIds.has(normalizedCandidate.batchRecordId)) {
            throw new Error('candidate batchRecordId must be unique')
        }

        seenBatchRecordIds.add(normalizedCandidate.batchRecordId)
        normalized.push(normalizedCandidate)
        totalMessages = safeAdd(totalMessages, normalizedCandidate.messageCount, 'candidate messageCount total')
        totalYieldedRecords = safeAdd(
            totalYieldedRecords,
            safeAdd(
                safeAdd(1, normalizedCandidate.messageCount, 'candidate record total'),
                normalizedCandidate.errorCount,
                'candidate record total',
            ),
            'candidate record total',
        )
        totalYieldedRecords = safeAdd(totalYieldedRecords, normalizedCandidate.notificationCount, 'candidate record total')
    }

    if (totalMessages > policy.maxMessages) {
        throw new Error('candidate messageCount total exceeds policy maxMessages')
    }

    if (totalYieldedRecords > MAX_STREAM_RECORDS) {
        throw new Error('expected escrow record count exceeds hard limit')
    }

    return [...normalized].sort(compareCandidates)
}

function normalizeCandidate(
    candidate: NewsletterRetentionCandidateLoaderRecord,
    index: number,
    policySiteId: string,
    cutoffMs: number,
): NormalizedCandidate {
    assertPlainObjectWithExactKeys(candidate, CANDIDATE_KEYS, 'candidate')
    const row = candidate as Record<string, unknown>

    const siteId = normalizeStrictString(row.siteId, 'siteId')
    if (siteId !== policySiteId) {
        throw new Error('candidate siteId must exactly match policy siteId')
    }

    const createdAt = normalizeUtcMillis(row.createdAt, 'createdAt')
    const createdAtMs = Date.parse(createdAt)
    if (createdAtMs >= cutoffMs) {
        throw new Error('candidate createdAt must be strictly before the cutoff')
    }

    const messageCount = normalizeCount(row.messageCount, 'messageCount')
    const notificationCount = normalizeCount(row.notificationCount, 'notificationCount')
    const errorCount = normalizeCount(row.errorCount, 'errorCount')
    const orphanCount = normalizeCount(row.orphanCount, 'orphanCount')

    if (normalizeBoolean(row.correlationComplete, 'correlationComplete') !== true) {
        throw new Error('candidate correlationComplete must be true')
    }

    if (orphanCount !== 0) {
        throw new Error('candidate orphanCount must be zero')
    }

    if (messageCount === 0 && notificationCount !== 0) {
        throw new Error('candidate with zero messages must have zero notifications')
    }

    return {
        siteId,
        batchRecordId: normalizeStrictString(row.batchRecordId, 'batchRecordId'),
        batchId: normalizeStrictString(row.batchId, 'batchId'),
        createdAt,
        createdAtMs,
        messageCount,
        notificationCount,
        errorCount,
        orphanCount,
        correlationComplete: true,
    }
}

async function loadBatchRow(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    candidate: NormalizedCandidate,
    policy: NewsletterRetentionPolicy,
): Promise<NormalizedBatchRow> {
    const row = await delegate.newsletterBatch.findFirst({
        where: {
            id: candidate.batchRecordId,
            siteId: candidate.siteId,
        },
        select: {
            id: true,
            siteId: true,
            fromEmail: true,
            contents: true,
            batchId: true,
            created: true,
        },
    })

    if (row === null) {
        throw new Error('candidate batch row must exist')
    }

    const normalized = normalizeBatchRow(row)
    if (normalized.id !== candidate.batchRecordId) {
        throw new Error('candidate batchRecordId does not match the stored batch row')
    }
    if (normalized.siteId !== candidate.siteId) {
        throw new Error('candidate siteId does not match the stored batch row')
    }
    if (normalized.batchId !== candidate.batchId) {
        throw new Error('candidate batchId does not match the stored batch row')
    }
    if (normalized.created !== candidate.createdAt) {
        throw new Error('candidate createdAt does not match the stored batch row')
    }
    if (Date.parse(normalized.created) >= Date.parse(policy.cutoff)) {
        throw new Error('stored batch row must be strictly before the cutoff')
    }

    return normalized
}

async function loadMessageRows(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    candidate: NormalizedCandidate,
): Promise<NormalizedMessageRow[]> {
    const rows = await delegate.newsletterMessages.findMany({
        where: {
            newsletterBatchId: candidate.batchRecordId,
        },
        orderBy: [{ id: 'asc' }],
        take: candidate.messageCount + 1,
        select: {
            id: true,
            messageId: true,
            toEmail: true,
            newsletterBatchId: true,
            created: true,
            formatedContents: true,
            recipientData: true,
        },
    })

    const normalized = normalizeMessageRows(rows, candidate.messageCount, candidate.batchRecordId)
    return normalized.map((row) => ({ ...row }))
}

async function loadErrorRows(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    candidate: NormalizedCandidate,
): Promise<NormalizedErrorRow[]> {
    const rows = await delegate.newsletterErrors.findMany({
        where: {
            newsletterBatchId: candidate.batchRecordId,
        },
        orderBy: [{ id: 'asc' }],
        take: candidate.errorCount + 1,
        select: {
            id: true,
            toEmail: true,
            error: true,
            created: true,
            newsletterBatchId: true,
            messageId: true,
            formatedContents: true,
            recipientData: true,
        },
    })

    return normalizeErrorRows(rows, candidate.errorCount, candidate.batchRecordId)
}

async function loadNotificationRows(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    candidate: NormalizedCandidate,
    messageRows: NormalizedMessageRow[],
): Promise<NormalizedNotificationRow[]> {
    const rows = await delegate.newsletterNotifications.findMany({
        where: {
            newsletter: {
                newsletterBatchId: candidate.batchRecordId,
            },
        },
        orderBy: [{ id: 'asc' }],
        take: candidate.notificationCount + 1,
        select: {
            id: true,
            type: true,
            notificationId: true,
            messageId: true,
            rawEvent: true,
            timestamp: true,
            created: true,
        },
    })

    const messageIds = new Set(messageRows.map((row) => row.messageId))
    return normalizeNotificationRows(rows, candidate.notificationCount, messageIds)
}

async function validateOrphanCount(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    candidate: NormalizedCandidate,
    messageRows: NormalizedMessageRow[],
): Promise<void> {
    const messageIds = messageRows.map((row) => row.messageId)
    if (messageIds.length === 0) {
        return
    }

    const orphanCount = await delegate.newsletterNotificationOrphan.count({
        where: {
            messageId: {
                in: messageIds,
            },
            reconciledAt: null,
        },
    })

    const normalizedOrphanCount = normalizeCount(orphanCount, 'newsletterNotificationOrphan.count')
    if (normalizedOrphanCount !== 0) {
        throw new Error('candidate orphan count must remain zero')
    }
}

function normalizeBatchRow(value: unknown): NormalizedBatchRow {
    assertPlainObjectWithExactKeys(value, BATCH_ROW_KEYS, 'newsletterBatch row')
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictString(row.id, 'id'),
        siteId: normalizeStrictString(row.siteId, 'siteId'),
        fromEmail: normalizeStrictString(row.fromEmail, 'fromEmail'),
        contents: normalizeString(row.contents, 'contents'),
        batchId: normalizeStrictString(row.batchId, 'batchId'),
        created: normalizePrismaDate(row.created, 'created'),
    }
}

function normalizeMessageRows(
    value: unknown,
    expectedCount: number,
    batchRecordId: string,
): NormalizedMessageRow[] {
    if (!Array.isArray(value)) {
        throw new Error('newsletterMessages.findMany must return an array')
    }
    if (value.length > expectedCount) {
        throw new Error('newsletterMessages.findMany returned more rows than expected')
    }
    if (value.length !== expectedCount) {
        throw new Error('newsletterMessages.findMany returned unexpected number of rows')
    }

    const rows: NormalizedMessageRow[] = []
    const seenIds = new Set<string>()
    const seenMessageIds = new Set<string>()
    let previousId: string | undefined

    for (let index = 0; index < value.length; index += 1) {
        const row = normalizeMessageRow(value[index], index)
        if (row.newsletterBatchId !== batchRecordId) {
            throw new Error('newsletterMessages row must belong to the current batch')
        }
        if (previousId !== undefined && compareStrings(previousId, row.id) >= 0) {
            throw new Error('newsletterMessages rows must be sorted by id and unique')
        }
        if (seenIds.has(row.id)) {
            throw new Error('newsletterMessages id must be unique')
        }
        if (seenMessageIds.has(row.messageId)) {
            throw new Error('newsletterMessages.messageId must be unique')
        }

        seenIds.add(row.id)
        seenMessageIds.add(row.messageId)
        previousId = row.id
        rows.push(row)
    }

    return rows
}

function normalizeErrorRows(
    value: unknown,
    expectedCount: number,
    batchRecordId: string,
): NormalizedErrorRow[] {
    if (!Array.isArray(value)) {
        throw new Error('newsletterErrors.findMany must return an array')
    }
    if (value.length > expectedCount) {
        throw new Error('newsletterErrors.findMany returned more rows than expected')
    }
    if (value.length !== expectedCount) {
        throw new Error('newsletterErrors.findMany returned unexpected number of rows')
    }

    const rows: NormalizedErrorRow[] = []
    const seenIds = new Set<string>()
    const seenMessageIds = new Set<string>()
    let previousId: string | undefined

    for (let index = 0; index < value.length; index += 1) {
        const row = normalizeErrorRow(value[index], index)
        if (row.newsletterBatchId !== batchRecordId) {
            throw new Error('newsletterErrors row must belong to the current batch')
        }
        if (previousId !== undefined && compareStrings(previousId, row.id) >= 0) {
            throw new Error('newsletterErrors rows must be sorted by id and unique')
        }
        if (seenIds.has(row.id)) {
            throw new Error('newsletterErrors id must be unique')
        }
        if (seenMessageIds.has(row.messageId)) {
            throw new Error('newsletterErrors.messageId must be unique')
        }

        seenIds.add(row.id)
        seenMessageIds.add(row.messageId)
        previousId = row.id
        rows.push(row)
    }

    return rows
}

function normalizeNotificationRows(
    value: unknown,
    expectedCount: number,
    messageIds: Set<string>,
): NormalizedNotificationRow[] {
    if (!Array.isArray(value)) {
        throw new Error('newsletterNotifications.findMany must return an array')
    }
    if (value.length > expectedCount) {
        throw new Error('newsletterNotifications.findMany returned more rows than expected')
    }
    if (value.length !== expectedCount) {
        throw new Error('newsletterNotifications.findMany returned unexpected number of rows')
    }

    const rows: NormalizedNotificationRow[] = []
    const seenIds = new Set<string>()
    const seenNotificationIds = new Set<string>()
    let previousId: string | undefined

    for (let index = 0; index < value.length; index += 1) {
        const row = normalizeNotificationRow(value[index], index)
        if (!messageIds.has(row.messageId)) {
            throw new Error('newsletterNotifications.messageId must belong to the current batch')
        }
        if (previousId !== undefined && compareStrings(previousId, row.id) >= 0) {
            throw new Error('newsletterNotifications rows must be sorted by id and unique')
        }
        if (seenIds.has(row.id)) {
            throw new Error('newsletterNotifications id must be unique')
        }
        if (seenNotificationIds.has(row.notificationId)) {
            throw new Error('newsletterNotifications.notificationId must be unique')
        }

        seenIds.add(row.id)
        seenNotificationIds.add(row.notificationId)
        previousId = row.id
        rows.push(row)
    }

    return rows
}

function assertSnapshotUniqueKeys(
    messageRows: NormalizedMessageRow[],
    errorRows: NormalizedErrorRow[],
    notificationRows: NormalizedNotificationRow[],
    seen: SnapshotUniqueKeys,
): void {
    for (const row of messageRows) {
        assertAndRememberUniqueKey(seen.messageRowIds, row.id, 'newsletterMessages id must be globally unique')
        assertAndRememberUniqueKey(seen.messageIds, row.messageId, 'newsletterMessages.messageId must be globally unique')
    }

    for (const row of errorRows) {
        assertAndRememberUniqueKey(seen.errorRowIds, row.id, 'newsletterErrors id must be globally unique')
        assertAndRememberUniqueKey(seen.errorMessageIds, row.messageId, 'newsletterErrors.messageId must be globally unique')
    }

    for (const row of notificationRows) {
        assertAndRememberUniqueKey(seen.notificationRowIds, row.id, 'newsletterNotifications id must be globally unique')
        assertAndRememberUniqueKey(
            seen.notificationIds,
            row.notificationId,
            'newsletterNotifications.notificationId must be globally unique',
        )
    }
}

function assertAndRememberUniqueKey(seen: Set<string>, value: string, message: string): void {
    if (seen.has(value)) {
        throw new Error(message)
    }
    seen.add(value)
}

function normalizeMessageRow(value: unknown, index: number): NormalizedMessageRow {
    assertPlainObjectWithExactKeys(value, MESSAGE_ROW_KEYS, `newsletterMessages[${index}]`)
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictString(row.id, 'id'),
        messageId: normalizeStrictString(row.messageId, 'messageId'),
        toEmail: normalizeStrictString(row.toEmail, 'toEmail'),
        newsletterBatchId: normalizeStrictString(row.newsletterBatchId, 'newsletterBatchId'),
        created: normalizePrismaDate(row.created, 'created'),
        formatedContents: normalizeString(row.formatedContents, 'formatedContents'),
        recipientData: normalizeRecipientData(row.recipientData),
    }
}

function normalizeErrorRow(value: unknown, index: number): NormalizedErrorRow {
    assertPlainObjectWithExactKeys(value, ERROR_ROW_KEYS, `newsletterErrors[${index}]`)
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictString(row.id, 'id'),
        toEmail: normalizeStrictString(row.toEmail, 'toEmail'),
        error: normalizeString(row.error, 'error'),
        created: normalizePrismaDate(row.created, 'created'),
        newsletterBatchId: normalizeStrictString(row.newsletterBatchId, 'newsletterBatchId'),
        messageId: normalizeStrictString(row.messageId, 'messageId'),
        formatedContents: normalizeString(row.formatedContents, 'formatedContents'),
        recipientData: normalizeRecipientData(row.recipientData),
    }
}

function normalizeNotificationRow(value: unknown, index: number): NormalizedNotificationRow {
    assertPlainObjectWithExactKeys(value, NOTIFICATION_ROW_KEYS, `newsletterNotifications[${index}]`)
    const row = value as Record<string, unknown>
    return {
        id: normalizeStrictString(row.id, 'id'),
        type: normalizeStrictString(row.type, 'type'),
        notificationId: normalizeStrictString(row.notificationId, 'notificationId'),
        messageId: normalizeStrictString(row.messageId, 'messageId'),
        rawEvent: normalizeString(row.rawEvent, 'rawEvent'),
        timestamp: normalizePrismaDate(row.timestamp, 'timestamp'),
        created: normalizePrismaDate(row.created, 'created'),
    }
}

function compareCandidates(left: NormalizedCandidate, right: NormalizedCandidate): number {
    return compareStrings(left.createdAt, right.createdAt)
        || compareStrings(left.batchId, right.batchId)
        || left.messageCount - right.messageCount
        || left.notificationCount - right.notificationCount
        || left.errorCount - right.errorCount
        || compareStrings(left.batchRecordId, right.batchRecordId)
}

function assertPlainObjectWithExactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new Error(`${label} must be a plain object with exact keys`)
    }

    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')) {
        throw new Error(`${label} must have exact keys`)
    }

    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`${label} must have exact keys`)
        }
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false
    }

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function normalizeStrictString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error(`${field} must be a non-empty string`)
    }

    return value
}

function normalizeString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new Error(`${field} must be a string`)
    }

    return value
}

function normalizeRecipientData(value: unknown): string | null {
    if (value === null) {
        return null
    }

    if (typeof value !== 'string') {
        throw new Error('recipientData must be a string or null')
    }

    return value
}

function normalizeBoolean(value: unknown, field: string): boolean {
    if (value !== true && value !== false) {
        throw new Error(`${field} must be a boolean`)
    }

    return value
}

function normalizeCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }

    return value
}

function safeAdd(left: number, right: number, field: string): number {
    if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }

    if (left > Number.MAX_SAFE_INTEGER - right) {
        throw new Error(`${field} sum exceeds Number.MAX_SAFE_INTEGER`)
    }

    return left + right
}

function parseStrictUtcIso(value: unknown, field: string): number {
    if (typeof value !== 'string' || !UTC_ISO_8601_MS.test(value)) {
        throw new Error(`${field} must be a strict UTC ISO-8601 string`)
    }

    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
        throw new Error(`${field} must be a strict UTC ISO-8601 string`)
    }

    if (new Date(timestamp).toISOString() !== value) {
        throw new Error(`${field} must be a strict UTC ISO-8601 string`)
    }

    return timestamp
}

function normalizeUtcMillis(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UTC_ISO_8601_MS.test(value)) {
        throw new Error(`${field} must be a canonical UTC millisecond string`)
    }

    const timestamp = Date.parse(value)
    if (!Number.isFinite(timestamp)) {
        throw new Error(`${field} must be a canonical UTC millisecond string`)
    }

    if (new Date(timestamp).toISOString() !== value) {
        throw new Error(`${field} must be a canonical UTC millisecond string`)
    }

    return value
}

function normalizePrismaDate(value: unknown, field: string): string {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new Error(`${field} must be a valid Date`)
    }

    return value.toISOString()
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}
