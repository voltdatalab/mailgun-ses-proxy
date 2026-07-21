import type { Message } from '@aws-sdk/client-sqs'
import { describe, expect, it, vi } from 'vitest'

const log = vi.hoisted(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}))

vi.mock('@/lib/core/logger', () => ({
    default: { child: vi.fn(() => log) },
}))

import { processSqsMessages } from '@/lib/core/sqs-worker'

describe('SQS worker handler-error logging', () => {
    it('does not include message body or receipt handle in error metadata', async () => {
        const message: Message = {
            MessageId: 'message-id',
            Body: 'private message content',
            ReceiptHandle: 'private-receipt-handle',
            Attributes: { ApproximateReceiveCount: '2' },
        }

        await expect(processSqsMessages(
            { send: vi.fn() } as any,
            'https://sqs.example.test/queue',
            [message],
            vi.fn().mockRejectedValue(new Error('handler failure')),
        )).resolves.toBe(0)

        const metadata = log.error.mock.calls[0][0]
        expect(metadata).not.toHaveProperty('Body')
        expect(metadata).not.toHaveProperty('ReceiptHandle')
    })
})
