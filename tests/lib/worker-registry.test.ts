import { describe, expect, it, beforeEach } from 'vitest'
import {
    EXPECTED_WORKER_NAMES,
    getWorkerStatuses,
    markWorkerDead,
    recordQueueTelemetry,
    recordTelemetryError,
    registerWorker,
    resetWorkerRegistryForTests,
} from '@/lib/core/worker-registry'

describe('worker telemetry registry', () => {
    beforeEach(() => resetWorkerRegistryForTests())

    it('returns immutable safe snapshots including stale workers', () => {
        registerWorker('newsletter-sender')
        recordQueueTelemetry('newsletter-sender', { visible: 3, notVisible: 2, delayed: 1, sampledAt: 1 })
        recordTelemetryError('newsletter-sender', new Error('https://secret.example/queue receipt private'))
        const worker = getWorkerStatuses(1)[0]

        expect(worker).toMatchObject({ name: 'newsletter-sender', alive: false, stale: true, telemetryErrorClass: 'Error' })
        expect(worker.queue).toEqual({ visible: 3, notVisible: 2, delayed: 1, sampledAt: 1 })
        expect(JSON.stringify(worker)).not.toContain('secret.example')
        expect(() => { worker.queue.visible = 99 }).toThrow()
        expect(EXPECTED_WORKER_NAMES).toEqual(['newsletter-sender', 'newsletter-events', 'system-events'])
    })

    it('does not expose raw death errors and returns copies', () => {
        registerWorker('system-events')
        markWorkerDead('system-events', new Error('recipient@example.test private stack'))
        const first = getWorkerStatuses()[0]
        const second = getWorkerStatuses()[0]

        expect(first).toMatchObject({ alive: false, telemetryErrorClass: 'Error' })
        expect(JSON.stringify(first)).not.toContain('recipient@example.test')
        expect(first).not.toBe(second)
    })

    it('bounds hostile telemetry and death error names before storing them', () => {
        registerWorker('newsletter-events')
        const hostile = new Error('recipient@example.test private stack')
        hostile.name = 'Sensitive/Error! ' + 'A'.repeat(65)
        recordTelemetryError('newsletter-events', hostile)
        expect(getWorkerStatuses()[0].telemetryErrorClass).toBe('Error')

        markWorkerDead('newsletter-events', { name: 'recipient@example.test' })
        const worker = getWorkerStatuses()[0]
        expect(worker.telemetryErrorClass).toBe('UnknownError')
        expect(JSON.stringify(worker)).not.toContain('recipient@example.test')
    })
})
