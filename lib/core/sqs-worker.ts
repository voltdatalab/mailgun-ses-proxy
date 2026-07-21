import {
    DeleteMessageBatchCommand,
    type Message,
    type MessageSystemAttributeName,
    type QueueAttributeName,
    ReceiveMessageCommand,
} from "@aws-sdk/client-sqs"
import { sqsClient } from "../../service/aws/awsHelper"
import logger from "./logger"
import { heartbeat, markWorkerDead, registerWorker } from "./worker-registry"

const log = logger.child({ module: "sqs-worker" })
const POLL_BACKOFF_MIN_MS = 1_000
const POLL_BACKOFF_MAX_MS = 30_000
export const MAX_CONSECUTIVE_ERRORS = 50
const SQS_BATCH_LIMIT = 10
let _shutdownRequested = false
const activePollControllers = new Set<AbortController>()

export function requestShutdown(): void {
    _shutdownRequested = true
    for (const controller of activePollControllers) controller.abort()
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
    handler: (message: Message) => Promise<void>
}

/**
 * Normalizes SQS receive and handler-pool sizes to the service's 1..10 range.
 * Non-finite values intentionally fall back to the safe single-message mode.
 */
export function normalizeSqsWorkerCount(value: number | undefined): number {
    const numeric = Number.isFinite(value) ? Math.floor(value!) : 1
    return Math.min(SQS_BATCH_LIMIT, Math.max(1, numeric))
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
        handler,
    } = config
    const client = bootstrapWorker(name, queueUrl)
    if (!client) return

    log.info({ name }, `Starting SQS worker: ${name}`)
    registerWorker(name)
    const receiveInput = buildReceiveInput(queueUrl, visibilityTimeout, waitTimeSeconds, batchSize)
    const concurrency = normalizeSqsWorkerCount(maxConcurrency)
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
                    heartbeat(name)
                    // An idle long-poll proves liveness, but not processing recovery.
                    continue
                }

                const acknowledged = await processSqsMessages(client, queueUrl, messages, handler, concurrency, name)
                // A non-empty poll is healthy only after a confirmed batch-delete entry.
                const circuit = circuitBreakerAfterPoll(name, messages, acknowledged, consecutiveErrors)
                consecutiveErrors = circuit.consecutiveErrors
                if (isHealthySqsPoll(messages, acknowledged)) {
                    heartbeat(name)
                } else {
                    log.warn({ name, consecutiveErrors }, "No messages in batch acknowledged — incrementing error counter")
                    if (circuit.shouldExit) return
                }
            } catch (loopError) {
                const failure = consecutiveFailure(name, consecutiveErrors)
                consecutiveErrors = failure.consecutiveErrors
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
): Promise<number> {
    const successful = await processWithConcurrency(messages, handler, maxConcurrency, name)
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
): Promise<Message[]> {
    const successful: Message[] = []
    let next = 0
    const workerCount = Math.min(messages.length, normalizeSqsWorkerCount(maxConcurrency))
    await Promise.all(Array.from({ length: workerCount }, async () => {
        // On shutdown, existing handlers drain but queued batch items are left for SQS.
        while (!_shutdownRequested && next < messages.length) {
            const message = messages[next++]
            try {
                await handler(message)
                successful.push(message)
            } catch (handlerError) {
                log.error({ name, messageId: message.MessageId, receiveCount: message.Attributes?.ApproximateReceiveCount, errorClass: errorClass(handlerError) }, "Handler error — message left in SQS for retry/redrive")
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

function errorClass(error: unknown): string {
    return error instanceof Error ? error.name : typeof error
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
