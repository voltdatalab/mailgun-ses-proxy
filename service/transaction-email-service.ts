import logger from "@/lib/core/logger"
import { errorClass } from "@/lib/core/error-class"
import { prisma } from "@/service/database/db"
import { MessageTag, SendEmailCommand } from "@aws-sdk/client-sesv2"
import { sesSystemClient } from "./aws/awsHelper"
import { EmailPayload } from "./validation-service/validation"

const log = logger.child({ module: "service:transactional-email-service" })

function formatEmail(email: EmailPayload, tags: MessageTag[]) {
    if (!process.env.TRANSACTIONAL_CONFIGURATION_SET_NAME) {
        throw new Error("env variable TRANSACTIONAL_CONFIGURATION_SET_NAME is not defined")
    }
    return {
        ConfigurationSetName: process.env.TRANSACTIONAL_CONFIGURATION_SET_NAME,
        FromEmailAddress: email.from,
        Destination: {
            ToAddresses: email.to,
        },
        ReplyToAddresses: email.replyTo ? [email.replyTo] : [],
        FeedbackForwardingEmailAddress: email.replyTo || email.from,
        Content: {
            Simple: {
                Subject: {
                    Data: email.subject,
                },
                Body: {
                    Html: {
                        Data: email.html,
                    },
                },
            },
        },
        EmailTags: tags
    }
}


export async function sendSystemMail(email: EmailPayload) {
    if (!email.to) throw new Error("Email to address is required")

    const mail = formatEmail(email, [{ Name: 'transactional-email', Value: 'true' }])
    const cmd = new SendEmailCommand(mail)
    let resp: { MessageId?: string }
    try {
        resp = await sesSystemClient().send(cmd)
    } catch (error) {
        log.error({ errorClass: errorClass(error) }, "failed to send system mail")
        throw error
    }

    if (resp.MessageId) {
        const { id } = await prisma.systemMails.create({
            select: { id: true },
            data: {
                messageId: resp.MessageId,
                toEmail: email.to.join(","),
                fromEmail: email.from,
                subject: email.subject,
                contents: email.html,
            }
        })
        log.info("system mail sent")
        return { messageId: resp.MessageId, dbId: id }
    }

    log.error({ errorClass: "MissingMessageId" }, "failed to send system mail")
    throw new Error("Failed to send email")
}

