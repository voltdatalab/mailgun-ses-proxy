import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { buildNewsletterRetentionManifest } from '@/service/newsletter-retention'
import {
    NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION,
    buildNewsletterRetentionApplyArtifact,
} from '@/service/newsletter-retention-apply'
import {
    NEWSLETTER_RETENTION_APPLY_LOCK_KEY,
    NewsletterRetentionApplyError,
    executeNewsletterRetentionApply,
    type NewsletterRetentionApplyDatabase,
    type NewsletterRetentionApplyInput,
    type NewsletterRetentionApplyLockProvider,
    type NewsletterRetentionApplyTransactionClient,
} from '@/service/newsletter-retention-applier'

interface BatchFixture {
    recordId: string
    batchId: string
    createdAt: string
    messageCount: number
    notificationCount: number
    errorCount: number
}

interface HarnessOverrides {
    parent?: unknown
    messages?: unknown
    orphanCounts?: unknown[]
    notificationDelete?: unknown
    errorDelete?: unknown
    messageDelete?: unknown
    batchDelete?: unknown
    parentPostCount?: unknown
    messagePostCount?: unknown
    errorPostCount?: unknown
    notificationPostCount?: unknown
    parentFailure?: unknown
    releaseFailure?: unknown
    lockAvailable?: boolean
}

const SITE_ID = 'tenant-a'
const CUTOFF = '2026-08-27T12:00:00.000Z'
const NOW = '2026-08-28T00:00:00.000Z'
const DEFAULT_BATCH: BatchFixture = {
    recordId: 'row-one',
    batchId: 'batch-one',
    createdAt: '2026-08-27T10:00:00.000Z',
    messageCount: 1,
    notificationCount: 2,
    errorCount: 1,
}

function buildInputParts(batches: BatchFixture[] = [DEFAULT_BATCH]) {
    const manifest = buildNewsletterRetentionManifest({
        siteId: SITE_ID,
        cutoff: CUTOFF,
        batches: batches.map((batch) => ({
            batchId: batch.batchId,
            createdAt: batch.createdAt,
            messageCount: batch.messageCount,
            notificationCount: batch.notificationCount,
            errorCount: batch.errorCount,
        })),
    })

    const records = batches
        .map((batch) => ({
            siteId: SITE_ID,
            batchRecordId: batch.recordId,
            batchId: batch.batchId,
            createdAt: batch.createdAt,
            messageCount: batch.messageCount,
            notificationCount: batch.notificationCount,
            errorCount: batch.errorCount,
            orphanCount: 0,
            correlationComplete: true,
        }))
        .sort((left, right) => left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0)

    const artifact = buildNewsletterRetentionApplyArtifact({ manifest, records })

    return {
        policy: {
            siteId: SITE_ID,
            cutoff: CUTOFF,
            apply: true,
            maxBatches: Math.max(1, batches.length),
            maxMessages: Math.max(1, batches.reduce((total, batch) => total + batch.messageCount, 0)),
        },
        evidence: {
            now: NOW,
            backup: {
                verifiedAt: '2026-08-27T23:00:00.000Z',
                restoredAt: '2026-08-27T23:10:00.000Z',
            },
            restore: {
                verifiedAt: '2026-08-27T23:20:00.000Z',
                restoredAt: '2026-08-27T23:30:00.000Z',
            },
            health: {
                queueCheckedAt: '2026-08-27T23:55:00.000Z',
                proxyCheckedAt: '2026-08-27T23:56:00.000Z',
                queueHealthy: true,
                proxyHealthy: true,
            },
        },
        manifest,
        artifact,
    }
}

function makeHarness(batch: BatchFixture = DEFAULT_BATCH, overrides: HarnessOverrides = {}) {
    const order: string[] = []
    const release = vi.fn(async () => {
        order.push('release')
        if (overrides.releaseFailure) throw overrides.releaseFailure
    })
    const tryAcquire = vi.fn(async () => {
        order.push('lock')
        return overrides.lockAvailable === false ? null : { release }
    })

    let orphanCall = 0
    const parentFindFirst = vi.fn(async () => {
        order.push('parent.findFirst')
        if (overrides.parentFailure) throw overrides.parentFailure
        if (Object.prototype.hasOwnProperty.call(overrides, 'parent')) return overrides.parent
        return {
            id: batch.recordId,
            siteId: SITE_ID,
            batchId: batch.batchId,
            created: new Date(batch.createdAt),
            _count: {
                NewslettersMessages: batch.messageCount,
                NewslettersErrors: batch.errorCount,
            },
        }
    })
    const messageFindMany = vi.fn(async () => {
        order.push('messages.findMany')
        if (Object.prototype.hasOwnProperty.call(overrides, 'messages')) return overrides.messages
        return Array.from({ length: batch.messageCount }, (_, index) => ({
            messageId: `message-private-${index + 1}`,
            _count: {
                notificationEvents: index === 0 ? batch.notificationCount : 0,
            },
        }))
    })
    const orphanCount = vi.fn(async () => {
        order.push(orphanCall === 0 ? 'orphans.preCount' : 'orphans.postCount')
        const value = overrides.orphanCounts?.[orphanCall] ?? 0
        orphanCall += 1
        return value
    })
    const notificationDeleteMany = vi.fn(async () => {
        order.push('notifications.deleteMany')
        return Object.prototype.hasOwnProperty.call(overrides, 'notificationDelete')
            ? overrides.notificationDelete
            : { count: batch.notificationCount }
    })
    const errorDeleteMany = vi.fn(async () => {
        order.push('errors.deleteMany')
        return Object.prototype.hasOwnProperty.call(overrides, 'errorDelete')
            ? overrides.errorDelete
            : { count: batch.errorCount }
    })
    const messageDeleteMany = vi.fn(async () => {
        order.push('messages.deleteMany')
        return Object.prototype.hasOwnProperty.call(overrides, 'messageDelete')
            ? overrides.messageDelete
            : { count: batch.messageCount }
    })
    const batchDeleteMany = vi.fn(async () => {
        order.push('batch.deleteMany')
        return Object.prototype.hasOwnProperty.call(overrides, 'batchDelete')
            ? overrides.batchDelete
            : { count: 1 }
    })
    const parentCount = vi.fn(async () => {
        order.push('batch.postCount')
        return overrides.parentPostCount ?? 0
    })
    const messageCount = vi.fn(async () => {
        order.push('messages.postCount')
        return overrides.messagePostCount ?? 0
    })
    const errorCount = vi.fn(async () => {
        order.push('errors.postCount')
        return overrides.errorPostCount ?? 0
    })
    const notificationCount = vi.fn(async () => {
        order.push('notifications.postCount')
        return overrides.notificationPostCount ?? 0
    })

    const tx = {
        newsletterBatch: {
            findFirst: parentFindFirst,
            deleteMany: batchDeleteMany,
            count: parentCount,
        },
        newsletterMessages: {
            findMany: messageFindMany,
            deleteMany: messageDeleteMany,
            count: messageCount,
        },
        newsletterErrors: {
            deleteMany: errorDeleteMany,
            count: errorCount,
        },
        newsletterNotifications: {
            deleteMany: notificationDeleteMany,
            count: notificationCount,
        },
        newsletterNotificationOrphan: {
            count: orphanCount,
        },
    } as unknown as NewsletterRetentionApplyTransactionClient

    const transaction = vi.fn(async (callback: (client: NewsletterRetentionApplyTransactionClient) => Promise<unknown>) => {
        order.push('transaction')
        return callback(tx)
    })

    return {
        order,
        release,
        tryAcquire,
        transaction,
        tx,
        spies: {
            parentFindFirst,
            messageFindMany,
            orphanCount,
            notificationDeleteMany,
            errorDeleteMany,
            messageDeleteMany,
            batchDeleteMany,
            parentCount,
            messageCount,
            errorCount,
            notificationCount,
        },
        lock: { tryAcquire } as NewsletterRetentionApplyLockProvider,
        database: { $transaction: transaction } as unknown as NewsletterRetentionApplyDatabase,
    }
}

function makeInput(
    harness: ReturnType<typeof makeHarness>,
    batches: BatchFixture[] = [DEFAULT_BATCH],
): NewsletterRetentionApplyInput & ReturnType<typeof buildInputParts> {
    return {
        ...buildInputParts(batches),
        lock: harness.lock,
        database: harness.database,
    } as NewsletterRetentionApplyInput & ReturnType<typeof buildInputParts>
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
        return `{${entries.join(',')}}`
    }
    return JSON.stringify(value)
}

function hashArtifactPayload(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function expectApplyError(error: unknown, completed: number, failedIndex: number | null, message: string) {
    expect(error).toBeInstanceOf(NewsletterRetentionApplyError)
    const applyError = error as NewsletterRetentionApplyError
    expect(applyError.completedBatchCount).toBe(completed)
    expect(applyError.failedManifestIndex).toBe(failedIndex)
    expect(applyError.message).toBe(message)
}

describe('executeNewsletterRetentionApply', () => {
    it('rejects dry-run, stale evidence, tampered binding, empty apply, and cap overflow before lock or DB', async () => {
        const cases: NewsletterRetentionApplyInput[] = []

        {
            const harness = makeHarness()
            const input = makeInput(harness)
            cases.push({ ...input, policy: { ...input.policy, apply: false } })
        }
        {
            const harness = makeHarness()
            const input = makeInput(harness)
            cases.push({
                ...input,
                evidence: {
                    ...input.evidence,
                    health: {
                        ...input.evidence.health,
                        queueCheckedAt: '2026-08-27T23:00:00.000Z',
                    },
                },
            })
        }
        {
            const harness = makeHarness()
            const input = makeInput(harness)
            cases.push({
                ...input,
                artifact: { ...input.artifact, publicManifestHash: '0'.repeat(64) },
            })
        }
        {
            const harness = makeHarness()
            const input = makeInput(harness)
            const payload = {
                version: NEWSLETTER_RETENTION_APPLY_ARTIFACT_VERSION,
                siteId: SITE_ID,
                publicManifestHash: input.manifest.hash,
                bindings: [],
            }
            cases.push({ ...input, artifact: { ...payload, hash: hashArtifactPayload(payload) } })
        }
        {
            const batch = { ...DEFAULT_BATCH, messageCount: 2 }
            const harness = makeHarness(batch)
            const input = makeInput(harness, [batch])
            cases.push({ ...input, policy: { ...input.policy, maxMessages: 1 } })
        }

        for (const input of cases) {
            await expect(executeNewsletterRetentionApply(input)).rejects.toThrow()
            expect(input.lock.tryAcquire).not.toHaveBeenCalled()
            expect(input.database.$transaction).not.toHaveBeenCalled()
        }
    })

    it('refuses overlap before starting a transaction', async () => {
        const harness = makeHarness(DEFAULT_BATCH, { lockAvailable: false })

        await expect(executeNewsletterRetentionApply(makeInput(harness))).rejects.toMatchObject({
            completedBatchCount: 0,
            failedManifestIndex: null,
        })
        expect(harness.tryAcquire).toHaveBeenCalledWith(NEWSLETTER_RETENTION_APPLY_LOCK_KEY)
        expect(harness.transaction).not.toHaveBeenCalled()
        expect(harness.release).not.toHaveBeenCalled()
    })

    it('revalidates exact identity and deletes child-first with deterministic receipt', async () => {
        const harness = makeHarness()
        const input = makeInput(harness)

        const receipt = await executeNewsletterRetentionApply(input)

        expect(receipt).toEqual({
            manifestHash: input.manifest.hash,
            artifactHash: input.artifact.hash,
            siteId: SITE_ID,
            batches: [{
                manifestIndex: 0,
                batchId: DEFAULT_BATCH.batchId,
                deletedNotificationCount: 2,
                deletedErrorCount: 1,
                deletedMessageCount: 1,
                deletedBatchCount: 1,
            }],
        })
        expect(harness.spies.parentFindFirst).toHaveBeenCalledWith({
            where: { id: DEFAULT_BATCH.recordId, siteId: SITE_ID },
            select: {
                id: true,
                siteId: true,
                batchId: true,
                created: true,
                _count: { select: { NewslettersMessages: true, NewslettersErrors: true } },
            },
        })
        expect(harness.spies.messageFindMany).toHaveBeenCalledWith({
            where: { newsletterBatchId: DEFAULT_BATCH.recordId },
            orderBy: [{ id: 'asc' }],
            take: 2,
            select: { messageId: true, _count: { select: { notificationEvents: true } } },
        })
        expect(harness.spies.batchDeleteMany).toHaveBeenCalledWith({
            where: {
                id: DEFAULT_BATCH.recordId,
                siteId: SITE_ID,
                batchId: DEFAULT_BATCH.batchId,
                created: new Date(DEFAULT_BATCH.createdAt),
            },
        })
        expect(harness.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' })
        expect(harness.order).toEqual([
            'lock',
            'transaction',
            'parent.findFirst',
            'messages.findMany',
            'orphans.preCount',
            'notifications.deleteMany',
            'errors.deleteMany',
            'messages.deleteMany',
            'batch.deleteMany',
            'batch.postCount',
            'messages.postCount',
            'errors.postCount',
            'notifications.postCount',
            'orphans.postCount',
            'release',
        ])
        expect((harness.tx.newsletterNotificationOrphan as unknown as { deleteMany?: unknown }).deleteMany).toBeUndefined()
    })

    it.each([
        ['missing parent', { parent: null }],
        ['malformed parent', { parent: 'secret-parent' }],
        ['stale timestamp', { parent: { id: DEFAULT_BATCH.recordId, siteId: SITE_ID, batchId: DEFAULT_BATCH.batchId, created: new Date('2026-08-27T09:00:00.000Z'), _count: { NewslettersMessages: 1, NewslettersErrors: 1 } } }],
        ['stale parent count', { parent: { id: DEFAULT_BATCH.recordId, siteId: SITE_ID, batchId: DEFAULT_BATCH.batchId, created: new Date(DEFAULT_BATCH.createdAt), _count: { NewslettersMessages: 2, NewslettersErrors: 1 } } }],
        ['malformed messages', { messages: 'secret-messages' }],
        ['message cardinality mismatch', { messages: [] }],
    ])('fails closed on %s before any delete', async (_label, overrides) => {
        const harness = makeHarness(DEFAULT_BATCH, overrides)

        await expect(executeNewsletterRetentionApply(makeInput(harness))).rejects.toMatchObject({
            completedBatchCount: 0,
            failedManifestIndex: 0,
        })
        expect(harness.spies.notificationDeleteMany).not.toHaveBeenCalled()
        expect(harness.spies.errorDeleteMany).not.toHaveBeenCalled()
        expect(harness.spies.messageDeleteMany).not.toHaveBeenCalled()
        expect(harness.spies.batchDeleteMany).not.toHaveBeenCalled()
        expect(harness.release).toHaveBeenCalledOnce()
    })

    it('rejects duplicate message IDs and notification-count overflow before deletes', async () => {
        const duplicateBatch = { ...DEFAULT_BATCH, messageCount: 2, notificationCount: 2 }
        const duplicateHarness = makeHarness(duplicateBatch, {
            messages: [
                { messageId: 'same-message', _count: { notificationEvents: 1 } },
                { messageId: 'same-message', _count: { notificationEvents: 1 } },
            ],
        })
        await expect(executeNewsletterRetentionApply(makeInput(duplicateHarness, [duplicateBatch]))).rejects.toThrow('newsletter retention apply failed')
        expect(duplicateHarness.spies.notificationDeleteMany).not.toHaveBeenCalled()

        const overflowBatch = { ...DEFAULT_BATCH, messageCount: 2, notificationCount: Number.MAX_SAFE_INTEGER }
        const overflowHarness = makeHarness(overflowBatch, {
            messages: [
                { messageId: 'message-a', _count: { notificationEvents: Number.MAX_SAFE_INTEGER } },
                { messageId: 'message-b', _count: { notificationEvents: 1 } },
            ],
        })
        await expect(executeNewsletterRetentionApply(makeInput(overflowHarness, [overflowBatch]))).rejects.toThrow('newsletter retention apply failed')
        expect(overflowHarness.spies.notificationDeleteMany).not.toHaveBeenCalled()
    })

    it('rejects a scoped orphan before every delete and never leaks message IDs', async () => {
        const harness = makeHarness(DEFAULT_BATCH, { orphanCounts: [1] })
        let error: unknown

        try {
            await executeNewsletterRetentionApply(makeInput(harness))
        } catch (caught) {
            error = caught
        }

        expectApplyError(error, 0, 0, 'newsletter retention apply failed')
        expect(JSON.stringify(error)).not.toContain('message-private-1')
        expect(harness.spies.notificationDeleteMany).not.toHaveBeenCalled()
        expect(harness.spies.errorDeleteMany).not.toHaveBeenCalled()
    })

    it('rolls back logically on delete-count mismatch and postcondition mismatch', async () => {
        const deleteMismatch = makeHarness(DEFAULT_BATCH, { notificationDelete: { count: 1 } })
        await expect(executeNewsletterRetentionApply(makeInput(deleteMismatch))).rejects.toThrow('newsletter retention apply failed')
        expect(deleteMismatch.spies.errorDeleteMany).not.toHaveBeenCalled()

        const postMismatch = makeHarness(DEFAULT_BATCH, { parentPostCount: 1 })
        await expect(executeNewsletterRetentionApply(makeInput(postMismatch))).rejects.toThrow('newsletter retention apply failed')
        expect(postMismatch.spies.batchDeleteMany).toHaveBeenCalledOnce()
        expect(postMismatch.spies.messageCount).not.toHaveBeenCalled()
    })

    it('handles an empty batch without message, orphan, or notification operations', async () => {
        const emptyBatch: BatchFixture = {
            ...DEFAULT_BATCH,
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
        }
        const harness = makeHarness(emptyBatch)

        const receipt = await executeNewsletterRetentionApply(makeInput(harness, [emptyBatch]))

        expect(receipt.batches[0]).toMatchObject({
            deletedNotificationCount: 0,
            deletedMessageCount: 0,
            deletedErrorCount: 0,
            deletedBatchCount: 1,
        })
        expect(harness.spies.messageFindMany).not.toHaveBeenCalled()
        expect(harness.spies.orphanCount).not.toHaveBeenCalled()
        expect(harness.spies.notificationDeleteMany).not.toHaveBeenCalled()
        expect(harness.spies.notificationCount).not.toHaveBeenCalled()
    })

    it('commits batches sequentially, stops after the first failed later batch, and reports partial progress', async () => {
        const first = { ...DEFAULT_BATCH, recordId: 'row-a', batchId: 'batch-a' }
        const second = { ...DEFAULT_BATCH, recordId: 'row-b', batchId: 'batch-b' }
        const firstHarness = makeHarness(first)
        const secondHarness = makeHarness(second, { parent: null })
        const release = vi.fn()
        const lock = { tryAcquire: vi.fn(async () => ({ release })) }
        let transactionIndex = 0
        const transaction = vi.fn(async (callback: (tx: NewsletterRetentionApplyTransactionClient) => Promise<unknown>) => {
            const selected = transactionIndex === 0 ? firstHarness.tx : secondHarness.tx
            transactionIndex += 1
            return callback(selected)
        })
        const input = {
            ...buildInputParts([first, second]),
            lock,
            database: { $transaction: transaction } as unknown as NewsletterRetentionApplyDatabase,
        }
        let error: unknown

        try {
            await executeNewsletterRetentionApply(input)
        } catch (caught) {
            error = caught
        }

        expectApplyError(error, 1, 1, 'newsletter retention apply failed')
        expect(transaction).toHaveBeenCalledTimes(2)
        expect(firstHarness.spies.batchDeleteMany).toHaveBeenCalledOnce()
        expect(secondHarness.spies.batchDeleteMany).not.toHaveBeenCalled()
        expect(release).toHaveBeenCalledOnce()
    })

    it('sanitizes delegate errors and always releases the lock', async () => {
        const secret = 'recipient@example.invalid SECRET_PAYLOAD'
        const harness = makeHarness(DEFAULT_BATCH, { parentFailure: new Error(secret) })
        let error: unknown

        try {
            await executeNewsletterRetentionApply(makeInput(harness))
        } catch (caught) {
            error = caught
        }

        expectApplyError(error, 0, 0, 'newsletter retention apply failed')
        expect((error as Error).message).not.toContain(secret)
        expect(harness.release).toHaveBeenCalledOnce()
    })

    it('surfaces lock release failure with completed progress on success and failure', async () => {
        const releaseAfterSuccess = makeHarness(DEFAULT_BATCH, { releaseFailure: new Error('secret-release') })
        let successError: unknown
        try {
            await executeNewsletterRetentionApply(makeInput(releaseAfterSuccess))
        } catch (caught) {
            successError = caught
        }
        expectApplyError(successError, 1, null, 'newsletter retention apply release failed')

        const releaseAfterFailure = makeHarness(DEFAULT_BATCH, {
            parent: null,
            releaseFailure: new Error('secret-release'),
        })
        let combinedError: unknown
        try {
            await executeNewsletterRetentionApply(makeInput(releaseAfterFailure))
        } catch (caught) {
            combinedError = caught
        }
        expectApplyError(combinedError, 0, 0, 'newsletter retention apply failed and lock release failed')
    })
})
