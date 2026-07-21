import { beforeEach, describe, expect, it, vi } from "vitest"

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock("@/lib/core/logger", () => ({ default: { child: () => log } }))

describe("authentication logging privacy", () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        process.env.API_KEY = "expected-key"
    })

    it("logs only an error class when a hostile error contains a token and stack", async () => {
        const { authentication } = await import("@/lib/authentication")
        const hostile = Object.assign(new Error("token=super-secret-token"), { name: "HostileError", stack: "token=super-secret-token\nstack" })
        const token = { split: () => { throw hostile } } as unknown as string
        expect(await authentication(token)).toBe(false)
        expect(log.error).toHaveBeenCalledWith({ errorClass: "HostileError" }, "Error in authentication")
        expect(JSON.stringify(log.error.mock.calls)).not.toContain("super-secret-token")
        expect(JSON.stringify(log.error.mock.calls)).not.toContain("stack")
    })

    it("bounds hostile authentication error names", async () => {
        const { authentication } = await import("@/lib/authentication")
        const hostile = new Error("token=super-secret-token")
        hostile.name = "Auth/Error! " + "A".repeat(65)
        const token = { split: () => { throw hostile } } as unknown as string

        expect(await authentication(token)).toBe(false)
        expect(log.error).toHaveBeenCalledWith({ errorClass: "Error" }, "Error in authentication")
        expect(JSON.stringify(log.error.mock.calls)).not.toContain("super-secret-token")
    })
})
