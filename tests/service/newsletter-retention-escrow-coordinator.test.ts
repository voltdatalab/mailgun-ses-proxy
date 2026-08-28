import { describe, expect, it, vi } from 'vitest'

import { createNewsletterRetentionEscrowAccumulator } from '@/service/newsletter-retention-escrow'
import type { NewsletterRetentionEscrowLoaderDelegate } from '@/service/newsletter-retention-escrow-loader'
import type { NewsletterRetentionCandidateLoaderRecord } from '@/service/newsletter-retention-candidate-loader'
import {
    buildNewsletterRetentionEscrowDryRunResult,
    type NewsletterRetentionEscrowDryRunCoordinatorInput,
} from '@/service/newsletter-retention-coordinator'
import { createProcessLocalAntiOverlapLock } from '@/service/newsletter-retention-plan'

const POLICY = {
    siteId: 'tenant-a',
    cutoff: '2026-08-27T12:00:00.000Z',
    maxBatches: 3,
    maxMessages: 20,
}

const EVIDENCE = {
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

const CANDIDATE: NewsletterRetentionCandidateLoaderRecord = {
    siteId: 'tenant-a',
    batchRecordId: 'private-batch-row',
    batchId: 'public-batch-id',
    createdAt: '2026-08-27T10:00:00.000Z',
    messageCount: 0,
    notificationCount: 0,
    errorCount: 0,
    orphanCount: 0,
    correlationComplete: true,
}

function makeDelegate(parent: unknown = {
    id: 'private-batch-row',
    siteId: 'tenant-a',
    fromEmail: 'news@example.test',
    contents: '',
    batchId: 'public-batch-id',
    created: new Date('2026-08-27T10:00:00.000Z'),
}): {
    delegate: NewsletterRetentionEscrowLoaderDelegate
    parentFindFirst: ReturnType<typeof vi.fn>
    messageFindMany: ReturnType<typeof vi.fn>
    errorFindMany: ReturnType<typeof vi.fn>
    notificationFindMany: ReturnType<typeof vi.fn>
    orphanCount: ReturnType<typeof vi.fn>
} {
    const parentFindFirst = vi.fn().mockResolvedValue(parent)
    const messageFindMany = vi.fn().mockResolvedValue([])
    const errorFindMany = vi.fn().mockResolvedValue([])
    const notificationFindMany = vi.fn().mockResolvedValue([])
    const orphanCount = vi.fn().mockResolvedValue(0)
    return {
        delegate: {
            newsletterBatch: { findFirst: parentFindFirst },
            newsletterMessages: { findMany: messageFindMany },
            newsletterErrors: { findMany: errorFindMany },
            newsletterNotifications: { findMany: notificationFindMany },
            newsletterNotificationOrphan: { count: orphanCount },
        },
        parentFindFirst,
        messageFindMany,
        errorFindMany,
        notificationFindMany,
        orphanCount,
    }
}

function makeInput(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    chunks: Uint8Array[],
    overrides: Partial<NewsletterRetentionEscrowDryRunCoordinatorInput> = {},
): NewsletterRetentionEscrowDryRunCoordinatorInput {
    return {
        policy: POLICY,
        evidence: EVIDENCE,
        queueHealthy: true,
        dlqHealthy: true,
        candidates: [CANDIDATE],
        delegate,
        schemaFingerprint: 'c'.repeat(64),
        writeChunk: (chunk) => {
            chunks.push(chunk.slice())
        },
        ...overrides,
    }
}

function decodeLines(chunks: Uint8Array[]): string[] {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return chunks.map((chunk) => decoder.decode(chunk).slice(0, -1))
}

describe('service/newsletter-retention escrow dry-run coordinator', () => {
    it('binds the exact snapshot to the public manifest under one tenant lock', async () => {
        const chunks: Uint8Array[] = []
        const {
            delegate,
            parentFindFirst,
            messageFindMany,
            errorFindMany,
            notificationFindMany,
            orphanCount,
        } = makeDelegate()

        const result = await buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, chunks))

        expect(result.dryRun).toBe(true)
        expect(result.plan.batchCount).toBe(1)
        expect(result.manifest.batches).toEqual([{
            batchId: 'public-batch-id',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
        }])
        expect(result.escrow).toMatchObject({
            siteId: 'tenant-a',
            cutoff: POLICY.cutoff,
            publicManifestHash: result.manifest.hash,
            schemaFingerprint: 'c'.repeat(64),
            counts: { batches: 1, messages: 0, errors: 0, notifications: 0 },
        })
        expect(JSON.stringify(result)).not.toContain('private-batch-row')
        expect(JSON.stringify(result)).not.toContain('news@example.test')

        expect(parentFindFirst).toHaveBeenCalledOnce()
        expect(messageFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
        expect(errorFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
        expect(notificationFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()

        const lines = decodeLines(chunks)
        expect(lines).toHaveLength(3)
        const header = JSON.parse(lines[0]) as Record<string, unknown>
        expect(header).toMatchObject({
            kind: 'header',
            siteId: 'tenant-a',
            cutoff: POLICY.cutoff,
            publicManifestHash: result.manifest.hash,
            schemaFingerprint: 'c'.repeat(64),
        })

        const verifier = createNewsletterRetentionEscrowAccumulator()
        for (const line of lines) {
            verifier.consume(line)
        }
        expect(verifier.finalize()).toEqual(result.escrow)
    })

    it('is stable when tied public candidates arrive in reversed private order', async () => {
        const tiedCandidates: NewsletterRetentionCandidateLoaderRecord[] = [
            { ...CANDIDATE, batchRecordId: 'private-row-b' },
            { ...CANDIDATE, batchRecordId: 'private-row-a' },
        ]
        const parentFindFirst = vi.fn().mockImplementation(async (args: { where: { id: string } }) => ({
            id: args.where.id,
            siteId: 'tenant-a',
            fromEmail: 'news@example.test',
            contents: '',
            batchId: 'public-batch-id',
            created: new Date('2026-08-27T10:00:00.000Z'),
        }))
        const delegate: NewsletterRetentionEscrowLoaderDelegate = {
            newsletterBatch: { findFirst: parentFindFirst },
            newsletterMessages: { findMany: vi.fn().mockResolvedValue([]) },
            newsletterErrors: { findMany: vi.fn().mockResolvedValue([]) },
            newsletterNotifications: { findMany: vi.fn().mockResolvedValue([]) },
            newsletterNotificationOrphan: { count: vi.fn().mockResolvedValue(0) },
        }
        const forwardChunks: Uint8Array[] = []
        const reversedChunks: Uint8Array[] = []

        const forward = await buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, forwardChunks, {
            candidates: tiedCandidates,
        }))
        const reversed = await buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, reversedChunks, {
            candidates: [...tiedCandidates].reverse(),
        }))

        expect(reversed).toEqual(forward)
        expect(decodeLines(reversedChunks)).toEqual(decodeLines(forwardChunks))
        expect(forward.manifest.batches).toHaveLength(2)
        expect(forward.escrow.counts.batches).toBe(2)
        expect(decodeLines(forwardChunks).map((line) => JSON.parse(line)).slice(1, 3)).toEqual([
            expect.objectContaining({ row: expect.objectContaining({ id: 'private-row-a' }) }),
            expect.objectContaining({ row: expect.objectContaining({ id: 'private-row-b' }) }),
        ])
    })

    it('writes a verifiable empty snapshot without querying the database', async () => {
        const chunks: Uint8Array[] = []
        const { delegate, parentFindFirst, messageFindMany, errorFindMany } = makeDelegate()

        const result = await buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, chunks, {
            candidates: [],
        }))

        expect(result.plan.batchCount).toBe(0)
        expect(result.manifest.batches).toEqual([])
        expect(result.escrow.counts).toEqual({ batches: 0, messages: 0, errors: 0, notifications: 0 })
        expect(chunks).toHaveLength(2)
        expect(parentFindFirst).not.toHaveBeenCalled()
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(errorFindMany).not.toHaveBeenCalled()
    })

    it('fails the DLQ gate before any database query or sink write', async () => {
        const chunks: Uint8Array[] = []
        const { delegate, parentFindFirst } = makeDelegate()

        await expect(buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, chunks, {
            dlqHealthy: false,
        }))).rejects.toThrow('queue or DLQ evidence must be healthy')

        expect(parentFindFirst).not.toHaveBeenCalled()
        expect(chunks).toEqual([])
    })

    it('releases the tenant lock when the exact snapshot is stale', async () => {
        const chunks: Uint8Array[] = []
        const { delegate } = makeDelegate(null)

        await expect(buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, chunks))).rejects.toThrow(
            'candidate batch row must exist',
        )
        expect(chunks).toHaveLength(1)

        const lockProbe = createProcessLocalAntiOverlapLock('tenant-a')
        expect(lockProbe.tryAcquire()).toBe(true)
        expect(lockProbe.release()).toBe(true)
    })

    it('rejects apply mode and an invalid schema commitment before querying', async () => {
        const chunks: Uint8Array[] = []
        const { delegate, parentFindFirst } = makeDelegate()

        await expect(buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, chunks, {
            policy: { ...POLICY, apply: true },
        }))).rejects.toThrow('apply is not enabled')
        await expect(buildNewsletterRetentionEscrowDryRunResult(makeInput(delegate, chunks, {
            schemaFingerprint: 'not-a-hash',
        }))).rejects.toThrow('schemaFingerprint must be a lowercase 64-hex string')

        expect(parentFindFirst).not.toHaveBeenCalled()
        expect(chunks).toEqual([])
    })
})
