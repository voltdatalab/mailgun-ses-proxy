import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    startWorker: vi.fn(),
    validateAndSend: vi.fn(),
    handleNewsletterEmailEvent: vi.fn(),
    handleSystemEmailEvent: vi.fn(),
}))

vi.mock('@/lib/core/sqs-worker', () => ({
    startWorker: mocks.startWorker,
    normalizeSqsWorkerCount: (value: number) => Math.min(10, Math.max(1, Math.floor(value))),
}))
vi.mock('@/service/aws/awsHelper', () => ({
    QUEUE_URL: {
        NEWSLETTER: 'newsletter-url',
        NEWSLETTER_NOTIFICATION: 'newsletter-events-url',
        SYSTEM_NOTIFICATION: 'system-events-url',
    },
}))
vi.mock('@/service/newsletter-service', () => ({ validateAndSend: mocks.validateAndSend }))
vi.mock('@/service/events-service', () => ({ handleNewsletterEmailEvent: mocks.handleNewsletterEmailEvent }))
vi.mock('@/service/system-email-notification', () => ({ handleSystemEmailEvent: mocks.handleSystemEmailEvent }))

import {
    processNewsletterEventsQueue,
    processNewsletterQueue,
    processSystemEventsQueue,
} from '@/service/background-process'

describe('background SQS worker configuration', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        delete process.env.NEWSLETTER_EVENT_POLLER_COUNT
    })

    it('starts newsletter sends one at a time with a 15-minute visibility timeout', async () => {
        await processNewsletterQueue()

        expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            name: 'newsletter-sender',
            queueUrl: 'newsletter-url',
            visibilityTimeout: 900,
            batchSize: 1,
            maxConcurrency: 1,
            pollConcurrency: 1,
            handler: mocks.validateAndSend,
        }))
    })

    it('starts three newsletter-event poll loops by default without multiplying the sender', async () => {
        await processNewsletterEventsQueue()

        expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            name: 'newsletter-events',
            queueUrl: 'newsletter-events-url',
            visibilityTimeout: 120,
            handlerTimeoutMs: 90_000,
            batchSize: 10,
            maxConcurrency: 10,
            pollConcurrency: 3,
            handler: mocks.handleNewsletterEmailEvent,
        }))
    })

    it('bounds configured newsletter-event poll loops to the SQS worker limit', async () => {
        process.env.NEWSLETTER_EVENT_POLLER_COUNT = '99'
        await processNewsletterEventsQueue()
        expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({ pollConcurrency: 10 }))
    })

    it('keeps system events on one poll loop', async () => {
        await processSystemEventsQueue()

        expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            name: 'system-events',
            queueUrl: 'system-events-url',
            visibilityTimeout: 120,
            handlerTimeoutMs: 90_000,
            batchSize: 10,
            maxConcurrency: 10,
            pollConcurrency: 1,
            handler: mocks.handleSystemEmailEvent,
        }))
    })
})
