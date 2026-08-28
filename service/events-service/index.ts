import { createEventProcessor } from "../../lib/core/event-processor"
import { getNewsletterMessage, isNewsletterNotificationForeignKeyError, saveNewsletterNotification, saveNewsletterNotificationOrphan } from "../database/db"

/**
 * Standardized handler for newsletter-related SES notification events.
 */
export const handleNewsletterEmailEvent = createEventProcessor({
    name: "newsletter-events",
    lookupMessage: getNewsletterMessage,
    saveNotification: saveNewsletterNotification,
    persistMissingParentNotification: saveNewsletterNotificationOrphan,
    isMissingParentSaveError: isNewsletterNotificationForeignKeyError,
})
