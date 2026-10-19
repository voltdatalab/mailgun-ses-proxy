import type { HistoricalArchiveBinding } from './newsletter-retention-historical-archive.js'

export type HistoricalDigestSets = Record<'B' | 'M' | 'E' | 'N', string>
export interface HistoricalOperationalBinding {
    baseGenerationId: string; deltaGenerationId: string
    baseManifestSha256: string; deltaManifestSha256: string; indexSha256: string; groupSha256: string
    configSha256: string; schemaFingerprint: string; procedureFingerprint: string
    containerId: string; imageId: string; manifestHash: string; artifactHash: string
    counts: Record<'B' | 'M' | 'E' | 'N', number>; setSha256: HistoricalDigestSets
}
export function operationalChainBinding(binding: HistoricalArchiveBinding) {
    return { baseGenerationId: binding.baseGenerationId, deltaGenerationId: binding.deltaGenerationId,
        baseManifestSha256: binding.baseManifestSha256, deltaManifestSha256: binding.deltaManifestSha256,
        indexSha256: binding.baseIndexSha256, groupSha256: binding.batchGroupSha256, schemaFingerprint: binding.schemaFingerprint }
}
/** Diagnostic comparison only; expected bindings come from verified archive selection.
 * Derived manifest/artifact/schema bindings are NOT independent restored-schema evidence.
 * Original v2 need not be reissued: compare every present commitment, label absences,
 * and always refuse unauthenticated acquisition. This NEVER mints a capability. */
export function inspectHistoricalOperationalReadback(value: unknown, expected: HistoricalOperationalBinding, now: Date) {
    const envelope = object(value)
    const chat = envelope.evidenceSource === 'operator_report_received_in_chat'
    const raw = chat ? object(envelope.originalOperatorReport) : envelope
    const reportedAt = chat && raw.timestampUtc === undefined ? null : validateReportedAt(raw.timestampUtc, now)
    const missingObservedCommitments: string[] = reportedAt === null ? ['timestampUtc'] : []
    const missingIndependentEvidence: string[] = []
    const compare = (record: Record<string, unknown>, key: string, wanted: unknown, missing: string[], label = key, kind = 'binding') => {
        if (!Object.hasOwn(record, key)) missing.push(label)
        else if (record[key] !== wanted) throw new Error(`operational readback ${kind} mismatch`)
    }
    for (const key of ['containerId', 'imageId'] as const) compare(raw, key, expected[key], missingObservedCommitments)
    const provenance = raw.provenance === undefined ? {} : object(raw.provenance)
    for (const key of ['baseGenerationId', 'deltaGenerationId', 'baseManifestSha256', 'deltaManifestSha256', 'indexSha256', 'groupSha256', 'configSha256'] as const) {
        compare(provenance, key, expected[key], missingObservedCommitments)
    }
    for (const key of ['schemaFingerprint', 'procedureFingerprint'] as const) compare(provenance, key, expected[key], missingIndependentEvidence)
    // Older reports do not contain these reconstructed private-selection hashes.
    // If supplied, they must still agree; absence is not an independent-evidence gap.
    for (const key of ['manifestHash', 'artifactHash'] as const) {
        if (Object.hasOwn(provenance, key) && provenance[key] !== expected[key]) throw new Error('operational readback binding mismatch')
    }
    const counts = raw.counts === undefined ? {} : object(raw.counts)
    const sets = raw.setSha256 === undefined ? {} : object(raw.setSha256)
    for (const tag of ['B', 'M', 'E', 'N'] as const) {
        if (!Number.isSafeInteger(expected.counts[tag]) || expected.counts[tag] < 0) throw new Error('operational readback count mismatch')
        if (!/^[a-f0-9]{64}$/.test(expected.setSha256[tag])) throw new Error('operational readback digest mismatch')
        compare(counts, tag, expected.counts[tag], missingObservedCommitments, `counts.${tag}`, 'count')
        compare(sets, tag, expected.setSha256[tag], missingObservedCommitments, `setSha256.${tag}`, 'digest')
    }
    return Object.freeze({ version: 2 as const, admission: 'refused' as const,
        reason: chat ? 'operator_report_not_independently_acquired' : 'readback_collection_provenance_unauthenticated', reportedAt,
        collectionAuthenticated: false as const,
        derivedBindings: Object.freeze({ manifestHash: expected.manifestHash, artifactHash: expected.artifactHash, schemaFingerprint: expected.schemaFingerprint,
            counts: Object.freeze({ ...expected.counts }), setSha256: Object.freeze({ ...expected.setSha256 }) }),
        missingObservedCommitments: Object.freeze(missingObservedCommitments),
        missingIndependentEvidence: Object.freeze(missingIndependentEvidence),
    })
}
function validateReportedAt(value: unknown, now: Date): string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value)) throw new Error('operational readback timestamp malformed')
    const msText = value.slice(0, 23) + 'Z'
    const ms = Date.parse(msText)
    if (!Number.isFinite(now.getTime()) || !Number.isFinite(ms) || new Date(ms).toISOString() !== msText
        || ms > now.getTime() || (ms === now.getTime() && /[1-9]/.test(value.slice(23, 27)))) throw new Error('operational readback timestamp invalid or future')
    return value
}
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('operational readback must be a plain object')
    return value as Record<string, unknown>
}
