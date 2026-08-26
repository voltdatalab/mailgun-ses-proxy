import { beforeEach, describe, expect, it, vi } from 'vitest'

const transaction = vi.hoisted(() => vi.fn())
const orphanFindUnique = vi.hoisted(() => vi.fn())
const messageFindUnique = vi.hoisted(() => vi.fn())
const notificationUpsert = vi.hoisted(() => vi.fn())
const orphanDelete = vi.hoisted(() => vi.fn())

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
        delete: orphanDelete,
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
        expect(orphanDelete).not.toHaveBeenCalled()
    })

    it('keeps the orphan unchanged when its parent mapping is still absent', async () => {
        orphanFindUnique.mockResolvedValue({ messageId: 'fixture-message-1' })
        messageFindUnique.mockResolvedValue(null)

        await expect(reconcileNewsletterNotificationOrphan('orphan-notification-1')).resolves.toBe('parent_missing')

        expect(messageFindUnique).toHaveBeenCalledWith({ where: { messageId: 'fixture-message-1' }, select: { id: true } })
        expect(notificationUpsert).not.toHaveBeenCalled()
        expect(orphanDelete).not.toHaveBeenCalled()
    })

    it('upserts one notification then removes only that orphan in the same transaction', async () => {
        const timestamp = new Date('2026-08-26T00:00:00.000Z')
        orphanFindUnique.mockResolvedValue({
            id: 'orphan-row-1',
            notificationId: 'orphan-notification-1',
            messageId: 'fixture-message-1',
            type: 'delivered',
            timestamp,
            rawEvent: '{"fixture":true}',
        })
        messageFindUnique.mockResolvedValue({ id: 'message-row-1' })
        notificationUpsert.mockResolvedValue({ id: 'notification-row-1' })
        orphanDelete.mockResolvedValue({ id: 'orphan-row-1' })

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
        expect(orphanDelete).toHaveBeenCalledWith({ where: { id: 'orphan-row-1' } })
    })
})
