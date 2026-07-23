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
})