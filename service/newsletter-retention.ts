import { createHash } from 'node:crypto'

export const NEWSLETTER_RETENTION_POLICY_VERSION = 1 as const
export const NEWSLETTER_RETENTION_MAX_BATCH_LIMIT = 100 as const
export const NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT = 10_000 as const

const DEFAULT_BATCH_LIMIT = 10
const DEFAULT_MESSAGE_LIMIT = 1_000
const MAX_BACKUP_RESTORE_AGE_MS = 24 * 60 * 60_000
const MAX_HEALTH_AGE_MS = 15 * 60_000
const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export interface NewsletterRetentionPolicyInput {
    siteId: string
    cutoff: string
    apply?: boolean
    maxBatches?: number
    maxMessages?: number
}

export interface NewsletterRetentionPolicy {
    siteId: string
    cutoff: string
    dryRun: boolean
    maxBatches: number
    maxMessages: number
    policyVersion: typeof NEWSLETTER_RETENTION_POLICY_VERSION
}

export interface NewsletterRetentionEvidenceInput {
    now: string
    backup: {
        verifiedAt: string
        restoredAt: string
    }
    restore: {
        verifiedAt: string
        restoredAt: string
    }
    health: {
        queueCheckedAt: string
        proxyCheckedAt: string
        queueHealthy: boolean
        proxyHealthy: boolean
    }
}

export type NewsletterRetentionEvidence = NewsletterRetentionEvidenceInput

export interface NewsletterRetentionManifestBatchInput {
    batchId: string
    createdAt: string
    messageCount: number
    notificationCount: number
    errorCount: number
    [key: string]: unknown
}

export interface NewsletterRetentionManifestBatch {
    batchId: string
    createdAt: string
    messageCount: number
    notificationCount: number
    errorCount: number
}

export interface NewsletterRetentionManifestInput {
    cutoff: string
    policyVersion?: number
    batches: NewsletterRetentionManifestBatchInput[]
}

export interface NewsletterRetentionManifest {
    cutoff: string
    policyVersion: number
    batches: NewsletterRetentionManifestBatch[]
    hash: string
}

export function parseNewsletterRetentionPolicy(input: NewsletterRetentionPolicyInput): NewsletterRetentionPolicy {
    if (!input || typeof input !== 'object') {
        throw new Error('siteId must be a non-empty string')
    }

    const siteId = normalizeSiteId(input.siteId)
    const cutoff = parseStrictUtcIso(input.cutoff, 'cutoff')

    return {
        siteId,
        cutoff: toUtcIso(cutoff),
        dryRun: input.apply !== true,
        maxBatches: clampPositiveInteger(input.maxBatches, DEFAULT_BATCH_LIMIT, NEWSLETTER_RETENTION_MAX_BATCH_LIMIT, 'maxBatches'),
        maxMessages: clampPositiveInteger(input.maxMessages, DEFAULT_MESSAGE_LIMIT, NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT, 'maxMessages'),
        policyVersion: NEWSLETTER_RETENTION_POLICY_VERSION,
    }
}

export function parseNewsletterRetentionEvidence(input: NewsletterRetentionEvidenceInput): NewsletterRetentionEvidence {
    if (!input || typeof input !== 'object') {
        throw new Error('evidence must be a plain object')
    }

    const nowMs = parseStrictUtcIso(input.now, 'now')
    const backupVerifiedAt = parseStrictUtcIso(input.backup?.verifiedAt, 'backup.verifiedAt')
    const backupRestoredAt = parseStrictUtcIso(input.backup?.restoredAt, 'backup.restoredAt')
    const restoreVerifiedAt = parseStrictUtcIso(input.restore?.verifiedAt, 'restore.verifiedAt')
    const restoreRestoredAt = parseStrictUtcIso(input.restore?.restoredAt, 'restore.restoredAt')
    const queueCheckedAt = parseStrictUtcIso(input.health?.queueCheckedAt, 'health.queueCheckedAt')
    const proxyCheckedAt = parseStrictUtcIso(input.health?.proxyCheckedAt, 'health.proxyCheckedAt')

    if (input.health?.queueHealthy !== true || input.health?.proxyHealthy !== true) {
        throw new Error('health evidence must be healthy')
    }

    ensureFreshEvidence('backup evidence', backupVerifiedAt, nowMs, MAX_BACKUP_RESTORE_AGE_MS)
    ensureFreshEvidence('backup evidence', backupRestoredAt, nowMs, MAX_BACKUP_RESTORE_AGE_MS)
    ensureFreshEvidence('restore evidence', restoreVerifiedAt, nowMs, MAX_BACKUP_RESTORE_AGE_MS)
    ensureFreshEvidence('restore evidence', restoreRestoredAt, nowMs, MAX_BACKUP_RESTORE_AGE_MS)
    ensureFreshEvidence('health evidence', queueCheckedAt, nowMs, MAX_HEALTH_AGE_MS)
    ensureFreshEvidence('health evidence', proxyCheckedAt, nowMs, MAX_HEALTH_AGE_MS)

    return {
        now: input.now,
        backup: {
            verifiedAt: toUtcIso(backupVerifiedAt),
            restoredAt: toUtcIso(backupRestoredAt),
        },
        restore: {
            verifiedAt: toUtcIso(restoreVerifiedAt),
            restoredAt: toUtcIso(restoreRestoredAt),
        },
        health: {
            queueCheckedAt: toUtcIso(queueCheckedAt),
            proxyCheckedAt: toUtcIso(proxyCheckedAt),
            queueHealthy: true,
            proxyHealthy: true,
        },
    }
}

export function buildNewsletterRetentionManifest(input: NewsletterRetentionManifestInput): NewsletterRetentionManifest {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.batches)) {
        throw new Error('manifest input must be a plain object with batches')
    }

    const cutoff = parseStrictUtcIso(input.cutoff, 'cutoff')
    const policyVersion = normalizePolicyVersion(input.policyVersion)
    const batches = [...input.batches]
        .map(normalizeManifestBatch)
        .sort((left, right) => compareCanonicalStrings(left.batchId, right.batchId)
            || compareCanonicalStrings(left.createdAt, right.createdAt)
            || left.messageCount - right.messageCount
            || left.notificationCount - right.notificationCount
            || left.errorCount - right.errorCount)

    const payload = {
        batches,
        cutoff: toUtcIso(cutoff),
        policyVersion,
    }

    return {
        ...payload,
        hash: hashCanonicalJson(payload),
    }
}

function normalizeSiteId(siteId: unknown): string {
    if (typeof siteId !== 'string') {
        throw new Error('siteId must be a non-empty string')
    }

    if (siteId !== siteId.trim() || siteId.length === 0) {
        throw new Error('siteId must be a non-empty string')
    }

    return siteId
}

function clampPositiveInteger(value: unknown, fallback: number, max: number, field: string): number {
    if (value === undefined) {
        return fallback
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer`)
    }

    if (value > max) {
        throw new Error(`${field} must not exceed ${max}`)
    }

    return value
}

function normalizePolicyVersion(value: unknown): number {
    if (value === undefined) {
        return NEWSLETTER_RETENTION_POLICY_VERSION
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error('policyVersion must be a positive integer')
    }

    return value
}

function parseStrictUtcIso(value: unknown, field: string): number {
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

    return timestamp
}

function ensureFreshEvidence(label: string, evidenceTimeMs: number, nowMs: number, maxAgeMs: number) {
    if (evidenceTimeMs > nowMs) {
        throw new Error(`${label} is stale`)
    }

    if (nowMs - evidenceTimeMs > maxAgeMs) {
        throw new Error(`${label} is stale`)
    }
}

function normalizeManifestBatch(batch: NewsletterRetentionManifestBatchInput): NewsletterRetentionManifestBatch {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Error('manifest batch must be a plain object')
    }

    return {
        batchId: normalizeManifestBatchId(batch.batchId),
        createdAt: toUtcIso(parseStrictUtcIso(batch.createdAt, 'createdAt')),
        messageCount: normalizeCount(batch.messageCount, 'messageCount'),
        notificationCount: normalizeCount(batch.notificationCount, 'notificationCount'),
        errorCount: normalizeCount(batch.errorCount, 'errorCount'),
    }
}

function normalizeManifestBatchId(batchId: unknown): string {
    if (typeof batchId !== 'string') {
        throw new Error('batchId must be a non-empty string')
    }

    if (batchId.trim().length === 0) {
        throw new Error('batchId must be a non-empty string')
    }

    return batchId
}

function normalizeCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }

    return value
}

function compareCanonicalStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function hashCanonicalJson(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => compareCanonicalStrings(left, right))
            .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
        return `{${entries.join(',')}}`
    }

    return JSON.stringify(value)
}

function toUtcIso(timestamp: number): string {
    return new Date(timestamp).toISOString()
}
