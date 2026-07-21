import { describe, expect, it, vi } from 'vitest'
import { createWorkerSupervisor } from '@/lib/core/worker-supervisor'

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('worker supervisor', () => {
    it('starts one fatal shutdown for the first unexpected resolution and exits 1 after all workers settle', async () => {
        const fatal = vi.fn()
        const complete = vi.fn()
        const newsletter = deferred()
        const events = deferred()
        const supervisor = createWorkerSupervisor(['newsletter', 'events'], {
            onUnexpectedStop: fatal,
            onAllWorkersSettled: complete,
        })

        supervisor.watch('newsletter', newsletter.promise)
        supervisor.watch('events', events.promise)
        newsletter.resolve()
        await Promise.resolve()

        expect(fatal).toHaveBeenCalledTimes(1)
        expect(fatal).toHaveBeenCalledWith({ workerName: 'newsletter', outcome: 'resolved' })
        expect(complete).not.toHaveBeenCalled()

        events.resolve()
        await Promise.resolve()
        expect(fatal).toHaveBeenCalledTimes(1)
        expect(complete).toHaveBeenCalledWith(1)
    })

    it('reports a rejected worker once using only its error class', async () => {
        const fatal = vi.fn()
        const complete = vi.fn()
        const worker = deferred()
        const supervisor = createWorkerSupervisor(['events'], {
            onUnexpectedStop: fatal,
            onAllWorkersSettled: complete,
        })

        supervisor.watch('events', worker.promise)
        worker.reject(new TypeError('secret failure detail'))
        await Promise.resolve()

        expect(fatal).toHaveBeenCalledTimes(1)
        expect(fatal).toHaveBeenCalledWith({ workerName: 'events', outcome: 'rejected', errorClass: 'TypeError' })
        expect(JSON.stringify(fatal.mock.calls)).not.toContain('secret failure detail')
        expect(complete).toHaveBeenCalledWith(1)
    })

    it('does not classify normal shutdown stops as fatal and selects exit 0', async () => {
        const fatal = vi.fn()
        const complete = vi.fn()
        const newsletter = deferred()
        const events = deferred()
        const supervisor = createWorkerSupervisor(['newsletter', 'events'], {
            onUnexpectedStop: fatal,
            onAllWorkersSettled: complete,
        })

        supervisor.watch('newsletter', newsletter.promise)
        supervisor.watch('events', events.promise)
        supervisor.requestGracefulShutdown()
        newsletter.resolve()
        events.reject(new Error('shutdown abort'))
        await Promise.resolve()

        expect(fatal).not.toHaveBeenCalled()
        expect(complete).toHaveBeenCalledTimes(1)
        expect(complete).toHaveBeenCalledWith(0)
    })
})
