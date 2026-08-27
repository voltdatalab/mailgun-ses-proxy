import { describe, expect, it } from 'vitest'

import { parseNewsletterRetentionEvidence, parseNewsletterRetentionPolicy } from '@/service/newsletter-retention'
import {
    createProcessLocalAntiOverlapLock,
    buildNewsletterRetentionSelectionPlan,
    withProcessLocalAntiOverlapLock,
} from '@/service/newsletter-retention-plan'

describe('service/newsletter-retention-plan', () => {
    it('builds a tenant-scoped, cutoff-bounded, deterministically ordered selection plan with only safe batch summaries', () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 3,
            maxMessages: 20,
        })
        const evidence = parseNewsletterRetentionEvidence({
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
        })

        const plan = buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [
                {
                    siteId: 'tenant-a',
                    batchId: 'batch-b',
                    createdAt: '2026-08-27T11:59:59.999Z',
                    messageCount: 5,
                    notificationCount: 2,
                    errorCount: 1,
                    orphanCount: 0,
                    correlationComplete: true,
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
                },
            ],
        })

        expect(plan).toEqual({
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
        })

        const serialized = JSON.stringify(plan)
        for (const forbidden of [
            'orphanCount',
            'correlationComplete',
            'queueHealthy',
            'dlqHealthy',
            'tenant-a',
        ]) {
            if (forbidden === 'tenant-a') continue
            expect(serialized).not.toContain(forbidden)
        }
        expect(serialized).toContain('tenant-a')
        expect(serialized).not.toContain('proxyCheckedAt')
    })

    it('rejects batches that are unscoped, post-cutoff, incomplete, or orphaned before producing a plan', () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 3,
            maxMessages: 20,
        })
        const evidence = parseNewsletterRetentionEvidence({
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
        })

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-b',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:59:59.999Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('candidate batch tenant scope must exactly match policy siteId')

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-post-cutoff',
                createdAt: '2026-08-27T12:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('candidate batch createdAt must be strictly before the retention cutoff')

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-incomplete',
                createdAt: '2026-08-27T11:59:59.999Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: false,
            }],
        })).toThrow('candidate batch correlation must be complete')

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-orphaned',
                createdAt: '2026-08-27T11:59:59.999Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 1,
                correlationComplete: true,
            }],
        })).toThrow('candidate batch orphanCount must be zero')
    })

    it('stops when queue evidence is unhealthy, DLQ evidence is unhealthy, or caps are exceeded', () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 3,
        })
        const evidence = parseNewsletterRetentionEvidence({
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
        })

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: false,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('queue or DLQ evidence must be healthy')

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: false,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('queue or DLQ evidence must be healthy')

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [
                {
                    siteId: 'tenant-a',
                    batchId: 'batch-a',
                    createdAt: '2026-08-27T11:00:00.000Z',
                    messageCount: 2,
                    notificationCount: 0,
                    errorCount: 0,
                    orphanCount: 0,
                    correlationComplete: true,
                },
                {
                    siteId: 'tenant-a',
                    batchId: 'batch-b',
                    createdAt: '2026-08-27T11:10:00.000Z',
                    messageCount: 2,
                    notificationCount: 0,
                    errorCount: 0,
                    orphanCount: 0,
                    correlationComplete: true,
                },
            ],
        })).toThrow('selected batch count exceeds the hard batch cap')

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 4,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('selected message count exceeds the hard message cap')
    })

    it('fails closed on unhealthy evidence before validating candidates', () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        expect(() => buildNewsletterRetentionSelectionPlan({
            policy,
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
                    proxyHealthy: false,
                },
            } as never,
            queueHealthy: true,
            dlqHealthy: true,
            candidates: [{
                siteId: 'tenant-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            }],
        })).toThrow('health evidence must be healthy')
    })

    it('prevents overlap across lock instances and releases the lock in a finally helper', async () => {
        const lockA = createProcessLocalAntiOverlapLock('newsletter-retention:test')
        const lockB = createProcessLocalAntiOverlapLock('newsletter-retention:test')

        expect(lockA.tryAcquire()).toBe(true)
        expect(lockB.tryAcquire()).toBe(false)
        expect(lockB.release()).toBe(false)

        const lockC = createProcessLocalAntiOverlapLock('newsletter-retention:test')
        expect(lockC.tryAcquire()).toBe(false)
        expect(lockA.isHeld()).toBe(true)

        expect(lockA.release()).toBe(true)
        expect(lockB.tryAcquire()).toBe(true)
        expect(lockA.release()).toBe(false)
        expect(lockB.release()).toBe(true)

        await expect(withProcessLocalAntiOverlapLock(lockA, async () => {
            expect(lockA.isHeld()).toBe(true)
            throw new Error('boom')
        })).rejects.toThrow('boom')

        expect(lockA.isHeld()).toBe(false)
        expect(lockA.tryAcquire()).toBe(true)
        lockA.release()
    })
})
