import { inspectHistoricalOperationalReadback, operationalChainBinding, type HistoricalOperationalBinding } from './newsletter-retention-operational-readback.js'
import { adaptNewsletterRetentionHistoricalArchive, HISTORICAL_LIMITS, type HistoricalArchiveBinding, type HistoricalArchiveChain } from './newsletter-retention-historical-archive.js'
import { preflightNewsletterRetentionArchiveCoverage, verifyNewsletterRetentionArchiveSelection, type NewsletterRetentionArchiveCoverageInput, type NewsletterRetentionArchiveRestoreProof } from './newsletter-retention-archive-coverage.js'
import { streamNewsletterRetentionEscrowRecords, type NewsletterRetentionEscrowLoaderDelegate } from './newsletter-retention-escrow-loader.js'
import { writeNewsletterRetentionEscrow } from './newsletter-retention-escrow-writer.js'
import { parseNewsletterRetentionPolicy, type NewsletterRetentionPolicyInput } from './newsletter-retention.js'
import { NEWSLETTER_RETENTION_APPLY_LOCK_KEY, type NewsletterRetentionApplyLockProvider } from './newsletter-retention-applier.js'

export interface NewsletterRetentionHistoricalPreparationSource {
    chain: HistoricalArchiveChain
    binding: HistoricalArchiveBinding
    // Only independently verified readback capabilities are accepted. No receipts.
    restoreProof?: NewsletterRetentionArchiveRestoreProof
    expectedProcedureFingerprint: string
    // Pinned metadata and a report are diagnostic input, never acquisition proof.
    operationalReadback?: { report: unknown; target: Pick<HistoricalOperationalBinding, 'configSha256' | 'containerId' | 'imageId'> }
    close(): Promise<void>
}
export interface NewsletterRetentionArchivePreparationDatabase {
    $transaction<T>(callback: (tx: NewsletterRetentionEscrowLoaderDelegate & { newsletterBatch: { findMany(args: { where: { batchId: string }; select: { id: true }; take: number }): Promise<Array<{ id: string }>> } }) => Promise<T>, options: { isolationLevel: 'Serializable' }): Promise<T>
}
export interface NewsletterRetentionArchivePreparationInput {
    policy: NewsletterRetentionPolicyInput
    now(): Date
    schemaFingerprint(): string | Promise<string>
    database: NewsletterRetentionArchivePreparationDatabase
    lock: NewsletterRetentionApplyLockProvider
    openArchive(): Promise<NewsletterRetentionHistoricalPreparationSource>
    live(): Promise<Omit<NewsletterRetentionArchiveCoverageInput['live'], 'coverageCheckedAt' | 'orphanCount'>>
}

/** Executor preparation only: no writer, no apply-context, no deletes or TTL substitution. */
export async function prepareNewsletterRetentionHistoricalArchive(input: NewsletterRetentionArchivePreparationInput) {
    const policy = parseNewsletterRetentionPolicy(input.policy)
    if (!policy.dryRun) throw new Error('historical archive preparation cannot apply')
    const lease = await input.lock.tryAcquire(NEWSLETTER_RETENTION_APPLY_LOCK_KEY)
    if (!lease) throw new Error('newsletter retention command is already running')
    let source: NewsletterRetentionHistoricalPreparationSource | undefined
    try {
        source = await input.openArchive()
        const schema = await input.schemaFingerprint()
        if (schema !== source.binding.schemaFingerprint) throw new Error('historical archive current schema mismatch')
        const selected = await adaptNewsletterRetentionHistoricalArchive(source.chain, source.binding, input.policy)
        const liveLines: string[] = []
        let liveBytes = 0
        // Existing loader checks exact parent, full children, counts, keys and orphans.
        // Reads share a Serializable snapshot; no mutation delegates are called here.
        const startedAt = input.now().toISOString()
        await input.database.$transaction(async (tx) => {
            const parents = await tx.newsletterBatch.findMany({ where: { batchId: selected.candidate.batchId }, select: { id: true }, take: 2 })
            if (parents.length !== 1 || parents[0].id !== selected.candidate.batchRecordId) throw new Error('historical archive live group parent set mismatch')
            await writeNewsletterRetentionEscrow({
                header: { kind: 'header', version: 1, siteId: policy.siteId, cutoff: policy.cutoff, policyVersion: policy.policyVersion, publicManifestHash: selected.manifest.hash, schemaFingerprint: schema },
                records: streamNewsletterRetentionEscrowRecords(tx, input.policy, [selected.candidate]),
                writeChunk(chunk) {
                    liveBytes += chunk.byteLength
                    if (liveBytes > HISTORICAL_LIMITS.selectionBytes * 2 || liveLines.length > HISTORICAL_LIMITS.selectionRows + 2) throw new Error('historical archive live selection memory capacity exceeded')
                    liveLines.push(new TextDecoder().decode(chunk).replace(/\n$/, '')) },
            })
        }, { isolationLevel: 'Serializable' })
        if (await input.schemaFingerprint() !== schema) throw new Error('historical archive current schema changed during preparation')
        const coverageInput = {
            now: input.now, policy: input.policy, manifest: selected.manifest, artifact: selected.artifact,
            expectedSchemaFingerprint: schema,
            archiveLines: (async function* () { yield* selected.lines })(),
            liveLines: (async function* () { yield* liveLines })(),
            live: { ...await input.live(), coverageCheckedAt: startedAt, orphanCount: 0 },
        }
        const coverage = source.restoreProof
            ? await preflightNewsletterRetentionArchiveCoverage({ ...coverageInput, restoreProof: source.restoreProof, expectedProcedureFingerprint: source.expectedProcedureFingerprint })
            : await verifyNewsletterRetentionArchiveSelection(coverageInput)
        const operationalAdmission = source.operationalReadback ? inspectHistoricalOperationalReadback(source.operationalReadback.report, {
            ...operationalChainBinding(source.binding), ...source.operationalReadback.target,
            procedureFingerprint: source.expectedProcedureFingerprint,
            manifestHash: selected.manifest.hash, artifactHash: selected.artifact.hash,
            counts: { B: 1, M: selected.candidate.messageCount, E: selected.candidate.errorCount, N: selected.candidate.notificationCount },
            setSha256: selected.readbackDigests,
        }, input.now()) : null
        return Object.freeze({
            admissionVersion: 2 as const,
            operationalAdmission,
            mode: 'historical-archive-preparation-v1' as const,
            dryRun: true as const,
            applyEnabled: false as const,
            admission: 'refused' as const,
            reason: operationalAdmission?.reason ?? (source.restoreProof ? 'archive_apply_admission_not_enabled' : 'independent_restore_readback_missing'),
            coverage,
        })
    } finally {
        try { await source?.close() } finally { await lease.release() }
    }
}
