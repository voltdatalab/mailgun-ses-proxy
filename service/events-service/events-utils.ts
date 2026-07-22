import { EventsProps, QueryParams } from "@/types/default"
import { formatAsMailgunEvent } from "../../lib/core/aws-utils"
import { prisma } from "../database/db"

type EventsCursor = {
    v: 1
    created: string
    id: string
    order: "asc" | "desc"
}

export class QueryValidationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "QueryValidationError"
    }
}

function fail(message: string): never {
    throw new QueryValidationError(message)
}

function parseInteger(value: string | null, key: string, fallback?: number) {
    if (value === null && fallback !== undefined) return fallback
    // Do not let Number() accept non-decimal forms such as 1e3, 0x10, or Infinity.
    if (value === null || !/^-?\d+$/.test(value)) fail(`Invalid query parameter: ${key}`)
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) fail(`Invalid query parameter: ${key}`)
    return parsed
}

function parseUnixSeconds(value: string | null, key: "begin" | "end") {
    const seconds = parseInteger(value, key)
    const date = new Date(seconds * 1000)
    if (!Number.isFinite(date.getTime())) fail(`Invalid query parameter: ${key}`)
    return seconds
}

function encodeEventsCursor(cursor: EventsCursor) {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

/** Decodes the opaque cursor only after validating its complete pagination contract. */
export function decodeEventsCursor(value: string, order: "asc" | "desc"): EventsCursor {
    let parsed: unknown
    try {
        parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    } catch {
        return fail("Invalid pagination cursor")
    }

    if (!parsed || typeof parsed !== "object") return fail("Invalid pagination cursor")
    const cursor = parsed as Partial<EventsCursor>
    const created = typeof cursor.created === "string" ? new Date(cursor.created) : undefined
    if (
        cursor.v !== 1 ||
        typeof cursor.id !== "string" || cursor.id.length === 0 ||
        !created || !Number.isFinite(created.getTime()) ||
        (cursor.order !== "asc" && cursor.order !== "desc") ||
        cursor.order !== order
    ) return fail("Invalid pagination cursor")

    return { v: 1, created: created.toISOString(), id: cursor.id, order: cursor.order }
}

function getNextPageUrl(baseUrl: string, cursor?: EventsCursor) {
    const url = new URL(baseUrl)
    if (cursor) {
        // Offset is used solely for a legacy first page and must not accompany a cursor.
        url.searchParams.delete("start")
        url.searchParams.set("cursor", encodeEventsCursor(cursor))
    }
    return url.toString()
}

function eventTypes(type: string) {
    return type.split(/\s+OR\s+/i).map(value => value.trim().toLowerCase())
}

/** Retrieves events using ingestion-time (`created`) filters, as required by Ghost analytics. */
export async function getEmailEvents(params: EventsProps) {
    const timeRange = {
        gt: new Date(params.begin * 1000),
        lt: new Date(params.end * 1000),
    }
    const cursor = params.cursor
    // This keyset is stable and duplicate-free only for a fixed result set; it is not cross-request snapshot isolation.
    // A concurrent insert at the cursor's exact created timestamp may sort behind a random UUID cursor and be recovered by polling/deduplication.
    const seek = cursor && {
        OR: params.order === "asc"
            ? [
                { created: { gt: new Date(cursor.created) } },
                { created: new Date(cursor.created), id: { gt: cursor.id } },
            ]
            : [
                { created: { lt: new Date(cursor.created) } },
                { created: new Date(cursor.created), id: { lt: cursor.id } },
            ],
    }

    const result = await prisma.newsletterNotifications.findMany({
        ...(cursor ? {} : { skip: params.start }),
        take: params.limit,
        orderBy: [{ created: params.order }, { id: params.order }],
        include: {
            newsletter: {
                include: { newsletterBatch: true },
            },
        },
        where: {
            type: { in: eventTypes(params.type) },
            newsletter: { newsletterBatch: { siteId: params.siteId } },
            created: timeRange,
            ...(seek ? { AND: [seek] } : {}),
        },
    })

    const last = result.at(-1)
    const nextCursor = last
        ? { v: 1 as const, created: last.created.toISOString(), id: last.id, order: params.order }
        : cursor
    return formatAsMailgunEvent(result, getNextPageUrl(params.url, nextCursor))
}

/** Validates the documented Mailgun-compatible analytics query contract. */
export function validateQueryParams(searchParams: URLSearchParams): QueryParams {
    const event = searchParams.get("event")
    if (!event || event.trim() === "") fail("Missing required query parameter: event")

    const limit = parseInteger(searchParams.get("limit"), "limit", 300)
    if (limit < 1 || limit > 300) fail("Invalid query parameter: limit")

    const start = parseInteger(searchParams.get("start"), "start", 0)
    if (start < 0) fail("Invalid query parameter: start")

    const begin = parseUnixSeconds(searchParams.get("begin"), "begin")
    const end = parseUnixSeconds(searchParams.get("end"), "end")
    if (begin >= end) fail("Invalid query parameter: begin/end")

    const ascending = searchParams.get("ascending")
    let order: "asc" | "desc" = "desc"
    if (ascending && ["yes", "true", "1"].includes(ascending.toLowerCase())) order = "asc"
    else if (ascending && !["no", "false", "0"].includes(ascending.toLowerCase())) fail("Invalid query parameter: ascending")

    const cursorValue = searchParams.get("cursor")
    const cursor = cursorValue === null ? undefined : decodeEventsCursor(cursorValue, order)
    return { start, limit, event, begin, end, order, cursor }
}

export async function fetchAnalyticsEvents(queryParams: QueryParams, siteId: string, url: string) {
    return getEmailEvents({ siteId, type: queryParams.event, begin: queryParams.begin, end: queryParams.end, order: queryParams.order, limit: queryParams.limit, start: queryParams.start, cursor: queryParams.cursor, url })
}
