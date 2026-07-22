import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    startWorker: vi.fn(),
    validateAndSend: vi.fn(),
    handleNewsletterEmailEvent: vi.fn(),
    handleSystemEmailEvent: vi.fn(),
}))

vi.mock('@/lib/core/sqs-worker', () => ({ startWorker: mocks.startWorker }))
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
    beforeEach(() => vi.clearAllMocks())

    it('starts newsletter sends one at a time with a 15-minute visibility timeout', async () => {
        await processNewsletterQueue()

        expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            name: 'newsletter-sender',
            queueUrl: 'newsletter-url',
            visibilityTimeout: 900,
            batchSize: 1,
            maxConcurrency: 1,
            handler: mocks.validateAndSend,
        }))
    })

    it.each([
        ['newsletter events', processNewsletterEventsQueue, 'newsletter-events', 'newsletter-events-url', mocks.handleNewsletterEmailEvent],
        ['system events', processSystemEventsQueue, 'system-events', 'system-events-url', mocks.handleSystemEmailEvent],
    ])('starts %s with a 10-message, 10-handler pool and a conservative visibility deadline', async (_label, start, name, queueUrl, handler) => {
        await start()

        expect(mocks.startWorker).toHaveBeenCalledWith(expect.objectContaining({
            name,
            queueUrl,
            visibilityTimeout: 120,
            handlerTimeoutMs: 90_000,
            batchSize: 10,
            maxConcurrency: 10,
            handler,
        }))
    })
})
