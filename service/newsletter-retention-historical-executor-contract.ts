import { createHash } from 'node:crypto'
import type { HistoricalAuthorizationLedger } from './newsletter-retention-historical-authorization-ledger.js'
import type { HistoricalArchiveBinding } from './newsletter-retention-historical-archive.js'
import type { HistoricalAcquisitionEnvelope, HistoricalAcquisitionTrustRoot } from './newsletter-retention-historical-acquisition.js'
import type { HistoricalOperationalBinding } from './newsletter-retention-operational-readback.js'
import type { HistoricalDeadlineOptions } from './newsletter-retention-historical-deadline.js'
import type { NewsletterRetentionPolicyInput } from './newsletter-retention.js'
import type { NewsletterRetentionApplyLockProvider, NewsletterRetentionApplyTransactionClient } from './newsletter-retention-applier.js'

export type HistoricalTransaction = NewsletterRetentionApplyTransactionClient & {
    newsletterBatch: { findMany(args: { where: { batchId: string }; select: { id: true }; take: number }): Promise<Array<{ id: string }>> }
}
interface Observation { checkedAt: string; scopeHash: string }
export interface HistoricalGateRequest { artifactHash: string; batchGroupSha256: string; attemptId: string; signal: AbortSignal }
/** Ports are independently provisioned trusted collectors, not request JSON flags. */
export interface HistoricalGatePorts {
    ghost(request: HistoricalGateRequest): Promise<Observation & { recipients: string[] }>
    queues(request: HistoricalGateRequest): Promise<Observation & { queues: Array<{ id: string; visible: number | null; inflight: number | null; delayed: number | null }> }>
    proxy(request: HistoricalGateRequest): Promise<Observation & { accepting: boolean }>
    pressure(request: HistoricalGateRequest): Promise<Observation & { activeQueries: number }>
    /** Independently observe SQL catalog using the approved procedure canonicalization,
     * and exact Prisma bytes. NEVER derive a SQL observation from expected/file hashes. */
    schema(request: HistoricalGateRequest): Promise<Observation & { liveDatabaseFingerprint: string; prismaFileFingerprint: string }>
    correlation(request: HistoricalGateRequest): Promise<Observation & { orphans: number; lateEvents: number }>
}
export interface HistoricalRemainingCounts { parents: number; messages: number; errors: number; notifications: number; orphans: number; lateEvents: number }
export interface HistoricalExecutorRoot {
    binding: HistoricalArchiveBinding
    policy: NewsletterRetentionPolicyInput
    /** Independent operator/policy authorization, not acquisition-signer authorization. */
    approval: { expected: HistoricalOperationalBinding; policy: NewsletterRetentionPolicyInput; schema: { expectedSqlDatabaseFingerprint: string; expectedPrismaFileFingerprint: string } }
    acquisitionRoot: HistoricalAcquisitionTrustRoot
    /** Mandatory independently provisioned durable one-shot approval. */
    authorization: HistoricalAuthorizationLedger
    now(): Date
    lock: NewsletterRetentionApplyLockProvider
    /** Complete approved inventory including ALL main queues AND their DLQs. */
    queueIds: readonly string[]
    maxGateAgeMs: number
    maxPressure: number
    gates: HistoricalGatePorts
    database: { $transaction<T>(callback: (tx: HistoricalTransaction) => Promise<T>, options: { isolationLevel: 'Serializable'; attemptId: string }): Promise<T> }
    /** Distinct connection/read dependency: NEVER the transaction client. */
    postcommit: { read(request: { attemptId: string; batchId: string; batchRecordId: string; messageIds: string[]; artifactHash: string }): Promise<HistoricalRemainingCounts> }
    /** Only a DB adapter's independently established outcome can confirm rollback. */
    confirmRollback?: (attemptId: string) => Promise<{ attemptId: string; outcome: 'rollback_confirmed' | 'unknown' }>
}
export interface HistoricalExecutorRequest {
    stream: AsyncIterable<Uint8Array>
    acquisition: HistoricalAcquisitionEnvelope
    deadlines?: HistoricalDeadlineOptions
}
export interface HistoricalExecutorReceipt {
    version: 1
    state: 'refused_before_transaction' | 'rollback_confirmed' | 'commit_unknown' | 'committed_readback_ok' | 'committed_readback_failed'
    stage: 'lock' | 'stream' | 'admission' | 'gates' | 'transaction' | 'postcommit'
    manifestHash?: string
    artifactHash?: string
    deleted?: { batches: number; messages: number; errors: number; notifications: number }
    cleanupFailures: Array<'source_cleanup_failed' | 'lock_release_failed'>
}
export function recipientCommitment(recipients: readonly string[]) {
    if (!Array.isArray(recipients) || recipients.length > 20_000 || recipients.some(v => typeof v !== 'string' || !v || Buffer.byteLength(v) > 1024)
        || new Set(recipients).size !== recipients.length) throw new Error('historical recipient set invalid')
    return { count: recipients.length, digest: createHash('sha256').update(JSON.stringify([...recipients].sort())).digest('hex') }
}
export async function checkHistoricalGates(root: Pick<HistoricalExecutorRoot, 'now' | 'gates' | 'queueIds' | 'maxGateAgeMs' | 'maxPressure' | 'approval'>, request: HistoricalGateRequest, expectedRecipients: readonly string[]) {
    if (request.signal.aborted) throw new Error('historical executor cancelled')
    // Capture methods/receiver once and own each result on its completion, not
    // after Promise.all (another collector can mutate an already returned object).
    const gates = root.gates
    const collect = <T>(method: (request: HistoricalGateRequest) => Promise<T>) => {
        const captured = method.bind(gates)
        return Promise.resolve().then(async () => structuredClone(await captured(request)))
    }
    const observations = await Promise.all([
        collect(gates.ghost), collect(gates.queues), collect(gates.proxy), collect(gates.pressure), collect(gates.schema), collect(gates.correlation),
    ])
    assertHistoricalGateObservations(root, request, expectedRecipients, {
        ghost: observations[0], queues: observations[1], proxy: observations[2],
        pressure: observations[3], schema: observations[4], correlation: observations[5],
    })
}
export type HistoricalGateObservations = { [Name in keyof HistoricalGatePorts]: Awaited<ReturnType<HistoricalGatePorts[Name]>> }
/** Pure assertion shared with readonly finalization. Scheduling and ownership
 * are implemented by each collector composition, not this assertion. */
export function assertHistoricalGateObservations(root: Pick<HistoricalExecutorRoot, 'now' | 'queueIds' | 'maxGateAgeMs' | 'maxPressure' | 'approval'>, request: HistoricalGateRequest, expectedRecipients: readonly string[], collected: HistoricalGateObservations) {
    const observations = [collected.ghost, collected.queues, collected.proxy, collected.pressure, collected.schema, collected.correlation]
    const now = root.now().getTime()
    for (const observation of observations) {
        const date = Date.parse(observation.checkedAt)
        if (!Number.isFinite(now) || !Number.isFinite(date) || new Date(date).toISOString() !== observation.checkedAt
            || date > now || now - date > root.maxGateAgeMs || observation.scopeHash !== request.artifactHash) throw new Error('historical gate scope or freshness invalid')
    }
    const { ghost, queues, proxy, pressure, schema, correlation } = collected
    if (JSON.stringify(recipientCommitment(ghost.recipients)) !== JSON.stringify(recipientCommitment(expectedRecipients))) throw new Error('historical Ghost recipient set mismatch')
    if (!Array.isArray(queues.queues) || queues.queues.length !== root.queueIds.length || new Set(queues.queues.map(q => q.id)).size !== root.queueIds.length
        || queues.queues.some(q => !root.queueIds.includes(q.id) || [q.visible, q.inflight, q.delayed].some(n => n !== 0))) throw new Error('historical complete queue/DLQ census refused')
    if (proxy.accepting !== true || !Number.isSafeInteger(pressure.activeQueries) || pressure.activeQueries < 0 || pressure.activeQueries > root.maxPressure) throw new Error('historical proxy/query pressure refused')
    if (schema.liveDatabaseFingerprint !== root.approval.schema.expectedSqlDatabaseFingerprint || schema.prismaFileFingerprint !== root.approval.schema.expectedPrismaFileFingerprint) throw new Error('historical live schema refused')
    if (correlation.orphans !== 0 || correlation.lateEvents !== 0 || request.signal.aborted) throw new Error('historical correlation/cancellation refused')
}
