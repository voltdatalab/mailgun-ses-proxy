import { describe, expect, it, vi } from 'vitest'

import { parseNewsletterRetentionPolicy } from '@/service/newsletter-retention'
import {
    streamNewsletterRetentionEscrowRecords,
    type NewsletterRetentionEscrowLoaderDelegate,
} from '@/service/newsletter-retention-escrow-loader'
import {
    NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS,
    type NewsletterRetentionEscrowRecord,
} from '@/service/newsletter-retention-escrow'

function makeDelegate(options: {
    batchRowsById?: Record<string, unknown>
    messageRowsByBatchId?: Record<string, unknown[]>
    errorRowsByBatchId?: Record<string, unknown[]>
    notificationRowsByBatchId?: Record<string, unknown[]>
    orphanCounts?: number[]
} = {}) {
    const batchRowsById = options.batchRowsById ?? {}
    const messageRowsByBatchId = options.messageRowsByBatchId ?? {}
    const errorRowsByBatchId = options.errorRowsByBatchId ?? {}
    const notificationRowsByBatchId = options.notificationRowsByBatchId ?? {}
    const orphanCounts = options.orphanCounts ?? []

    const findFirst = vi.fn().mockImplementation(async (args: { where?: { id?: unknown } }) => {
        const id = args.where?.id
        return typeof id === 'string' ? batchRowsById[id] ?? null : null
    })
    const messageFindMany = vi.fn().mockImplementation(async (args: { where?: { newsletterBatchId?: unknown } }) => {
        const batchRecordId = args.where?.newsletterBatchId
        return typeof batchRecordId === 'string' ? messageRowsByBatchId[batchRecordId] ?? [] : []
    })
    const errorFindMany = vi.fn().mockImplementation(async (args: { where?: { newsletterBatchId?: unknown } }) => {
        const batchRecordId = args.where?.newsletterBatchId
        return typeof batchRecordId === 'string' ? errorRowsByBatchId[batchRecordId] ?? [] : []
    })
    const notificationFindMany = vi.fn().mockImplementation(async (args: { where?: { newsletter?: { newsletterBatchId?: unknown } } }) => {
        const batchRecordId = args.where?.newsletter?.newsletterBatchId
        return typeof batchRecordId === 'string' ? notificationRowsByBatchId[batchRecordId] ?? [] : []
    })
    const orphanCount = vi.fn().mockImplementation(async () => orphanCounts[orphanCount.mock.calls.length - 1] ?? 0)

    return {
        delegate: {
            newsletterBatch: { findFirst },
            newsletterMessages: { findMany: messageFindMany },
            newsletterErrors: { findMany: errorFindMany },
            newsletterNotifications: { findMany: notificationFindMany },
            newsletterNotificationOrphan: { count: orphanCount },
        } as unknown as NewsletterRetentionEscrowLoaderDelegate,
        findFirst,
        messageFindMany,
        errorFindMany,
        notificationFindMany,
        orphanCount,
    }
}

async function collectRecords(
    delegate: NewsletterRetentionEscrowLoaderDelegate,
    candidates: unknown,
    policy = parseNewsletterRetentionPolicy({
        siteId: 'tenant-a',
        cutoff: '2026-08-27T12:00:00.000Z',
        maxBatches: 2,
        maxMessages: 10,
    }),
) {
    const records: NewsletterRetentionEscrowRecord[] = []
    for await (const record of streamNewsletterRetentionEscrowRecords(delegate, policy, candidates as never)) {
        records.push(record)
    }
    return records
}

describe('service/newsletter-retention-escrow-loader', () => {
    it('streams a deterministically ordered escrow snapshot with exact queries, duplicate batchIds, and empty payloads', async () => {
        const earlierCandidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'shared-batch-id',
            createdAt: '2026-08-27T10:30:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 1,
            orphanCount: 0,
            correlationComplete: true,
        }
        const laterCandidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-b',
            batchId: 'shared-batch-id',
            createdAt: '2026-08-27T11:30:00.000Z',
            messageCount: 1,
            notificationCount: 1,
            errorCount: 1,
            orphanCount: 0,
            correlationComplete: true,
        }

        const { delegate, findFirst, messageFindMany, errorFindMany, notificationFindMany, orphanCount } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: '',
                    batchId: 'shared-batch-id',
                    created: new Date('2026-08-27T10:30:00.000Z'),
                },
                'private-b': {
                    id: 'private-b',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: '',
                    batchId: 'shared-batch-id',
                    created: new Date('2026-08-27T11:30:00.000Z'),
                },
            },
            errorRowsByBatchId: {
                'private-a': [
                    {
                        id: 'error-only-row',
                        toEmail: 'fail@example.test',
                        error: '',
                        created: new Date('2026-08-27T10:31:00.000Z'),
                        newsletterBatchId: 'private-a',
                        messageId: 'error-only-message-id',
                        formatedContents: '',
                        recipientData: null,
                    },
                ],
                'private-b': [
                    {
                        id: 'collision-id',
                        toEmail: 'fail@example.test',
                        error: '',
                        created: new Date('2026-08-27T11:32:00.000Z'),
                        newsletterBatchId: 'private-b',
                        messageId: 'shared-message-id',
                        formatedContents: '',
                        recipientData: '',
                    },
                ],
            },
            messageRowsByBatchId: {
                'private-b': [
                    {
                        id: 'collision-id',
                        messageId: 'shared-message-id',
                        toEmail: 'recipient@example.test',
                        newsletterBatchId: 'private-b',
                        created: new Date('2026-08-27T11:31:00.000Z'),
                        formatedContents: '',
                        recipientData: '',
                    },
                ],
            },
            notificationRowsByBatchId: {
                'private-b': [
                    {
                        id: 'collision-id',
                        type: 'Delivery',
                        notificationId: 'shared-notification-id',
                        messageId: 'shared-message-id',
                        rawEvent: '',
                        timestamp: new Date('2026-08-27T11:33:00.000Z'),
                        created: new Date('2026-08-27T11:34:00.000Z'),
                    },
                ],
            },
            orphanCounts: [0],
        })

        const records = await collectRecords(delegate, [laterCandidate, earlierCandidate])

        expect(findFirst).toHaveBeenCalledTimes(2)
        expect(findFirst).toHaveBeenNthCalledWith(1, {
            where: { id: 'private-a', siteId: 'tenant-a' },
            select: {
                id: true,
                siteId: true,
                fromEmail: true,
                contents: true,
                batchId: true,
                created: true,
            },
        })
        expect(findFirst).toHaveBeenNthCalledWith(2, {
            where: { id: 'private-b', siteId: 'tenant-a' },
            select: {
                id: true,
                siteId: true,
                fromEmail: true,
                contents: true,
                batchId: true,
                created: true,
            },
        })

        expect(messageFindMany).toHaveBeenCalledTimes(2)
        expect(messageFindMany).toHaveBeenNthCalledWith(1, {
            where: { newsletterBatchId: 'private-a' },
            orderBy: [{ id: 'asc' }],
            take: 1,
            select: {
                id: true,
                messageId: true,
                toEmail: true,
                newsletterBatchId: true,
                created: true,
                formatedContents: true,
                recipientData: true,
            },
        })
        expect(messageFindMany).toHaveBeenNthCalledWith(2, {
            where: { newsletterBatchId: 'private-b' },
            orderBy: [{ id: 'asc' }],
            take: 2,
            select: {
                id: true,
                messageId: true,
                toEmail: true,
                newsletterBatchId: true,
                created: true,
                formatedContents: true,
                recipientData: true,
            },
        })

        expect(errorFindMany).toHaveBeenCalledTimes(2)
        expect(errorFindMany).toHaveBeenNthCalledWith(1, {
            where: { newsletterBatchId: 'private-a' },
            orderBy: [{ id: 'asc' }],
            take: 2,
            select: {
                id: true,
                toEmail: true,
                error: true,
                created: true,
                newsletterBatchId: true,
                messageId: true,
                formatedContents: true,
                recipientData: true,
            },
        })
        expect(errorFindMany).toHaveBeenNthCalledWith(2, {
            where: { newsletterBatchId: 'private-b' },
            orderBy: [{ id: 'asc' }],
            take: 2,
            select: {
                id: true,
                toEmail: true,
                error: true,
                created: true,
                newsletterBatchId: true,
                messageId: true,
                formatedContents: true,
                recipientData: true,
            },
        })

        expect(notificationFindMany).toHaveBeenCalledTimes(1)
        expect(notificationFindMany).toHaveBeenCalledWith({
            where: { newsletter: { newsletterBatchId: 'private-b' } },
            orderBy: [{ id: 'asc' }],
            take: 2,
            select: {
                id: true,
                type: true,
                notificationId: true,
                messageId: true,
                rawEvent: true,
                timestamp: true,
                created: true,
            },
        })

        expect(orphanCount).toHaveBeenCalledTimes(1)
        expect(orphanCount).toHaveBeenCalledWith({
            where: {
                messageId: { in: ['shared-message-id'] },
                reconciledAt: null,
            },
        })

        expect(records).toEqual([
            {
                kind: 'newsletterBatch',
                manifestIndex: 0,
                row: {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: '',
                    batchId: 'shared-batch-id',
                    created: '2026-08-27T10:30:00.000Z',
                },
            },
            {
                kind: 'newsletterErrors',
                manifestIndex: 0,
                row: {
                    id: 'error-only-row',
                    toEmail: 'fail@example.test',
                    error: '',
                    created: '2026-08-27T10:31:00.000Z',
                    newsletterBatchId: 'private-a',
                    messageId: 'error-only-message-id',
                    formatedContents: '',
                    recipientData: null,
                },
            },
            {
                kind: 'newsletterBatch',
                manifestIndex: 1,
                row: {
                    id: 'private-b',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: '',
                    batchId: 'shared-batch-id',
                    created: '2026-08-27T11:30:00.000Z',
                },
            },
            {
                kind: 'newsletterMessages',
                manifestIndex: 1,
                row: {
                    id: 'collision-id',
                    messageId: 'shared-message-id',
                    toEmail: 'recipient@example.test',
                    newsletterBatchId: 'private-b',
                    created: '2026-08-27T11:31:00.000Z',
                    formatedContents: '',
                    recipientData: '',
                },
            },
            {
                kind: 'newsletterErrors',
                manifestIndex: 1,
                row: {
                    id: 'collision-id',
                    toEmail: 'fail@example.test',
                    error: '',
                    created: '2026-08-27T11:32:00.000Z',
                    newsletterBatchId: 'private-b',
                    messageId: 'shared-message-id',
                    formatedContents: '',
                    recipientData: '',
                },
            },
            {
                kind: 'newsletterNotifications',
                manifestIndex: 1,
                row: {
                    id: 'collision-id',
                    type: 'Delivery',
                    notificationId: 'shared-notification-id',
                    messageId: 'shared-message-id',
                    rawEvent: '',
                    timestamp: '2026-08-27T11:33:00.000Z',
                    created: '2026-08-27T11:34:00.000Z',
                },
            },
        ])
    })

    it('streams an exact empty candidate set without issuing queries', async () => {
        const { delegate, findFirst, messageFindMany, errorFindMany, notificationFindMany, orphanCount } = makeDelegate()

        await expect(collectRecords(delegate, [])).resolves.toEqual([])
        expect(findFirst).not.toHaveBeenCalled()
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(errorFindMany).not.toHaveBeenCalled()
        expect(notificationFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('uses a sentinel query to detect a late message when the expected count is zero', async () => {
        const candidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }
        const { delegate, messageFindMany, errorFindMany, notificationFindMany, orphanCount } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: '',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [{
                    id: 'late-message',
                    messageId: 'late-message',
                    toEmail: 'recipient@example.test',
                    newsletterBatchId: 'private-a',
                    created: new Date('2026-08-27T10:01:00.000Z'),
                    formatedContents: '',
                    recipientData: null,
                }],
            },
        })

        await expect(collectRecords(delegate, [candidate])).rejects.toThrow(
            'newsletterMessages.findMany returned more rows than expected',
        )
        expect(messageFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
        expect(errorFindMany).not.toHaveBeenCalled()
        expect(notificationFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('uses a sentinel query to detect a late error when the expected count is zero', async () => {
        const candidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }
        const { delegate, messageFindMany, errorFindMany, notificationFindMany, orphanCount } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: '',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            errorRowsByBatchId: {
                'private-a': [{
                    id: 'late-error',
                    toEmail: 'recipient@example.test',
                    error: '',
                    created: new Date('2026-08-27T10:01:00.000Z'),
                    newsletterBatchId: 'private-a',
                    messageId: 'late-error-message',
                    formatedContents: '',
                    recipientData: null,
                }],
            },
        })

        await expect(collectRecords(delegate, [candidate])).rejects.toThrow(
            'newsletterErrors.findMany returned more rows than expected',
        )
        expect(messageFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
        expect(errorFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
        expect(notificationFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('rejects an expected total above the escrow hard record limit before querying', async () => {
        const { delegate, findFirst } = makeDelegate()
        const candidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 1,
            notificationCount: NEWSLETTER_RETENTION_ESCROW_MAX_RECORDS,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }

        await expect(collectRecords(delegate, [candidate])).rejects.toThrow(
            'expected escrow record count exceeds hard limit',
        )
        expect(findFirst).not.toHaveBeenCalled()
    })

    it('rejects schema-global unique key collisions across candidate batches', async () => {
        const candidates = [
            {
                siteId: 'tenant-a',
                batchRecordId: 'private-a',
                batchId: 'batch-a',
                createdAt: '2026-08-27T09:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
            {
                siteId: 'tenant-a',
                batchRecordId: 'private-b',
                batchId: 'batch-b',
                createdAt: '2026-08-27T10:00:00.000Z',
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
                orphanCount: 0,
                correlationComplete: true,
            },
        ]
        const { delegate } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a', siteId: 'tenant-a', fromEmail: 'news@example.test', contents: '',
                    batchId: 'batch-a', created: new Date('2026-08-27T09:00:00.000Z'),
                },
                'private-b': {
                    id: 'private-b', siteId: 'tenant-a', fromEmail: 'news@example.test', contents: '',
                    batchId: 'batch-b', created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [{
                    id: 'globally-duplicate', messageId: 'globally-duplicate', toEmail: 'a@example.test',
                    newsletterBatchId: 'private-a', created: new Date('2026-08-27T09:01:00.000Z'),
                    formatedContents: '', recipientData: null,
                }],
                'private-b': [{
                    id: 'globally-duplicate', messageId: 'globally-duplicate', toEmail: 'b@example.test',
                    newsletterBatchId: 'private-b', created: new Date('2026-08-27T10:01:00.000Z'),
                    formatedContents: '', recipientData: null,
                }],
            },
            orphanCounts: [0, 0],
        })

        await expect(collectRecords(delegate, candidates)).rejects.toThrow(
            'newsletterMessages id must be globally unique',
        )
    })

    it('rejects a schema-global notificationId collision across candidate batches', async () => {
        const candidates = ['a', 'b'].map((suffix, index) => ({
            siteId: 'tenant-a',
            batchRecordId: `private-${suffix}`,
            batchId: `batch-${suffix}`,
            createdAt: `2026-08-27T${String(index + 9).padStart(2, '0')}:00:00.000Z`,
            messageCount: 1,
            notificationCount: 1,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }))
        const { delegate } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a', siteId: 'tenant-a', fromEmail: 'news@example.test', contents: '',
                    batchId: 'batch-a', created: new Date('2026-08-27T09:00:00.000Z'),
                },
                'private-b': {
                    id: 'private-b', siteId: 'tenant-a', fromEmail: 'news@example.test', contents: '',
                    batchId: 'batch-b', created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [{
                    id: 'message-a', messageId: 'message-a', toEmail: 'a@example.test',
                    newsletterBatchId: 'private-a', created: new Date('2026-08-27T09:01:00.000Z'),
                    formatedContents: '', recipientData: null,
                }],
                'private-b': [{
                    id: 'message-b', messageId: 'message-b', toEmail: 'b@example.test',
                    newsletterBatchId: 'private-b', created: new Date('2026-08-27T10:01:00.000Z'),
                    formatedContents: '', recipientData: null,
                }],
            },
            notificationRowsByBatchId: {
                'private-a': [{
                    id: 'notification-a', type: 'Delivery', notificationId: 'duplicate-notification-id',
                    messageId: 'message-a', rawEvent: '', timestamp: new Date('2026-08-27T09:02:00.000Z'),
                    created: new Date('2026-08-27T09:03:00.000Z'),
                }],
                'private-b': [{
                    id: 'notification-b', type: 'Delivery', notificationId: 'duplicate-notification-id',
                    messageId: 'message-b', rawEvent: '', timestamp: new Date('2026-08-27T10:02:00.000Z'),
                    created: new Date('2026-08-27T10:03:00.000Z'),
                }],
            },
            orphanCounts: [0, 0],
        })

        await expect(collectRecords(delegate, candidates)).rejects.toThrow(
            'newsletterNotifications.notificationId must be globally unique',
        )
    })

    it('emits earlier candidate records before a later candidate fails', async () => {
        const secretFixture = 'secret-fixture-42'
        const validCandidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-ok',
            batchId: 'batch-ok',
            createdAt: '2026-08-27T09:30:00.000Z',
            messageCount: 1,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }
        const failingCandidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-bad',
            batchId: secretFixture,
            createdAt: '2026-08-27T11:30:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }

        const { delegate } = makeDelegate({
            batchRowsById: {
                'private-ok': {
                    id: 'private-ok',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: 'body',
                    batchId: 'batch-ok',
                    created: new Date('2026-08-27T09:30:00.000Z'),
                },
                'private-bad': {
                    id: 'private-bad',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: secretFixture,
                    batchId: 'stored-batch-id',
                    created: new Date('2026-08-27T11:30:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-ok': [
                    {
                        id: 'message-ok',
                        messageId: 'message-ok',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-ok',
                        created: new Date('2026-08-27T09:31:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                ],
            },
            orphanCounts: [0],
        })

        const seen: unknown[] = []
        let thrown: unknown
        try {
            for await (const record of streamNewsletterRetentionEscrowRecords(delegate, parseNewsletterRetentionPolicy({
                siteId: 'tenant-a',
                cutoff: '2026-08-27T12:00:00.000Z',
                maxBatches: 2,
                maxMessages: 10,
            }), [validCandidate, failingCandidate])) {
                seen.push(record)
            }
        } catch (error) {
            thrown = error
        }

        expect(thrown).toBeInstanceOf(Error)
        expect((thrown as Error).message).toBe('candidate batchId does not match the stored batch row')
        expect((thrown as Error).message).not.toContain(secretFixture)

        expect(seen).toEqual([
            {
                kind: 'newsletterBatch',
                manifestIndex: 0,
                row: {
                    id: 'private-ok',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: 'body',
                    batchId: 'batch-ok',
                    created: '2026-08-27T09:30:00.000Z',
                },
            },
            {
                kind: 'newsletterMessages',
                manifestIndex: 0,
                row: {
                    id: 'message-ok',
                    messageId: 'message-ok',
                    toEmail: 'reader@example.test',
                    newsletterBatchId: 'private-ok',
                    created: '2026-08-27T09:31:00.000Z',
                    formatedContents: 'body',
                    recipientData: null,
                },
            },
        ])
        expect(secretFixture).not.toBe('')
    })

    it.each([
        ['candidates must be an array', 'not-an-array', undefined],
        ['candidate count exceeds policy maxBatches', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }, {
            siteId: 'tenant-a',
            batchRecordId: 'private-b',
            batchId: 'batch-b',
            createdAt: '2026-08-27T11:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }, {
            siteId: 'tenant-a',
            batchRecordId: 'private-c',
            batchId: 'batch-c',
            createdAt: '2026-08-27T12:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }], undefined],
        ['candidate siteId must exactly match policy siteId', [{
            siteId: 'tenant-b',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }], undefined],
        ['candidate createdAt must be strictly before the cutoff', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T12:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }], undefined],
        ['candidate correlationComplete must be true', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: false,
        }], undefined],
        ['candidate orphanCount must be zero', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 1,
            correlationComplete: true,
        }], undefined],
        ['candidate batchRecordId must be unique', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }, {
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-b',
            createdAt: '2026-08-27T11:00:00.000Z',
            messageCount: 0,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }], undefined],
        ['messageCount total exceeds policy maxMessages', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 11,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }], parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 2,
            maxMessages: 10,
        })],
        ['messageCount must be a non-negative safe integer', [{
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: Number.MAX_SAFE_INTEGER + 1,
            notificationCount: 0,
            errorCount: 0,
            orphanCount: 0,
            correlationComplete: true,
        }], undefined],
    ])('fails closed before any delegate calls when %s', async (_label, candidateSet, maybePolicy) => {
        const { delegate, findFirst, messageFindMany, errorFindMany, notificationFindMany, orphanCount } = makeDelegate()
        const policy = maybePolicy ?? parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 2,
            maxMessages: 10,
        })

        await expect(collectRecords(delegate, candidateSet, policy)).rejects.toThrow()
        expect(findFirst).not.toHaveBeenCalled()
        expect(messageFindMany).not.toHaveBeenCalled()
        expect(errorFindMany).not.toHaveBeenCalled()
        expect(notificationFindMany).not.toHaveBeenCalled()
        expect(orphanCount).not.toHaveBeenCalled()
    })

    it('rejects drift, unsorted rows, duplicate PKs, foreign-key mismatches, and orphan races with sanitized errors', async () => {
        const policy = parseNewsletterRetentionPolicy({
            siteId: 'tenant-a',
            cutoff: '2026-08-27T12:00:00.000Z',
            maxBatches: 1,
            maxMessages: 10,
        })

        const baseCandidate = {
            siteId: 'tenant-a',
            batchRecordId: 'private-a',
            batchId: 'batch-a',
            createdAt: '2026-08-27T10:00:00.000Z',
            messageCount: 2,
            notificationCount: 1,
            errorCount: 1,
            orphanCount: 0,
            correlationComplete: true,
        }

        const { delegate: missingParent } = makeDelegate({
            batchRowsById: {},
        })
        await expect(collectRecords(missingParent, [baseCandidate], policy)).rejects.toThrow('candidate batch row must exist')

        const { delegate: unsortedMessages } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: 'body',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [
                    {
                        id: 'message-b',
                        messageId: 'message-b',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-a',
                        created: new Date('2026-08-27T10:01:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                    {
                        id: 'message-a',
                        messageId: 'message-a',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-a',
                        created: new Date('2026-08-27T10:02:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                ],
            },
        })
        await expect(collectRecords(unsortedMessages, [baseCandidate], policy)).rejects.toThrow(
            'newsletterMessages rows must be sorted by id and unique',
        )

        const { delegate: duplicateMessageId } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: 'body',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [
                    {
                        id: 'message-a',
                        messageId: 'message-a',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-a',
                        created: new Date('2026-08-27T10:01:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                    {
                        id: 'message-b',
                        messageId: 'message-a',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-a',
                        created: new Date('2026-08-27T10:02:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                ],
            },
        })
        await expect(collectRecords(duplicateMessageId, [baseCandidate], policy)).rejects.toThrow(
            'newsletterMessages.messageId must be unique',
        )

        const { delegate: notificationForeignKeyMismatch } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: 'body',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [
                    {
                        id: 'message-a',
                        messageId: 'message-a',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-a',
                        created: new Date('2026-08-27T10:01:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                ],
            },
            notificationRowsByBatchId: {
                'private-a': [
                    {
                        id: 'notification-a',
                        type: 'Delivery',
                        notificationId: 'notification-a',
                        messageId: 'secret-fixture-42',
                        rawEvent: 'body',
                        timestamp: new Date('2026-08-27T10:02:00.000Z'),
                        created: new Date('2026-08-27T10:03:00.000Z'),
                    },
                ],
            },
        })
        await expect(collectRecords(notificationForeignKeyMismatch, [{
            ...baseCandidate,
            messageCount: 1,
            notificationCount: 1,
            errorCount: 0,
        }], policy)).rejects.toThrow(
            'newsletterNotifications.messageId must belong to the current batch',
        )

        const { delegate: orphanRace } = makeDelegate({
            batchRowsById: {
                'private-a': {
                    id: 'private-a',
                    siteId: 'tenant-a',
                    fromEmail: 'news@example.test',
                    contents: 'body',
                    batchId: 'batch-a',
                    created: new Date('2026-08-27T10:00:00.000Z'),
                },
            },
            messageRowsByBatchId: {
                'private-a': [
                    {
                        id: 'message-a',
                        messageId: 'message-a',
                        toEmail: 'reader@example.test',
                        newsletterBatchId: 'private-a',
                        created: new Date('2026-08-27T10:01:00.000Z'),
                        formatedContents: 'body',
                        recipientData: null,
                    },
                ],
            },
            notificationRowsByBatchId: {
                'private-a': [],
            },
            orphanCounts: [1],
        })
        await expect(collectRecords(orphanRace, [
            {
                ...baseCandidate,
                messageCount: 1,
                notificationCount: 0,
                errorCount: 0,
            },
        ], policy)).rejects.toThrow('candidate orphan count must remain zero')
    })
})
