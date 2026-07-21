import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "..")
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8")
const migration = readFileSync(
  path.join(root, "prisma/migrations/20260721120000_add_ghost_analytics_indexes/migration.sql"),
  "utf8",
)

const indexes = [
  {
    table: "NewsletterNotifications",
    name: "idx_notifications_type_created_id",
    definition: "1:type,2:created,3:id",
    columnCount: 3,
    sentinel: "__analytics_index_definition_mismatch_notifications__",
  },
  {
    table: "NewsletterBatch",
    name: "NewsletterBatch_siteId_idx",
    definition: "1:siteId",
    columnCount: 1,
    sentinel: "__analytics_index_definition_mismatch_batch__",
  },
]

describe("Ghost analytics indexes", () => {
  it("declares the exact nonredundant indexes used by analytics queries", () => {
    expect(schema).toMatch(/model NewsletterNotifications\s*\{[\s\S]*?@@index\(\[type, created, id\], map: "idx_notifications_type_created_id"\)/)
    expect(schema).toMatch(/model NewsletterBatch\s*\{[\s\S]*?@@index\(\[siteId\], map: "NewsletterBatch_siteId_idx"\)/)
    expect(schema).not.toMatch(/@@index\(\[type, created\]/)
  })

  it("checks ordered columns and non-uniqueness rather than only index names", () => {
    expect(migration).toContain("information_schema.STATISTICS")
    expect(migration).toContain("TABLE_SCHEMA = DATABASE()")
    expect(migration).toContain("SEQ_IN_INDEX")
    expect(migration).toContain("COLUMN_NAME")
    expect(migration).toContain("NON_UNIQUE")

    for (const index of indexes) {
      const blockStart = migration.indexOf(`-- ${index.table}`)
      const blockEnd = migration.indexOf("PREPARE analytics_index_statement", blockStart)
      const block = migration.slice(blockStart, blockEnd)

      expect(blockStart).toBeGreaterThan(-1)
      expect(block).toContain(`INDEX_NAME = '${index.name}'`)
      expect(block).toContain(`COUNT(*) = ${index.columnCount}`)
      expect(block).toContain("MIN(NON_UNIQUE) = 1")
      expect(block).toContain("MAX(NON_UNIQUE) = 1")
      expect(block).toContain("ORDER BY SEQ_IN_INDEX")
      expect(block).toContain(`) = '${index.definition}'`)
    }
  })

  it("reuses an equivalent legacy-named definition and aborts incompatible expected names", () => {
    for (const index of indexes) {
      const expectedNameCheck = `INDEX_NAME <> '${index.name}'`
      const equivalentPosition = migration.indexOf(expectedNameCheck)
      const mismatchPosition = migration.indexOf(index.sentinel)
      const createPosition = migration.indexOf(`CREATE INDEX \`${index.name}\``)

      expect(equivalentPosition).toBeGreaterThan(-1)
      expect(migration.slice(equivalentPosition, createPosition)).toContain("@analytics_equivalent_definition_exists = 1")
      expect(mismatchPosition).toBeGreaterThan(-1)
      expect(mismatchPosition).toBeLessThan(createPosition)
      expect(migration.slice(equivalentPosition, mismatchPosition)).toContain("@analytics_expected_name_exists = 1 AND @analytics_expected_name_matches = 0")
    }

    expect(migration).toContain("legacy name; that non-destructive drift is")
    expect(migration).toContain("migration aborts without DDL")
    expect(migration).toContain("Runtime compatibility and lock behavior must still be exercised in Task 12/14")
  })

  it("uses conditional prepared DDL only when no matching definition exists", () => {
    for (const index of indexes) {
      const createPosition = migration.indexOf(`CREATE INDEX \`${index.name}\``)
      const preparePosition = migration.indexOf("PREPARE analytics_index_statement", createPosition)
      expect(createPosition).toBeGreaterThan(-1)
      expect(preparePosition).toBeGreaterThan(createPosition)
    }

    expect(migration).toContain("PREPARE")
    expect(migration).toContain("EXECUTE")
    expect(migration).toContain("DEALLOCATE PREPARE")
    expect(migration).not.toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i)
    expect(migration).not.toMatch(/^\s*CREATE\s+INDEX\b/im)
    expect(migration).not.toMatch(/\b(?:DROP|RENAME)\s+INDEX\b/i)
  })
})
