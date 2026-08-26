import { describe, expect, it, vi, beforeEach } from 'vitest'

const notificationUpsert = vi.hoisted(() => vi.fn())
const orphanUpsert = vi.hoisted(() => vi.fn())

vi.mock('@/lib/database', () => ({
    prisma: {
        newsletterNotifications: { upsert: notificationUpsert },
        newsletterNotificationOrphan: { upsert: orphanUpsert },
    },
}))

vi.mock('@/lib/core/aws-utils', () => ({}))

import { isNewsletterNotificationForeignKeyError, saveNewsletterNotification, saveNewsletterNotificationOrphan } from '@/service/database/db'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('service/database/db newsletter notification persistence', () => {
    it('saves newsletter notifications with only the tracked event fields', async () => {
        const event = {
            notificationId: 'notif-1',
            messageId: 'message-1',
            type: 'delivery',
            timestamp: new Date('2026-01-01T00:00:00.000Z'),
            raw: '{"eventType":"Delivery"}',
        } as any

        await saveNewsletterNotification(event)

        expect(notificationUpsert).toHaveBeenCalledOnce()
        expect(notificationUpsert).toHaveBeenCalledWith({
            where: { notificationId: 'notif-1' },
            create: {
                messageId: 'message-1',
                notificationId: 'notif-1',
                rawEvent: '{"eventType":"Delivery"}',
                timestamp: new Date('2026-01-01T00:00:00.000Z'),
                type: 'delivery',
            },
            update: {
                messageId: 'message-1',
                notificationId: 'notif-1',
                rawEvent: '{"eventType":"Delivery"}',
                timestamp: new Date('2026-01-01T00:00:00.000Z'),
                type: 'delivery',
            },
        })
    })

    it('saves newsletter orphans with a fixed missing_parent reason and no FK fields', async () => {
        const event = {
            notificationId: 'notif-2',
            messageId: 'message-2',
            type: 'bounce',
            timestamp: new Date('2026-01-01T00:00:00.000Z'),
            raw: '{"eventType":"Bounce"}',
        } as any

        await saveNewsletterNotificationOrphan(event)

        expect(orphanUpsert).toHaveBeenCalledOnce()
        expect(orphanUpsert).toHaveBeenCalledWith({
            where: { notificationId: 'notif-2' },
            create: {
                messageId: 'message-2',
                notificationId: 'notif-2',
                rawEvent: '{"eventType":"Bounce"}',
                reason: 'missing_parent',
                timestamp: new Date('2026-01-01T00:00:00.000Z'),
                type: 'bounce',
            },
            update: {
                messageId: 'message-2',
                notificationId: 'notif-2',
                rawEvent: '{"eventType":"Bounce"}',
                reason: 'missing_parent',
                timestamp: new Date('2026-01-01T00:00:00.000Z'),
                type: 'bounce',
            },
        })
        expect(Object.keys(orphanUpsert.mock.calls[0][0].create).sort()).toEqual([
            'messageId',
            'notificationId',
            'rawEvent',
            'reason',
            'timestamp',
            'type',
        ])
    })

    it('only classifies Prisma P2003 known request errors as missing-parent FK races', () => {
        expect(isNewsletterNotificationForeignKeyError({ code: 'P2003', meta: { field_name: 'messageId' } })).toBe(true)
        expect(isNewsletterNotificationForeignKeyError({ code: 'P2025', meta: { field_name: 'messageId' } })).toBe(false)
        expect(isNewsletterNotificationForeignKeyError(new Error('boom'))).toBe(false)
        expect(isNewsletterNotificationForeignKeyError(null)).toBe(false)
    })
})
