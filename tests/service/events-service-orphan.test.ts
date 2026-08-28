import { describe, expect, it, vi, beforeEach } from 'vitest'

const getNewsletterMessage = vi.hoisted(() => vi.fn())
const saveNewsletterNotification = vi.hoisted(() => vi.fn())
const saveNewsletterNotificationOrphan = vi.hoisted(() => vi.fn())
const isNewsletterNotificationForeignKeyError = vi.hoisted(() => vi.fn())

vi.mock('@/service/database/db', () => ({
    getNewsletterMessage,
    saveNewsletterNotification,
    saveNewsletterNotificationOrphan,
    isNewsletterNotificationForeignKeyError,
}))

vi.mock('@/lib/core/logger', () => ({
    default: {
        child: () => ({
            info: vi.fn(),
            warn: vi.fn(),
        }),
    },
}))

import { handleNewsletterEmailEvent } from '@/service/events-service'

beforeEach(() => {
    vi.clearAllMocks()
})

function newsletterEvent() {
    return {
        MessageId: 'sqs-newsletter-1',
        Body: JSON.stringify({
            eventType: 'Delivery',
            mail: {
                messageId: 'newsletter-message-1',
                tags: { 'ghost-email': ['true'] },
            },
        }),
    } as any
}

describe('handleNewsletterEmailEvent', () => {
    it('persists a missing-parent orphan and acknowledges the message', async () => {
        getNewsletterMessage.mockResolvedValue(null)
        saveNewsletterNotificationOrphan.mockResolvedValue({ id: 'orphan-1' })

        await expect(handleNewsletterEmailEvent(newsletterEvent())).resolves.toBeUndefined()

        expect(getNewsletterMessage).toHaveBeenCalledWith('newsletter-message-1')
        expect(saveNewsletterNotification).not.toHaveBeenCalled()
        expect(saveNewsletterNotificationOrphan).toHaveBeenCalledOnce()
    })

    it('uses the classified P2003 fallback for a normal save race', async () => {
        getNewsletterMessage.mockResolvedValue({ id: 'newsletter-row-1' })
        saveNewsletterNotification.mockRejectedValue({ code: 'P2003', meta: { field_name: 'messageId' } })
        isNewsletterNotificationForeignKeyError.mockReturnValue(true)
        saveNewsletterNotificationOrphan.mockResolvedValue({ id: 'orphan-1' })

        await expect(handleNewsletterEmailEvent(newsletterEvent())).resolves.toBeUndefined()

        expect(saveNewsletterNotification).toHaveBeenCalledOnce()
        expect(isNewsletterNotificationForeignKeyError).toHaveBeenCalledOnce()
        expect(saveNewsletterNotificationOrphan).toHaveBeenCalledOnce()
    })

    it('rethrows non-FK save errors', async () => {
        getNewsletterMessage.mockResolvedValue({ id: 'newsletter-row-1' })
        saveNewsletterNotification.mockRejectedValue(new Error('database write failed'))
        isNewsletterNotificationForeignKeyError.mockReturnValue(false)

        await expect(handleNewsletterEmailEvent(newsletterEvent())).rejects.toThrow('database write failed')
        expect(saveNewsletterNotificationOrphan).not.toHaveBeenCalled()
    })
})
