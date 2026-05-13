/**
 * In-process worker heartbeat registry.
 * Shared between worker loops and the dashboard API route (same Node.js process).
 */

export interface WorkerStatus {
    name: string
    lastHeartbeat: number | null  // epoch ms of the last successful poll
    alive: boolean
    pollCount: number
    startedAt: string | null
    lastError: string | null
}

// Module-level singleton — persists across API requests in the same process.
const registry = new Map<string, WorkerStatus>()

/** Registers a worker at loop start. */
export function registerWorker(name: string): void {
    registry.set(name, {
        name,
        lastHeartbeat: null,
        alive: false,
        pollCount: 0,
        startedAt: new Date().toISOString(),
        lastError: null,
    })
}

/** Called on every successful poll iteration (idle or with messages). */
export function heartbeat(name: string): void {
    const entry = registry.get(name)
    if (!entry) return
    entry.lastHeartbeat = Date.now()
    entry.alive = true
    entry.pollCount += 1
    entry.lastError = null
}

/** Marks a worker as dead and stores the last error. */
export function markWorkerDead(name: string, error: unknown): void {
    const entry = registry.get(name)
    if (!entry) return
    entry.alive = false
    entry.lastError = error instanceof Error ? error.message : String(error)
}

/**
 * Returns a liveness snapshot of all workers.
 * A worker is considered stale if its heartbeat is older than `staleThresholdMs`
 * (default 60 s — comfortably above the 20 s SQS long-poll wait).
 */
export function getWorkerStatuses(staleThresholdMs = 60_000): WorkerStatus[] {
    const now = Date.now()
    return Array.from(registry.values()).map((w) => ({
        ...w,
        alive:
            w.alive &&
            w.lastHeartbeat !== null &&
            now - w.lastHeartbeat < staleThresholdMs,
    }))
}
