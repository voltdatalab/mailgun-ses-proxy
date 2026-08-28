import { createHash } from 'node:crypto'

import {
    buildNewsletterRetentionManifest,
    type NewsletterRetentionEvidence,
    type NewsletterRetentionEvidenceInput,
    type NewsletterRetentionManifest,
    type NewsletterRetentionManifestBatchInput,
    type NewsletterRetentionManifestInput,
    type NewsletterRetentionPolicy,
    type NewsletterRetentionPolicyInput,
    parseNewsletterRetentionEvidence,
    parseNewsletterRetentionPolicy,
} from '@/service/newsletter-retention'
import type { NewsletterRetentionCandidateLoaderRecord } from '@/service/newsletter-retention-candidate-loader'

export const NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION = 1 as const
const UTC_ISO_8601_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export interface NewsletterRetentionManifestApplyBinding {
    manifestIndex: number
    batchRecordId: string
}

export interface NewsletterRetentionApplyArtifact {
    version: number
    siteId: string
    publicManifestHash: string
    bindings: NewsletterRetentionManifestApplyBinding[]
    hash: string
}

export interface NewsletterRetentionApplyArtifactInput {
    manifest: NewsletterRetentionManifest
    records: ReadonlyArray<NewsletterRetentionCandidateLoaderRecord>
}

export interface NewsletterRetentionApplyContextInput {
    policy: NewsletterRetentionPolicyInput
    evidence: NewsletterRetentionEvidenceInput
    manifest: unknown
    artifact: unknown
}

export interface NewsletterRetentionApplyContext {
    policy: NewsletterRetentionPolicy
    evidence: NewsletterRetentionEvidence
    manifest: NewsletterRetentionManifest
    artifact: NewsletterRetentionApplyArtifact
}

export type NewsletterRetentionManifestApplyArtifactInput = NewsletterRetentionApplyArtifactInput
export type NewsletterRetentionManifestApplyContextInput = NewsletterRetentionApplyContextInput
export type NewsletterRetentionManifestApplyContext = NewsletterRetentionApplyContext

export function buildNewsletterRetentionApplyArtifact(input: NewsletterRetentionApplyArtifactInput): NewsletterRetentionApplyArtifact {
    const context = normalizeApplyArtifactInput(input)

    const canonicalManifest = normalizeManifestForApply(context.manifest)

    const cutoffMs = parseStrictUtcIsoMs(canonicalManifest.cutoff, 'canonical manifest cutoff')
    if (context.records.length === 0) {
        throw new Error('apply artifact bindings must be non-empty')
    }

    if (context.records.length !== canonicalManifest.batches.length) {
        throw new Error('private record count must match manifest batch count')
    }

    const seenBatchRecordIds = new Set<string>()
    const bindings = context.records.map((record, index) => {
        const canonicalBatch = canonicalManifest.batches[index]
        const normalizedRecord = normalizePrivateRecord(record)

        if (normalizedRecord.orphanCount !== 0) {
            throw new Error('private record orphanCount must be 0')
        }

        if (normalizedRecord.correlationComplete !== true) {
            throw new Error('private record correlation must be complete')
        }

        if (normalizedRecord.siteId !== canonicalManifest.siteId) {
            throw new Error('private record tenant scope must match manifest siteId')
        }

        if (normalizedRecord.batchId !== canonicalBatch.batchId) {
            throw new Error('private record batchId does not match public manifest')
        }

        if (normalizedRecord.createdAt !== canonicalBatch.createdAt) {
            throw new Error('private record createdAt does not match public manifest')
        }

        if (normalizedRecord.messageCount !== canonicalBatch.messageCount) {
            throw new Error('private record messageCount does not match public manifest')
        }

        if (normalizedRecord.notificationCount !== canonicalBatch.notificationCount) {
            throw new Error('private record notificationCount does not match public manifest')
        }

        if (normalizedRecord.errorCount !== canonicalBatch.errorCount) {
            throw new Error('private record errorCount does not match public manifest')
        }

        const canonicalBatchCreatedAtMs = parseStrictUtcIsoMs(canonicalBatch.createdAt, 'canonical manifest batch createdAt')
        const normalizedRecordCreatedAtMs = parseStrictUtcIsoMs(normalizedRecord.createdAt, 'private record createdAt')
        if (canonicalBatchCreatedAtMs >= cutoffMs) {
            throw new Error('canonical manifest batch createdAt must be before cutoff')
        }

        if (normalizedRecordCreatedAtMs >= cutoffMs) {
            throw new Error('private record createdAt must be before cutoff')
        }

        if (seenBatchRecordIds.has(normalizedRecord.batchRecordId)) {
            throw new Error('private batchRecordIds must be unique')
        }

        seenBatchRecordIds.add(normalizedRecord.batchRecordId)

        return {
            manifestIndex: index,
            batchRecordId: normalizedRecord.batchRecordId,
        }
    })

    const artifactPayload = {
        version: NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION,
        siteId: canonicalManifest.siteId,
        publicManifestHash: canonicalManifest.hash,
        bindings,
    } as const

    return {
        ...artifactPayload,
        hash: hashCanonicalJson(artifactPayload),
    }
}

export function parseNewsletterRetentionApplyArtifact(input: unknown): NewsletterRetentionApplyArtifact {
    const normalized = normalizeApplyArtifact(input)
    const actualHash = hashCanonicalJson({
        version: normalized.version,
        siteId: normalized.siteId,
        publicManifestHash: normalized.publicManifestHash,
        bindings: normalized.bindings,
    })

    if (actualHash !== normalized.hash) {
        throw new Error('apply artifact hash mismatch')
    }

    return normalized
}

export function parseNewsletterRetentionApplyContext(input: NewsletterRetentionApplyContextInput): NewsletterRetentionApplyContext {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('apply context input must be a plain object')
    }

    const policy = parseNewsletterRetentionPolicy(input.policy)
    if (policy.dryRun) {
        throw new Error('apply mode must be explicitly enabled')
    }

    const evidence = parseNewsletterRetentionEvidence(input.evidence)
    const manifest = normalizeManifestForApply(input.manifest)
    if (manifest.siteId !== policy.siteId) {
        throw new Error('manifest siteId must match policy')
    }

    if (manifest.cutoff !== policy.cutoff) {
        throw new Error('manifest cutoff must match policy')
    }

    if (manifest.policyVersion !== policy.policyVersion) {
        throw new Error('manifest policyVersion must match policy')
    }

    const artifact = parseNewsletterRetentionApplyArtifact(input.artifact)
    if (artifact.siteId !== manifest.siteId) {
        throw new Error('apply artifact siteId must match manifest siteId')
    }

    if (artifact.publicManifestHash !== manifest.hash) {
        throw new Error('apply artifact manifest hash must match canonical manifest hash')
    }

    if (artifact.bindings.length === 0) {
        throw new Error('apply artifact bindings must be non-empty')
    }

    if (artifact.bindings.length !== manifest.batches.length) {
        throw new Error('apply artifact bindings must cover all manifest batches')
    }

    if (!artifact.bindings.every((binding) => binding.manifestIndex >= 0 && binding.manifestIndex < manifest.batches.length)) {
        throw new Error('apply artifact manifestIndex references unknown manifest batch')
    }

    const totalMessageCount = manifest.batches.reduce((total, batch) => safeAddIntegers(total, batch.messageCount, 'manifest total messageCount'), 0)
    if (manifest.batches.length > policy.maxBatches) {
        throw new Error('manifest batch count exceeds policy maxBatches')
    }

    if (totalMessageCount > policy.maxMessages) {
        throw new Error('manifest total messageCount exceeds policy maxMessages')
    }

    return {
        policy,
        evidence,
        manifest,
        artifact,
    }
}

function normalizeApplyArtifactInput(input: NewsletterRetentionApplyArtifactInput): {
    manifest: unknown
    records: NewsletterRetentionCandidateLoaderRecord[]
} {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('apply artifact input must be a plain object')
    }

    return {
        manifest: (input as { manifest?: unknown }).manifest,
        records: normalizePrivateRecords((input as { records?: unknown }).records),
    }
}

function normalizeApplyArtifact(input: unknown): NewsletterRetentionApplyArtifact {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('apply artifact input must be a plain object')
    }

    const version = normalizeApplyArtifactVersion((input as { version?: unknown }).version)
    const siteId = normalizeApplyArtifactSiteId((input as { siteId?: unknown }).siteId)
    const publicManifestHash = normalizeApplyArtifactManifestHash((input as { publicManifestHash?: unknown }).publicManifestHash)
    const bindings = normalizeApplyArtifactBindings((input as { bindings?: unknown }).bindings)
    const hash = normalizeApplyArtifactHash((input as { hash?: unknown }).hash)

    return {
        version,
        siteId,
        publicManifestHash,
        bindings,
        hash,
    }
}

function normalizeManifestForApply(manifest: unknown): NewsletterRetentionManifest {
    const normalized = normalizeManifestInput(manifest)
    const canonical = buildNewsletterRetentionManifest(normalized)
    const manifestHash = normalizeManifestHash((manifest as { hash?: unknown }).hash)

    if (canonical.hash !== manifestHash) {
        throw new Error('public manifest hash mismatch')
    }

    return canonical
}

function normalizeManifestInput(manifest: unknown): NewsletterRetentionManifestInput {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error('public manifest input must be a plain object')
    }

    const raw = manifest as {
        siteId?: unknown
        cutoff?: unknown
        policyVersion?: unknown
        batches?: unknown
    }

    if (!Object.prototype.hasOwnProperty.call(raw, 'policyVersion')) {
        throw new Error('public manifest policyVersion is required')
    }

    return {
        siteId: normalizeManifestSiteId(raw.siteId),
        cutoff: parseStrictUtcIso(raw.cutoff, 'manifest cutoff'),
        policyVersion: normalizeManifestVersion(raw.policyVersion),
        batches: normalizeManifestBatches(raw.batches),
    }
}

function normalizeManifestBatches(value: unknown): NewsletterRetentionManifestBatchInput[] {
    if (!Array.isArray(value)) {
        throw new Error('public manifest batches must be an array')
    }

    return value.map((batch) => normalizeManifestBatch(batch))
}

function normalizeManifestBatch(batch: unknown): NewsletterRetentionManifestBatchInput {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Error('manifest batch must be a plain object')
    }

    return {
        batchId: normalizeManifestBatchId((batch as { batchId?: unknown }).batchId),
        createdAt: parseStrictUtcIso((batch as { createdAt?: unknown }).createdAt, 'manifest batch createdAt'),
        messageCount: normalizeCount((batch as { messageCount?: unknown }).messageCount, 'messageCount'),
        notificationCount: normalizeCount((batch as { notificationCount?: unknown }).notificationCount, 'notificationCount'),
        errorCount: normalizeCount((batch as { errorCount?: unknown }).errorCount, 'errorCount'),
    }
}

function normalizePrivateRecords(records: unknown): NewsletterRetentionCandidateLoaderRecord[] {
    if (!Array.isArray(records)) {
        throw new Error('private records must be an array')
    }

    return records.map((record) => normalizePrivateRecord(record))
}

function normalizePrivateRecord(record: unknown): NewsletterRetentionCandidateLoaderRecord {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('private record must be a plain object')
    }

    return {
        siteId: normalizeApplyTenantScope((record as { siteId?: unknown }).siteId),
        batchRecordId: normalizeBatchRecordId((record as { batchRecordId?: unknown }).batchRecordId),
        batchId: normalizeOpaqueId((record as { batchId?: unknown }).batchId, 'batchId'),
        createdAt: normalizeCreatedAt((record as { createdAt?: unknown }).createdAt),
        messageCount: normalizeCount((record as { messageCount?: unknown }).messageCount, 'messageCount'),
        notificationCount: normalizeCount((record as { notificationCount?: unknown }).notificationCount, 'notificationCount'),
        errorCount: normalizeCount((record as { errorCount?: unknown }).errorCount, 'errorCount'),
        orphanCount: normalizeCount((record as { orphanCount?: unknown }).orphanCount, 'orphanCount'),
        correlationComplete: normalizeBoolean((record as { correlationComplete?: unknown }).correlationComplete, 'correlationComplete'),
    }
}

function normalizeManifestVersion(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('public manifest policyVersion must be a positive safe integer')
    }

    return value
}

function normalizeManifestSiteId(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error('siteId must be a non-empty string')
    }

    return value
}

function normalizeManifestBatchId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('batchId must be a non-empty string')
    }

    return value
}

function normalizeApplyTenantScope(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error('private record tenant scope must be a non-empty string')
    }

    return value
}

function normalizeBatchRecordId(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error('private batchRecordId must be a non-empty string')
    }

    return value
}

function normalizeOpaqueId(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`)
    }

    return value
}

function normalizeCreatedAt(value: unknown): string {
    if (typeof value !== 'string') {
        throw new Error('createdAt must be a strict UTC ISO-8601 string')
    }

    return parseStrictUtcIso(value, 'createdAt')
}

function normalizeCount(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`)
    }

    return value
}

function normalizeBoolean(value: unknown, field: string): boolean {
    if (value !== true && value !== false) {
        throw new Error(`${field} must be true or false`)
    }

    return value
}

function normalizeApplyArtifactVersion(value: unknown): number {
    if (value !== NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION) {
        throw new Error('apply artifact version is unsupported')
    }

    return NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION
}

function normalizeApplyArtifactSiteId(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        throw new Error('apply artifact siteId must be a non-empty string')
    }

    return value
}

function normalizeApplyArtifactManifestHash(value: unknown): string {
    if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error('apply artifact manifest hash must be a 64-char lowercase hex string')
    }

    return value
}

function normalizeManifestHash(value: unknown): string {
    if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error('public manifest hash must be a 64-char lowercase hex string')
    }

    return value
}

function normalizeApplyArtifactHash(value: unknown): string {
    if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error('apply artifact hash must be a 64-char lowercase hex string')
    }

    return value
}

function normalizeApplyArtifactBindings(value: unknown): NewsletterRetentionManifestApplyBinding[] {
    if (!Array.isArray(value)) {
        throw new Error('apply artifact bindings must be an array')
    }

    if (value.length === 0) {
        throw new Error('apply artifact bindings must be non-empty')
    }

    const seenIndexes = new Set<number>()
    const seenRecordIds = new Set<string>()
    return value.map((binding, index) => {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
            throw new Error('apply artifact binding must be a plain object')
        }

        const manifestIndex = normalizeManifestIndex((binding as { manifestIndex?: unknown }).manifestIndex)
        const batchRecordId = normalizeBatchRecordId((binding as { batchRecordId?: unknown }).batchRecordId)

        if (manifestIndex !== index) {
            throw new Error('apply artifact binding indexes must be sequential from 0')
        }

        if (seenIndexes.has(manifestIndex)) {
            throw new Error('apply artifact bindings must have unique manifest indexes')
        }

        if (seenRecordIds.has(batchRecordId)) {
            throw new Error('apply artifact bindings must have unique batchRecordIds')
        }

        seenIndexes.add(manifestIndex)
        seenRecordIds.add(batchRecordId)

        return {
            manifestIndex,
            batchRecordId,
        }
    })
}

function normalizeManifestIndex(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('apply artifact manifest index must be a non-negative safe integer')
    }

    return value
}

function parseStrictUtcIso(value: unknown, field: string): string {
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

    return canonical
}

function parseStrictUtcIsoMs(value: unknown, field: string): number {
    return Date.parse(parseStrictUtcIso(value, field))
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

function hashCanonicalJson(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(',')}]`
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
        return `{${entries.join(',')}}`
    }

    return JSON.stringify(value)
}
