import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as publicGET } from '@/app/healthcheck/route'
import { GET as opsGET } from '@/app/ops/health/route'
import { beginWorkerProcessing, endWorkerProcessing, getWorkerStatuses, heartbeat, markWorkerDead, recordQueueTelemetry, recordWorkerProcessing, registerWorker, resetWorkerRegistryForTests } from '@/lib/core/worker-registry'

const names = ['newsletter-sender', 'newsletter-events', 'system-events']
function readyWorkers() {
    for (const name of names) {
        registerWorker(name)
        heartbeat(name)
        recordQueueTelemetry(name, { visible: 0, notVisible: 0, delayed: 0, sampledAt: Date.now() })
    }
}
async function response(handler = opsGET) { const result = handler(); return { status: result.status, body: await result.json() } }

describe('/healthcheck safe operational health', () => {
    beforeEach(() => resetWorkerRegistryForTests())
    it('returns 503 for a missing expected worker rather than an empty healthy registry', async () => {
        const result = await response(publicGET)
        expect(result.status).toBe(503)
        expect(result.body).toEqual({ status: 'unhealthy', ready: false, degraded: true, timestamp: expect.any(String) })
    })
    it('keeps detailed worker snapshots on authenticated /ops/health only', async () => {
        readyWorkers()
        const result = await response()
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ status: 'ok', ready: true, degraded: false, backlog: { visible: 0, notVisible: 0, delayed: 0, telemetryStale: false } })
    })
    it('never exposes worker telemetry or counters on public health', async () => {
        readyWorkers()
        const result = await response(publicGET)
        expect(result.status).toBe(200)
        expect(result.body).toEqual({ status: 'ok', ready: true, degraded: false, timestamp: expect.any(String) })
        expect(JSON.stringify(result.body)).not.toMatch(/worker|backlog|queue|received|telemetry/i)
    })
    it('keeps HTTP 200 but marks backlog telemetry degraded', async () => {
        readyWorkers()
        recordQueueTelemetry('newsletter-sender', { visible: 1000, notVisible: 0, delayed: 0, sampledAt: Date.now() })
        const result = await response()
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ status: 'degraded', ready: true, degraded: true })
    })
    it('returns 503 for a stale worker heartbeat', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        readyWorkers()
        vi.advanceTimersByTime(60_000)
        const result = await response()
        expect(result.status).toBe(503)
        expect(result.body.workers.some((worker: { stale: boolean }) => worker.stale)).toBe(true)
        vi.useRealTimers()
    })
    it('keeps a newsletter worker ready while it is processing within its 900 second visibility deadline', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        readyWorkers()
        vi.advanceTimersByTime(61_000)
        heartbeat('newsletter-events')
        heartbeat('system-events')
        beginWorkerProcessing('newsletter-sender', 900_000)

        const result = await response()

        expect(result.status).toBe(200)
        expect(result.body.workers.find((worker: { name: string }) => worker.name === 'newsletter-sender')).toMatchObject({ processing: true, stale: false })
        vi.useRealTimers()
    })
    it('returns 503 when active processing exceeds its deadline', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        readyWorkers()
        beginWorkerProcessing('newsletter-sender', 900_000)
        vi.advanceTimersByTime(900_000)

        const result = await response()

        expect(result.status).toBe(503)
        expect(result.body.workers.find((worker: { name: string }) => worker.name === 'newsletter-sender')).toMatchObject({ processing: true, stale: true })
        vi.useRealTimers()
    })
    it('clears busy state when processing finishes', () => {
        registerWorker('newsletter-sender')
        beginWorkerProcessing('newsletter-sender', 900_000)
        endWorkerProcessing('newsletter-sender')

        expect(getWorkerStatuses()[0]).toMatchObject({ processing: false, processingStartedAt: null, processingDeadlineAt: null })
    })
    it('clears stale observed message age after an empty long poll without erasing its observation timestamp', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        readyWorkers()
        recordWorkerProcessing('newsletter-sender', { lastMessageAgeMs: 15 * 60_000 })
        const before = await response()
        expect(before.status).toBe(200)
        expect(before.body).toMatchObject({ status: 'degraded', backlog: { oldestObservedAgeMs: 15 * 60_000 } })
        const observedAt = before.body.workers.find((worker: { name: string }) => worker.name === 'newsletter-sender').lastMessageAt

        recordWorkerProcessing('newsletter-sender', { lastMessageAgeMs: null })
        const after = await response()
        const worker = after.body.workers.find((item: { name: string }) => item.name === 'newsletter-sender')
        expect(after.body).toMatchObject({ status: 'ok', degraded: false, backlog: { oldestObservedAgeMs: 0 } })
        expect(worker).toMatchObject({ lastMessageAgeMs: null, lastMessageAt: observedAt })
        vi.useRealTimers()
    })
    it('returns 503 for a dead worker and never serializes secrets/errors', async () => {
        readyWorkers()
        const hostile = new Error('recipient@example.test https://queue/private')
        hostile.name = 'Worker/Error! ' + 'A'.repeat(65)
        markWorkerDead('system-events', hostile)
        const result = await response()
        expect(result.status).toBe(503)
        expect(result.body.workers.find((worker: { name: string }) => worker.name === 'system-events').telemetryErrorClass).toBe('Error')
        const json = JSON.stringify(result.body)
        expect(json).not.toMatch(/recipient|queue\/private|lastError|ReceiptHandle|Body/i)
        expect(json).not.toContain('Worker/Error!')
    })
})
