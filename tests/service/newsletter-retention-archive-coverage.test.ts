import { describe, expect, it } from 'vitest'
import { buildNewsletterRetentionManifest, parseNewsletterRetentionEvidence } from '@/service/newsletter-retention'
import { buildNewsletterRetentionApplyArtifact } from '@/service/newsletter-retention-apply'
import { writeNewsletterRetentionEscrow } from '@/service/newsletter-retention-escrow-writer'
import type { NewsletterRetentionEscrowRecord } from '@/service/newsletter-retention-escrow'
import { preflightNewsletterRetentionArchiveCoverage, verifyNewsletterRetentionArchiveRestore } from '@/service/newsletter-retention-archive-coverage'

const NOW = '2026-10-01T00:00:00.000Z'
const OLD = '2026-01-02T00:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'
const SCHEMA = 'a'.repeat(64)
const PROCEDURE = 'b'.repeat(64)
async function* lines(values: string[]) { yield* values }

async function fixture(contents = 'synthetic content', parentId = 'synthetic-parent') {
    const manifest = buildNewsletterRetentionManifest({ siteId: 'synthetic-tenant', cutoff: OLD, batches: [{ batchId: 'synthetic-group', createdAt: CREATED, messageCount: 1, notificationCount: 1, errorCount: 0 }] })
    const records: NewsletterRetentionEscrowRecord[] = [
        { kind: 'newsletterBatch', manifestIndex: 0, row: { id: parentId, siteId: manifest.siteId, batchId: 'synthetic-group', created: CREATED, contents, fromEmail: 'sender@example.invalid' } },
        { kind: 'newsletterMessages', manifestIndex: 0, row: { id: 'synthetic-message-row', messageId: 'synthetic-message', newsletterBatchId: parentId, created: CREATED, toEmail: 'recipient@example.invalid', formatedContents: 'synthetic message', recipientData: null } },
        { kind: 'newsletterNotifications', manifestIndex: 0, row: { id: 'synthetic-notification-row', messageId: 'synthetic-message', notificationId: 'synthetic-notification', created: CREATED, timestamp: CREATED, rawEvent: '{}', type: 'delivered' } },
    ]
    const serialized: string[] = []
    const escrow = await writeNewsletterRetentionEscrow({
        header: { kind: 'header', version: 1, siteId: manifest.siteId, cutoff: manifest.cutoff, policyVersion: 1, publicManifestHash: manifest.hash, schemaFingerprint: SCHEMA },
        records: (async function* () { yield* records })(),
        writeChunk: (chunk) => { serialized.push(new TextDecoder().decode(chunk).trimEnd()) },
    })
    const artifact = buildNewsletterRetentionApplyArtifact({ manifest, escrow, records: [{ siteId: manifest.siteId, batchRecordId: parentId, batchId: 'synthetic-group', createdAt: CREATED, messageCount: 1, notificationCount: 1, errorCount: 0, orphanCount: 0, correlationComplete: true }] })
    const restoreInput = { now: () => new Date(NOW), restoredAt: OLD, procedureFingerprint: PROCEDURE, expectedProcedureFingerprint: PROCEDURE, expectedSchemaFingerprint: SCHEMA, archiveLines: lines(serialized), restoredLines: lines(serialized) }
    const restoreProof = await verifyNewsletterRetentionArchiveRestore(restoreInput)
    const input = {
        now: () => new Date(NOW), policy: { siteId: manifest.siteId, cutoff: manifest.cutoff }, manifest, artifact, restoreProof,
        expectedProcedureFingerprint: PROCEDURE, expectedSchemaFingerprint: SCHEMA,
        archiveLines: lines(serialized), liveLines: lines(serialized),
        live: { coverageCheckedAt: NOW, queueCheckedAt: NOW, proxyCheckedAt: NOW, dlqCheckedAt: NOW, queueHealthy: true, proxyHealthy: true, dlqMessageCount: 0, orphanCount: 0 },
    }
    return { input, serialized, restoreInput }
}

describe('opt-in archive coverage foundation (not apply admission)', () => {
    it('reuses an old independently read-back restore without rewriting timestamps', async () => {
        const { input } = await fixture()
        expect(await preflightNewsletterRetentionArchiveCoverage(input)).toMatchObject({ applyEnabled: false, restoredAt: OLD, coverageCheckedAt: NOW, artifactHash: input.artifact.hash })
        expect(() => parseNewsletterRetentionEvidence({ now: NOW, backup: { verifiedAt: OLD, restoredAt: OLD }, restore: { verifiedAt: OLD, restoredAt: OLD }, health: { queueCheckedAt: NOW, proxyCheckedAt: NOW, queueHealthy: true, proxyHealthy: true } })).toThrow('stale')
    })
    it('rejects JSON/cloned/self-attested restore capabilities', async () => {
        const { input } = await fixture()
        input.restoreProof = JSON.parse(JSON.stringify(input.restoreProof))
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('verified readback')
    })
    it('rejects explicit apply even with complete proof', async () => {
        const { input } = await fixture()
        await expect(preflightNewsletterRetentionArchiveCoverage({ ...input, policy: { ...input.policy, apply: true } })).rejects.toThrow('not enabled')
    })
    it.each(['archiveLines', 'liveLines'] as const)('rejects valid same-count changed content in %s', async (field) => {
        const { input } = await fixture()
        const changed = await fixture('changed synthetic contents')
        input[field] = lines(changed.serialized)
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('mismatch')
    })
    it('rejects valid same-count identity substitution', async () => {
        const { input } = await fixture()
        input.liveLines = lines((await fixture('synthetic content', 'other-synthetic-parent')).serialized)
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('mismatch')
    })
    it('rejects a rehashed artifact with wrong private membership', async () => {
        const { input } = await fixture()
        input.artifact = buildNewsletterRetentionApplyArtifact({
            manifest: input.manifest, escrow: input.artifact.escrow,
            records: [{ siteId: input.manifest.siteId, batchRecordId: 'wrong-synthetic-parent', batchId: 'synthetic-group', createdAt: CREATED, messageCount: 1, notificationCount: 1, errorCount: 0, orphanCount: 0, correlationComplete: true }],
        })
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('selection binding mismatch')
    })
    it.each(['coverageCheckedAt', 'queueCheckedAt', 'proxyCheckedAt', 'dlqCheckedAt'] as const)('rejects stale %s', async (field) => {
        const { input } = await fixture()
        input.live[field] = '2026-09-30T23:44:59.999Z'
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('stale')
    })
    it.each(['coverageCheckedAt', 'queueCheckedAt', 'proxyCheckedAt', 'dlqCheckedAt'] as const)('rejects future %s', async (field) => {
        const { input } = await fixture()
        input.live[field] = '2026-10-01T00:00:00.001Z'
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('stale')
    })
    it.each(['dlqMessageCount', 'orphanCount'] as const)('rejects unsafe %s', async (field) => {
        const { input } = await fixture()
        input.live[field] = 1
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('unsafe')
    })
    it.each(['queueHealthy', 'proxyHealthy'] as const)('rejects unhealthy %s', async (field) => {
        const { input } = await fixture()
        input.live[field] = false
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('unsafe')
    })
    it('requires the independently restored bytes to match', async () => {
        const { restoreInput, serialized } = await fixture()
        restoreInput.archiveLines = lines(serialized)
        restoreInput.restoredLines = lines((await fixture('changed restore')).serialized)
        await expect(verifyNewsletterRetentionArchiveRestore(restoreInput)).rejects.toThrow('mismatch')
    })
    it.each(['expectedSchemaFingerprint', 'expectedProcedureFingerprint'] as const)('rejects incompatible %s', async (field) => {
        const { input } = await fixture()
        input[field] = 'c'.repeat(64)
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('mismatch')
    })
    it('rejects missing/truncated archive framing and corrupt bytes', async () => {
        for (const corrupt of ['truncated', 'changed']) {
            const { input, serialized } = await fixture()
            input.archiveLines = lines(corrupt === 'truncated' ? serialized.slice(0, -1) : serialized.map((line) => line.replace('synthetic content', 'tampered')))
            await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow()
        }
    })
    it('rejects policy tenant/cutoff mismatch and a tampered manifest', async () => {
        const { input } = await fixture()
        await expect(preflightNewsletterRetentionArchiveCoverage({ ...input, policy: { ...input.policy, siteId: 'other-synthetic-tenant' } })).rejects.toThrow('policy mismatch')
        const next = (await fixture()).input
        next.manifest = { ...next.manifest, hash: 'c'.repeat(64) }
        await expect(preflightNewsletterRetentionArchiveCoverage(next)).rejects.toThrow('hash mismatch')
    })
    it('rejects invalid or future historical restore timestamps', async () => {
        for (const restoredAt of ['2026-02-30T00:00:00.000Z', '2026-10-01T00:00:00.001Z']) {
            const { restoreInput } = await fixture()
            await expect(verifyNewsletterRetentionArchiveRestore({ ...restoreInput, restoredAt })).rejects.toThrow()
        }
    })
    it('rejects an unknown live evidence flag', async () => {
        const { input } = await fixture()
        await expect(preflightNewsletterRetentionArchiveCoverage({ ...input, live: { ...input.live, covered: true } } as typeof input)).rejects.toThrow('exact keys')
    })
    it('accepts the freshness boundary but not one millisecond beyond it', async () => {
        const { input } = await fixture()
        input.live.coverageCheckedAt = '2026-09-30T23:45:00.000Z'
        expect((await preflightNewsletterRetentionArchiveCoverage(input)).applyEnabled).toBe(false)
    })
    it('fails closed for unknown/unreconciled DLQ state even with matching archive and healthy proxy', async () => {
        for (const dlqMessageCount of [undefined, null, -1, Number.NaN]) {
            const { input } = await fixture()
            await expect(preflightNewsletterRetentionArchiveCoverage({ ...input, live: { ...input.live, dlqMessageCount } } as typeof input)).rejects.toThrow('unsafe')
        }
    })
    it('refreshes its clock after slow streams instead of accepting expired health', async () => {
        const { input, serialized } = await fixture()
        let current = NOW
        input.now = () => new Date(current)
        input.liveLines = (async function* () {
            yield* serialized
            current = '2026-10-01T00:15:00.001Z'
        })()
        await expect(preflightNewsletterRetentionArchiveCoverage(input)).rejects.toThrow('stale')
    })
    it('rejects unknown bypass fields rather than ignoring evidence JSON', async () => {
        const { input } = await fixture()
        await expect(preflightNewsletterRetentionArchiveCoverage({ ...input, allowOldRestore: true } as typeof input)).rejects.toThrow('exact keys')
    })
})
