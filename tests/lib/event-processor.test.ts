import { describe, expect, it, beforeEach, vi } from 'vitest'

const loggerMocks = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
}))

vi.mock('@/lib/core/logger', () => ({
    default: {
        child: () => loggerMocks,
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

beforeEach(() => {
    vi.clearAllMocks()
})

describe('createEventProcessor', () => {
    it.each([
        { MessageId: 'sqs-1' },
        { MessageId: 'sqs-1', Body: '' },
        { Body: trackedDeliveryEvent() },
    ])('rejects an empty SQS event message so it is not acknowledged', async (message: any) => {
        await expect(processor()(message)).rejects.toThrow('Invalid SQS event message')
    })

    it('rejects malformed event data so it is not acknowledged', async () => {
        await expect(processor()({ MessageId: 'sqs-1', Body: '{not-json' } as any)).rejects.toThrow()
    })

    it('acknowledges a valid untracked event without looking up or persisting it', async () => {
        const lookupMessage = vi.fn()
        const saveNotification = vi.fn()
        const persistMissingParentNotification = vi.fn()

        await expect(processor({ lookupMessage, saveNotification, persistMissingParentNotification })({
            MessageId: 'sqs-1',
            Body: untrackedDeliveryEvent(),
        } as any)).resolves.toBeUndefined()

        expect(lookupMessage).not.toHaveBeenCalled()
        expect(saveNotification).not.toHaveBeenCalled()
        expect(persistMissingParentNotification).not.toHaveBeenCalled()
    })

    it('acknowledges a tracked event with a successful normal save and no orphan persistence', async () => {
        const lookupMessage = vi.fn().mockResolvedValue({ id: 'db-message-1' })
        const saveNotification = vi.fn().mockResolvedValue(undefined)
        const persistMissingParentNotification = vi.fn()

        await expect(processor({ lookupMessage, saveNotification, persistMissingParentNotification })({
            MessageId: 'sqs-1',
            Body: trackedDeliveryEvent(),
        } as any)).resolves.toBeUndefined()

        expect(lookupMessage).toHaveBeenCalledOnce()
        expect(saveNotification).toHaveBeenCalledOnce()
        expect(persistMissingParentNotification).not.toHaveBeenCalled()
        expect(loggerMocks.info).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'events', type: 'delivered' }),
            'Processed event successfully',
        )
    })

    it('persists a missing parent orphan and resolves without exposing the message ID in logs', async () => {
        const lookupMessage = vi.fn().mockResolvedValue(null)
        const persistMissingParentNotification = vi.fn().mockResolvedValue({ id: 'orphan-row-1' })

        await expect(processor({ lookupMessage, persistMissingParentNotification })({
            MessageId: 'sqs-1',
            Body: trackedDeliveryEvent(),
        } as any)).resolves.toBeUndefined()

        expect(persistMissingParentNotification).toHaveBeenCalledOnce()
        expect(persistMissingParentNotification).toHaveBeenCalledWith(expect.objectContaining({
            messageId: 'ses-message-1',
            notificationId: 'sqs-1',
            type: 'delivered',
        }))
        expect(loggerMocks.warn).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'events', reason: 'missing_parent', type: 'delivered' }),
            'Tracked event parent missing; orphan persisted',
        )
        expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain('ses-message-1')
    })

    it('retries the orphan persistence path on event redelivery', async () => {
        const lookupMessage = vi.fn().mockResolvedValue(null)
        const persistMissingParentNotification = vi.fn().mockResolvedValue({ id: 'orphan-row-1' })
        const event = { MessageId: 'sqs-1', Body: trackedDeliveryEvent() } as any

        await expect(processor({ lookupMessage, persistMissingParentNotification })(event)).resolves.toBeUndefined()
        await expect(processor({ lookupMessage, persistMissingParentNotification })(event)).resolves.toBeUndefined()

        expect(persistMissingParentNotification).toHaveBeenCalledTimes(2)
    })

    it('rejects when orphan persistence fails so the worker does not ACK', async () => {
        const lookupMessage = vi.fn().mockResolvedValue(null)
        const persistMissingParentNotification = vi.fn().mockRejectedValue(new Error('orphan write failed'))

        await expect(processor({ lookupMessage, persistMissingParentNotification })({
            MessageId: 'sqs-1',
            Body: trackedDeliveryEvent(),
        } as any)).rejects.toThrow('orphan write failed')

        expect(persistMissingParentNotification).toHaveBeenCalledOnce()
    })

    it('persists an orphan when the normal save fails with a classified P2003 race', async () => {
        const saveNotification = vi.fn().mockRejectedValue({ code: 'P2003', meta: { field_name: 'messageId' } })
        const persistMissingParentNotification = vi.fn().mockResolvedValue({ id: 'orphan-row-1' })
        const isMissingParentSaveError = vi.fn().mockReturnValue(true)
        const lookupMessage = vi.fn().mockResolvedValue({ id: 'db-message-1' })

        await expect(processor({
            lookupMessage,
            saveNotification,
            persistMissingParentNotification,
            isMissingParentSaveError,
        })({ MessageId: 'sqs-1', Body: trackedDeliveryEvent() } as any)).resolves.toBeUndefined()

        expect(saveNotification).toHaveBeenCalledOnce()
        expect(isMissingParentSaveError).toHaveBeenCalledOnce()
        expect(persistMissingParentNotification).toHaveBeenCalledOnce()
    })

    it('rethrows non-FK save errors so they remain retryable', async () => {
        const saveNotification = vi.fn().mockRejectedValue(new Error('database write failed'))
        const persistMissingParentNotification = vi.fn()
        const isMissingParentSaveError = vi.fn().mockReturnValue(false)
        const lookupMessage = vi.fn().mockResolvedValue({ id: 'db-message-1' })

        await expect(processor({
            lookupMessage,
            saveNotification,
            persistMissingParentNotification,
            isMissingParentSaveError,
        })({ MessageId: 'sqs-1', Body: trackedDeliveryEvent() } as any)).rejects.toThrow('database write failed')

        expect(persistMissingParentNotification).not.toHaveBeenCalled()
    })

    it('rejects when the corresponding DB message is missing without callbacks configured', async () => {
        const lookupMessage = vi.fn().mockResolvedValue(null)
        const rejected = processor({ lookupMessage })({ MessageId: 'sqs-1', Body: trackedDeliveryEvent() } as any)

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
})
