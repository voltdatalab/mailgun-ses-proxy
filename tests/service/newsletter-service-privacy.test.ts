import type { Message } from '@aws-sdk/client-sqs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    getNewsletterContent: vi.fn(),
    createNewsletterEntry: vi.fn(),
    createNewsletterErrorEntry: vi.fn(),
    checkNewsletterAlreadySent: vi.fn(),
    sesSend: vi.fn(),
    preparePayload: vi.fn(),
}))

vi.unmock('@/service/newsletter-service')

vi.mock('@/lib/core/logger', () => ({
    default: { child: vi.fn(() => mocks.log) },
}))
vi.mock('@/service/aws/awsHelper', () => ({
    sqsClient: vi.fn(),
    sesNewsletterClient: () => ({ send: mocks.sesSend }),
    QUEUE_URL: { NEWSLETTER: 'https://sqs.example.test/newsletter' },
}))
vi.mock('@/service/database/db', () => ({
    checkNewsletterAlreadySent: mocks.checkNewsletterAlreadySent,
    createNewsletterBatchEntry: vi.fn(),
    createNewsletterEntry: mocks.createNewsletterEntry,
    createNewsletterErrorEntry: mocks.createNewsletterErrorEntry,
    getNewsletterContent: mocks.getNewsletterContent,
    shouldPersistNewsletterFormattedContents: vi.fn(() => false),
}))
vi.mock('@/lib/core/aws-utils', () => ({
    preparePayload: mocks.preparePayload,
}))
vi.mock('@/lib/task-queue', () => ({
    TaskQueue: class {
        private readonly tasks: Promise<unknown>[] = []

        enqueue(task: () => Promise<unknown>) {
            this.tasks.push(task())
        }

        async waitUntilFinished() {
            const results = await Promise.allSettled(this.tasks)
            const failedCount = results.filter((result) => result.status === 'rejected').length
            return { settledCount: results.length, failedCount, totalDuration: 0 }
        }
    },
}))

import { validateAndSend } from '@/service/newsletter-service'

const recipient = 'recipient.private@example.test'
const body = 'private-newsletter-batch-body'
const receiptHandle = 'private-sqs-receipt-handle'
const from = 'sender.private@example.test'

function loggedMetadata() {
    return [...mocks.log.error.mock.calls, ...mocks.log.info.mock.calls]
        .map(([metadata]) => JSON.stringify(metadata))
        .join('\n')
}

describe('newsletter service privacy and retry behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.checkNewsletterAlreadySent.mockResolvedValue(false)
    })

    it('rejects invalid SQS messages for retry/redrive without logging payload or attributes', async () => {
        const message: Message = {
            MessageId: 'safe-message-id',
            Body: body,
            ReceiptHandle: receiptHandle,
            Attributes: { ApproximateReceiveCount: '2' },
            MessageAttributes: {
                from: { DataType: 'String', StringValue: from },
                siteId: { DataType: 'String', StringValue: 'private-site-id' },
            },
        }

        await expect(validateAndSend({ ...message, MessageAttributes: { from: message.MessageAttributes!.from } }))
            .rejects.toThrow('Invalid newsletter SQS message')

        expect(mocks.log.error).toHaveBeenCalledWith(
            'invalid or incomplete SQS message; leaving for retry/redrive'
        )
        const output = loggedMetadata()
        for (const secret of [body, receiptHandle, from, 'private-site-id']) {
            expect(output).not.toContain(secret)
        }
    })

    it('throws when the referenced newsletter batch is absent so the message is not ACKed', async () => {
        mocks.getNewsletterContent.mockResolvedValue(null)
        const message = {
            MessageId: 'safe-message-id',
            Body: 'newsletter-batch-123',
            MessageAttributes: {
                from: { DataType: 'String', StringValue: from },
                siteId: { DataType: 'String', StringValue: 'site-123' },
            },
        } as Message

        await expect(validateAndSend(message)).rejects.toThrow('Newsletter batch not found')
        expect(mocks.log.error).toHaveBeenCalledWith(
            { newsletterBatchId: 'newsletter-batch-123', siteId: 'site-123' },
            'Newsletter batch not found in DB; leaving message for retry/redrive',
        )
    })

    it('logs SES failures with identifiers and errorClass only, never recipient data', async () => {
        mocks.getNewsletterContent.mockResolvedValue({ 'v:email-id': 'batch-safe-id' })
        mocks.preparePayload.mockReturnValue([{
            request: { Destination: { ToAddresses: [recipient] } },
            recipientVariables: { email: recipient },
        }])
        mocks.sesSend.mockRejectedValue(new Error('SES credential secret'))

        await expect(validateAndSend({
            MessageId: 'safe-message-id',
            Body: 'newsletter-batch-123',
            ReceiptHandle: receiptHandle,
            MessageAttributes: {
                from: { DataType: 'String', StringValue: from },
                siteId: { DataType: 'String', StringValue: 'site-123' },
            },
        } as Message)).rejects.toThrow('1/1 emails failed in batch batch-safe-id')

        const sesLog = mocks.log.error.mock.calls.find(([, message]) => message === 'SES send failed')
        expect(sesLog?.[0]).toMatchObject({ errorClass: 'Error', siteId: 'site-123' })
        expect(sesLog?.[0]).not.toHaveProperty('err')
        expect(sesLog?.[0]).not.toHaveProperty('toEmail')
        const output = loggedMetadata()
        for (const secret of [recipient, body, receiptHandle, from, 'SES credential secret']) {
            expect(output).not.toContain(secret)
        }
    })
})
