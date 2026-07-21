import { DeleteMessageCommand, type Message } from '@aws-sdk/client-sqs'
import { describe, expect, it, vi } from 'vitest'
import { processSqsMessage } from '@/lib/core/sqs-worker'

const queueUrl = 'https://sqs.example.test/queue'

function message(receiveCount = '1'): Message {
    return {
        MessageId: 'message-1',
        ReceiptHandle: 'receipt-1',
        Attributes: { ApproximateReceiveCount: receiveCount },
    }
}

describe('processSqsMessage', () => {
    it('deletes exactly once when the handler resolves', async () => {
        const send = vi.fn().mockResolvedValue({})
        const handler = vi.fn().mockResolvedValue(undefined)

        await expect(processSqsMessage({ send } as any, queueUrl, message(), handler)).resolves.toBe(true)

        expect(handler).toHaveBeenCalledOnce()
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteMessageCommand)
    })

    it('does not delete when the handler throws a transient DB-equivalent failure', async () => {
        const send = vi.fn().mockResolvedValue({})
        const handler = vi.fn().mockRejectedValue(new Error('database temporarily unavailable'))

        await expect(processSqsMessage({ send } as any, queueUrl, message(), handler)).resolves.toBe(false)

        expect(send).not.toHaveBeenCalled()
    })

    it('never manually discards a high-receive-count failing message', async () => {
        const send = vi.fn().mockResolvedValue({})
        const handler = vi.fn().mockRejectedValue(new Error('still failing'))

        await expect(processSqsMessage({ send } as any, queueUrl, message('99'), handler)).resolves.toBe(false)

        expect(handler).toHaveBeenCalledOnce()
        expect(send).not.toHaveBeenCalled()
    })
})
