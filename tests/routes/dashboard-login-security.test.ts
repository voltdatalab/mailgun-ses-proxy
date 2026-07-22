import { beforeEach, describe, expect, it, vi } from "vitest"

const ensureBootstrapUser = vi.fn()
const verifyPassword = vi.fn()
const createSession = vi.fn()
const setSessionCookie = vi.fn()
const dashboardUser = { findUnique: vi.fn(), update: vi.fn() }
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

vi.mock("@/lib/dashboard/auth", () => ({
    DashboardBootstrapError: class DashboardBootstrapError extends Error {},
    ensureBootstrapUser, verifyPassword, createSession, setSessionCookie,
}))
vi.mock("@/lib/database", () => ({ prisma: { dashboardUser } }))
vi.mock("@/lib/core/logger", () => ({ default: { child: () => log } }))

describe("dashboard login credential boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        ensureBootstrapUser.mockResolvedValue(undefined)
        verifyPassword.mockResolvedValue(true)
        createSession.mockResolvedValue("session-token")
        dashboardUser.findUnique.mockResolvedValue({ id: "user-1", email: "operator@example.com", password: "hash", name: "Operator" })
    })

    it("ignores unauthenticated replacement credential fields", async () => {
        const { POST } = await import("@/app/dashboard/api/login/route")
        const response = await POST(new Request("http://localhost/dashboard/api/login", {
            method: "POST",
            body: JSON.stringify({ email: "operator@example.com", password: "valid-password", newEmail: "attacker@example.com", newPassword: "attacker-password" }),
        }))
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ ok: true, user: { email: "operator@example.com" } })
        expect(dashboardUser.update).not.toHaveBeenCalled()
        expect(createSession).toHaveBeenCalledWith("user-1", "operator@example.com", "Operator")
    })
})
