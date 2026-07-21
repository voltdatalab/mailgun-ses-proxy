import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { buildQueueAttributesInput, normalizeTelemetrySampleInterval, observedMessageAgeMs, sampleQueueTelemetry } from '@/lib/core/sqs-worker'
import { getWorkerStatuses, registerWorker, resetWorkerRegistryForTests } from '@/lib/core/worker-registry'

describe('SQS queue telemetry', () => {
    beforeEach(() => resetWorkerRegistryForTests())
    it('requests only queue depth attributes and caches parsed safe counts', async () => {
        registerWorker('newsletter-sender')
        const send = vi.fn().mockResolvedValue({ Attributes: {
            ApproximateNumberOfMessages: '12', ApproximateNumberOfMessagesNotVisible: '3', ApproximateNumberOfMessagesDelayed: 'bad',
        } })
        await expect(sampleQueueTelemetry({ send } as any, 'newsletter-sender', 'https://private.queue')).resolves.toBe(true)
        expect(send.mock.calls[0][0]).toBeInstanceOf(GetQueueAttributesCommand)
        expect(buildQueueAttributesInput('url').AttributeNames).toEqual(['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'])
        expect(getWorkerStatuses()[0].queue).toMatchObject({ visible: 12, notVisible: 3, delayed: null })
    })
    it('isolates telemetry failures and retains only error class', async () => {
        registerWorker('newsletter-sender')
        await expect(sampleQueueTelemetry({ send: vi.fn().mockRejectedValue(new Error('https://private.queue receipt body')) } as any, 'newsletter-sender', 'https://private.queue')).resolves.toBe(false)
        const worker = getWorkerStatuses()[0]
        expect(worker.telemetryErrorClass).toBe('Error')
        expect(JSON.stringify(worker)).not.toContain('private.queue')
    })
    it('clamps the sampling interval to 10 seconds through five minutes', () => {
        expect(normalizeTelemetrySampleInterval()).toBe(30_000)
        expect(normalizeTelemetrySampleInterval(1)).toBe(10_000)
        expect(normalizeTelemetrySampleInterval(999_999)).toBe(300_000)
    })
    it('uses SentTimestamp only for nonnegative observed age and clamps future messages', () => {
        const now = Date.now()
        expect(observedMessageAgeMs([{ Attributes: { SentTimestamp: String(now + 5_000) } }])).toBe(0)
        expect(observedMessageAgeMs([{ Attributes: { SentTimestamp: String(now - 2_000) } }, { Attributes: { SentTimestamp: 'bad' } }])).toBeGreaterThanOrEqual(2_000)
    })
})
