import logger from "@/lib/core/logger"
import { fetchAnalyticsEvents, validateQueryParams } from "@/service/events-service"
import { NextRequest } from "next/server"

const log = logger.child({ path: "app/v3/events" })
type pathParam = { params: Promise<{ siteId: string, slug?: string[] }> }

async function fetchAnalyticsEvent(req: NextRequest, { params }: pathParam) {
    const { siteId, slug } = await params
    const startTime = Date.now()
    try {
        const queryParams = validateQueryParams(req.nextUrl.searchParams)
        log.info({ queryParams, siteId, slug, fullUrl: req.url, method: req.method }, "incoming request")
        
        const events = await fetchAnalyticsEvents(queryParams, siteId, req.url)
        
        const elapsed = Date.now() - startTime
        log.info({ count: events.items.length, siteId, slug, elapsedMs: elapsed, elapsedSec: (elapsed / 1000).toFixed(2) }, "analytics events response")
        return Response.json(events, { status: 200 })
    } catch (e) {
        const elapsed = Date.now() - startTime
        log.error({ err: e, elapsedMs: elapsed, elapsedSec: (elapsed / 1000).toFixed(2) }, 'error when fetching analytics events')
        const errorMessage = e instanceof Error ? e.message : "An error occurred";
        return Response.json({ message: errorMessage }, { status: 400 })
    }
}

export const GET = fetchAnalyticsEvent
