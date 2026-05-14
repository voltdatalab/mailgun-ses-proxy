/**
 * In-process worker heartbeat registry.
 * Shared between worker loops and the dashboard API route (same Node.js process).
 *
 * Stored on `globalThis` so that the server.ts entry point (which calls
 * registerWorker / heartbeat) and the Next.js API route bundle (which calls
 * getWorkerStatuses) both reference the exact same Map instance.
 */

export interface WorkerStatus {
    name: string
    lastHeartbeat: number | null  // epoch ms of the last successful poll
    alive: boolean
    pollCount: number
    startedAt: string | null
    lastError: string | null
}

// Use a Symbol on globalThis so the Map survives Next.js re-bundling.
const REGISTRY_KEY = Symbol.for("mailgun-ses-proxy:worker-registry")

function getRegistry(): Map<string, WorkerStatus> {
    const g = globalThis as Record<symbol, unknown>
    if (!g[REGISTRY_KEY]) {
        g[REGISTRY_KEY] = new Map<string, WorkerStatus>()
    }
    return g[REGISTRY_KEY] as Map<string, WorkerStatus>
}

/** Registers a worker at loop start. */
export function registerWorker(name: string): void {
    getRegistry().set(name, {
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
    const entry = getRegistry().get(name)
    if (!entry) return
    entry.lastHeartbeat = Date.now()
    entry.alive = true
    entry.pollCount += 1
    entry.lastError = null
}

/** Marks a worker as dead and stores the last error. */
export function markWorkerDead(name: string, error: unknown): void {
    const entry = getRegistry().get(name)
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
    return Array.from(getRegistry().values()).map((w) => ({
        ...w,
        alive:
            w.alive &&
            w.lastHeartbeat !== null &&
            now - w.lastHeartbeat < staleThresholdMs,
    }))
}
