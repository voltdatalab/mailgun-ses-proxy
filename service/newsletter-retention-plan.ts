import { parseNewsletterRetentionEvidence, type NewsletterRetentionEvidenceInput, type NewsletterRetentionPolicy } from '@/service/newsletter-retention'

export interface NewsletterRetentionSelectionPlanCandidateInput {
    siteId: string
    batchId: string
    createdAt: string | Date
    messageCount: number
    notificationCount: number
    errorCount: number
    orphanCount: number
    correlationComplete: boolean
}

export interface NewsletterRetentionSelectionPlanCandidate {
    batchId: string
    createdAt: string
    messageCount: number
    notificationCount: number
    errorCount: number
}

export interface NewsletterRetentionSelectionPlanTotals {
    messageCount: number
    notificationCount: number
    errorCount: number
}

export interface NewsletterRetentionSelectionPlan {
    siteId: string
    cutoff: string
    batchCount: number
    totals: NewsletterRetentionSelectionPlanTotals
    batches: NewsletterRetentionSelectionPlanCandidate[]
}

export interface NewsletterRetentionSelectionPlanInput {
    policy: NewsletterRetentionPolicy
    evidence: NewsletterRetentionEvidenceInput
    queueHealthy: boolean
    dlqHealthy: boolean
    candidates: NewsletterRetentionSelectionPlanCandidateInput[]
}

export interface ProcessLocalAntiOverlapLock {
    readonly name: string
    tryAcquire(): boolean
    release(): boolean
    isHeld(): boolean
}

const heldLockTokens = new Map<string, symbol>()
const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function buildNewsletterRetentionSelectionPlan(input: NewsletterRetentionSelectionPlanInput): NewsletterRetentionSelectionPlan {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('selection plan input must be a plain object')
    }

    const policy = input.policy
    if (!policy || typeof policy !== 'object') {
        throw new Error('selection plan policy must be a plain object')
    }

    parseNewsletterRetentionEvidence(input.evidence)
    if (input.queueHealthy !== true || input.dlqHealthy !== true) {
        throw new Error('queue or DLQ evidence must be healthy')
    }

    const cutoffMs = parseStrictUtcIso(policy.cutoff, 'cutoff')
    const normalizedCandidates = normalizeSelectionCandidates(input.candidates, policy.siteId, cutoffMs)
    const selectedCandidates = [...normalizedCandidates].sort(compareSelectionCandidates)

    if (selectedCandidates.length > policy.maxBatches) {
        throw new Error('selected batch count exceeds the hard batch cap')
    }

    const totals = selectedCandidates.reduce<NewsletterRetentionSelectionPlanTotals>((accumulator, candidate) => ({
        messageCount: safeAddIntegers(
            accumulator.messageCount,
            candidate.messageCount,
            'selectedTotals.messageCount',
        ),
        notificationCount: safeAddIntegers(
            accumulator.notificationCount,
            candidate.notificationCount,
            'selectedTotals.notificationCount',
        ),
        errorCount: safeAddIntegers(
            accumulator.errorCount,
            candidate.errorCount,
            'selectedTotals.errorCount',
        ),
    }), {
        messageCount: 0,
        notificationCount: 0,
        errorCount: 0,
    })

    if (totals.messageCount > policy.maxMessages) {
        throw new Error('selected message count exceeds the hard message cap')
    }

    return {
        siteId: policy.siteId,
        cutoff: policy.cutoff,
        batchCount: selectedCandidates.length,
        totals,
        batches: selectedCandidates,
    }
}

export function createProcessLocalAntiOverlapLock(name: string): ProcessLocalAntiOverlapLock {
    const normalizedName = normalizeLockName(name)
    const ownerToken = Symbol(normalizedName)
    return {
        name: normalizedName,
        tryAcquire: () => {
            if (heldLockTokens.has(normalizedName)) {
                return false
            }

            heldLockTokens.set(normalizedName, ownerToken)
            return true
        },
        release: () => {
            if (heldLockTokens.get(normalizedName) !== ownerToken) {
                return false
            }

            heldLockTokens.delete(normalizedName)
            return true
        },
        isHeld: () => heldLockTokens.get(normalizedName) === ownerToken,
    }
}

export async function withProcessLocalAntiOverlapLock<T>(lock: ProcessLocalAntiOverlapLock, work: () => T | Promise<T>): Promise<T> {
    if (!lock.tryAcquire()) {
        throw new Error(`anti-overlap lock "${lock.name}" is already held`)
    }

    try {
        return await work()
    } finally {
        lock.release()
    }
}

function normalizeSelectionCandidates(
    candidates: NewsletterRetentionSelectionPlanCandidateInput[],
    siteId: string,
    cutoffMs: number,
): NewsletterRetentionSelectionPlanCandidate[] {
    if (!Array.isArray(candidates)) {
        throw new Error('candidates must be an array')
    }

    return candidates.map((candidate) => normalizeSelectionCandidate(candidate, siteId, cutoffMs))
}

function normalizeSelectionCandidate(
    candidate: NewsletterRetentionSelectionPlanCandidateInput,
    siteId: string,
    cutoffMs: number,
): NewsletterRetentionSelectionPlanCandidate {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('candidate batch must be a plain object')
    }

    if (candidate.siteId !== siteId) {
        throw new Error('candidate batch tenant scope must exactly match policy siteId')
    }

    const batchId = normalizeOpaqueId(candidate.batchId, 'batchId')
    const createdAtMs = parseCandidateCreatedAt(candidate.createdAt)
    if (createdAtMs >= cutoffMs) {
        throw new Error('candidate batch createdAt must be strictly before the retention cutoff')
    }

    const messageCount = normalizeCount(candidate.messageCount, 'messageCount')
    const notificationCount = normalizeCount(candidate.notificationCount, 'notificationCount')
    const errorCount = normalizeCount(candidate.errorCount, 'errorCount')
    const orphanCount = normalizeCount(candidate.orphanCount, 'orphanCount')

    if (candidate.correlationComplete !== true) {
        throw new Error('candidate batch correlation must be complete')
    }

    if (orphanCount !== 0) {
        throw new Error('candidate batch orphanCount must be zero')
    }

    return {
        batchId,
        createdAt: new Date(createdAtMs).toISOString(),
        messageCount,
        notificationCount,
        errorCount,
    }
}

function compareSelectionCandidates(left: NewsletterRetentionSelectionPlanCandidate, right: NewsletterRetentionSelectionPlanCandidate): number {
    return compareCanonicalStrings(left.createdAt, right.createdAt)
        || compareCanonicalStrings(left.batchId, right.batchId)
        || left.messageCount - right.messageCount
        || left.notificationCount - right.notificationCount
        || left.errorCount - right.errorCount
}

function parseCandidateCreatedAt(value: string | Date): number {
    if (value instanceof Date) {
        const timestamp = value.getTime()
        if (!Number.isFinite(timestamp)) {
            throw new Error('createdAt must be a strict UTC ISO-8601 string or Date')
        }
        return timestamp
    }

    return parseStrictUtcIso(value, 'createdAt')
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

function normalizeOpaqueId(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`)
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

function compareCanonicalStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function normalizeLockName(name: string): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error('lock name must be a non-empty string')
    }

    return name
}
