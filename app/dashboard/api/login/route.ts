import { DashboardBootstrapError, verifyPassword, createSession, setSessionCookie, ensureBootstrapUser } from "@/lib/dashboard/auth"
import logger from "@/lib/core/logger"
import { prisma } from "@/lib/database"

const log = logger.child({ module: "dashboard/api/login" })

function errorClass(error: unknown): string {
    return error instanceof Error && error.name ? error.name : "UnknownError"
}

export async function POST(req: Request) {
    try {
        const body = await req.json()
        const { email, password } = body as { email?: string; password?: string }
        if (!email || !password) return Response.json({ error: "Email and password are required" }, { status: 400 })

        await ensureBootstrapUser()
        const user = await prisma.dashboardUser.findUnique({ where: { email } })
        if (!user || !(await verifyPassword(password, user.password))) {
            log.warn("Invalid dashboard login attempt")
            return Response.json({ error: "Invalid credentials" }, { status: 401 })
        }

        const token = await createSession(user.id, user.email, user.name || "")
        const response = Response.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } })
        setSessionCookie(response, token)
        log.info("Successful dashboard login")
        return response
    } catch (error) {
        log.error({ errorClass: errorClass(error) }, "Dashboard login failed")
        if (error instanceof DashboardBootstrapError) {
            return Response.json({ error: "Dashboard is temporarily unavailable" }, { status: 503 })
        }
        return Response.json({ error: "Internal server error" }, { status: 500 })
    }
}
