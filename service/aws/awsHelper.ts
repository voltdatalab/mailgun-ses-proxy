import { SESv2Client } from "@aws-sdk/client-sesv2"
import { SQSClient } from "@aws-sdk/client-sqs"

export const QUEUE_URL = {
    NEWSLETTER: process.env.NEWSLETTER_QUEUE,
    NEWSLETTER_NOTIFICATION: process.env.NEWSLETTER_NOTIFICATION_QUEUE,
    SYSTEM_NOTIFICATION: process.env.TRANSACTIONAL_NOTIFICATION_QUEUE
}

const regions = (process.env.SES_REGION || "").split(",").map(s => s.trim())

const newsletterClients = new Map<string, SESv2Client>()

export function sesNewsletterClient() {
    if (!process.env.SES_REGION) throw new Error("env variable SES_REGION not found")
    const region = regions[Math.floor(Math.random() * regions.length)];
    if (!newsletterClients.has(region)) {
        newsletterClients.set(region, new SESv2Client({ region }))
    }
    return newsletterClients.get(region)!
}

let _sesSystemClient: SESv2Client | null = null

export const sesSystemClient = () => {
    if (_sesSystemClient) return _sesSystemClient
    const region = process.env.SES_TRANSACTIONAL_REGION || regions[0]
    if (!region) throw new Error("env SES_TRANSACTIONAL_REGION is not defined")
    _sesSystemClient = new SESv2Client({ region })
    return _sesSystemClient
}

let _sqsClient: SQSClient | null = null

export const sqsClient = () => {
    if (_sqsClient) return _sqsClient
    const region = process.env.SQS_REGION
    if (!region) throw new Error("env SQS_REGION is not defined")
    _sqsClient = new SQSClient({ region })
    return _sqsClient
}
