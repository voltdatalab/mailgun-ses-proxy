import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/core/logger', () => ({
    default: {
        child: () => ({
            info: vi.fn(),
            warn: vi.fn(),
        }),
    },
}))
import { createEventProcessor, TrackedEventMessageMissingError } from '@/lib/core/event-processor'

function trackedDeliveryEvent() {
    return JSON.stringify({
        eventType: 'Delivery',
        mail: {
            messageId: 'ses-message-1',
            tags: { 'ghost-email': ['true'] },
        },
    })
}

function untrackedDeliveryEvent() {
    return JSON.stringify({
        eventType: 'Delivery',
        mail: {
            messageId: 'ses-message-untracked',
            tags: {},
        },
    })
}

function processor(overrides: Partial<Parameters<typeof createEventProcessor>[0]> = {}) {
    return createEventProcessor({
        name: 'events',
        lookupMessage: vi.fn().mockResolvedValue({ id: 'db-message-1' }),
        saveNotification: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    })
}

describe('createEventProcessor', () => {
    it.each([
        { MessageId: 'sqs-1' },
        { MessageId: 'sqs-1', Body: '' },
        { Body: trackedDeliveryEvent() },
    ])('rejects an empty SQS event message so it is not acknowledged', async (message) => {
        await expect(processor()(message)).rejects.toThrow('Invalid SQS event message')
    })

    it('rejects malformed event data so it is not acknowledged', async () => {
        await expect(processor()({ MessageId: 'sqs-1', Body: '{not-json' })).rejects.toThrow()
    })

    it('acknowledges a valid untracked event without looking up or persisting it', async () => {
        const lookupMessage = vi.fn()
        const saveNotification = vi.fn()

        await expect(processor({ lookupMessage, saveNotification })({
            MessageId: 'sqs-1',
            Body: untrackedDeliveryEvent(),
        })).resolves.toBeUndefined()

        expect(lookupMessage).not.toHaveBeenCalled()
        expect(saveNotification).not.toHaveBeenCalled()
    })

    it('rejects when the corresponding DB message is missing', async () => {
        const lookupMessage = vi.fn().mockResolvedValue(null)
        const rejected = processor({ lookupMessage })({ MessageId: 'sqs-1', Body: trackedDeliveryEvent() })

        await expect(rejected).rejects.toBeInstanceOf(TrackedEventMessageMissingError)
        await expect(rejected).rejects.toThrow('Tracked event message missing')

        try {
            await rejected
        } catch (error) {
            expect(error).toBeInstanceOf(TrackedEventMessageMissingError)
            expect(error).toHaveProperty('message')
            expect((error as Error).message).not.toContain('ses-message-1')
        }
    })

    it('rejects when notification persistence fails', async () => {
        const saveNotification = vi.fn().mockRejectedValue(new Error('database write failed'))

        await expect(processor({ saveNotification })({ MessageId: 'sqs-1', Body: trackedDeliveryEvent() }))
            .rejects.toThrow('database write failed')
    })
})
