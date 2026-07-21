import { beforeEach, describe, expect, it, vi } from "vitest"

const dashboardUser = {
    count: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
}

vi.mock("next/headers", () => ({ cookies: vi.fn() }))
vi.mock("@/lib/database", () => ({ prisma: { dashboardUser } }))

describe("dashboard bootstrap security", () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        delete process.env.DASHBOARD_INITIAL_ADMIN_EMAIL
        delete process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD
        delete process.env.DASHBOARD_JWT_SECRET
    })

    it("fails closed without creating a user when an empty database has no bootstrap configuration", async () => {
        dashboardUser.count.mockResolvedValue(0)
        dashboardUser.findUnique.mockResolvedValue(null)
        const { ensureBootstrapUser, DashboardBootstrapError } = await import("@/lib/dashboard/auth")
        await expect(ensureBootstrapUser()).rejects.toBeInstanceOf(DashboardBootstrapError)
        expect(dashboardUser.create).not.toHaveBeenCalled()
    })

    it("rejects weak bootstrap passwords without creating a user", async () => {
        process.env.DASHBOARD_INITIAL_ADMIN_EMAIL = "operator@example.com"
        process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD = "short"
        dashboardUser.count.mockResolvedValue(0)
        dashboardUser.findUnique.mockResolvedValue(null)
        const { ensureBootstrapUser } = await import("@/lib/dashboard/auth")
        await expect(ensureBootstrapUser()).rejects.toThrow("Dashboard bootstrap is not configured")
        expect(dashboardUser.create).not.toHaveBeenCalled()
    })

    it("creates only the configured bootstrap account", async () => {
        process.env.DASHBOARD_INITIAL_ADMIN_EMAIL = "operator@example.com"
        process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD = "sixteen-character-password"
        dashboardUser.count.mockResolvedValue(0)
        dashboardUser.findUnique.mockResolvedValue(null)
        dashboardUser.create.mockResolvedValue({ id: "configured-user" })
        const { ensureBootstrapUser } = await import("@/lib/dashboard/auth")
        await ensureBootstrapUser()
        expect(dashboardUser.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: "operator@example.com" }) }))
        expect(dashboardUser.create.mock.calls[0][0].data.password).not.toContain(process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD)
    })

    it("does not remediate a legacy row without valid configuration", async () => {
        dashboardUser.count.mockResolvedValue(1)
        dashboardUser.findUnique.mockResolvedValue({ id: "legacy-user", email: "admin@localhost", password: "legacy" })
        const { ensureBootstrapUser } = await import("@/lib/dashboard/auth")
        await expect(ensureBootstrapUser()).rejects.toThrow("Dashboard bootstrap is not configured")
        expect(dashboardUser.update).not.toHaveBeenCalled()
    })

    it("remediates a legacy row to the configured account before authentication", async () => {
        process.env.DASHBOARD_INITIAL_ADMIN_EMAIL = "operator@example.com"
        process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD = "sixteen-character-password"
        dashboardUser.count.mockResolvedValue(1)
        dashboardUser.findUnique.mockResolvedValue({ id: "legacy-user", email: "admin@localhost", password: "legacy" })
        dashboardUser.update.mockResolvedValue({ id: "legacy-user" })
        const { ensureBootstrapUser } = await import("@/lib/dashboard/auth")
        await ensureBootstrapUser()
        expect(dashboardUser.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "legacy-user" }, data: expect.objectContaining({ email: "operator@example.com" }) }))
        expect(dashboardUser.update.mock.calls[0][0].data.password).not.toContain(process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD)
    })

    it("removes only the legacy account when the configured account already exists", async () => {
        process.env.DASHBOARD_INITIAL_ADMIN_EMAIL = "operator@example.com"
        process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD = "sixteen-character-password"
        dashboardUser.count.mockResolvedValue(2)
        dashboardUser.findUnique
            .mockResolvedValueOnce({ id: "legacy-user", email: "admin@localhost", password: "legacy" })
            .mockResolvedValueOnce({ id: "configured-user", email: "operator@example.com", password: "hash" })
        dashboardUser.delete.mockResolvedValue({ id: "legacy-user" })
        const { ensureBootstrapUser } = await import("@/lib/dashboard/auth")
        await ensureBootstrapUser()
        expect(dashboardUser.delete).toHaveBeenCalledWith({ where: { id: "legacy-user" } })
        expect(dashboardUser.update).not.toHaveBeenCalled()
        expect(dashboardUser.create).not.toHaveBeenCalled()
    })

    it("fails closed when removing the legacy account fails", async () => {
        process.env.DASHBOARD_INITIAL_ADMIN_EMAIL = "operator@example.com"
        process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD = "sixteen-character-password"
        dashboardUser.count.mockResolvedValue(2)
        dashboardUser.findUnique
            .mockResolvedValueOnce({ id: "legacy-user", email: "admin@localhost", password: "legacy" })
            .mockResolvedValueOnce({ id: "configured-user", email: "operator@example.com", password: "hash" })
        dashboardUser.delete.mockRejectedValue(new Error("database failure"))
        const { ensureBootstrapUser, DashboardBootstrapError } = await import("@/lib/dashboard/auth")
        await expect(ensureBootstrapUser()).rejects.toBeInstanceOf(DashboardBootstrapError)
    })

    it("cannot mint a session when the JWT secret is absent", async () => {
        const { createSession } = await import("@/lib/dashboard/auth")
        await expect(createSession("user", "operator@example.com", "Operator")).rejects.toThrow("Dashboard bootstrap is not configured")
    })

    it("rejects JWT secrets shorter than 32 characters", async () => {
        process.env.DASHBOARD_JWT_SECRET = "too-short"
        const { createSession, DashboardBootstrapError } = await import("@/lib/dashboard/auth")
        await expect(createSession("user", "operator@example.com", "Operator")).rejects.toBeInstanceOf(DashboardBootstrapError)
    })
})
