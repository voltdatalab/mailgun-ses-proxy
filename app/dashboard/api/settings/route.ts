import { getSessionFromCookies, hashPassword } from "@/lib/dashboard/auth"
import { errorClass } from "@/lib/core/error-class"
import logger from "@/lib/core/logger"
import { prisma } from "@/lib/database"

const log = logger.child({ module: "dashboard/api/settings" })

export async function GET() {
    try {
        const session = await getSessionFromCookies()
        if (!session) {
            return Response.json({ error: "Unauthorized" }, { status: 401 })
        }

        return Response.json({
            operationalConfiguration: {
                source: "deployment_environment",
                dashboardOverridesEnabled: false,
            },
        })
    } catch (error) {
        log.error({ errorClass: errorClass(error) }, "Settings GET error")
        return Response.json({ error: "Internal server error" }, { status: 500 })
    }
}

export async function PUT(req: Request) {
    try {
        const session = await getSessionFromCookies()
        if (!session) {
            return Response.json({ error: "Unauthorized" }, { status: 401 })
        }

        const body: unknown = await req.json()
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return Response.json({ error: "Invalid request format" }, { status: 400 })
        }

        const candidate = body as Record<string, unknown>
        if (Object.prototype.hasOwnProperty.call(candidate, "settings")) {
            return Response.json(
                { error: "Operational settings are managed in the deployment environment" },
                { status: 400 },
            )
        }
        if (Object.keys(candidate).some((key) => key !== "credentials")) {
            return Response.json({ error: "Invalid request format" }, { status: 400 })
        }

        const credentials = candidate.credentials
        if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
            return Response.json({ error: "Invalid credential update" }, { status: 400 })
        }

        const credentialInput = credentials as { email?: unknown; password?: unknown }
        const email = typeof credentialInput.email === "string" ? credentialInput.email.trim() : ""
        const password = credentialInput.password
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== "string" || password.length < 16) {
            return Response.json({ error: "Invalid credential update" }, { status: 400 })
        }

        await prisma.dashboardUser.update({
            where: { id: session.sub },
            data: { email, password: await hashPassword(password) },
        })
        log.info({ credentialsUpdated: true }, "Settings updated")
        return Response.json({ ok: true, credentialsUpdated: true })
    } catch (error) {
        log.error({ errorClass: errorClass(error) }, "Settings PUT error")
        return Response.json({ error: "Internal server error" }, { status: 500 })
    }
}
