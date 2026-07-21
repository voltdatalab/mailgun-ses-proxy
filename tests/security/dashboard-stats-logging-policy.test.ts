import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const dashboardAndStatsRoutes = [
    "app/stats/[action]/route.ts",
    "app/dashboard/api/events/route.ts",
    "app/dashboard/api/newsletters/route.ts",
    "app/dashboard/api/newsletters/[id]/route.ts",
    "app/dashboard/api/stats/route.ts",
    "app/dashboard/api/logout/route.ts",
    "app/dashboard/api/login/route.ts",
    "app/dashboard/api/settings/route.ts",
    "app/dashboard/api/transactional/route.ts",
    "app/dashboard/api/transactional/[id]/route.ts",
]

const emailPipelineRoutes = [
    "app/v1/send/route.ts",
    "app/v3/[siteId]/events/[[...slug]]/route.ts",
]

describe("dashboard and stats logging policy", () => {
    it.each(dashboardAndStatsRoutes)("logs only error classes in %s", (route) => {
        const source = readFileSync(resolve(process.cwd(), route), "utf8")
        expect(source).not.toMatch(/log\.error\(error/)
        expect(source).toMatch(/log\.error\(\{ errorClass: errorClass\(error\) \}/)
    })
    it.each(emailPipelineRoutes)("does not include email identifiers or payloads in %s logs", (route) => {
        const source = readFileSync(resolve(process.cwd(), route), "utf8")
        expect(source).not.toMatch(/log\.(info|error|warn|debug)\(.*(messageId|siteId|recipient|email|subject|queryParams)/)
    })
})
