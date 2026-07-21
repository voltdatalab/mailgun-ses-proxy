import logger from "@/lib/core/logger"
import { errorClass } from "@/lib/core/error-class"
import { fetchAnalyticsEvents, QueryValidationError, validateQueryParams } from "@/service/events-service/events-utils"
import { NextRequest } from "next/server"

const log = logger.child({ module: "app/v3/events" })
type pathParam = { params: Promise<{ siteId: string, slug?: string[] }> }

function publicRequestUrl(req: NextRequest) {
    const forwardedHost = req.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
    const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    if (!forwardedHost || (forwardedProto !== "http" && forwardedProto !== "https")) return req.url
    if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(forwardedHost)) return req.url

    try {
        const origin = new URL(`${forwardedProto}://${forwardedHost}`)
        if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return req.url
        const url = new URL(req.url)
        url.protocol = origin.protocol
        url.hostname = origin.hostname
        url.port = origin.port
        return url.toString()
    } catch {
        return req.url
    }
}

/**
 * GET /api/v3/events/{siteId}/{...slug}
 * 
 * Retrieves analytics events for a specific site with optional filtering parameters.
 * 
 * @param req - The Next.js request object containing query parameters
 * @param params - Path parameters containing siteId and optional slug array
 * @param params.siteId - The unique identifier for the site
 * @param params.slug - Optional array of additional path segments
 * 
 * @returns JSON response containing analytics events data or error message
 * 
 */
async function fetchAnalyticsEvent(req: NextRequest, { params }: pathParam) {
    const { siteId } = await params
    try {
        const queryParams = validateQueryParams(req.nextUrl.searchParams)
        const events = await fetchAnalyticsEvents(queryParams, siteId, publicRequestUrl(req))
        log.debug({ count: events.items.length }, "analytics events count")
        return Response.json(events, { status: 200 })
    } catch (e) {
        log.error({ errorClass: errorClass(e) }, "error when fetching analytics events")
        if (e instanceof QueryValidationError) {
            return Response.json({ message: e.message }, { status: 400 })
        }
        return Response.json({ message: "Unable to fetch analytics events" }, { status: 500 })
    }
}

export const GET = fetchAnalyticsEvent 