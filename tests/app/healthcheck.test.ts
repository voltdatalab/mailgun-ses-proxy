import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/healthcheck/route'
import { heartbeat, markWorkerDead, recordQueueTelemetry, registerWorker, resetWorkerRegistryForTests } from '@/lib/core/worker-registry'

const names = ['newsletter-sender', 'newsletter-events', 'system-events']
function readyWorkers() {
    for (const name of names) {
        registerWorker(name)
        heartbeat(name)
        recordQueueTelemetry(name, { visible: 0, notVisible: 0, delayed: 0, sampledAt: Date.now() })
    }
}
async function response() { const result = GET(); return { status: result.status, body: await result.json() } }

describe('/healthcheck safe operational health', () => {
    beforeEach(() => resetWorkerRegistryForTests())
    it('returns 503 for a missing expected worker rather than an empty healthy registry', async () => {
        const result = await response()
        expect(result.status).toBe(503)
        expect(result.body).toMatchObject({ status: 'unhealthy', ready: false })
        expect(result.body.workers).toHaveLength(3)
    })
    it('returns ready 200 with safe worker snapshots', async () => {
        readyWorkers()
        const result = await response()
        expect(result.status).toBe(200)
        expect(result.body).toMatchObject({ status: 'ok', ready: true, degraded: false, backlog: { visible: 0, notVisible: 0, delayed: 0, telemetryStale: false } })
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
    it('returns 503 for a dead worker and never serializes secrets/errors', async () => {
        readyWorkers()
        markWorkerDead('system-events', new Error('recipient@example.test https://queue/private'))
        const result = await response()
        expect(result.status).toBe(503)
        const json = JSON.stringify(result.body)
        expect(json).not.toMatch(/recipient|queue\/private|lastError|ReceiptHandle|Body/i)
    })
})
