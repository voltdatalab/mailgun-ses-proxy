import { operationalChainBinding } from './newsletter-retention-operational-readback.js'
import { parseNewsletterRetentionPolicy } from './newsletter-retention.js'
import type { adaptNewsletterRetentionHistoricalArchive } from './newsletter-retention-historical-archive.js'
import type { HistoricalExecutorRoot } from './newsletter-retention-historical-executor-contract.js'
export type HistoricalReadOnlyRoot = Pick<HistoricalExecutorRoot, 'binding' | 'policy' | 'approval' | 'acquisitionRoot' | 'now' | 'queueIds' | 'maxGateAgeMs' | 'maxPressure' | 'gates'>
export function assertHistoricalReadOnlyRoot(root: HistoricalReadOnlyRoot) {
    if (!root?.acquisitionRoot || !root.approval || !root.gates) throw new Error('historical trusted read-only adapters missing')
    for (const key of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) if (typeof root.gates[key] !== 'function') throw new Error('historical trusted gate adapter missing')
    if (root.policy.apply === true || root.approval.policy.apply === true || !Number.isSafeInteger(root.maxGateAgeMs) || root.maxGateAgeMs <= 0 || root.maxGateAgeMs > 900_000
        || !Number.isSafeInteger(root.maxPressure) || root.maxPressure < 0 || root.maxPressure > 100
        || root.queueIds.length < 2 || new Set(root.queueIds).size !== root.queueIds.length || root.queueIds.some(id => !id)) throw new Error('historical trusted root limits invalid')
    // Independent policy approval must pin BOTH domains; never derive SQL from Prisma.
    const approvedSchema = root.approval.schema
    if (!approvedSchema || [approvedSchema.expectedSqlDatabaseFingerprint, approvedSchema.expectedPrismaFileFingerprint].some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
        || approvedSchema.expectedSqlDatabaseFingerprint !== root.acquisitionRoot.expectedSqlDatabaseFingerprint
        || approvedSchema.expectedPrismaFileFingerprint !== root.acquisitionRoot.expectedPrismaFileFingerprint
        || approvedSchema.expectedPrismaFileFingerprint !== root.binding.schemaFingerprint
        || approvedSchema.expectedPrismaFileFingerprint !== root.approval.expected.schemaFingerprint) throw new Error('historical approved schema commitments invalid')
}
export function assertHistoricalSelectedWave(root: HistoricalReadOnlyRoot, selected: Awaited<ReturnType<typeof adaptNewsletterRetentionHistoricalArchive>>) {
    const expected = root.approval.expected
    const policy = parseNewsletterRetentionPolicy(root.policy)
    const derived = { ...operationalChainBinding(root.binding), procedureFingerprint: root.acquisitionRoot.procedureFingerprint,
        manifestHash: selected.manifest.hash, artifactHash: selected.artifact.hash,
        counts: { B: 1, M: selected.candidate.messageCount, E: selected.candidate.errorCount, N: selected.candidate.notificationCount }, setSha256: selected.readbackDigests }
    // Complete chain/selection/policy comparison, never caller flags or report.matches.
    for (const [key, value] of Object.entries(derived)) {
        const wanted = expected[key as keyof typeof expected]
        if (typeof value === 'object' ? Object.entries(value).some(([k, v]) => (wanted as Record<string, unknown>)?.[k] !== v) : wanted !== value) throw new Error('historical wave binding mismatch')
    }
    if (JSON.stringify(policy) !== JSON.stringify(parseNewsletterRetentionPolicy(root.approval.policy))) throw new Error('historical wave policy mismatch')
}
