import { describe, expect, it, vi } from 'vitest'

import {
    NEWSLETTER_RETENTION_MAX_BATCH_LIMIT,
    NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT,
    parseNewsletterRetentionPolicy,
} from '@/service/newsletter-retention'
import {
    loadNewsletterRetentionCandidates,
    loadNewsletterRetentionCandidateRecords,
    type NewsletterRetentionCandidateLoaderDelegate,
} from '@/service/newsletter-retention-candidate-loader'

type MessageRowsByBatchId = Record<string, unknown[]>

function makeDelegate(
    batchRows: unknown,
    messagesByBatchId: MessageRowsByBatchId = {},
    orphanCounts: number[] = [],
) {
    const findMany = vi.fn().mockResolvedValue(batchRows)
    const messageFindMany = vi.fn().mockImplementation(async (args: unknown) => {
        const batchId = ((args as { where?: { newsletterBatchId?: unknown } }).where?.newsletterBatchId)
        if (typeof batchId !== 'string') {
            return []
        }

        return messagesByBatchId[batchId] ?? []
    })
    const orphanCount = vi.fn().mockImplementation(async () => orphanCounts[orphanCount.mock.calls.length - 1] ?? 0)

    return {
        delegate: {
            newsletterBatch: {
                findMany,
            },
            newsletterMessages: {
                findMany: messageFindMany,
            },
            newsletterNotificationOrphan: {
                count: orphanCount,
            },
        } as unknown as NewsletterRetentionCandidateLoaderDelegate,
        findMany,
        messageFindMany,
        orphanCount,
    }
}

describe('service/newsletter-retention-candidate-loader', () => {
    it('rejects when newsletterBatch.findMany returns a non-array payload', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        for (const rows of [null, {}, 'not-an-array']) {
            const { delegate } = makeDelegate(rows)
            await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
                'newsletterBatch.findMany must return an array',
            )
        }
    })

    it('rejects forged maxBatches policy above hard limit before querying batches', async () => {
        const forgedPolicy = {
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            dryRun: true,
            policyVersion: 1,
            maxBatches: NEWSLETTER_RETENTION_MAX_BATCH_LIMIT + 1,
            maxMessages: 1,
        } as never

        const { delegate, findMany, messageFindMany, orphanCount } = makeDelegate([])

        await expect(loadNewsletterRetentionCandidates(delegate, forgedPolicy)).rejects.toThrow(
            `maxBatches must not exceed ${NEWSLETTER_RETENTION_MAX_BATCH_LIMIT}`,
        )
        expect(findMany).not.toHaveBeenCalled()
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('rejects forged maxMessages policy above hard limit before querying batches', async () => {
        const forgedPolicy = {
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            dryRun: true,
            policyVersion: 1,
            maxBatches: 1,
            maxMessages: NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT + 1,
        } as never

        const { delegate, findMany, messageFindMany, orphanCount } = makeDelegate([])

        await expect(loadNewsletterRetentionCandidates(delegate, forgedPolicy)).rejects.toThrow(
            `maxMessages must not exceed ${NEWSLETTER_RETENTION_MAX_MESSAGE_LIMIT}`,
        )
        expect(findMany).not.toHaveBeenCalled()
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('rejects forged whitespace siteId policy before querying batches', async () => {
        const forgedPolicy = {
            siteId: ' tenant-a ',
            cutoff: '2026-08-27T12:00:00.000Z',
            dryRun: true,
            policyVersion: 1,
            maxBatches: 1,
            maxMessages: 1,
        } as never

        const { delegate, findMany, messageFindMany, orphanCount } = makeDelegate([])

        await expect(loadNewsletterRetentionCandidates(delegate, forgedPolicy)).rejects.toThrow(
            'siteId must be a non-empty string',
        )
        expect(findMany).not.toHaveBeenCalled()
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('sorts candidates deterministically with rowId as canonical final tie-break and never exposes rowId', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 2,
            maxMessages: 10,
        })

        const { delegate } = makeDelegate([
            {
                id: 'row-second',
                batchId: 'batch-shared',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
            {
                id: 'row-first',
                batchId: 'batch-shared',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
        ], {
            'row-second': [
                {
                    messageId: 'message-second',
                    _count: {
                        notificationEvents: 0,
                    },
                },
            ],
            'row-first': [
                {
                    messageId: 'message-first',
                    _count: {
                        notificationEvents: 0,
                    },
                },
            ],
        })

        const candidates = await loadNewsletterRetentionCandidates(delegate, policy)

        expect(candidates).toEqual([
            {
                siteId: 'tenant-a',
                batchId: 'batch-shared',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
            {
                siteId: 'tenant-a',
                batchId: 'batch-shared',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
        ])

        expect(candidates[0]).not.toHaveProperty('rowId')
        expect(candidates[1]).not.toHaveProperty('rowId')
        expect(candidates[0]).not.toHaveProperty('batchRecordId')
        expect(candidates[1]).not.toHaveProperty('batchRecordId')
    })

    it('performs bounded first-phase retrieval and second-phase message/orphan lookups with exact arguments', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 2,
            maxMessages: 10,
        })

        const { delegate, findMany, messageFindMany, orphanCount } = makeDelegate(
            [
                {
                    id: 'row-b',
                    batchId: 'batch-b',
                    created: new Date('2026-08-27T11:59:59.999Z'),
                    _count: {
                        NewslettersErrors: 1,
                        NewslettersMessages: 2,
                    },
                },
                {
                    id: 'row-a',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T11:00:00.000Z'),
                    _count: {
                        NewslettersErrors: 0,
                        NewslettersMessages: 0,
                    },
                },
            ],
            {
                'row-b': [
                    {
                        messageId: 'message-b-1',
                        _count: {
                            notificationEvents: 2,
                        },
                    },
                    {
                        messageId: 'message-b-2',
                        _count: {
                            notificationEvents: 1,
                        },
                    },
                ],
            },
            [1],
        )

        const candidates = await loadNewsletterRetentionCandidates(delegate, policy)

        expect(findMany).toHaveBeenCalledTimes(1)
        expect(findMany).toHaveBeenCalledWith({
            where: {
                siteId: 'tenant-a',
                created: {
                    lt: new Date('2026-08-27T12:00:00.000Z'),
                },
            },
            orderBy: [{ created: 'asc' }, { id: 'asc' }],
            take: 3,
            select: {
                id: true,
                batchId: true,
                created: true,
                _count: {
                    select: {
                        NewslettersErrors: true,
                        NewslettersMessages: true,
                    },
                },
            },
        })

        expect(messageFindMany).toHaveBeenCalledTimes(1)
        expect(messageFindMany).toHaveBeenCalledWith({
            where: {
                newsletterBatchId: 'row-b',
            },
            orderBy: [{ id: 'asc' }],
            take: 3,
            select: {
                messageId: true,
                _count: {
                    select: {
                        notificationEvents: true,
                    },
                },
            },
        })

        expect(orphanCount).toHaveBeenCalledTimes(1)
        expect(orphanCount).toHaveBeenCalledWith({
            where: {
                messageId: {
                    in: ['message-b-1', 'message-b-2'],
                },
            },
        })

        expect(candidates).toEqual([
            {
                siteId: 'tenant-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 0,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
            {
                siteId: 'tenant-a',
                batchId: 'batch-b',
                createdAt: '2026-08-27T11:59:59.999Z',
                messageCount: 2,
                notificationCount: 3,
                errorCount: 1,
                orphanCount: 1,
                correlationComplete: false,
            },
        ])
    })

    it('does not issue message or orphan queries for an empty batch', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const { delegate, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-empty',
                batchId: 'batch-empty',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 0,
                },
            },
        ])

        const candidates = await loadNewsletterRetentionCandidates(delegate, policy)

        expect(messageFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
        expect(candidates).toEqual([
            {
                siteId: 'tenant-a',
                batchId: 'batch-empty',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 0,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
        ])
    })

    it('fails closed when first-phase batches exceed policy maxBatches before message-orphan queries', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const { delegate, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-b',
                batchId: 'batch-b',
                created: new Date('2026-08-27T11:10:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
            {
                id: 'row-a',
                batchId: 'batch-a',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
        ], {
            'row-a': [
                { messageId: 'm-a', _count: { notificationEvents: 0 } },
            ],
            'row-b': [
                { messageId: 'm-b', _count: { notificationEvents: 0 } },
            ],
        }, [0, 0])

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterBatch.findMany returned more batches than maxBatches',
        )
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('fails closed when first-phase message totals exceed policy maxMessages before message-orphan queries', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 10,
            maxMessages: 2,
        })

        const { delegate, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-a',
                batchId: 'batch-a',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
            {
                id: 'row-b',
                batchId: 'batch-b',
                created: new Date('2026-08-27T11:30:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 2,
                },
            },
        ], {
            'row-a': [{ messageId: 'message-a', _count: { notificationEvents: 0 } }],
            'row-b': [
                { messageId: 'message-b-1', _count: { notificationEvents: 0 } },
                { messageId: 'message-b-2', _count: { notificationEvents: 0 } },
            ],
        }, [0, 0])

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'sum of newsletterBatch._count.NewslettersMessages exceeds maxMessages',
        )
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('rejects when newsletterMessages.findMany does not return an array and never counts orphans', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const { delegate, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-bad-rows',
                batchId: 'batch-bad-rows',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
        ], {
            'row-bad-rows': {} as unknown as [],
        })

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterMessages.findMany must return an array',
        )
        expect(messageFindMany).toHaveBeenCalledTimes(1)
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('fails closed when a batch contains duplicated messageIds before querying orphans', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const { delegate, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-duplicate',
                batchId: 'batch-duplicate',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 2,
                },
            },
        ], {
            'row-duplicate': [
                {
                    messageId: 'message-dup',
                    _count: {
                        notificationEvents: 1,
                    },
                },
                {
                    messageId: 'message-dup',
                    _count: {
                        notificationEvents: 2,
                    },
                },
            ],
        })

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterMessages.findMany returned duplicate messageId',
        )
        expect(messageFindMany).toHaveBeenCalledTimes(1)
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('rejects when aggregate message count does not match actual returned message rows and never counts orphans', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const { delegate, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-mismatch',
                batchId: 'batch-mismatch',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 2,
                },
            },
        ], {
            'row-mismatch': [
                {
                    messageId: 'message-m-1',
                    _count: {
                        notificationEvents: 0,
                    },
                },
            ],
        })

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterMessages.findMany returned unexpected number of rows',
        )
        expect(messageFindMany).toHaveBeenCalledTimes(1)
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('preserves opaque batch and message IDs and uses exact ids for orphan lookup', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const { delegate, orphanCount } = makeDelegate([
            {
                id: 'row-orphan-scope',
                batchId: 'batch-id ',
                created: new Date('2026-08-27T11:30:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 2,
                },
            },
        ], {
            'row-orphan-scope': [
                {
                    messageId: 'message-id-1 ',
                    _count: {
                        notificationEvents: 4,
                    },
                },
                {
                    messageId: ' message-id-2',
                    _count: {
                        notificationEvents: 2,
                    },
                },
            ],
        }, [9])

        const candidates = await loadNewsletterRetentionCandidates(delegate, policy)

        expect(orphanCount).toHaveBeenCalledWith({
            where: {
                messageId: {
                    in: ['message-id-1 ', ' message-id-2'],
                },
            },
        })

        expect(candidates).toEqual([
            {
                siteId: 'tenant-a',
                batchId: 'batch-id ',
                createdAt: '2026-08-27T11:30:00.000Z',
                messageCount: 2,
                notificationCount: 6,
                errorCount: 0,
                orphanCount: 9,
                correlationComplete: false,
            },
        ])
    })

    it('rejects unsafe NewslettersErrors aggregate counts with sanitized error messages', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        const { delegate } = makeDelegate([
            {
                id: 'row-unsafe-errors',
                batchId: 'batch-unsafe-errors',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: Number.MAX_SAFE_INTEGER + 1,
                    NewslettersMessages: 1,
                },
            },
            {
                id: 'row-safe',
                batchId: 'batch-safe',
                created: new Date('2026-08-27T10:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 0,
                },
            },
        ])

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterBatch._count.NewslettersErrors must be a non-negative integer',
        )
    })

    it('rejects unsafe aggregate NewslettersMessages counts with sanitized error messages', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        const { delegate } = makeDelegate([
            {
                id: 'row-unsafe-newsletter-count',
                batchId: 'batch-unsafe-newsletter-count',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: Number.MAX_SAFE_INTEGER + 1,
                },
            },
        ])

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterBatch._count.NewslettersMessages must be a non-negative integer',
        )
    })

    it('rejects unsafe newsletterMessages._count.notificationEvents with sanitized error messages', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        const { delegate } = makeDelegate([
            {
                id: 'row-unsafe-notification-count',
                batchId: 'batch-unsafe-notification-count',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
        ], {
            'row-unsafe-notification-count': [
                {
                    messageId: 'message-safe',
                    _count: {
                        notificationEvents: Number.MAX_SAFE_INTEGER + 1,
                    },
                },
            ],
        })

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterMessages._count.notificationEvents must be a non-negative integer',
        )
    })

    it('rejects overflowing sum of notificationEvents before producing candidates', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        const { delegate } = makeDelegate([
            {
                id: 'row-unsafe-notification-sum',
                batchId: 'batch-unsafe-notification-sum',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 2,
                },
            },
        ], {
            'row-unsafe-notification-sum': [
                {
                    messageId: 'message-safe-1',
                    _count: {
                        notificationEvents: Number.MAX_SAFE_INTEGER,
                    },
                },
                {
                    messageId: 'message-safe-2',
                    _count: {
                        notificationEvents: 1,
                    },
                },
            ],
        })

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterMessages._count.notificationEvents sum exceeds Number.MAX_SAFE_INTEGER',
        )
    })

    it('rejects unsafe newsletterNotificationOrphan.count results with sanitized error messages', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        const { delegate } = makeDelegate([
            {
                id: 'row-unsafe-orphan-count',
                batchId: 'batch-unsafe-orphan-count',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
        ], {
            'row-unsafe-orphan-count': [
                {
                    messageId: 'message-safe',
                    _count: {
                        notificationEvents: 0,
                    },
                },
            ],
        }, [Number.MAX_SAFE_INTEGER + 1])

        await expect(loadNewsletterRetentionCandidates(delegate, policy)).rejects.toThrow(
            'newsletterNotificationOrphan.count must be a non-negative integer',
        )
    })

    it('rejects malformed rows and malformed policy inputs', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
        })

        await expect(loadNewsletterRetentionCandidates(makeDelegate([
            {
                id: 'row-missing-counts',
                batchId: 'batch-missing-counts',
                created: new Date('2026-08-27T11:00:00.000Z'),
            } as never,
        ]).delegate, policy)).rejects.toThrow('newsletterBatch row must include aggregate child counts')

        await expect(loadNewsletterRetentionCandidates(makeDelegate([
            {
                id: 'row-missing-message-count',
                batchId: 'batch-missing-message-count',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                } as never,
            },
        ]).delegate, policy)).rejects.toThrow(
            'newsletterBatch._count.NewslettersMessages must be a non-negative integer',
        )

        await expect(loadNewsletterRetentionCandidates(makeDelegate([]).delegate, {
            siteId: ' ',
            cutoff: '2026-08-27T12:00:00.000Z',
            dryRun: true,
            maxBatches: 1,
            maxMessages: 1,
            policyVersion: 1,
        } as never)).rejects.toThrow('siteId must be a non-empty string')

        await expect(loadNewsletterRetentionCandidates(makeDelegate([]).delegate, {
            siteId: 'tenant-a',
            cutoff: 'not-a-strict-cutoff',
            dryRun: true,
            maxBatches: 1,
            maxMessages: 1,
            policyVersion: 1,
        } as never)).rejects.toThrow('cutoff must be a strict UTC ISO-8601 string')
    })

    it('returns private batchRecordId in the internal record loader while preserving two-phase fetch behavior', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 2,
            maxMessages: 10,
        })

        const { delegate, findMany, messageFindMany, orphanCount } = makeDelegate([
            {
                id: 'row-b',
                batchId: 'batch-b',
                created: new Date('2026-08-27T11:00:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
            {
                id: 'row-a',
                batchId: 'batch-a',
                created: new Date('2026-08-27T11:30:00.000Z'),
                _count: {
                    NewslettersErrors: 0,
                    NewslettersMessages: 1,
                },
            },
        ], {
            'row-b': [
                {
                    messageId: 'message-b',
                    _count: {
                        notificationEvents: 0,
                    },
                },
            ],
            'row-a': [
                {
                    messageId: 'message-a',
                    _count: {
                        notificationEvents: 0,
                    },
                },
            ],
        }, [0, 0])

        const records = await loadNewsletterRetentionCandidateRecords(delegate, policy)

        expect(findMany).toHaveBeenCalledTimes(1)
        expect(messageFindMany).toHaveBeenCalledTimes(2)
        expect(orphanCount).toHaveBeenCalledTimes(2)
        expect(records).toEqual([
            {
                siteId: 'tenant-a',
                batchRecordId: 'row-b',
                batchId: 'batch-b',
                createdAt: '2026-08-27T11:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
            {
                siteId: 'tenant-a',
                batchRecordId: 'row-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T11:30:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
        ])
    })
})
