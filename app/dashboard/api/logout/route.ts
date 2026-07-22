import { clearSessionCookie } from "@/lib/dashboard/auth"
import logger from "@/lib/core/logger"
import { errorClass } from "@/lib/core/error-class"

const log = logger.child({ module: "dashboard/api/logout" })

export async function POST() {
    try {
        const response = Response.json({ ok: true })
        clearSessionCookie(response)
        log.info("Dashboard logout")
        return response
    } catch (error) {
        log.error({ errorClass: errorClass(error) }, "Logout error")
        return Response.json({ error: "Internal server error" }, { status: 500 })
    }
}
