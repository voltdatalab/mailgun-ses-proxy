/**
 * In-process, privacy-safe worker health and SQS telemetry registry.
 * Kept on globalThis so server.ts and Next route bundles share the same state.
 */
import { errorClass } from "./error-class"

export const EXPECTED_WORKER_NAMES = ["newsletter-sender", "newsletter-events", "system-events"] as const
export type ExpectedWorkerName = typeof EXPECTED_WORKER_NAMES[number]

export interface QueueTelemetry {
    visible: number | null
    notVisible: number | null
    delayed: number | null
    sampledAt: number | null
}

export interface WorkerStatus {
    name: string
    lastHeartbeat: number | null
    alive: boolean
    stale: boolean
    startedAt: string | null
    received: number
    acked: number
    failed: number
    consecutiveErrors: number
    lastMessageAt: number | null
    lastMessageAgeMs: number | null
    processing: boolean
    processingCount: number
    processingStartedAt: number | null
    processingDeadlineAt: number | null
    queue: QueueTelemetry
    telemetryErrorClass: string | null
}

type StoredWorker = Omit<WorkerStatus, "stale">
const REGISTRY_KEY = Symbol.for("mailgun-ses-proxy:worker-registry")

function getRegistry(): Map<string, StoredWorker> {
    const g = globalThis as Record<symbol, unknown>
    if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = new Map<string, StoredWorker>()
    return g[REGISTRY_KEY] as Map<string, StoredWorker>
}

function emptyQueue(): QueueTelemetry {
    return { visible: null, notVisible: null, delayed: null, sampledAt: null }
}

/** Registers a loop. A restart deliberately gets fresh counters and timestamps. */
export function registerWorker(name: string): void {
    getRegistry().set(name, {
        name, lastHeartbeat: null, alive: false, startedAt: new Date().toISOString(),
        received: 0, acked: 0, failed: 0, consecutiveErrors: 0,
        lastMessageAt: null, lastMessageAgeMs: null,
        processing: false, processingCount: 0, processingStartedAt: null, processingDeadlineAt: null,
        queue: emptyQueue(), telemetryErrorClass: null,
    })
}

/** Successful SQS long poll or acknowledged non-empty poll. */
export function heartbeat(name: string): void {
    const entry = getRegistry().get(name)
    if (!entry) return
    entry.lastHeartbeat = Date.now()
    entry.alive = true
}

/** Marks a received batch as in-flight using only a bounded visibility deadline. */
export function beginWorkerProcessing(name: string, deadlineMs: number): void {
    const entry = getRegistry().get(name)
    if (!entry) return
    const now = Date.now()
    entry.processingCount += 1
    entry.processing = true
    entry.processingStartedAt = entry.processingStartedAt ?? now
    entry.processingDeadlineAt = Math.max(entry.processingDeadlineAt ?? 0, now + boundedProcessingDeadline(deadlineMs))
}

/** Clears in-flight state after every non-empty batch, including failures. */
export function endWorkerProcessing(name: string): void {
    const entry = getRegistry().get(name)
    if (!entry) return
    entry.processingCount = Math.max(0, entry.processingCount - 1)
    if (entry.processingCount > 0) return
    entry.processing = false
    entry.processingStartedAt = null
    entry.processingDeadlineAt = null
}

/** Records delivery totals only; payloads, IDs, URLs and error text never enter this registry. */
export function recordWorkerProcessing(name: string, update: {
    received?: number
    acked?: number
    failed?: number
    consecutiveErrors?: number
    lastMessageAgeMs?: number | null
}): void {
    const entry = getRegistry().get(name)
    if (!entry) return
    entry.received += safeCount(update.received)
    entry.acked += safeCount(update.acked)
    entry.failed += safeCount(update.failed)
    if (update.consecutiveErrors !== undefined) entry.consecutiveErrors = safeCount(update.consecutiveErrors)
    if (update.lastMessageAgeMs !== undefined) {
        // Empty polls clear a residual age but retain when the last non-empty sample occurred.
        if (update.lastMessageAgeMs !== null) entry.lastMessageAt = Date.now()
        entry.lastMessageAgeMs = update.lastMessageAgeMs === null ? null : safeCount(update.lastMessageAgeMs)
    }
}

/** Replaces the cached SQS queue-depth sample with parsed non-negative counts. */
export function recordQueueTelemetry(name: string, queue: QueueTelemetry): void {
    const entry = getRegistry().get(name)
    if (!entry) return
    entry.queue = Object.freeze({
        visible: nullableCount(queue.visible), notVisible: nullableCount(queue.notVisible),
        delayed: nullableCount(queue.delayed), sampledAt: finiteTimestamp(queue.sampledAt),
    })
    entry.telemetryErrorClass = null
}

/** Error class is intentionally the sole telemetry failure detail retained. */
export function recordTelemetryError(name: string, error: unknown): void {
    const entry = getRegistry().get(name)
    if (entry) entry.telemetryErrorClass = errorClass(error)
}

/** Marks a loop unavailable without retaining raw exceptions or error messages. */
export function markWorkerDead(name: string, error: unknown): void {
    const entry = getRegistry().get(name)
    if (!entry) return
    entry.alive = false
    entry.telemetryErrorClass = errorClass(error)
}

/** Immutable snapshot copies. `alive` is actual loop state; `stale` is heartbeat age. */
export function getWorkerStatuses(staleThresholdMs = 60_000): Readonly<WorkerStatus>[] {
    const now = Date.now()
    const threshold = Math.max(1, safeCount(staleThresholdMs))
    return Array.from(getRegistry().values()).map(entry => Object.freeze({
        ...entry,
        stale: entry.processing
            ? entry.processingDeadlineAt === null || now >= entry.processingDeadlineAt
            : entry.lastHeartbeat === null || now - entry.lastHeartbeat >= threshold,
        queue: Object.freeze({ ...entry.queue }),
    }))
}

/** Test-only reset of the global registry. */
export function resetWorkerRegistryForTests(): void {
    getRegistry().clear()
}

function safeCount(value: number | undefined): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0
}
function boundedProcessingDeadline(value: number): number {
    return Number.isFinite(value) ? Math.min(12 * 60 * 60_000, Math.max(1, Math.floor(value))) : 30_000
}
function nullableCount(value: number | null): number | null { return value === null ? null : safeCount(value) }
function finiteTimestamp(value: number | null): number | null { return value !== null && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null }
