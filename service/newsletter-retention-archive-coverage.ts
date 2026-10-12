import { buildNewsletterRetentionApplyArtifact, parseNewsletterRetentionApplyArtifact } from './newsletter-retention-apply.js'
import type { NewsletterRetentionCandidateLoaderRecord } from './newsletter-retention-candidate-loader.js'
import { createNewsletterRetentionEscrowAccumulator, type NewsletterRetentionEscrowVerificationResult } from './newsletter-retention-escrow.js'
import { parseNewsletterRetentionPolicy, type NewsletterRetentionManifest, type NewsletterRetentionPolicyInput } from './newsletter-retention.js'

const MAX_LIVE_AGE_MS = 15 * 60_000
const proofs = new WeakMap<object, RestoreProofState>()

/** An in-process capability, not a serializable evidence-file flag. */
export interface NewsletterRetentionArchiveRestoreProof {
    readonly mode: 'archive-restore-proof-v1'
    readonly restoredAt: string
}

interface RestoreProofState {
    verification: NewsletterRetentionEscrowVerificationResult
    procedureFingerprint: string
    restoredAt: string
}

type CanonicalLines = AsyncIterable<string>

export interface NewsletterRetentionArchiveRestoreInput {
    now(): Date
    restoredAt: string
    procedureFingerprint: string
    expectedProcedureFingerprint: string
    expectedSchemaFingerprint: string
    archiveLines: CanonicalLines
    restoredLines: CanonicalLines
}

/**
 * Foundation only: trusted adapters must supply archive bytes and independently
 * retained isolated-restore readback, never a caller-provided verification JSON.
 * The existing bounded canonical escrow format is the only supported format.
 */
export async function verifyNewsletterRetentionArchiveRestore(
    input: NewsletterRetentionArchiveRestoreInput,
): Promise<NewsletterRetentionArchiveRestoreProof> {
    exactKeys(input, ['now', 'restoredAt', 'procedureFingerprint', 'expectedProcedureFingerprint', 'expectedSchemaFingerprint', 'archiveLines', 'restoredLines'])
    const now = clock(input.now)
    const restoredAt = timestamp(input.restoredAt)
    if (restoredAt > now) throw new Error('restore proof is in the future')
    fingerprint(input.procedureFingerprint)
    fingerprint(input.expectedProcedureFingerprint)
    fingerprint(input.expectedSchemaFingerprint)
    if (input.procedureFingerprint !== input.expectedProcedureFingerprint) throw new Error('restore procedure mismatch')
    const archive = await verifyLines(input.archiveLines)
    const restored = await verifyLines(input.restoredLines)
    sameVerification(archive.verification, restored.verification)
    if (archive.verification.schemaFingerprint !== input.expectedSchemaFingerprint) throw new Error('restore schema mismatch')
    const proof = Object.freeze({ mode: 'archive-restore-proof-v1' as const, restoredAt: input.restoredAt })
    proofs.set(proof, {
        verification: archive.verification,
        procedureFingerprint: input.procedureFingerprint,
        restoredAt: input.restoredAt,
    })
    return proof
}

export interface NewsletterRetentionArchiveCoverageInput {
    now(): Date
    policy: NewsletterRetentionPolicyInput
    manifest: NewsletterRetentionManifest
    artifact: unknown
    restoreProof: NewsletterRetentionArchiveRestoreProof
    expectedProcedureFingerprint: string
    expectedSchemaFingerprint: string
    archiveLines: CanonicalLines
    liveLines: CanonicalLines
    live: {
        coverageCheckedAt: string
        queueCheckedAt: string
        proxyCheckedAt: string
        dlqCheckedAt: string
        queueHealthy: boolean
        proxyHealthy: boolean
        dlqMessageCount: number
        orphanCount: number
    }
}

/** Read-only preflight. Its result deliberately cannot admit an existing apply. */
export async function preflightNewsletterRetentionArchiveCoverage(input: NewsletterRetentionArchiveCoverageInput) {
    exactKeys(input, ['now', 'policy', 'manifest', 'artifact', 'restoreProof', 'expectedProcedureFingerprint', 'expectedSchemaFingerprint', 'archiveLines', 'liveLines', 'live'])
    clock(input.now)
    const policy = parseNewsletterRetentionPolicy(input.policy)
    if (!policy.dryRun) throw new Error('archive coverage apply integration is not enabled')
    parseNewsletterRetentionApplyArtifact(input.artifact)
    const proof = proofs.get(input.restoreProof)
    if (!proof) throw new Error('restore proof must originate from verified readback')
    fingerprint(input.expectedProcedureFingerprint)
    fingerprint(input.expectedSchemaFingerprint)
    if (proof.procedureFingerprint !== input.expectedProcedureFingerprint) throw new Error('restore procedure mismatch')
    if (proof.verification.schemaFingerprint !== input.expectedSchemaFingerprint) throw new Error('restore schema mismatch')
    if (timestamp(proof.restoredAt) > clock(input.now)) throw new Error('restore proof is in the future')

    return verifyArchiveSelection(input, proof)
}

/** Preparation inspects coverage without promoting historical receipts to proof. */
export async function verifyNewsletterRetentionArchiveSelection(
    input: Omit<NewsletterRetentionArchiveCoverageInput, 'restoreProof' | 'expectedProcedureFingerprint'>,
) {
    exactKeys(input, ['now', 'policy', 'manifest', 'artifact', 'expectedSchemaFingerprint', 'archiveLines', 'liveLines', 'live'])
    return verifyArchiveSelection(input)
}

async function verifyArchiveSelection(
    input: Omit<NewsletterRetentionArchiveCoverageInput, 'restoreProof' | 'expectedProcedureFingerprint'>,
    proof?: RestoreProofState,
) {
    const policy = parseNewsletterRetentionPolicy(input.policy)
    if (!policy.dryRun) throw new Error('archive coverage apply integration is not enabled')
    const artifact = parseNewsletterRetentionApplyArtifact(input.artifact)
    const archive = await verifyLines(input.archiveLines)
    if (archive.verification.schemaFingerprint !== input.expectedSchemaFingerprint) throw new Error('archive schema mismatch')
    if (proof) sameVerification(archive.verification, proof.verification)
    sameVerification(archive.verification, artifact.escrow)
    // Reconstruct private identities AND per-batch counts from verified bytes.
    // Aggregate counts / a manifest hash alone cannot certify exact membership.
    const rebuilt = buildNewsletterRetentionApplyArtifact({
        manifest: input.manifest,
        escrow: archive.verification,
        records: archive.records,
    })
    if (rebuilt.hash !== artifact.hash) throw new Error('archive selection binding mismatch')
    if (input.manifest.siteId !== policy.siteId || input.manifest.cutoff !== policy.cutoff
        || input.manifest.policyVersion !== policy.policyVersion) throw new Error('archive policy mismatch')
    if (archive.records.length > policy.maxBatches || archive.verification.counts.messages > policy.maxMessages) throw new Error('archive selection exceeds policy caps')

    const live = await verifyLines(input.liveLines)
    sameVerification(live.verification, archive.verification)
    // Refresh the trusted clock after potentially long archive/live streams.
    const now = clock(input.now)
    if (proof && timestamp(proof.restoredAt) > now) throw new Error('restore proof is in the future')
    exactKeys(input.live, ['coverageCheckedAt', 'queueCheckedAt', 'proxyCheckedAt', 'dlqCheckedAt', 'queueHealthy', 'proxyHealthy', 'dlqMessageCount', 'orphanCount'])
    for (const at of [input.live.coverageCheckedAt, input.live.queueCheckedAt, input.live.proxyCheckedAt, input.live.dlqCheckedAt]) {
        const age = now - timestamp(at)
        if (age < 0 || age > MAX_LIVE_AGE_MS) throw new Error('live archive coverage or health evidence is stale')
    }
    if (input.live.queueHealthy !== true || input.live.proxyHealthy !== true
        || input.live.dlqMessageCount !== 0 || input.live.orphanCount !== 0) throw new Error('live archive coverage or health is unsafe')
    return Object.freeze({
        mode: 'archive-coverage-preflight-v1' as const,
        applyEnabled: false as const,
        manifestHash: rebuilt.publicManifestHash,
        artifactHash: rebuilt.hash,
        escrowContentHash: archive.verification.contentHash,
        schemaFingerprint: archive.verification.schemaFingerprint,
        restoredAt: proof?.restoredAt ?? null,
        coverageCheckedAt: input.live.coverageCheckedAt,
    })
}

async function verifyLines(lines: CanonicalLines) {
    if (!lines || typeof lines[Symbol.asyncIterator] !== 'function') throw new Error('canonical archive lines must be an async iterable')
    const accumulator = createNewsletterRetentionEscrowAccumulator()
    const records: NewsletterRetentionCandidateLoaderRecord[] = []
    for await (const line of lines) {
        if (typeof line !== 'string') throw new Error('canonical archive line must be a string')
        accumulator.consume(line)
        const value = JSON.parse(line)
        if (value.kind === 'newsletterBatch') {
            records.push({
                siteId: value.row.siteId, batchRecordId: value.row.id,
                batchId: value.row.batchId, createdAt: value.row.created,
                messageCount: 0, notificationCount: 0, errorCount: 0,
                orphanCount: 0, correlationComplete: true,
            })
        } else if (value.kind !== 'header' && value.kind !== 'footer') {
            const record = records[value.manifestIndex]
            if (value.kind === 'newsletterMessages') record.messageCount += 1
            else if (value.kind === 'newsletterErrors') record.errorCount += 1
            else record.notificationCount += 1
        }
    }
    return { verification: accumulator.finalize(), records }
}

function sameVerification(left: NewsletterRetentionEscrowVerificationResult, right: NewsletterRetentionEscrowVerificationResult) {
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('archive content, schema or coverage mismatch')
}

function timestamp(value: unknown): number {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('invalid evidence timestamp')
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error('invalid evidence timestamp')
    return ms
}

function clock(now: () => Date): number {
    if (typeof now !== 'function') throw new Error('invalid preflight clock')
    const value = now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('invalid preflight clock')
    return value.getTime()
}

function fingerprint(value: string) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid fingerprint')
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('evidence must be a plain object')
    const own = Reflect.ownKeys(value)
    if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('evidence must have exact keys')
}
