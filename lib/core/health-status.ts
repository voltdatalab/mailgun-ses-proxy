import { EXPECTED_WORKER_NAMES, getWorkerStatuses, type WorkerStatus } from "@/lib/core/worker-registry"

const DEFAULT_WORKER_STALE_MS = 60_000
const DEFAULT_TELEMETRY_STALE_MS = 90_000
const DEFAULT_BACKLOG_THRESHOLD = 1_000
const DEFAULT_AGE_THRESHOLD_MS = 15 * 60_000

type HealthWorker = WorkerStatus | ReturnType<typeof missingWorker>

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name])
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.floor(value)))
}

function healthThresholds() {
    return {
        workerStaleMs: boundedEnv("HEALTH_WORKER_STALE_MS", DEFAULT_WORKER_STALE_MS, 30_000, 5 * 60_000),
        telemetryStaleMs: boundedEnv("SQS_TELEMETRY_STALE_MS", DEFAULT_TELEMETRY_STALE_MS, 30_000, 10 * 60_000),
        backlogThreshold: boundedEnv("SQS_BACKLOG_DEGRADED_THRESHOLD", DEFAULT_BACKLOG_THRESHOLD, 1, 1_000_000),
        ageThresholdMs: boundedEnv("SQS_AGE_DEGRADED_MS", DEFAULT_AGE_THRESHOLD_MS, 10_000, 24 * 60 * 60_000),
    }
}

function missingWorker(name: string) {
    return { name, missing: true, alive: false, stale: true, lastHeartbeat: null, startedAt: null, received: 0, acked: 0, failed: 0, consecutiveErrors: 0, lastMessageAt: null, lastMessageAgeMs: null, processing: false, processingStartedAt: null, processingDeadlineAt: null, queue: { visible: null, notVisible: null, delayed: null, sampledAt: null }, telemetryErrorClass: null }
}

function sum(workers: HealthWorker[], key: "visible" | "notVisible" | "delayed"): number {
    return workers.reduce((total, worker) => total + (worker.queue[key] ?? 0), 0)
}

/** A single privacy-safe snapshot so public and authenticated health agree on readiness. */
export function buildHealthSnapshot(now = Date.now()) {
    const thresholds = healthThresholds()
    const byName = new Map(getWorkerStatuses(thresholds.workerStaleMs).map(worker => [worker.name, worker]))
    const workers = EXPECTED_WORKER_NAMES.map(name => byName.get(name) ?? missingWorker(name))
    const ready = workers.every(worker => worker.alive && !worker.stale)
    const telemetryStale = workers.some(worker => worker.queue.sampledAt === null || now - worker.queue.sampledAt >= thresholds.telemetryStaleMs)
    const visible = sum(workers, "visible")
    const notVisible = sum(workers, "notVisible")
    const delayed = sum(workers, "delayed")
    const oldestObservedAgeMs = Math.max(0, ...workers.map(worker => worker.lastMessageAgeMs ?? 0))
    const degraded = telemetryStale || visible >= thresholds.backlogThreshold || notVisible >= thresholds.backlogThreshold || delayed >= thresholds.backlogThreshold || oldestObservedAgeMs >= thresholds.ageThresholdMs
    return {
        status: ready ? (degraded ? "degraded" : "ok") : "unhealthy",
        ready,
        degraded,
        timestamp: new Date(now).toISOString(),
        workers,
        backlog: { visible, notVisible, delayed, oldestObservedAgeMs, telemetryStale },
        httpStatus: ready ? 200 : 503,
    }
}

export function publicHealthProjection(snapshot = buildHealthSnapshot()) {
    return { status: snapshot.status, ready: snapshot.ready, degraded: snapshot.degraded, timestamp: snapshot.timestamp }
}

export function detailedHealthProjection(snapshot = buildHealthSnapshot()) {
    return {
        status: snapshot.status,
        ready: snapshot.ready,
        degraded: snapshot.degraded,
        timestamp: snapshot.timestamp,
        workers: snapshot.workers,
        backlog: snapshot.backlog,
    }
}
