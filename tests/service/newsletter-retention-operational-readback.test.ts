import { describe, expect, it } from 'vitest'
import { readPinnedNewsletterRetentionOperationalReport } from '@/service/newsletter-retention-cli'
import { inspectHistoricalOperationalReadback } from '@/service/newsletter-retention-operational-readback'
const h = 'a'.repeat(64)
const expected = { baseGenerationId: 'fixture-base', deltaGenerationId: 'fixture-delta', baseManifestSha256: h, deltaManifestSha256: h, indexSha256: h, groupSha256: h, configSha256: h, schemaFingerprint: h, procedureFingerprint: h, containerId: h, imageId: `sha256:${h}`, manifestHash: h, artifactHash: h, counts: { B: 1, M: 1, E: 0, N: 1 }, setSha256: { B: h, M: h, E: h, N: h } }
function report() { return { timestampUtc: '2026-10-07T19:52:52.4874872Z', containerId: expected.containerId, imageId: expected.imageId, provenance: { ...expected }, counts: { ...expected.counts }, setSha256: { ...expected.setSha256 }, matches: true, readbackStatus: 'verified' } }
describe('operational digest evidence admission boundary', () => {
    it('rejects malformed pin before accessing a report descriptor', async () => {
        await expect(readPinnedNewsletterRetentionOperationalReport('/no-such-fixture', 'invalid')).rejects.toThrow('pin invalid')
        await expect(readPinnedNewsletterRetentionOperationalReport('/no-such-fixture', h)).rejects.toThrow('descriptor or byte pin invalid')
    })
    it('rejects submillisecond future timestamp instead of silently rounding it', () => {
        expect(() => inspectHistoricalOperationalReadback(report(), expected, new Date('2026-10-07T19:52:52.487Z'))).toThrow('future')
    })
    it('does not promote a serialized or cloned diagnostic result to admission', () => {
        const result = inspectHistoricalOperationalReadback(report(), expected, new Date('2026-10-07T20:00:00.000Z'))
        expect(() => inspectHistoricalOperationalReadback(JSON.parse(JSON.stringify(result)), expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('timestamp')
        expect(result.admission).toBe('refused')
    })
    it('diagnoses original v2 without asking for reconstructed commitments', () => {
        const r = report()
        for (const key of ['schemaFingerprint', 'procedureFingerprint', 'manifestHash', 'artifactHash'] as const) delete (r.provenance as Partial<typeof expected>)[key]
        const result = inspectHistoricalOperationalReadback(r, expected, new Date('2026-10-07T20:00:00.000Z'))
        expect(result).toMatchObject({ admission: 'refused', reportedAt: r.timestampUtc,
            derivedBindings: { manifestHash: h, artifactHash: h, schemaFingerprint: h },
            missingIndependentEvidence: ['schemaFingerprint', 'procedureFingerprint'], missingObservedCommitments: [] })
    })
    it('preserves original precision, but refuses pinned self-attestation', () => {
        expect(inspectHistoricalOperationalReadback(report(), expected, new Date('2026-10-07T20:00:00.000Z'))).toMatchObject({ version: 2, admission: 'refused', reason: 'readback_collection_provenance_unauthenticated', reportedAt: '2026-10-07T19:52:52.4874872Z' })
    })
    it('compares present commitments inside chat wrappers before refusal', () => {
        const r = report(); r.provenance.configSha256 = 'b'.repeat(64)
        expect(() => inspectHistoricalOperationalReadback({ evidenceSource: 'operator_report_received_in_chat', originalOperatorReport: r }, expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('binding mismatch')
    })
    it('refuses chat wrapper without promoting nested flags', () => {
        expect(inspectHistoricalOperationalReadback({ evidenceSource: 'operator_report_received_in_chat', rawWindowsReportFileIndependentlyFetched: false, originalOperatorReport: report() }, expected, new Date('2026-10-07T20:00:00.000Z')).reason).toBe('operator_report_not_independently_acquired')
    })
    it.each(['containerId', 'imageId'] as const)('rejects %s drift', (key) => {
        const r = report(); r[key] += '0'
        expect(() => inspectHistoricalOperationalReadback(r, expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('binding mismatch')
    })
    it.each(['baseGenerationId', 'deltaGenerationId', 'baseManifestSha256', 'deltaManifestSha256', 'indexSha256', 'groupSha256', 'configSha256', 'schemaFingerprint', 'procedureFingerprint', 'manifestHash', 'artifactHash'] as const)('rejects %s drift', (key) => {
        const r = report(); r.provenance[key] += '0'
        expect(() => inspectHistoricalOperationalReadback(r, expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('binding mismatch')
    })
    it.each(['B', 'M', 'E', 'N'] as const)('rejects %s digest/count drift', (key) => {
        const r = report(); r.setSha256[key] = 'b'.repeat(64)
        expect(() => inspectHistoricalOperationalReadback(r, expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('digest mismatch')
        r.setSha256[key] = h; r.counts[key]++
        expect(() => inspectHistoricalOperationalReadback(r, expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('count mismatch')
    })
    it.each(['2026-02-30T19:52:52.4874872Z', '2026-10-07T19:52:52Z', '2027-10-07T19:52:52.4874872Z'])('rejects malformed/future timestamp %s', (timestampUtc) => {
        expect(() => inspectHistoricalOperationalReadback({ ...report(), timestampUtc }, expected, new Date('2026-10-07T20:00:00.000Z'))).toThrow('timestamp')
    })
})
