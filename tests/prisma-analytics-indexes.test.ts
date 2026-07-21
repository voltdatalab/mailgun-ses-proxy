import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..")
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8")
const migration = readFileSync(
  path.join(root, "prisma/migrations/20260721120000_add_ghost_analytics_indexes/migration.sql"),
  "utf8",
)

describe("Ghost analytics indexes", () => {
  it("declares the exact nonredundant indexes used by analytics queries", () => {
    expect(schema).toMatch(/model NewsletterNotifications\s*\{[\s\S]*?@@index\(\[type, created, id\], map: "idx_notifications_type_created_id"\)/)
    expect(schema).toMatch(/model NewsletterBatch\s*\{[\s\S]*?@@index\(\[siteId\], map: "NewsletterBatch_siteId_idx"\)/)
    expect(schema).not.toMatch(/@@index\(\[type, created\]/)
  })

  it("creates each missing production index only after an information_schema name check", () => {
    for (const indexName of ["idx_notifications_type_created_id", "NewsletterBatch_siteId_idx"]) {
      const indexCheckPosition = migration.indexOf("INDEX_NAME = '" + indexName + "'")
      const createPosition = migration.indexOf("CREATE INDEX `" + indexName + "`")
      expect(indexCheckPosition).toBeGreaterThan(-1)
      expect(createPosition).toBeGreaterThan(indexCheckPosition)
    }

    expect(migration).toContain("information_schema.STATISTICS")
    expect(migration).toContain("TABLE_SCHEMA = DATABASE()")
    expect(migration).toContain("PREPARE")
    expect(migration).toContain("EXECUTE")
    expect(migration).toContain("DEALLOCATE PREPARE")
    expect(migration).not.toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i)
    expect(migration).not.toMatch(/^\s*CREATE\s+INDEX\b(?![\s\S]*?PREPARE)/im)
    expect(migration).not.toMatch(/\bDROP\s+(?:INDEX|TABLE|DATABASE)\b/i)
  })
})
