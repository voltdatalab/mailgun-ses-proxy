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
}

/** Creates a standardised SES notification handler. Resolves to ACK; throws to retry. */
export function createEventProcessor(config: EventProcessorConfig) {
    const { name, lookupMessage, saveNotification } = config
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
            throw new TrackedEventMessageMissingError()
        }
        await saveNotification(result)
        log.info({ name, type: result.type }, "Processed event successfully")
    }
}
