import { beforeEach, describe, expect, it, vi } from 'vitest'

const transaction = vi.hoisted(() => vi.fn())
const orphanFindUnique = vi.hoisted(() => vi.fn())
const messageFindUnique = vi.hoisted(() => vi.fn())
const notificationUpsert = vi.hoisted(() => vi.fn())
const orphanUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/database', () => ({
    prisma: {
        $transaction: transaction,
    },
}))

vi.mock('@/lib/core/aws-utils', () => ({}))

import { reconcileNewsletterNotificationOrphan } from '@/service/database/db'

const transactionClient = {
    newsletterNotificationOrphan: {
        findUnique: orphanFindUnique,
        update: orphanUpdate,
    },
    newsletterMessages: {
        findUnique: messageFindUnique,
    },
    newsletterNotifications: {
        upsert: notificationUpsert,
    },
}

beforeEach(() => {
    vi.clearAllMocks()
    transaction.mockImplementation(async (callback) => callback(transactionClient))
})

describe('reconcileNewsletterNotificationOrphan', () => {
    it('returns absent without writing when the exact orphan does not exist', async () => {
        orphanFindUnique.mockResolvedValue(null)

        await expect(reconcileNewsletterNotificationOrphan('orphan-notification-1')).resolves.toBe('absent')

        expect(messageFindUnique).not.toHaveBeenCalled()
        expect(notificationUpsert).not.toHaveBeenCalled()
        expect(orphanUpdate).not.toHaveBeenCalled()
    })

    it('keeps the orphan unchanged when its parent mapping is still absent', async () => {
        orphanFindUnique.mockResolvedValue({ messageId: 'fixture-message-1', reconciledAt: null })
        messageFindUnique.mockResolvedValue(null)

        await expect(reconcileNewsletterNotificationOrphan('orphan-notification-1')).resolves.toBe('parent_missing')

        expect(messageFindUnique).toHaveBeenCalledWith({ where: { messageId: 'fixture-message-1' }, select: { id: true } })
        expect(notificationUpsert).not.toHaveBeenCalled()
        expect(orphanUpdate).not.toHaveBeenCalled()
    })

    it('returns already_reconciled without writing when the audit row was previously reconciled', async () => {
        orphanFindUnique.mockResolvedValue({
            messageId: 'fixture-message-1',
            reconciledAt: new Date('2026-08-27T00:00:00.000Z'),
        })

        await expect(reconcileNewsletterNotificationOrphan('orphan-notification-1')).resolves.toBe('already_reconciled')

        expect(messageFindUnique).not.toHaveBeenCalled()
        expect(notificationUpsert).not.toHaveBeenCalled()
        expect(orphanUpdate).not.toHaveBeenCalled()
    })

    it('upserts one notification then marks the orphan reconciled without deleting its audit row', async () => {
        const timestamp = new Date('2026-08-26T00:00:00.000Z')
        orphanFindUnique.mockResolvedValue({
            id: 'orphan-row-1',
            notificationId: 'orphan-notification-1',
            messageId: 'fixture-message-1',
            type: 'delivered',
            timestamp,
            rawEvent: '{"fixture":true}',
            reconciledAt: null,
        })
        messageFindUnique.mockResolvedValue({ id: 'message-row-1' })
        notificationUpsert.mockResolvedValue({ id: 'notification-row-1' })
        orphanUpdate.mockResolvedValue({ id: 'orphan-row-1' })

        await expect(reconcileNewsletterNotificationOrphan('orphan-notification-1')).resolves.toBe('reconciled')

        expect(notificationUpsert).toHaveBeenCalledWith({
            where: { notificationId: 'orphan-notification-1' },
            create: {
                notificationId: 'orphan-notification-1',
                messageId: 'fixture-message-1',
                type: 'delivered',
                timestamp,
                rawEvent: '{"fixture":true}',
            },
            update: {
                notificationId: 'orphan-notification-1',
                messageId: 'fixture-message-1',
                type: 'delivered',
                timestamp,
                rawEvent: '{"fixture":true}',
            },
        })
        expect(orphanUpdate).toHaveBeenCalledWith({
            where: { id: 'orphan-row-1' },
            data: { reconciledAt: expect.any(Date) },
        })
    })
})
