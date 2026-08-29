import { describe, expect, it } from 'vitest'

import { buildNewsletterRetentionManifest } from '@/service/newsletter-retention'
import { NEWSLETTER_RETENTION_ESCROW_VERSION } from '@/service/newsletter-retention-escrow'
import {
    NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION,
    buildNewsletterRetentionApplyArtifact,
    parseNewsletterRetentionApplyArtifact,
    parseNewsletterRetentionApplyContext,
    type NewsletterRetentionManifestApplyBinding,
} from '@/service/newsletter-retention-apply'

interface Fixture {
    manifest: ReturnType<typeof buildNewsletterRetentionManifest>
    escrow: ReturnType<typeof createEscrowCommitment>
    records: {
        siteId: string
        batchRecordId: string
        batchId: string
        createdAt: string
        messageCount: number
        notificationCount: number
        errorCount: number
        orphanCount: number
        correlationComplete: boolean
    }[]
}

function createEscrowCommitment(manifest: ReturnType<typeof buildNewsletterRetentionManifest>) {
    const counts = manifest.batches.reduce((total, batch) => ({
        batches: total.batches + 1,
        messages: total.messages + batch.messageCount,
        errors: total.errors + batch.errorCount,
        notifications: total.notifications + batch.notificationCount,
    }), { batches: 0, messages: 0, errors: 0, notifications: 0 })

    return {
        version: NEWSLETTER_RETENTION_ESCROW_VERSION,
        siteId: manifest.siteId,
        cutoff: manifest.cutoff,
        policyVersion: manifest.policyVersion,
        publicManifestHash: manifest.hash,
        schemaFingerprint: 'a'.repeat(64),
        contentHash: 'b'.repeat(64),
        counts,
    }
}

function createFixture(): Fixture {
    const manifest = buildNewsletterRetentionManifest({
        siteId: 'tenant-a',
        cutoff: '2026-08-27T12:00:00.000Z',
        batches: [
            {
                batchId: 'batch-two',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 2,
                notificationCount: 1,
                errorCount: 0,
            },
            {
                batchId: 'batch-one',
                createdAt: '2026-08-27T10:00:00.000Z',
                messageCount: 1,
                notificationCount: 2,
                errorCount: 0,
            },
        ],
    })

    const records = [
        {
            siteId: 'tenant-a',
            batchRecordId: 'row-one',
            batchId: 'batch-one',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 1,
            notificationCount: 2,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        },
        {
            siteId: 'tenant-a',
            batchRecordId: 'row-two',
            batchId: 'batch-two',
            createdAt: '2026-08-27T11:00:00.000Z',
            messageCount: 2,
            notificationCount: 1,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        },
    ]

    return { manifest, escrow: createEscrowCommitment(manifest), records }
}

describe('service/newsletter-retention-apply', () => {
    it('parses an apply context only when policy, evidence, manifest, and artifact are bound exactly', () => {
        const { manifest, escrow, records } = createFixture()
        const artifact = buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records,
        })

        const context = parseNewsletterRetentionApplyContext({
            policy: {
                siteId: 'tenant-a',
                cutoff: '2026-08-27T12:00:00.000Z',
                apply: true,
                maxBatches: 2,
                maxMessages: 3,
            },
            evidence: {
                now: '2026-08-27T12:05:00.000Z',
                backup: {
                    verifiedAt: '2026-08-27T11:00:00.000Z',
                    restoredAt: '2026-08-27T11:05:00.000Z',
                },
                restore: {
                    verifiedAt: '2026-08-27T11:10:00.000Z',
                    restoredAt: '2026-08-27T11:15:00.000Z',
                },
                health: {
                    queueCheckedAt: '2026-08-27T12:00:00.000Z',
                    proxyCheckedAt: '2026-08-27T12:01:00.000Z',
                    queueHealthy: true,
                    proxyHealthy: true,
                },
            },
            manifest,
            artifact,
        })

        expect(context.policy.siteId).toBe('tenant-a')
        expect(context.manifest.hash).toBe(manifest.hash)
        expect(context.artifact).toEqual(artifact)
    })

    it('builds a private apply artifact with exact index-to-ID bindings and validates its own hash', () => {
        const { manifest, escrow, records } = createFixture()

        const artifact = buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records,
        })

        expect(artifact.version).toBe(NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION)
        expect(artifact.siteId).toBe('tenant-a')
        expect(artifact.publicManifestHash).toBe(manifest.hash)
        expect(artifact.escrow).toEqual(escrow)
        expect(artifact.bindings).toEqual([
            {
                manifestIndex: 0,
                batchRecordId: 'row-one',
            },
            {
                manifestIndex: 1,
                batchRecordId: 'row-two',
            },
        ] as NewsletterRetentionManifestApplyBinding[])

        const parsed = parseNewsletterRetentionApplyArtifact(artifact)
        expect(parsed).toEqual(artifact)
    })

    it('rejects escrow commitment drift and binds it into the artifact hash', () => {
        const { manifest, escrow, records } = createFixture()

        for (const drifted of [
            { ...escrow, siteId: 'tenant-b' },
            { ...escrow, cutoff: '2026-08-27T11:59:59.999Z' },
            { ...escrow, policyVersion: escrow.policyVersion + 1 },
            { ...escrow, publicManifestHash: '0'.repeat(64) },
            { ...escrow, counts: { ...escrow.counts, messages: escrow.counts.messages + 1 } },
        ]) {
            expect(() => buildNewsletterRetentionApplyArtifact({
                manifest,
                escrow: drifted,
                records,
            })).toThrow()
        }

        const artifact = buildNewsletterRetentionApplyArtifact({ manifest, escrow, records })
        expect(() => parseNewsletterRetentionApplyArtifact({
            ...artifact,
            escrow: { ...artifact.escrow, contentHash: 'c'.repeat(64) },
        })).toThrow('apply artifact hash mismatch')
        expect(() => parseNewsletterRetentionApplyArtifact({
            ...artifact,
            version: 1,
        })).toThrow('apply artifact version is unsupported')
    })

    it('rejects cross-tenant replay by requiring matching private record tenant scope', () => {
        const { manifest, escrow, records } = createFixture()

        const foreignRecords = records.map((record) => ({
            ...record,
            siteId: 'tenant-b',
        }))

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: foreignRecords,
        })).toThrow('private record tenant scope must match manifest siteId')
    })

    it('rejects public manifest hash mismatch and malformed public manifest order', () => {
        const { manifest, escrow, records } = createFixture()

        const tamperedManifest = {
            ...manifest,
            cutoff: '2026-08-27T11:59:59.999Z',
        }

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest: tamperedManifest,
            escrow,
            records,
        })).toThrow('public manifest hash mismatch')
    })

    it('rejects malformed public manifest batches', () => {
        const { manifest, escrow, records } = createFixture()

        const malformedBatches: Array<unknown> = [
            null,
            {},
            '[]',
        ]

        for (const batches of malformedBatches) {
            expect(() => buildNewsletterRetentionApplyArtifact({
                manifest: {
                    ...manifest,
                    batches,
                } as never,
                escrow,
                records,
            })).toThrow('public manifest batches must be an array')
        }
    })

    it('rejects reordered, missing, and extra private records', () => {
        const { manifest, escrow, records } = createFixture()

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: [records[1], records[0]],
        })).toThrow('private record batchId does not match public manifest')

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: records.slice(0, 1),
        })).toThrow('private record count must match manifest batch count')

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: [...records, {
                siteId: 'tenant-a',
                batchRecordId: 'row-extra',
                batchId: 'batch-one',
                createdAt: '2026-08-27T10:00:00.000Z',
                messageCount: 1,
                notificationCount: 2,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('private record count must match manifest batch count')
    })

    it('rejects duplicate private record IDs and whitespace-normalized private IDs', () => {
        const { manifest, escrow, records } = createFixture()

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: [
                { ...records[0], batchRecordId: 'row-dup' },
                { ...records[1], batchRecordId: 'row-dup' },
            ],
        })).toThrow('private batchRecordIds must be unique')

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: [
                { ...records[0], batchRecordId: 'row-one' },
                { ...records[1], batchRecordId: 'row-two ' },
            ],
        })).toThrow('private batchRecordId must be a non-empty string')
    })

    it('rejects tampered private artifact hashes and binding index corruption', () => {
        const { manifest, escrow, records } = createFixture()

        const artifact = buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records,
        })

        expect(() => parseNewsletterRetentionApplyArtifact({
            ...artifact,
            hash: '0'.repeat(64),
        })).toThrow('apply artifact hash mismatch')

        expect(() => parseNewsletterRetentionApplyArtifact({
            ...artifact,
            bindings: [
                {
                    manifestIndex: 1,
                    batchRecordId: artifact.bindings[0].batchRecordId,
                },
                artifact.bindings[1],
            ],
        } as never)).toThrow('apply artifact binding indexes must be sequential from 0')
    })

    it('rejects private records with orphans or incomplete correlation', () => {
        const { manifest, escrow, records } = createFixture()

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: [
                {
                    ...records[0],
                    orphanCount: 1,
                },
                records[1],
            ],
        })).toThrow('private record orphanCount must be 0')

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow,
            records: [
                {
                    ...records[0],
                    correlationComplete: false,
                },
                records[1],
            ],
        })).toThrow('private record correlation must be complete')
    })

    it('rejects canonical manifest and private createdAt timestamps that are not strictly before cutoff', () => {
        const manifest = buildNewsletterRetentionManifest({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            batches: [
                {
                    batchId: 'batch-two',
                    createdAt: '2026-08-27T12:00:00.000Z',
                    messageCount: 2,
                    notificationCount: 1,
                    errorCount: 0,
                },
                {
                    batchId: 'batch-one',
                    createdAt: '2026-08-27T13:00:00.000Z',
                    messageCount: 1,
                    notificationCount: 2,
                    errorCount: 0,
                },
            ],
        })

        expect(() => buildNewsletterRetentionApplyArtifact({
            manifest,
            escrow: createEscrowCommitment(manifest),
            records: [
                {
                    siteId: 'tenant-a',
                    batchRecordId: 'row-two',
                    batchId: 'batch-two',
                    createdAt: '2026-08-27T12:00:00.000Z',
                    messageCount: 2,
                    notificationCount: 1,
                    errorCount: 0,
                    orphanCount: 0,
                    correlationComplete: true,
                },
                {
                    siteId: 'tenant-a',
                    batchRecordId: 'row-one',
                    batchId: 'batch-one',
                    createdAt: '2026-08-27T13:00:00.000Z',
                    messageCount: 1,
                    notificationCount: 2,
                    errorCount: 0,
                    orphanCount: 0,
                    correlationComplete: true,
                },
            ],
        })).toThrow('canonical manifest batch createdAt must be before cutoff')
    })

    it('binds records successfully when createdAt order conflicts with batchId order', () => {
        const manifest = buildNewsletterRetentionManifest({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            batches: [
                { batchId: 'a-later', createdAt: '2026-08-27T11:00:00.000Z', messageCount: 1, notificationCount: 0, errorCount: 0 },
                { batchId: 'z-earlier', createdAt: '2026-08-27T10:00:00.000Z', messageCount: 1, notificationCount: 0, errorCount: 0 },
            ],
        })
        const records = [
            {
                siteId: 'tenant-a',
                batchRecordId: 'row-earlier',
                batchId: 'z-earlier',
                createdAt: '2026-08-27T10:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
            {
                siteId: 'tenant-a',
                batchRecordId: 'row-later',
                batchId: 'a-later',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
        ]

        expect(buildNewsletterRetentionApplyArtifact({ manifest, escrow: createEscrowCommitment(manifest), records }).bindings).toEqual([
            { manifestIndex: 0, batchRecordId: 'row-earlier' },
            { manifestIndex: 1, batchRecordId: 'row-later' },
        ])
    })

    it('does not leak private batchRecordIds in public dry-run manifests', () => {
        const { manifest } = createFixture()

        const serialized = JSON.stringify(manifest)

        expect(serialized).not.toContain('batchRecordId')
        expect(serialized).not.toContain('rowId')
    })
})
