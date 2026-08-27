import { describe, expect, it } from 'vitest'

import { NEWSLETTER_RETENTION_POLICY_VERSION } from '@/service/newsletter-retention'
import { createProcessLocalAntiOverlapLock } from '@/service/newsletter-retention-plan'
import { buildNewsletterRetentionDryRunResult } from '@/service/newsletter-retention-coordinator'

describe('service/newsletter-retention-coordinator', () => {
    const policyInput = {
        siteId: 'tenant-a',
        cutoff: '2026-08-27T12:00:00.000Z',
        maxBatches: 3,
        maxMessages: 20,
    }

    const evidenceInput = {
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
    }

    const candidates = [
        {
            siteId: 'tenant-a',
            batchId: 'batch-b',
            createdAt: '2026-08-27T11:59:59.999Z',
            messageCount: 5,
            notificationCount: 2,
            errorCount: 1,
            orphanCount: 0,
            correlationComplete: true,
            email: 'recipient-b@example.test',
            rawEvent: '{"eventType":"Delivery"}',
            secret: 'do-not-leak',
        },
        {
            siteId: 'tenant-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T11:00:00.000Z',
            messageCount: 3,
            notificationCount: 1,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
            email: 'recipient-a@example.test',
            contents: 'still-do-not-leak',
        },
    ]

    it('builds a dry-run-only coordinator result with a safe plan and manifest', async () => {
        const result = await buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })

        expect(result).toEqual({
            dryRun: true,
            policyVersion: NEWSLETTER_RETENTION_POLICY_VERSION,
            plan: {
                siteId: 'tenant-a',
                cutoff: '2026-08-27T12:00:00.000Z',
                batchCount: 2,
                totals: {
                    messageCount: 8,
                    notificationCount: 3,
                    errorCount: 1,
                },
                batches: [
                    {
                        batchId: 'batch-a',
                        createdAt: '2026-08-27T11:00:00.000Z',
                        messageCount: 3,
                        notificationCount: 1,
                        errorCount: 0,
                    },
                    {
                        batchId: 'batch-b',
                        createdAt: '2026-08-27T11:59:59.999Z',
                        messageCount: 5,
                        notificationCount: 2,
                        errorCount: 1,
                    },
                ],
            },
            manifest: {
                cutoff: '2026-08-27T12:00:00.000Z',
                policyVersion: NEWSLETTER_RETENTION_POLICY_VERSION,
                batches: [
                    {
                        batchId: 'batch-a',
                        createdAt: '2026-08-27T11:00:00.000Z',
                        messageCount: 3,
                        notificationCount: 1,
                        errorCount: 0,
                    },
                    {
                        batchId: 'batch-b',
                        createdAt: '2026-08-27T11:59:59.999Z',
                        messageCount: 5,
                        notificationCount: 2,
                        errorCount: 1,
                    },
                ],
                hash: '0376629b2ae0472643807a25404ecfecf7312b4138056fc7ed3647810e93867e',
            },
        })

        const serialized = JSON.stringify(result)
        for (const forbidden of [
            'queueHealthy',
            'proxyCheckedAt',
            'backup',
            'restore',
            'email',
            'rawEvent',
            'secret',
            'contents',
        ]) {
            expect(serialized).not.toContain(forbidden)
        }
    })

    it('defaults to dry-run and rejects apply mode unconditionally', async () => {
        const dryRunResult = await buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })

        expect(dryRunResult.dryRun).toBe(true)
        expect(dryRunResult.policyVersion).toBe(NEWSLETTER_RETENTION_POLICY_VERSION)

        await expect(buildNewsletterRetentionDryRunResult({
            policy: {
                ...policyInput,
                apply: true,
            },
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })).rejects.toThrow('apply is not enabled')
    })

    it('rejects apply mode even when a caller supplies a forged pre-normalized policy', async () => {
        await expect(buildNewsletterRetentionDryRunResult({
            policy: {
                ...policyInput,
                dryRun: true,
                policyVersion: NEWSLETTER_RETENTION_POLICY_VERSION,
                apply: true,
            } as unknown as typeof policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })).rejects.toThrow('apply is not enabled')
    })

    it('fails closed when DLQ evidence is unhealthy even if proxy evidence is healthy', async () => {
        await expect(buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: false,
            candidates,
        })).rejects.toThrow('queue or DLQ evidence must be healthy')
    })

    it('fails closed when the tenant lock is already held and releases the lock after execution', async () => {
        const heldLock = createProcessLocalAntiOverlapLock('tenant-a')
        expect(heldLock.tryAcquire()).toBe(true)

        await expect(buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })).rejects.toThrow('anti-overlap lock "tenant-a" is already held')

        expect(heldLock.isHeld()).toBe(true)
        expect(heldLock.release()).toBe(true)

        const result = await buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })

        expect(result.plan.batchCount).toBe(2)
    })

    it('releases the tenant lock even when planning fails', async () => {
        const probeCandidate = [{
            ...candidates[0],
            createdAt: policyInput.cutoff,
        }]

        await expect(buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: probeCandidate,
        })).rejects.toThrow('candidate batch createdAt must be strictly before the retention cutoff')

        const probeLock = createProcessLocalAntiOverlapLock('tenant-a')
        expect(probeLock.tryAcquire()).toBe(true)
        expect(probeLock.release()).toBe(true)
    })

    it('does not leak raw evidence or recipient fields into the returned payload', async () => {
        const result = await buildNewsletterRetentionDryRunResult({
            policy: policyInput,
            evidence: evidenceInput,
            queueHealthy: true,
            dlqHealthy: true,
            candidates,
        })

        const serialized = JSON.stringify(result)
        for (const forbidden of [
            'now',
            'backup',
            'restore',
            'health',
            'recipient-a@example.test',
            'recipient-b@example.test',
            'do-not-leak',
            'still-do-not-leak',
        ]) {
            expect(serialized).not.toContain(forbidden)
        }
    })
})
