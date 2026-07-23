import {
    DeleteMessageBatchCommand,
    GetQueueAttributesCommand,
    type Message,
    type MessageSystemAttributeName,
    type QueueAttributeName,
    ReceiveMessageCommand,
} from "@aws-sdk/client-sqs"
import { sqsClient } from "../../service/aws/awsHelper"
import logger from "./logger"
import { errorClass } from "./error-class"
import { beginWorkerProcessing, endWorkerProcessing, heartbeat, markWorkerDead, recordQueueTelemetry, recordTelemetryError, recordWorkerProcessing, registerWorker } from "./worker-registry"

const log = logger.child({ module: "sqs-worker" })
const POLL_BACKOFF_MIN_MS = 1_000
const POLL_BACKOFF_MAX_MS = 30_000
export const MAX_CONSECUTIVE_ERRORS = 50
const SQS_BATCH_LIMIT = 10
export const DEFAULT_TELEMETRY_SAMPLE_INTERVAL_MS = 30_000
const MIN_TELEMETRY_SAMPLE_INTERVAL_MS = 10_000
const MAX_TELEMETRY_SAMPLE_INTERVAL_MS = 5 * 60_000
let _shutdownRequested = false
const telemetryRequests = new Set<string>()
const telemetryLastSample = new Map<string, number>()
const telemetryTimers = new Map<string, ReturnType<typeof setInterval>>()
const activePollControllers = new Set<AbortController>()

export function requestShutdown(): void {
    _shutdownRequested = true
    for (const controller of activePollControllers) controller.abort()
    clearAllQueueTelemetrySampling()
    log.info("Shutdown requested — active polls aborted and in-flight handlers will drain")
}

/** Visible for testing. */
export function _isShutdownRequested(): boolean {
    return _shutdownRequested
}

/** Test-only reset for isolated worker-loop tests. */
export function _resetShutdownForTests(): void {
    _shutdownRequested = false
    activePollControllers.clear()
    clearAllQueueTelemetrySampling()
}

export interface WorkerConfig {
    name: string
    queueUrl: string
    visibilityTimeout?: number
    waitTimeSeconds?: number
    /** SQS receive batch size, clamped to the service limit of 1..10. */
    batchSize?: number
    /** Maximum simultaneous handler calls, bounded to the received batch. */
    maxConcurrency?: number
    /** Fatal deadline for one handler; timeout stops the worker for process replacement. */
    handlerTimeoutMs?: number
    /** Cached GetQueueAttributes sampling interval (10 seconds through 5 minutes). */
    telemetrySampleIntervalMs?: number
    handler: (message: Message) => Promise<void>
}

export function normalizeTelemetrySampleInterval(value?: number): number {
    const numeric = Number.isFinite(value) ? Math.floor(value!) : DEFAULT_TELEMETRY_SAMPLE_INTERVAL_MS
    return Math.min(MAX_TELEMETRY_SAMPLE_INTERVAL_MS, Math.max(MIN_TELEMETRY_SAMPLE_INTERVAL_MS, numeric))
}

export function buildQueueAttributesInput(queueUrl: string) {
    return {
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] as QueueAttributeName[],
    }
}

/** One cached sample. Its failures never influence delivery or the circuit breaker. */
export async function sampleQueueTelemetry(client: ReturnType<typeof sqsClient>, name: string, queueUrl: string): Promise<boolean> {
    try {
        const response = await client.send(new GetQueueAttributesCommand(buildQueueAttributesInput(queueUrl)))
        const attributes = response.Attributes ?? {}
        recordQueueTelemetry(name, {
            visible: parseSqsCount(attributes.ApproximateNumberOfMessages),
            notVisible: parseSqsCount(attributes.ApproximateNumberOfMessagesNotVisible),
            delayed: parseSqsCount(attributes.ApproximateNumberOfMessagesDelayed),
            sampledAt: Date.now(),
        })
        return true
    } catch (error) {
        recordTelemetryError(name, error)
        log.warn({ name, errorClass: errorClass(error) }, "SQS queue telemetry sample failed")
        return false
    }
}

function parseSqsCount(value: string | undefined): number | null {
    if (value === undefined || !/^\d+$/.test(value)) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Starts sampling without coupling a slow/failing attributes call to ACK delivery. */
function launchQueueTelemetrySample(client: ReturnType<typeof sqsClient>, name: string, queueUrl: string, intervalMs: number): void {
    const now = Date.now()
    const lastSample = telemetryLastSample.get(name)
    if (telemetryRequests.has(name) || (lastSample !== undefined && now - lastSample < intervalMs)) return
    telemetryLastSample.set(name, now)
    telemetryRequests.add(name)
    // The sampler itself isolates AWS failures; this guard also prevents an
    // unexpected registry/logging failure from becoming an unhandled rejection.
    void sampleQueueTelemetry(client, name, queueUrl).catch(error => {
        log.warn({ name, errorClass: errorClass(error) }, "Unexpected SQS queue telemetry sampler failure")
    }).finally(() => telemetryRequests.delete(name))
}

/** Starts one uncoupled sampler per worker, including during handler awaits. */
export function startQueueTelemetrySampling(client: ReturnType<typeof sqsClient>, name: string, queueUrl: string, intervalMs: number): void {
    clearQueueTelemetrySampling(name)
    telemetryLastSample.delete(name)
    launchQueueTelemetrySample(client, name, queueUrl, intervalMs)
    const timer = setInterval(() => launchQueueTelemetrySample(client, name, queueUrl, intervalMs), intervalMs)
    timer.unref?.()
    telemetryTimers.set(name, timer)
}

export function clearQueueTelemetrySampling(name: string): void {
    const timer = telemetryTimers.get(name)
    if (timer) clearInterval(timer)
    telemetryTimers.delete(name)
    telemetryLastSample.delete(name)
}

function clearAllQueueTelemetrySampling(): void {
    for (const name of telemetryTimers.keys()) clearQueueTelemetrySampling(name)
}

export function observedMessageAgeMs(messages: Message[]): number | null {
    let oldest: number | null = null
    const now = Date.now()
    for (const message of messages) {
        const raw = message.Attributes?.SentTimestamp
        if (!raw || !/^\d+$/.test(raw)) continue
        const timestamp = Number(raw)
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) continue
        const age = Math.max(0, now - timestamp)
        oldest = oldest === null ? age : Math.max(oldest, age)
    }
    return oldest
}

/**
 * Normalizes SQS receive and handler-pool sizes to the service's 1..10 range.
 * Non-finite values intentionally fall back to the safe single-message mode.
 */
export function normalizeSqsWorkerCount(value: number | undefined): number {
    const numeric = Number.isFinite(value) ? Math.floor(value!) : 1
    return Math.min(SQS_BATCH_LIMIT, Math.max(1, numeric))
}

export class HandlerTimeoutError extends Error {
    constructor(workerName: string) {
        super(`Handler deadline exceeded for ${workerName}`)
        this.name = "HandlerTimeoutError"
    }
}

async function withHandlerTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined, workerName: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs! <= 0) return operation
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new HandlerTimeoutError(workerName)), Math.floor(timeoutMs!))
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/** Bounded in-flight readiness deadline derived from this worker's visibility timeout. */
export function processingDeadlineMsFromVisibilityTimeout(visibilityTimeout: number | undefined): number {
    const seconds = Number.isFinite(visibilityTimeout) ? visibilityTimeout! : 30
    return Math.min(12 * 60 * 60_000, Math.max(1, Math.floor(seconds * 1_000)))
}

/**
 * An idle long-poll proves the worker is alive; non-empty polls require a
 * confirmed acknowledgement before they count as healthy.
 */
export function isHealthySqsPoll(messages: Message[] | undefined, acknowledged: number): boolean {
    return !messages || messages.length === 0 || acknowledged > 0
}

/**
 * Records every processing or polling failure through the same bounded circuit
 * breaker. Callers must exit their loop when `shouldExit` is true.
 */
export function consecutiveFailure(name: string, previousFailures: number): { consecutiveErrors: number, shouldExit: boolean } {
    const consecutiveErrors = previousFailures + 1
    const shouldExit = consecutiveErrors >= MAX_CONSECUTIVE_ERRORS
    if (shouldExit) {
        const reason = `Worker ${name} hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors — exiting loop`
        log.error({ name }, reason)
        markWorkerDead(name, reason)
    }
    return { consecutiveErrors, shouldExit }
}

/** Applies ACK-based recovery without letting idle long-polls erase failures. */
export function circuitBreakerAfterPoll(
    name: string,
    messages: Message[] | undefined,
    acknowledged: number,
    previousFailures: number,
): { consecutiveErrors: number, shouldExit: boolean } {
    if (!messages || messages.length === 0) return { consecutiveErrors: previousFailures, shouldExit: false }
    if (acknowledged > 0) return { consecutiveErrors: 0, shouldExit: false }
    return consecutiveFailure(name, previousFailures)
}

/** Exported test seam for the exact ReceiveMessageCommand input. */
export function buildReceiveInput(queueUrl: string, visibilityTimeout: number, waitTimeSeconds: number, batchSize?: number) {
    return {
        QueueUrl: queueUrl,
        AttributeNames: ["All"] as QueueAttributeName[],
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["SentTimestamp", "ApproximateReceiveCount"] as MessageSystemAttributeName[],
        VisibilityTimeout: visibilityTimeout,
        // SQS permits at most ten messages in a receive request.
        MaxNumberOfMessages: normalizeSqsWorkerCount(batchSize),
        // Preserve long polling; empty responses do not spin the loop.
        WaitTimeSeconds: waitTimeSeconds,
    }
}

/** Sends one abortable SQS ReceiveMessage request and deregisters it on settle. */
export async function receiveSqsMessages(
    client: ReturnType<typeof sqsClient>,
    receiveInput: ReturnType<typeof buildReceiveInput>,
): Promise<Message[] | undefined> {
    const controller = new AbortController()
    activePollControllers.add(controller)
    try {
        const response = await client.send(new ReceiveMessageCommand(receiveInput), { abortSignal: controller.signal })
        return response.Messages
    } finally {
        activePollControllers.delete(controller)
    }
}

/**
 * Long-polling SQS worker. Messages are handled by a bounded pool and only
 * successful handlers with receipt handles are acknowledged as a batch.
 */
export async function startWorker(config: WorkerConfig) {
    const {
        name,
        queueUrl,
        visibilityTimeout = 30,
        waitTimeSeconds = 20,
        batchSize = 1,
        maxConcurrency = 1,
        handlerTimeoutMs,
        telemetrySampleIntervalMs,
        handler,
    } = config
    const client = bootstrapWorker(name, queueUrl)
    if (!client) return

    log.info({ name }, `Starting SQS worker: ${name}`)
    registerWorker(name)
    const receiveInput = buildReceiveInput(queueUrl, visibilityTimeout, waitTimeSeconds, batchSize)
    const processingDeadlineMs = processingDeadlineMsFromVisibilityTimeout(visibilityTimeout)
    const concurrency = normalizeSqsWorkerCount(maxConcurrency)
    const telemetryIntervalMs = normalizeTelemetrySampleInterval(
        telemetrySampleIntervalMs ?? Number(process.env.SQS_TELEMETRY_SAMPLE_INTERVAL_MS),
    )
    startQueueTelemetrySampling(client, name, queueUrl, telemetryIntervalMs)
    let pollBackoffMs = POLL_BACKOFF_MIN_MS
    let consecutiveErrors = 0

    try {
        while (!_shutdownRequested) {
            await new Promise(resolve => setImmediate(resolve))
            try {
                let messages: Message[] | undefined
                try {
                    messages = await receiveSqsMessages(client, receiveInput)
                    pollBackoffMs = POLL_BACKOFF_MIN_MS
                } catch (pollError) {
                    if (_shutdownRequested && isAbortError(pollError)) break
                    const failure = consecutiveFailure(name, consecutiveErrors)
                    consecutiveErrors = failure.consecutiveErrors
                    recordWorkerProcessing(name, { consecutiveErrors })
                    log.error({ name, errorClass: errorClass(pollError), consecutiveErrors }, `Poll error — retrying in ${pollBackoffMs}ms`)
                    if (failure.shouldExit) return
                    await sleep(pollBackoffMs)
                    pollBackoffMs = Math.min(pollBackoffMs * 2, POLL_BACKOFF_MAX_MS)
                    continue
                }

                // A message received concurrently with SIGTERM stays unACKed.
                if (_shutdownRequested) break
                if (!messages || messages.length === 0) {
                    // ReceiveMessage remains a long-poll request, so this does not busy-loop.
                    recordWorkerProcessing(name, { consecutiveErrors, lastMessageAgeMs: null })
                    heartbeat(name)
                    // An idle long-poll proves liveness, but not processing recovery.
                    continue
                }

                // Receiving a batch proves the loop is live. Keep that distinct from ACK success.
                heartbeat(name)
                beginWorkerProcessing(name, processingDeadlineMs)
                let acknowledged: number
                try {
                    acknowledged = await processSqsMessages(client, queueUrl, messages, handler, concurrency, name, handlerTimeoutMs)
                } finally {
                    // Handler and delete failures must never leave a completed batch marked busy.
                    endWorkerProcessing(name)
                }
                // A non-empty poll is healthy only after a confirmed batch-delete entry.
                const circuit = circuitBreakerAfterPoll(name, messages, acknowledged, consecutiveErrors)
                consecutiveErrors = circuit.consecutiveErrors
                recordWorkerProcessing(name, {
                    received: messages.length,
                    acked: acknowledged,
                    failed: Math.max(0, messages.length - acknowledged),
                    consecutiveErrors,
                    lastMessageAgeMs: observedMessageAgeMs(messages),
                })
                if (isHealthySqsPoll(messages, acknowledged)) {
                    heartbeat(name)
                } else {
                    log.warn({ name, consecutiveErrors }, "No messages in batch acknowledged — incrementing error counter")
                    if (circuit.shouldExit) return
                }
            } catch (loopError) {
                if (loopError instanceof HandlerTimeoutError) {
                    log.error({ name, errorClass: errorClass(loopError) }, "Handler deadline exceeded — stopping worker for replacement")
                    markWorkerDead(name, loopError)
                    return
                }
                const failure = consecutiveFailure(name, consecutiveErrors)
                consecutiveErrors = failure.consecutiveErrors
                recordWorkerProcessing(name, { consecutiveErrors })
                log.error({ name, errorClass: errorClass(loopError), consecutiveErrors }, `Unexpected loop error — continuing (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`)
                if (failure.shouldExit) return
                await sleep(pollBackoffMs)
                pollBackoffMs = Math.min(pollBackoffMs * 2, POLL_BACKOFF_MAX_MS)
            }
        }
        log.info({ name }, `Worker ${name} stopped (shutdown requested)`)
        markWorkerDead(name, "graceful shutdown")
    } catch (fatalError) {
        log.error({ name, errorClass: errorClass(fatalError) }, "Fatal error escaped worker loop")
        markWorkerDead(name, fatalError)
        throw fatalError
    } finally {
        clearQueueTelemetrySampling(name)
    }
}

/**
 * Processes messages with a bounded pool, then deletes only successful work in
 * SQS-sized batches. It returns confirmed acknowledgements, not delete attempts.
 */
export async function processSqsMessages(
    client: ReturnType<typeof sqsClient>,
    queueUrl: string,
    messages: Message[],
    handler: (message: Message) => Promise<void>,
    maxConcurrency = 1,
    name = "worker",
    handlerTimeoutMs?: number,
): Promise<number> {
    const successful = await processWithConcurrency(messages, handler, maxConcurrency, name, handlerTimeoutMs)
    const ackable = successful.filter(message => Boolean(message.ReceiptHandle))
    let acknowledged = 0
    for (let offset = 0; offset < ackable.length; offset += SQS_BATCH_LIMIT) {
        acknowledged += await deleteMessageBatch(client, queueUrl, ackable.slice(offset, offset + SQS_BATCH_LIMIT))
    }
    return acknowledged
}

/** Compatibility seam for callers/tests which process a single message. */
export async function processSqsMessage(
    client: ReturnType<typeof sqsClient>,
    queueUrl: string,
    message: Message,
    handler: (message: Message) => Promise<void>,
    name = "worker",
): Promise<boolean> {
    return (await processSqsMessages(client, queueUrl, [message], handler, 1, name)) === 1
}

async function processWithConcurrency(
    messages: Message[],
    handler: (message: Message) => Promise<void>,
    maxConcurrency: number,
    name: string,
    handlerTimeoutMs?: number,
): Promise<Message[]> {
    const successful: Message[] = []
    let next = 0
    const workerCount = Math.min(messages.length, normalizeSqsWorkerCount(maxConcurrency))
    await Promise.all(Array.from({ length: workerCount }, async () => {
        // On shutdown, existing handlers drain but queued batch items are left for SQS.
        while (!_shutdownRequested && next < messages.length) {
            const message = messages[next++]
            try {
                await withHandlerTimeout(handler(message), handlerTimeoutMs, name)
                successful.push(message)
            } catch (handlerError) {
                if (handlerError instanceof HandlerTimeoutError) throw handlerError
                log.error({ name, receiveCount: boundedReceiveCount(message.Attributes?.ApproximateReceiveCount), errorClass: errorClass(handlerError) }, "Handler error — message left in SQS for retry/redrive")
            }
        }
    }))
    return successful
}

async function deleteMessageBatch(
    client: ReturnType<typeof sqsClient>,
    queueUrl: string,
    messages: Message[],
): Promise<number> {
    if (messages.length === 0) return 0
    const entries = messages.map((message, index) => ({ Id: `entry-${index}`, ReceiptHandle: message.ReceiptHandle! }))
    try {
        const response = await client.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: entries }))
        const acknowledged = new Set(response.Successful?.map(entry => entry.Id).filter((id): id is string => Boolean(id)))
        const failed = response.Failed?.map(({ Code, SenderFault }) => ({ Code, SenderFault })) ?? []
        if (failed.length > 0) log.warn({ failed: failed.length, failures: failed }, "Some SQS batch delete entries failed")
        return entries.reduce((count, entry) => count + (acknowledged.has(entry.Id) ? 1 : 0), 0)
    } catch (error) {
        log.warn({ count: entries.length, errorClass: errorClass(error) }, "SQS batch delete request failed")
        return 0
    }
}

function bootstrapWorker(name: string, queueUrl: string): ReturnType<typeof sqsClient> | null {
    if (!queueUrl) {
        log.error({ name }, "[bootstrap] Queue URL missing — worker will not start")
        return null
    }
    try {
        return sqsClient()
    } catch (error) {
        log.error({ name, errorClass: errorClass(error) }, "[bootstrap] SQS client init failed — worker will not start")
        return null
    }
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError"
}

function boundedReceiveCount(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/.test(value)) return undefined
    const count = Number(value)
    return Number.isSafeInteger(count) ? Math.min(1_000, count) : undefined
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
