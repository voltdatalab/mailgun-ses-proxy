import { EventsProps, QueryParams } from "@/types/default"
import { formatAsMailgunEvent } from "../../lib/core/aws-utils"
import { Prisma } from "../../lib/generated"
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

function parseUnixSeconds(value: string | null, key: "begin" | "end", fallback: number) {
    if (value === null || value === "") return fallback
    // Ghost uses Unix seconds with optional milliseconds. Keep the grammar
    // strict so exponent, hex, whitespace and special values remain rejected.
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) fail(`Invalid query parameter: ${key}`)
    const seconds = Number(value)
    const date = new Date(seconds * 1000)
    if (!Number.isFinite(seconds) || !Number.isFinite(date.getTime())) fail(`Invalid query parameter: ${key}`)
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

export class AnalyticsBusyError extends Error {
    constructor() { super("Analytics busy; retry shortly"); this.name = "AnalyticsBusyError" }
}

// No unbounded wait queue: sending and event ingestion keep their pool capacity.
let analyticsActive = false

export function buildEventIdQuery(params: EventsProps) {
    const order = Prisma.raw(params.order === "asc" ? "ASC" : "DESC")
    const comparison = Prisma.raw(params.order === "asc" ? ">" : "<")
    const offset = params.cursor ? 0 : params.start
    if (offset > 10000 || !Number.isSafeInteger(offset + params.limit)) fail("Invalid query parameter: start")
    const cursor = params.cursor
    const seek = cursor ? Prisma.sql`AND (n.created ${comparison} ${new Date(cursor.created)}
        OR (n.created = ${new Date(cursor.created)} AND n.id ${comparison} ${cursor.id}))` : Prisma.empty
    // Each equality on type can walk (type, created, id) in result order.
    // Merge only the page-sized ID streams, never millions of rawEvent payloads.
    const branches = [...new Set(eventTypes(params.type))].map(type => Prisma.sql`(
        SELECT n.id, n.created FROM NewsletterNotifications n
        FORCE INDEX (idx_notifications_type_created_id)
        STRAIGHT_JOIN NewsletterMessages m ON m.messageId = n.messageId
        STRAIGHT_JOIN NewsletterBatch b ON b.id = m.newsletterBatchId
        WHERE n.type = ${type} AND b.siteId = ${params.siteId}
          AND n.created > ${new Date(params.begin * 1000)} AND n.created < ${new Date(params.end * 1000)}
          ${seek}
        ORDER BY n.created ${order}, n.id ${order} LIMIT ${offset + params.limit}
    )`)
    return Prisma.sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ id, created
        FROM (${Prisma.join(branches, " UNION ALL ")}) AS page_ids
        ORDER BY created ${order}, id ${order} LIMIT ${params.limit} OFFSET ${offset}`
}

/** Read one bounded page; never sort event bodies or campaign contents. */
export async function getEmailEvents(params: EventsProps) {
    if (analyticsActive) throw new AnalyticsBusyError()
    analyticsActive = true
    try {
        const ids = await prisma.$queryRaw<{ id: string, created: Date }[]>(buildEventIdQuery(params))
        const rows = ids.length ? await prisma.newsletterNotifications.findMany({
            where: { id: { in: ids.map(row => row.id) } },
            select: {
                id: true, created: true, timestamp: true, type: true, messageId: true, rawEvent: true,
                newsletter: { select: { toEmail: true, newsletterBatch: { select: { batchId: true } } } },
            },
        }) : []
        const byId = new Map(rows.map(row => [row.id, row]))
        const result = ids.flatMap(row => { const event = byId.get(row.id); return event ? [event] : [] })
        // Advance using the selected IDs even if a concurrent retention pass removed a payload.
        const last = ids.at(-1)
        const nextCursor = last
            ? { v: 1 as const, created: last.created.toISOString(), id: last.id, order: params.order }
            : params.cursor
        return formatAsMailgunEvent(result, getNextPageUrl(params.url, nextCursor))
    } finally {
        analyticsActive = false
    }
}

/** Validates the documented Mailgun-compatible analytics query contract. */
export function validateQueryParams(searchParams: URLSearchParams): QueryParams {
    const event = searchParams.get("event")
    if (!event || event.trim() === "") fail("Missing required query parameter: event")
    if (event.length > 512 || eventTypes(event).length > 16) fail("Too many event types")

    const limit = parseInteger(searchParams.get("limit"), "limit", 300)
    if (limit < 1 || limit > 300) fail("Invalid query parameter: limit")

    const start = parseInteger(searchParams.get("start"), "start", 0)
    if (start < 0 || start > 10000) fail("Invalid query parameter: start")

    // Mailgun-compatible bounds are optional. Current Ghost omits `end` on
    // its normal incremental analytics fetch.
    const begin = parseUnixSeconds(searchParams.get("begin"), "begin", 0)
    const end = parseUnixSeconds(searchParams.get("end"), "end", Date.now() / 1000)
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
