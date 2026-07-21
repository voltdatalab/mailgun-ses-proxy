import { DeleteMessageBatchCommand, type Message } from '@aws-sdk/client-sqs'
import { describe, expect, it, vi } from 'vitest'
import {
    buildReceiveInput,
    isHealthySqsPoll,
    normalizeSqsWorkerCount,
    processSqsMessage,
    processSqsMessages,
} from '@/lib/core/sqs-worker'

const queueUrl = 'https://sqs.example.test/queue'

function message(id: string, receiveCount = '1', receipt = `receipt-${id}`): Message {
    return {
        MessageId: id,
        ReceiptHandle: receipt,
        Attributes: { ApproximateReceiveCount: receiveCount },
    }
}

describe('SQS receive batching', () => {
    it.each([
        [0, 1],
        [-3, 1],
        [12, 10],
        [2.9, 2],
        [Number.NaN, 1],
        [Number.POSITIVE_INFINITY, 1],
    ])('normalizes batch and concurrency values %s to %s', (input, expected) => {
        // The same normalizer is used for ReceiveMessage batching and handler concurrency.
        expect(normalizeSqsWorkerCount(input)).toBe(expected)
        expect(buildReceiveInput(queueUrl, 30, 20, input).MaxNumberOfMessages).toBe(expected)
    })

    it('uses the configured batch size and preserves its long-poll wait', () => {
        expect(buildReceiveInput(queueUrl, 30, 20, 7).MaxNumberOfMessages).toBe(7)
        expect(buildReceiveInput(queueUrl, 30, 17, 1).WaitTimeSeconds).toBe(17)
    })
})

describe('SQS poll health policy', () => {
    it('treats empty long-polls as healthy without dispatching handlers or deletes', async () => {
        const send = vi.fn()
        const handler = vi.fn()

        expect(isHealthySqsPoll([], 0)).toBe(true)
        await expect(processSqsMessages({ send } as any, queueUrl, [], handler)).resolves.toBe(0)
        expect(handler).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it('requires an acknowledgement for a non-empty poll to be healthy', () => {
        expect(isHealthySqsPoll([message('one')], 0)).toBe(false)
        expect(isHealthySqsPoll([message('one')], 1)).toBe(true)
    })
})

describe('processSqsMessages', () => {
    it('never processes more handlers than maxConcurrency', async () => {
        let active = 0
        let peak = 0
        const release: Array<() => void> = []
        const handler = vi.fn(async () => {
            active++
            peak = Math.max(peak, active)
            await new Promise<void>(resolve => release.push(resolve))
            active--
        })
        const send = vi.fn().mockResolvedValue({ Successful: [] })
        const processing = processSqsMessages(
            { send } as any, queueUrl,
            [message('1'), message('2'), message('3')], handler, 2,
        )

        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
        expect(peak).toBe(2)
        release.splice(0).forEach(resolve => resolve())
        await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(3))
        release.splice(0).forEach(resolve => resolve())
        await processing
        expect(peak).toBe(2)
    })

    it('batch ACKs only handler-success messages that have a receipt handle', async () => {
        const send = vi.fn().mockResolvedValue({ Successful: [{ Id: 'entry-0' }] })
        const handler = vi.fn(async (item: Message) => {
            if (item.MessageId === 'bad') throw new Error('transient failure')
        })

        await expect(processSqsMessages(
            { send } as any, queueUrl,
            [message('good'), message('bad'), message('missing', '1', '')], handler, 10,
        )).resolves.toBe(1)

        expect(send).toHaveBeenCalledOnce()
        const command = send.mock.calls[0][0]
        expect(command).toBeInstanceOf(DeleteMessageBatchCommand)
        expect(command.input.Entries).toEqual([{ Id: 'entry-0', ReceiptHandle: 'receipt-good' }])
    })

    it('does not report failed batch-delete entries as acknowledged', async () => {
        const send = vi.fn().mockResolvedValue({
            Successful: [{ Id: 'entry-0' }],
            Failed: [{ Id: 'entry-1', Code: 'InternalError' }],
        })

        await expect(processSqsMessages(
            { send } as any, queueUrl, [message('one'), message('two')], vi.fn().mockResolvedValue(undefined), 10,
        )).resolves.toBe(1)
    })

    it('splits ACK requests into SQS-sized chunks', async () => {
        const messages = Array.from({ length: 11 }, (_, index) => message(`${index}`))
        const send = vi.fn()
            .mockResolvedValueOnce({ Successful: Array.from({ length: 10 }, (_, index) => ({ Id: `entry-${index}` })) })
            .mockResolvedValueOnce({ Successful: [{ Id: 'entry-0' }] })

        await expect(processSqsMessages(
            { send } as any, queueUrl, messages, vi.fn().mockResolvedValue(undefined), 10,
        )).resolves.toBe(11)

        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[0][0].input.Entries).toHaveLength(10)
        expect(send.mock.calls[1][0].input.Entries).toHaveLength(1)
    })

    it('reports zero acknowledgements when the batch delete request fails', async () => {
        const send = vi.fn().mockRejectedValue(new Error('SQS batch delete failed'))

        const acknowledged = await processSqsMessages(
            { send } as any, queueUrl, [message('one')], vi.fn().mockResolvedValue(undefined), 10,
        )
        expect(acknowledged).toBe(0)
        expect(isHealthySqsPoll([message('one')], acknowledged)).toBe(false)
    })
})

describe('processSqsMessage compatibility', () => {
    it('reports failure when acknowledgement fails after the handler resolves', async () => {
        const send = vi.fn().mockRejectedValue(new Error('SQS DeleteMessageBatch failed'))
        const handler = vi.fn().mockResolvedValue(undefined)

        await expect(processSqsMessage({ send } as any, queueUrl, message('one'), handler)).resolves.toBe(false)
        expect(handler).toHaveBeenCalledOnce()
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('does not delete when the handler throws a transient DB-equivalent failure', async () => {
        const send = vi.fn().mockResolvedValue({})
        const handler = vi.fn().mockRejectedValue(new Error('database temporarily unavailable'))

        await expect(processSqsMessage({ send } as any, queueUrl, message('one'), handler)).resolves.toBe(false)
        expect(send).not.toHaveBeenCalled()
    })

    it('never manually discards a high-receive-count failing message', async () => {
        const send = vi.fn().mockResolvedValue({})
        const handler = vi.fn().mockRejectedValue(new Error('still failing'))

        await expect(processSqsMessage({ send } as any, queueUrl, message('one', '99'), handler)).resolves.toBe(false)
        expect(send).not.toHaveBeenCalled()
    })
})
