import { NotificationEvent } from "../../lib/core/aws-utils"
import { MailgunMessage } from "@/types/mailgun"
import { safeStringify } from "../../lib/core/common"
import { PrismaClient } from "../../lib/generated"
import logger from "../../lib/core/logger"
import { SendMessageCommand } from "@aws-sdk/client-sqs"
import { QUEUE_URL, sqsClient } from "../aws/awsHelper"

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

export async function createNewsletterEntry(messageId: string, batchId: string, toEmail: string, recipientData: string) {
    return prisma.newsletterMessages.create({
        data: {
            newsletterBatchId: batchId,
            formatedContents: "",
            recipientData,
            toEmail,
            messageId,
        },
    })
}

export async function createNewsletterErrorEntry(
    messageId: string,
    errorMessage: string,
    batchId: string,
    toEmail: string,
    recipientData: string
) {
    return prisma.newsletterErrors.create({
        data: {
            error: errorMessage,
            newsletterBatchId: batchId,
            messageId: messageId,
            formatedContents: "",
            recipientData,
            toEmail,
        },
    })
}

export async function saveNewsletterNotification(event: NotificationEvent) {
    const log = logger.child({ service: "saveNewsletterNotification" })
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
            try {
                const params = {
                    QueueUrl: QUEUE_URL.NEWSLETTER_NOTIFICATION,
                    MessageBody: String(event.raw),
                    DelaySeconds: 30,
                    MessageAttributes: {
                        notificationId: { DataType: "String", StringValue: event.notificationId },
                        messageId: { DataType: "String", StringValue: event.messageId },
                    },
                }
                await sqsClient().send(new SendMessageCommand(params))
                log.info({ notificationId: event.notificationId, messageId: event.messageId }, "re-enqueued newsletter notification after FK error")
            } catch (sqse) {
                log.error({ error: sqse, notificationId: event.notificationId, messageId: event.messageId }, "failed to re-enqueue newsletter notification")
            }
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
    return prisma.systemMailNotifications.create({
        data: {
            messageId: event.messageId,
            rawEvent: event.raw,
            type: event.type,
            notificationId: event.notificationId,
            timestamp: event.timestamp,
        },
    })
}