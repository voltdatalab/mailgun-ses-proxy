import { buildHealthSnapshot, detailedHealthProjection } from "@/lib/core/health-status"

/** Authenticated operational queue and worker health endpoint. */
export function GET() {
    const snapshot = buildHealthSnapshot()
    return Response.json(detailedHealthProjection(snapshot), { status: snapshot.httpStatus })
}
