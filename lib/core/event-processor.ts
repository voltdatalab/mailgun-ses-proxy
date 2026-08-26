import { Message } from "@aws-sdk/client-sqs"
import { NotificationEvent, parseNotificationEvent } from "./aws-utils"
import logger from "./logger"

const log = logger.child({ module: "event-processor" })

export class TrackedEventMessageMissingError extends Error {
    constructor() {
        super("Tracked event message missing; will retry")
        this.name = "TrackedEventMessageMissingError"
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

interface EventProcessorConfig {
    name: string
    lookupMessage: (messageId: string) => Promise<any>
    saveNotification: (event: NotificationEvent) => Promise<any>
    persistMissingParentNotification?: (event: NotificationEvent) => Promise<any>
    isMissingParentSaveError?: (error: unknown) => boolean
}

/** Creates a standardised SES notification handler. Resolves to ACK; throws to retry. */
export function createEventProcessor(config: EventProcessorConfig) {
    const { name, lookupMessage, saveNotification, persistMissingParentNotification, isMissingParentSaveError } = config

    async function persistMissingParent(result: NotificationEvent) {
        if (!persistMissingParentNotification) {
            throw new TrackedEventMessageMissingError()
        }

        await persistMissingParentNotification(result)
        log.warn({ name, reason: "missing_parent", type: result.type }, "Tracked event parent missing; orphan persisted")
    }

    return async (message: Message) => {
        if (!message.Body || !message.MessageId) {
            log.warn({ name }, "Invalid SQS event message")
            throw new Error("Invalid SQS event message")
        }
        const result = parseNotificationEvent(message.MessageId, message.Body)
        if (!result.isNewsletterEmailEvent && !result.isTransactionalEmailEvent) {
            log.warn({ name }, "Untracked event — acknowledging")
            return
        }
        if (!await lookupMessage(result.messageId)) {
            await persistMissingParent(result)
            return
        }

        try {
            await saveNotification(result)
        } catch (error) {
            if (persistMissingParentNotification && isMissingParentSaveError?.(error)) {
                await persistMissingParent(result)
                return
            }
            throw error
        }

        log.info({ name, type: result.type }, "Processed event successfully")
    }
}
