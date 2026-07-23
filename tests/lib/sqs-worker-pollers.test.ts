import { GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('@/service/aws/awsHelper', () => ({
    sqsClient: () => ({ send: mocks.send }),
}))

vi.mock('@/lib/core/logger', () => ({
    default: {
        child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}))

import {
    _resetShutdownForTests,
    requestShutdown,
    startWorker,
} from '@/lib/core/sqs-worker'
import { resetWorkerRegistryForTests } from '@/lib/core/worker-registry'

describe('SQS receive poll concurrency', () => {
    beforeEach(() => {
        mocks.send.mockReset()
        _resetShutdownForTests()
        resetWorkerRegistryForTests()
    })

    afterEach(() => {
        requestShutdown()
        _resetShutdownForTests()
    })

    it('keeps the configured number of ReceiveMessage calls in flight', async () => {
        mocks.send.mockImplementation((command: unknown, options?: { abortSignal?: AbortSignal }) => {
            if (command instanceof GetQueueAttributesCommand) {
                return Promise.resolve({ Attributes: {} })
            }
            if (command instanceof ReceiveMessageCommand) {
                return new Promise((_resolve, reject) => {
                    options?.abortSignal?.addEventListener('abort', () => {
                        const error = new Error('request aborted')
                        error.name = 'AbortError'
                        reject(error)
                    }, { once: true })
                })
            }
            return Promise.resolve({})
        })

        const running = startWorker({
            name: 'newsletter-events',
            queueUrl: 'https://sqs.example.test/newsletter-events',
            batchSize: 10,
            maxConcurrency: 10,
            pollConcurrency: 3,
            handler: vi.fn(),
        })

        await vi.waitFor(() => {
            const receives = mocks.send.mock.calls.filter(([command]) => command instanceof ReceiveMessageCommand)
            expect(receives).toHaveLength(3)
        })

        requestShutdown()
        await expect(running).resolves.toBeUndefined()
    })

    it('aborts and drains sibling pollers before rejecting the worker group', async () => {
        let receiveCount = 0
        let siblingAborts = 0
        mocks.send.mockImplementation((command: unknown, options?: { abortSignal?: AbortSignal }) => {
            if (command instanceof GetQueueAttributesCommand) {
                return Promise.resolve({ Attributes: {} })
            }
            if (command instanceof ReceiveMessageCommand) {
                receiveCount += 1
                if (receiveCount === 1) {
                    return Promise.resolve({ Messages: [{ MessageId: 'event-1', ReceiptHandle: 'receipt-1' }] })
                }
                return new Promise((_resolve, reject) => {
                    options?.abortSignal?.addEventListener('abort', () => {
                        siblingAborts += 1
                        const error = new Error('request aborted')
                        error.name = 'AbortError'
                        reject(error)
                    }, { once: true })
                })
            }
            return Promise.resolve({})
        })

        const running = startWorker({
            name: 'newsletter-events',
            queueUrl: 'https://sqs.example.test/newsletter-events',
            batchSize: 10,
            maxConcurrency: 10,
            pollConcurrency: 3,
            handlerTimeoutMs: 50,
            handler: () => new Promise<void>(() => undefined),
        })

        await vi.waitFor(() => expect(receiveCount).toBe(3))
        await expect(running).rejects.toMatchObject({ name: 'HandlerTimeoutError' })
        expect(siblingAborts).toBe(2)
    })
})