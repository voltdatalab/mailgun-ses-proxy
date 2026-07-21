import { buildHealthSnapshot, publicHealthProjection } from "@/lib/core/health-status"

/** CapRover liveness endpoint. Deliberately contains no operational telemetry. */
export function GET() {
    const snapshot = buildHealthSnapshot()
    return Response.json(publicHealthProjection(snapshot), { status: snapshot.httpStatus })
}
