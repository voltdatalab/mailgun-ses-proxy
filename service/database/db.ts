import { SendEmailRequest } from "@aws-sdk/client-sesv2"
import { NotificationEvent } from "../../lib/core/aws-utils"
import { MailgunMessage } from "@/types/mailgun"
import { safeStringify } from "../../lib/core/common"
import { PrismaClient } from "../../lib/generated"
import logger from "../../lib/core/logger"

export const prisma = new PrismaClient()

export async function createNewsletterBatchEntry(siteId: string, message: MailgunMessage) {
    const batchId = message["v:email-id"]
    const contents = safeStringify(message)
    const fromEmail = message.from
    return prisma.newsletterBatch.create({
        select: { id: true },
        data: {
            siteId,
            batchId,
            contents,
            fromEmail,
        },
    })
}

export async function createNewsletterEntry(messageId: string, batchId: string, payload: SendEmailRequest) {
    const toEmail = payload.Destination?.ToAddresses?.join("") || ""
    return prisma.newsletterMessages.create({
        data: {
            newsletterBatchId: batchId,
            formatedContents: safeStringify(payload),
            toEmail,
            messageId,
        },
    })
}

export async function createNewsletterErrorEntry(
    messageId: string,
    errorMessage: string,
    batchId: string,
    payload: SendEmailRequest
) {
    const toEmail = payload.Destination?.ToAddresses?.join("") || ""
    return prisma.newsletterErrors.create({
        data: {
            error: errorMessage,
            newsletterBatchId: batchId,
            messageId: messageId,
            formatedContents: safeStringify(payload),
            toEmail
        },
    })
}

export async function saveNewsletterNotification(event: NotificationEvent) {
    const log = logger.child({ service: "saveNewsletterNotification" })
    log.debug({ messageId: event.messageId, notificationId: event.notificationId }, "saving newsletter notification")
    try {
        return await prisma.newsletterNotifications.create({
            data: {
                messageId: event.messageId,
                rawEvent: event.raw,
                type: event.type,
                notificationId: event.notificationId,
                timestamp: event.timestamp,
            },
        })
    } catch (e: any) {
        log.error({ error: e, messageId: event.messageId, notificationId: event.notificationId }, "failed saving newsletter notification")
        if (e?.code === "P2003") {
            log.error({ code: e.code, meta: e?.meta }, "foreign key constraint violated when saving newsletter notification")
        }
        throw e
    }
}

export async function getNewsletterContent(id: string) {
    const result = await prisma.newsletterBatch.findUnique({
        where: { id },
        select: { contents: true }
    })
    return result && result.contents ? JSON.parse(result.contents) : null
}

export async function saveSystemEmailEvent(event: NotificationEvent) {
    return prisma.newsletterNotifications.create({
        data: {
            messageId: event.messageId,
            rawEvent: event.raw,
            type: event.type,
            notificationId: event.notificationId,
            timestamp: event.timestamp,
        },
    })
}