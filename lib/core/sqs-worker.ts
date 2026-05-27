import {
    DeleteMessageCommand,
    Message,
    MessageSystemAttributeName,
    QueueAttributeName,
    ReceiveMessageCommand
} from "@aws-sdk/client-sqs"
import { sqsClient } from "../../service/aws/awsHelper"
import logger from "./logger"
import { heartbeat, markWorkerDead, registerWorker } from "./worker-registry"

const log = logger.child({ module: "sqs-worker" })

// Messages received more than this many times are discarded as poison-pills.
const MAX_RECEIVE_COUNT = 3

// Exponential back-off bounds for transient poll errors (ms).
const POLL_BACKOFF_MIN_MS = 1_000
const POLL_BACKOFF_MAX_MS = 30_000

// If the loop hits this many consecutive unexpected errors, the worker exits
// to avoid spinning indefinitely. The restart wrapper in server.ts will
// bring it back with backoff.
const MAX_CONSECUTIVE_ERRORS = 50

// Graceful-shutdown flag. When set, all workers finish their current iteration
// and then exit the poll loop so in-flight work can complete before the
// process terminates.
let _shutdownRequested = false

/**
 * Signal all workers to stop polling after the current iteration.
 * In-flight handler calls are allowed to complete.
 */
export function requestShutdown(): void {
    _shutdownRequested = true
    log.info("Shutdown requested — workers will drain after current iteration")
}

/** Visible for testing. */
export function _isShutdownRequested(): boolean {
    return _shutdownRequested
}

interface WorkerConfig {
    name: string
    queueUrl: string
    visibilityTimeout?: number
    waitTimeSeconds?: number
    handler: (message: Message) => Promise<void>
}

/**
 * Long-polling SQS worker.
 *  - handler resolves → message deleted
 *  - handler throws   → message left in SQS for retry
 *  - poll error       → exponential back-off, loop continues
 *  - receiveCount > MAX_RECEIVE_COUNT → deleted without calling handler
 *  - unexpected loop error → logged, backoff, loop continues (circuit-breaker exits after MAX_CONSECUTIVE_ERRORS)
 */
export async function startWorker(config: WorkerConfig) {
    const {
        name,
        queueUrl,
        visibilityTimeout = 30,
        waitTimeSeconds = 20,
        handler,
    } = config

    const client = bootstrapWorker(name, queueUrl)
    if (!client) return

    log.info({ name, queueUrl }, `Starting SQS worker: ${name}`)
    registerWorker(name)

    const receiveInput = {
        QueueUrl: queueUrl,
        AttributeNames: ["All"] as QueueAttributeName[],
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: [
            MessageSystemAttributeName.SentTimestamp,
            MessageSystemAttributeName.ApproximateReceiveCount,
        ],
        VisibilityTimeout: visibilityTimeout,
        WaitTimeSeconds: waitTimeSeconds,
    }

    let pollBackoffMs = POLL_BACKOFF_MIN_MS
    let consecutiveErrors = 0

    try {
        while (!_shutdownRequested) {
            try {
                let messages: Message[] | undefined
                try {
                    const { Messages } = await client.send(new ReceiveMessageCommand(receiveInput))
                    messages = Messages
                    pollBackoffMs = POLL_BACKOFF_MIN_MS
                } catch (pollError) {
                    log.error({ name, err: pollError }, `Poll error — retrying in ${pollBackoffMs}ms`)
                    await sleep(pollBackoffMs)
                    pollBackoffMs = Math.min(pollBackoffMs * 2, POLL_BACKOFF_MAX_MS)
                    consecutiveErrors++
                    continue
                }

                if (!messages || messages.length === 0) {
                    heartbeat(name)
                    consecutiveErrors = 0
                    continue
                }

                let anyHandlerSuccess = false

                for (const message of messages) {
                    const receiveCount = parseInt(
                        message.Attributes?.ApproximateReceiveCount ?? "0",
                        10
                    )

                    if (receiveCount > MAX_RECEIVE_COUNT) {
                        log.error(
                            { name, messageId: message.MessageId, receiveCount },
                            "Message exceeded max receive count — discarding"
                        )
                        await deleteMessage(client, queueUrl, message)
                        continue
                    }

                    try {
                        await handler(message)
                        await deleteMessage(client, queueUrl, message)
                        anyHandlerSuccess = true
                    } catch (handlerError) {
                        log.error(
                            { name, messageId: message.MessageId, receiveCount, err: handlerError },
                            "Handler error — message left in SQS for retry"
                        )
                    }
                }

                // Only consider the poll healthy if at least one handler
                // succeeded. If every message failed (e.g. DB down), the
                // worker should not mask the failure behind a heartbeat.
                if (anyHandlerSuccess) {
                    heartbeat(name)
                    consecutiveErrors = 0
                } else {
                    consecutiveErrors++
                    log.warn(
                        { name, consecutiveErrors },
                        "All messages in batch failed — incrementing error counter"
                    )
                }
            } catch (loopError) {
                consecutiveErrors++
                log.error(
                    { name, err: loopError, consecutiveErrors },
                    `Unexpected loop error — continuing (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`
                )

                if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                    const msg = `Worker ${name} hit ${MAX_CONSECUTIVE_ERRORS} consecutive errors — exiting loop`
                    log.error({ name }, msg)
                    markWorkerDead(name, msg)
                    return
                }

                await sleep(pollBackoffMs)
                pollBackoffMs = Math.min(pollBackoffMs * 2, POLL_BACKOFF_MAX_MS)
            }
        }

        // Clean exit — shutdown was requested
        log.info({ name }, `Worker ${name} stopped (shutdown requested)`)
        markWorkerDead(name, "graceful shutdown")
    } catch (fatalError) {
        // Belt-and-suspenders: if something escapes all inner catches, log and exit.
        log.error({ name, err: fatalError }, "Fatal error escaped worker loop")
        markWorkerDead(name, fatalError)
        throw fatalError
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Validates config and initialises the SQS client. Returns null if setup fails. */
function bootstrapWorker(name: string, queueUrl: string): ReturnType<typeof sqsClient> | null {
    if (!queueUrl) {
        log.error({ name }, "[bootstrap] Queue URL missing — worker will not start")
        return null
    }

    try {
        return sqsClient()
    } catch (err) {
        log.error({ name, err }, "[bootstrap] SQS client init failed (check SQS_REGION) — worker will not start")
        return null
    }
}

async function deleteMessage(
    client: ReturnType<typeof sqsClient>,
    queueUrl: string,
    message: Message
): Promise<void> {
    if (!message.ReceiptHandle) return
    try {
        await client.send(new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
        }))
    } catch (err) {
        // Non-fatal — message becomes visible again after the visibility timeout.
        log.warn({ messageId: message.MessageId, err }, "Failed to delete message from SQS")
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
