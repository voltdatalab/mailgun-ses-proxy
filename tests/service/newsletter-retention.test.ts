import { describe, expect, it } from 'vitest'

import {
    NEWSLETTER_RETENTION_MAX_BATCH_LIMIT,
    NEWSLETTER_RETENTION_POLICY_VERSION,
    buildNewsletterRetentionManifest,
    parseNewsletterRetentionEvidence,
    parseNewsletterRetentionPolicy,
} from '@/service/newsletter-retention'

describe('service/newsletter-retention', () => {
    it('parses strict UTC cutoff values and defaults to dry-run', () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'poligono',
            cutoff: '2026-08-27T12:34:56.789Z',
            apply: false,
        })

        expect(policy).toEqual({
            siteId: 'poligono',
            cutoff: '2026-08-27T12:34:56.789Z',
            dryRun: true,
            maxBatches: 10,
            maxMessages: 1000,
            policyVersion: NEWSLETTER_RETENTION_POLICY_VERSION,
        })

        expect(parseNewsletterRetentionPolicy({
            siteId: 'poligono',
            cutoff: '2026-08-27T12:34:56.789Z',
            apply: true,
        }).dryRun).toBe(false)
    })

    it('rejects non byte-exact siteId values in retention policy parser', () => {
        expect(() => parseNewsletterRetentionPolicy({
            siteId: '  poligono',
            cutoff: '2026-08-27T12:34:56.789Z',
            apply: false,
        })).toThrow('siteId must be a non-empty string')

        expect(() => parseNewsletterRetentionPolicy({
            siteId: 'poligono  ',
            cutoff: '2026-08-27T12:34:56.789Z',
            apply: false,
        })).toThrow('siteId must be a non-empty string')

        expect(() => parseNewsletterRetentionPolicy({
            siteId: '   ',
            cutoff: '2026-08-27T12:34:56.789Z',
            apply: false,
        })).toThrow('siteId must be a non-empty string')
    })

    it('rejects blank site ids and non-UTC cutoff strings', () => {
        expect(() => parseNewsletterRetentionPolicy({ siteId: 'site-a', cutoff: '2026-08-27T00:00:00-03:00' }))
            .toThrow('cutoff must be a strict UTC ISO-8601 string')
        expect(() => parseNewsletterRetentionPolicy({ siteId: 'site-a', cutoff: 'not-a-date' }))
            .toThrow('cutoff must be a strict UTC ISO-8601 string')
        expect(() => parseNewsletterRetentionPolicy({
            siteId: 'site-a',
            cutoff: '2026-08-27T00:00:00.000Z',
            maxBatches: 2.9,
        })).toThrow('maxBatches must be a positive integer')
        expect(() => parseNewsletterRetentionPolicy({
            siteId: 'site-a',
            cutoff: '2026-08-27T00:00:00.000Z',
            maxBatches: '5' as unknown as number,
        })).toThrow('maxBatches must be a positive integer')
        expect(() => parseNewsletterRetentionPolicy({
            siteId: 'site-a',
            cutoff: '2026-08-27T00:00:00.000Z',
            maxBatches: NEWSLETTER_RETENTION_MAX_BATCH_LIMIT + 1,
        })).toThrow(`maxBatches must not exceed ${NEWSLETTER_RETENTION_MAX_BATCH_LIMIT}`)
    })

    it('validates fresh plain backup, restore, and health evidence', () => {
        const evidence = parseNewsletterRetentionEvidence({
            now: '2026-08-27T12:00:00.000Z',
            backup: {
                verifiedAt: '2026-08-27T08:00:00.000Z',
                restoredAt: '2026-08-27T08:05:00.000Z',
            },
            restore: {
                verifiedAt: '2026-08-27T10:00:00.000Z',
                restoredAt: '2026-08-27T10:03:00.000Z',
            },
            health: {
                queueCheckedAt: '2026-08-27T11:50:00.000Z',
                proxyCheckedAt: '2026-08-27T11:51:00.000Z',
                queueHealthy: true,
                proxyHealthy: true,
            },
        })

        expect(evidence).toEqual({
            now: '2026-08-27T12:00:00.000Z',
            backup: {
                verifiedAt: '2026-08-27T08:00:00.000Z',
                restoredAt: '2026-08-27T08:05:00.000Z',
            },
            restore: {
                verifiedAt: '2026-08-27T10:00:00.000Z',
                restoredAt: '2026-08-27T10:03:00.000Z',
            },
            health: {
                queueCheckedAt: '2026-08-27T11:50:00.000Z',
                proxyCheckedAt: '2026-08-27T11:51:00.000Z',
                queueHealthy: true,
                proxyHealthy: true,
            },
        })
    })

    it('refuses stale or unhealthy evidence', () => {
        expect(() => parseNewsletterRetentionEvidence({
            now: '2026-08-27T12:00:00.000Z',
            backup: {
                verifiedAt: '2026-08-25T11:59:59.999Z',
                restoredAt: '2026-08-25T12:00:00.000Z',
            },
            restore: {
                verifiedAt: '2026-08-27T10:00:00.000Z',
                restoredAt: '2026-08-27T10:03:00.000Z',
            },
            health: {
                queueCheckedAt: '2026-08-27T11:50:00.000Z',
                proxyCheckedAt: '2026-08-27T11:51:00.000Z',
                queueHealthy: true,
                proxyHealthy: true,
            },
        })).toThrow('backup evidence is stale')

        expect(() => parseNewsletterRetentionEvidence({
            now: '2026-08-27T12:00:00.000Z',
            backup: {
                verifiedAt: '2026-08-27T08:00:00.000Z',
                restoredAt: '2026-08-27T08:05:00.000Z',
            },
            restore: {
                verifiedAt: '2026-08-27T10:00:00.000Z',
                restoredAt: '2026-08-27T10:03:00.000Z',
            },
            health: {
                queueCheckedAt: '2026-08-27T11:50:00.000Z',
                proxyCheckedAt: '2026-08-27T11:51:00.000Z',
                queueHealthy: true,
                proxyHealthy: false,
            },
        })).toThrow('health evidence must be healthy')

        expect(() => parseNewsletterRetentionEvidence({
            now: '2026-08-27T12:00:00.000Z',
            backup: { verifiedAt: '2026-08-27T11:59:59.999Z', restoredAt: '2026-08-27T11:59:59.999Z' },
            restore: { verifiedAt: '2026-08-27T11:59:59.999Z', restoredAt: '2026-08-27T11:59:59.999Z' },
            health: { queueCheckedAt: '2026-08-27T11:59:59.999Z', proxyCheckedAt: '2026-08-27T11:59:59.999Z', queueHealthy: 'true' as unknown as boolean, proxyHealthy: true },
        })).toThrow('health evidence must be healthy')

        expect(() => parseNewsletterRetentionEvidence({
            now: '2026-08-27T12:00:00.000Z',
            backup: {
                verifiedAt: '2026-08-25T11:59:59.999Z',
                restoredAt: '2026-08-27T11:59:59.999Z',
            },
            restore: {
                verifiedAt: '2026-08-27T11:59:59.999Z',
                restoredAt: '2026-08-27T11:59:59.999Z',
            },
            health: {
                queueCheckedAt: '2026-08-27T11:40:00.000Z',
                proxyCheckedAt: '2026-08-27T11:59:59.999Z',
                queueHealthy: true,
                proxyHealthy: true,
            },
        })).toThrow('backup evidence is stale')
    })

    it('builds a canonical manifest with sorted batches, sanitized fields, and a deterministic SHA-256 hash', () => {
        const manifest = buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            policyVersion: NEWSLETTER_RETENTION_POLICY_VERSION,
            batches: [
                {
                    batchId: 'batch-b',
                    createdAt: '2026-08-25T09:00:00.000Z',
                    messageCount: 5,
                    notificationCount: 2,
                    errorCount: 1,
                    email: 'recipient-b@example.test',
                    rawEvent: '{"eventType":"Delivery"}',
                    contents: 'secret contents',
                },
                {
                    batchId: 'batch-a',
                    createdAt: '2026-08-24T09:00:00.000Z',
                    messageCount: 9,
                    notificationCount: 4,
                    errorCount: 0,
                    recipient: 'recipient-a@example.test',
                    dsn: 'dsn-secret',
                    message: 'do not keep',
                },
            ],
        })

        expect(manifest.policyVersion).toBe(NEWSLETTER_RETENTION_POLICY_VERSION)
        expect(manifest.cutoff).toBe('2026-08-27T00:00:00.000Z')
        expect(manifest.batches).toEqual([
            {
                batchId: 'batch-a',
                createdAt: '2026-08-24T09:00:00.000Z',
                errorCount: 0,
                messageCount: 9,
                notificationCount: 4,
            },
            {
                batchId: 'batch-b',
                createdAt: '2026-08-25T09:00:00.000Z',
                errorCount: 1,
                messageCount: 5,
                notificationCount: 2,
            },
        ])

        const serialized = JSON.stringify(manifest)
        for (const forbidden of [
            'recipient-a@example.test',
            'recipient-b@example.test',
            'secret contents',
            'dsn-secret',
            'rawEvent',
            'email',
            'recipient',
        ]) {
            expect(serialized).not.toContain(forbidden)
        }

        expect(manifest.hash).toBe('86e5e280b85fd96335788ac4c2b8f9093cee016c901e1aa0bf795c0108d2cc18')
        expect(manifest.hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('rejects malformed manifest containers and array-shaped batches', () => {
        expect(() => buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: {} as unknown as [],
        })).toThrow('manifest input must be a plain object with batches')
        expect(() => buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [[] as unknown as never],
        })).toThrow('manifest batch must be a plain object')
    })

    it('uses a total canonical batch order when IDs and timestamps tie', () => {
        const input = {
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [
                { batchId: 'same', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 2, notificationCount: 0, errorCount: 0 },
                { batchId: 'same', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 1, notificationCount: 1, errorCount: 0 },
            ],
        }
        const reversed = { ...input, batches: [...input.batches].reverse() }

        expect(buildNewsletterRetentionManifest(input)).toEqual(buildNewsletterRetentionManifest(reversed))
    })

    it('uses deterministic manifest sorting and hash behavior when batch IDs differ only by trailing space', () => {
        const manifest = buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [
                { batchId: 'batch-1 ', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 1, notificationCount: 0, errorCount: 0 },
                { batchId: 'batch-1', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 2, notificationCount: 0, errorCount: 0 },
            ],
        })

        expect(manifest.batches.map((batch) => batch.batchId)).toEqual(['batch-1', 'batch-1 '])

        const manifestEquivalentWithoutTrailing = buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [
                { batchId: 'batch-1', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 2, notificationCount: 0, errorCount: 0 },
                { batchId: 'batch-1', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 1, notificationCount: 0, errorCount: 0 },
            ],
        })

        expect(manifest.hash).not.toBe(manifestEquivalentWithoutTrailing.hash)
    })

    it('rejects fractional and unsafe manifest counts instead of rewriting them', () => {
        expect(() => buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [{
                batchId: 'batch-a',
                createdAt: '2026-08-24T09:00:00.000Z',
                messageCount: 1.9,
                notificationCount: 0,
                errorCount: 0,
            }],
        })).toThrow('messageCount must be a non-negative safe integer')

        expect(() => buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [{
                batchId: 'batch-a',
                createdAt: '2026-08-24T09:00:00.000Z',
                messageCount: Number.MAX_SAFE_INTEGER + 1,
                notificationCount: 0,
                errorCount: 0,
            }],
        })).toThrow('messageCount must be a non-negative safe integer')
    })

    it('rejects malformed manifest siteId values and whitespace-only variants', () => {
        expect(() => buildNewsletterRetentionManifest({
            siteId: '  poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [],
        })).toThrow('siteId must be a non-empty string')

        expect(() => buildNewsletterRetentionManifest({
            siteId: 'poligono ',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [],
        })).toThrow('siteId must be a non-empty string')

        expect(() => buildNewsletterRetentionManifest({
            siteId: '   ',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [],
        })).toThrow('siteId must be a non-empty string')
    })

    it('uses createdAt before batchId in the canonical end-to-end order', () => {
        const manifest = buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            batches: [
                { batchId: 'a-later', createdAt: '2026-08-25T09:00:00.000Z', messageCount: 1, notificationCount: 0, errorCount: 0 },
                { batchId: 'z-earlier', createdAt: '2026-08-24T09:00:00.000Z', messageCount: 1, notificationCount: 0, errorCount: 0 },
            ],
        })

        expect(manifest.batches.map((batch) => batch.batchId)).toEqual(['z-earlier', 'a-later'])
    })

    it('rejects unsafe policy versions at manifest construction', () => {
        expect(() => buildNewsletterRetentionManifest({
            siteId: 'poligono',
            cutoff: '2026-08-27T00:00:00.000Z',
            policyVersion: Number.MAX_SAFE_INTEGER + 1,
            batches: [],
        })).toThrow('policyVersion must be a positive safe integer')
    })
})
