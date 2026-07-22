import { errorClass } from "./error-class"

export type WorkerStop = {
    workerName: string
    outcome: 'resolved' | 'rejected'
    errorClass?: string
}

export interface WorkerSupervisorCallbacks {
    /** Called exactly once when a worker stops before shutdown was requested. */
    onUnexpectedStop: (stop: WorkerStop) => void
    /** Called once every registered worker has settled. */
    onAllWorkersSettled: (exitCode: 0 | 1) => void
}

/**
 * Coordinates background worker lifecycles without importing the HTTP entry
 * point. A worker loop resolving is only normal after graceful shutdown has
 * been requested; otherwise it is a fatal condition that must restart the
 * container after remaining work has drained.
 */
export function createWorkerSupervisor(workerNames: readonly string[], callbacks: WorkerSupervisorCallbacks) {
    const expectedWorkers = new Set(workerNames)
    if (expectedWorkers.size !== workerNames.length || expectedWorkers.size === 0) {
        throw new Error('Worker supervisor requires a non-empty unique worker list')
    }

    const watchedWorkers = new Set<string>()
    const settledWorkers = new Set<string>()
    let shutdownRequested = false
    let fatalShutdown = false
    let completionReported = false

    function requestGracefulShutdown(): void {
        shutdownRequested = true
    }

    function watch(workerName: string, promise: Promise<unknown>): void {
        if (!expectedWorkers.has(workerName)) throw new Error(`Unknown worker: ${workerName}`)
        if (watchedWorkers.has(workerName)) throw new Error(`Worker already watched: ${workerName}`)
        watchedWorkers.add(workerName)

        void promise.then(
            () => settle({ workerName, outcome: 'resolved' }),
            (reason: unknown) => settle({ workerName, outcome: 'rejected', errorClass: errorClass(reason) }),
        )
    }

    function settle(stop: WorkerStop): void {
        if (settledWorkers.has(stop.workerName)) return
        settledWorkers.add(stop.workerName)

        if (!shutdownRequested && !fatalShutdown) {
            fatalShutdown = true
            shutdownRequested = true
            callbacks.onUnexpectedStop(stop)
        }

        if (settledWorkers.size === expectedWorkers.size && !completionReported) {
            completionReported = true
            callbacks.onAllWorkersSettled(fatalShutdown ? 1 : 0)
        }
    }

    return { requestGracefulShutdown, watch }
}
