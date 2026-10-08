import { randomUUID } from 'node:crypto'
import { createHistoricalAcquisitionVerifier, type HistoricalAcquisitionEnvelope } from './newsletter-retention-historical-acquisition.js'
import { assertHistoricalReadOnlyRoot, assertHistoricalSelectedWave, type HistoricalReadOnlyRoot } from './newsletter-retention-historical-readonly-preparation.js'
import { checkHistoricalGates } from './newsletter-retention-historical-executor-contract.js'
import { openNewsletterRetentionHistoricalArchiveStream } from './newsletter-retention-archive-stream-source.js'
import { adaptNewsletterRetentionHistoricalArchive } from './newsletter-retention-historical-archive.js'
import { boundedHistoricalSource, type HistoricalDeadlineOptions } from './newsletter-retention-historical-deadline.js'
import { readPinnedNewsletterRetentionMetadataBytes } from './newsletter-retention-secure-metadata.js'

export type HistoricalPreflightRoot = HistoricalReadOnlyRoot
export interface HistoricalPreflightReceipt {
    version: 1
    state: 'refused' | 'preflight_verified'
    stage: 'arguments' | 'root' | 'metadata' | 'stream' | 'acquisition' | 'gates' | 'complete'
    cleanupFailures: Array<'source_cleanup_failed'>
    reportedAt?: string
    reportSha256?: string
    manifestHash?: string
    artifactHash?: string
    missingPrerequisites?: string[]
}
const refusal = (stage: HistoricalPreflightReceipt['stage']): HistoricalPreflightReceipt => ({ version: 1, state: 'refused', stage, cleanupFailures: [] })
/** No lock, transaction, postcommit, SQL client, deletion port or apply switch.
 * This result grants no authority and cannot substitute admission/restore proof.
 * Only trusted application code may supply root; NEVER load it from env/JSON. */
export function createHistoricalReadOnlyPreflight(provided: HistoricalPreflightRoot) {
    const keys = ['binding', 'policy', 'approval', 'acquisitionRoot', 'now', 'queueIds', 'maxGateAgeMs', 'maxPressure', 'gates']
    if (!provided || Reflect.ownKeys(provided).some(k => typeof k !== 'string' || !keys.includes(k))) throw new Error('historical read-only root refused')
    const root: HistoricalPreflightRoot = {
        ...provided, binding: structuredClone(provided.binding), policy: structuredClone(provided.policy), approval: structuredClone(provided.approval),
        acquisitionRoot: { ...provided.acquisitionRoot }, queueIds: [...provided.queueIds], gates: {
            ghost: provided.gates.ghost.bind(provided.gates), queues: provided.gates.queues.bind(provided.gates), proxy: provided.gates.proxy.bind(provided.gates),
            pressure: provided.gates.pressure.bind(provided.gates), schema: provided.gates.schema.bind(provided.gates), correlation: provided.gates.correlation.bind(provided.gates),
        },
    }
    assertHistoricalReadOnlyRoot(root)
    const authenticate = createHistoricalAcquisitionVerifier(root.acquisitionRoot)
    return async (request: { stream: AsyncIterable<Uint8Array>; acquisition: HistoricalAcquisitionEnvelope; deadlines?: HistoricalDeadlineOptions }): Promise<HistoricalPreflightReceipt> => {
        const receipt = refusal('stream')
        let work: ReturnType<typeof boundedHistoricalSource> | undefined
        let source: Awaited<ReturnType<typeof openNewsletterRetentionHistoricalArchiveStream>> | undefined
        try {
            if (!request || Reflect.ownKeys(request).some(k => !['stream', 'acquisition', 'deadlines'].includes(k as string))) return receipt
            work = boundedHistoricalSource(request.stream, request.deadlines)
            source = await openNewsletterRetentionHistoricalArchiveStream(work, { ...root.binding, expectedProcedureFingerprint: root.acquisitionRoot.procedureFingerprint }, { ...request.deadlines, signal: work.signal })
            const selected = await adaptNewsletterRetentionHistoricalArchive(source.chain, source.binding, root.policy, {}, { ...request.deadlines, signal: work.signal })
            work.check()
            receipt.stage = 'acquisition'
            assertHistoricalSelectedWave(root, selected)
            const authenticated = authenticate(request.acquisition, root.approval.expected, root.now())
            // Verifier-owned bytes stay private across awaited gates. A shallow
            // freeze would not protect buffers; never replay caller references.
            const replay: HistoricalAcquisitionEnvelope = {
                reportBytes: authenticated.authenticatedBytes.report, configBytes: authenticated.authenticatedBytes.config,
                attestationBytes: authenticated.authenticatedBytes.metadata, signature: authenticated.authenticatedBytes.signature,
            }
            receipt.stage = 'gates'
            const gateRequest = Object.freeze({ artifactHash: selected.artifact.hash, batchGroupSha256: root.binding.batchGroupSha256, attemptId: randomUUID(), signal: work.signal })
            // Abort races bound even a misbehaving collector; trusted collectors
            // must honor signal to actually stop underlying read work.
            await new Promise<void>((resolve, reject) => {
                const abort = () => reject(new Error('historical read-only deadline'))
                work!.signal.addEventListener('abort', abort, { once: true })
                Promise.resolve().then(() => { work!.check(); return checkHistoricalGates(root, gateRequest, selected.records.flatMap(r => r.kind === 'newsletterMessages' ? [r.row.toEmail] : [])) })
                    .then(resolve, reject).finally(() => work!.signal.removeEventListener('abort', abort)).catch(() => {})
            })
            work.check()
            // Long gate collection must not turn old source timestamps fresh.
            authenticate(replay, root.approval.expected, root.now())
            Object.assign(receipt, { state: 'preflight_verified', stage: 'complete', reportedAt: authenticated.reportedAt, reportSha256: authenticated.reportSha256, manifestHash: selected.manifest.hash, artifactHash: selected.artifact.hash })
        } catch { receipt.state = 'refused' }
        finally {
            try { await source?.close() } catch { receipt.cleanupFailures.push('source_cleanup_failed') }
            await work?.close()
            if (work?.cleanupIncomplete && !receipt.cleanupFailures.length) receipt.cleanupFailures.push('source_cleanup_failed')
            if (receipt.cleanupFailures.length) receipt.state = 'refused'
        }
        return receipt
    }
}
/** Same descriptor-bound, owned mode0400, double-read SHA adapter as legacy
 * operational diagnostics; original raw bytes are authenticated, not reserialized.
 * All arguments are forbidden, including any apply/output/root/key overrides. */
export async function executeHistoricalPreflightCommand(argv: readonly string[], env: NodeJS.ProcessEnv, stream: AsyncIterable<Uint8Array>, approvedRoot?: HistoricalPreflightRoot): Promise<HistoricalPreflightReceipt> {
    if (argv.length) return refusal('arguments')
    if (!approvedRoot) return { ...refusal('root'), missingPrerequisites: ['approved_out_of_band_root', 'approved_collector_procedure_and_independent_restored_sql_attestation', 'independently_acquired_raw_readback', 'live_readonly_gate_collectors'] }
    let preflight: ReturnType<typeof createHistoricalReadOnlyPreflight>
    try { preflight = createHistoricalReadOnlyPreflight(approvedRoot) } catch { return refusal('root') }
    try {
        const names = ['REPORT', 'CONFIG', 'ATTESTATION', 'SIGNATURE'] as const
        const files = names.map(name => ({ path: env[`NEWSLETTER_RETENTION_OPERATIONAL_${name}_FILE`], sha: env[`NEWSLETTER_RETENTION_OPERATIONAL_${name}_SHA256`] }))
        if (files.some(v => !v.path || !v.sha)) return { ...refusal('metadata'), missingPrerequisites: names.filter((_, i) => !files[i].path || !files[i].sha).map(name => `pinned_${name.toLowerCase()}_metadata`) }
        if (new Set(files.map(f => f.path)).size !== files.length) return refusal('metadata')
        const [reportBytes, configBytes, attestationBytes, signatureBytes] = await Promise.all(files.map(f => readPinnedNewsletterRetentionMetadataBytes(f.path!, f.sha!)))
        const detached = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(signatureBytes))
        if (!detached || Object.keys(detached).join(',') !== 'signatureBase64' || typeof detached.signatureBase64 !== 'string') return refusal('metadata')
        const signature = Buffer.from(detached.signatureBase64, 'base64')
        if (signature.length !== 64 || signature.toString('base64') !== detached.signatureBase64) return refusal('metadata')
        return await preflight({ stream, acquisition: { reportBytes, configBytes, attestationBytes, signature } })
    } catch { return refusal('metadata') }
}
