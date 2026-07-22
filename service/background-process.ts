import { startWorker } from "../lib/core/sqs-worker"
import { QUEUE_URL } from "./aws/awsHelper"
import { handleNewsletterEmailEvent } from "./events-service"
import { validateAndSend } from "./newsletter-service"
import { handleSystemEmailEvent } from "./system-email-notification"

/**
 * Processes the newsletter queue (Ghost CMS batches).
 * Uses a long visibility timeout (15m) to handle large batch sends.
 */
export async function processNewsletterQueue() {
    return startWorker({
        name: "newsletter-sender",
        queueUrl: QUEUE_URL.NEWSLETTER!,
        visibilityTimeout: 900, // 15 minutes for processing batches
        // Each SQS message represents an entire newsletter campaign.
        batchSize: 1,
        maxConcurrency: 1,
        handler: validateAndSend
    })
}

/**
 * Processes delivery/bounce events for newsletter emails.
 */
export async function processNewsletterEventsQueue() {
    return startWorker({
        name: "newsletter-events",
        queueUrl: QUEUE_URL.NEWSLETTER_NOTIFICATION!,
        // Batch handlers ACK only after all ten events complete; retain them for 2m.
        visibilityTimeout: 120,
        handlerTimeoutMs: 90_000,
        batchSize: 10,
        maxConcurrency: 10,
        handler: handleNewsletterEmailEvent
    })
}

/**
 * Processes delivery/bounce events for system/transactional emails.
 */
export async function processSystemEventsQueue() {
    return startWorker({
        name: "system-events",
        queueUrl: QUEUE_URL.SYSTEM_NOTIFICATION!,
        // Batch handlers ACK only after all ten events complete; retain them for 2m.
        visibilityTimeout: 120,
        handlerTimeoutMs: 90_000,
        batchSize: 10,
        maxConcurrency: 10,
        handler: handleSystemEmailEvent
    })
}


