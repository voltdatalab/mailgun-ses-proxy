import { EventsProps, QueryParams } from "@/types/default"
import { prisma, saveNewsletterNotification } from "./database/db"
import { formatAsMailgunEvent, parseNotificationEvent } from "../lib/core/aws-utils"
import { DeleteMessageCommand, ReceiveMessageCommandOutput } from "@aws-sdk/client-sqs"
import logger from "../lib/core/logger"
import { QUEUE_URL, sqsClient } from "./aws/awsHelper"

const log = logger.child({ service: "events-service" })

function upsertStartParam(url: string, startVal: number) {
    url = url.slice(0, url.lastIndexOf("?"))
    const urlObject = new URL(`${url}/next`)
    const params = new URLSearchParams()
    params.set("start", String(startVal))
    urlObject.search = params.toString()
    return urlObject.toString()
}

export async function getEmailEvents(params: EventsProps) {
    const startTime = Date.now()
    const MAX_TIME_MS = 50000 // 50s budget, 10s buffer for Ghost's 60s timeout
    const BATCH_SIZE = 500
    let currentSkip = params.start || 0
    const initialSkip = currentSkip

    let type = [params.type]
    if (params.type.includes("OR")) {
        type = params.type.split("OR").map((s) => s.trim().toLocaleLowerCase())
    }

    const range = { gt: new Date(params.begin * 1000), lt: new Date(params.end * 1000) }

    const whereClause = {
        type: { in: type },
        newsletter: { newsletterBatch: { siteId: params.siteId } },
        created: range,
    }

    // Fetch in small batches, accumulate until time budget runs out
    let allResults: Awaited<ReturnType<typeof prisma.newsletterNotifications.findMany>> = []
    let batchCount = 0

    while (true) {
        const batchStart = Date.now()
        const batch = await prisma.newsletterNotifications.findMany({
            skip: currentSkip,
            take: BATCH_SIZE,
            orderBy: { id: params.order },
            include: { newsletter: { include: { newsletterBatch: true } } },
            where: whereClause,
        })
        const batchMs = Date.now() - batchStart
        batchCount++

        allResults = allResults.concat(batch)
        currentSkip += BATCH_SIZE

        // No more results
        if (batch.length < BATCH_SIZE) {
            currentSkip = initialSkip + allResults.length
            break
        }

        // Time budget exhausted
        const elapsed = Date.now() - startTime
        if (elapsed > MAX_TIME_MS) {
            log.info({ elapsedMs: elapsed, batches: batchCount, totalRows: allResults.length, reason: "time_budget" }, "stopping batch fetch")
            break
        }
    }

    const totalMs = Date.now() - startTime
    const next = upsertStartParam(params.url, currentSkip)
    const output = await formatAsMailgunEvent(allResults, next)

    log.info({ totalMs, batches: batchCount, totalRows: allResults.length, skip: initialSkip, nextSkip: currentSkip, siteId: params.siteId }, "getEmailEvents complete")

    return output
}

export function validateQueryParams(searchParams: URLSearchParams): QueryParams {
    const exception = (missingParam: string) => {
        throw `Missing query param (${missingParam})`
    }

    const event = searchParams.get("event") || exception("event")
    const begin = searchParams.get("begin") || exception("begin")
    const end = searchParams.get("end") || exception("end")

    const queryParams = {
        start: parseInt(searchParams.get("start") || "0"),
        limit: parseInt(searchParams.get("limit") || "300"),
        event: event,
        begin: parseInt(begin),
        end: parseInt(end),
        order: searchParams.get("ascending") ? "asc" : "desc",
    } as QueryParams

    return queryParams
}

export async function fetchAnalyticsEvents(queryParam: QueryParams, siteId: string, url: string) {
    const response = await getEmailEvents({
        siteId,
        type: queryParam.event,
        begin: queryParam.begin,
        end: queryParam.end,
        order: queryParam.order,
        limit: queryParam.limit,
        start: queryParam.start,
        url,
    })
    return response
}


export async function processNewsletterEmailEvents(response: ReceiveMessageCommandOutput) {
    const log = logger.child({ service: "processEmailEvents" })
    if (!response.Messages || response.Messages.length == 0)
        throw new Error("No messages found")
    for (const msg of response.Messages) {
        if (msg.Body && msg.MessageId) {
            try {
                const result = parseNotificationEvent(msg.MessageId, msg.Body)
                await saveNewsletterNotification(result)
            } catch (e) {
                log.error(e)
            }
            const command = new DeleteMessageCommand({
                QueueUrl: QUEUE_URL.NEWSLETTER_NOTIFICATION,
                ReceiptHandle: msg.ReceiptHandle,
            })
            await sqsClient().send(command)
        }
    }
}