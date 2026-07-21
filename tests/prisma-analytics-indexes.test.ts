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
    key: "notifications",
    table: "NewsletterNotifications",
    name: "idx_notifications_type_created_id",
    definition: "1:type,2:created,3:id",
    columnCount: 3,
  },
  {
    key: "batch",
    table: "NewsletterBatch",
    name: "NewsletterBatch_siteId_idx",
    definition: "1:siteId",
    columnCount: 1,
  },
]

const preflightBlock = (index: (typeof indexes)[number]) => {
  const blockStart = migration.indexOf(`-- ${index.table}`)
  const blockEnd = migration.indexOf("-- No DDL may be prepared", blockStart)
  return { blockStart, block: migration.slice(blockStart, blockEnd) }
}

describe("Ghost analytics indexes", () => {
  it("declares the exact nonredundant indexes used by analytics queries", () => {
    expect(schema).toMatch(/model NewsletterNotifications\s*\{[\s\S]*?@@index\(\[type, created, id\], map: "idx_notifications_type_created_id"\)/)
    expect(schema).toMatch(/model NewsletterBatch\s*\{[\s\S]*?@@index\(\[siteId\], map: "NewsletterBatch_siteId_idx"\)/)
    expect(schema).not.toMatch(/@@index\(\[type, created\]/)
  })

  it("preflights ordered columns and non-uniqueness for both indexes", () => {
    expect(migration).toContain("information_schema.STATISTICS")
    expect(migration).toContain("TABLE_SCHEMA = DATABASE()")
    expect(migration).toContain("SEQ_IN_INDEX")
    expect(migration).toContain("COLUMN_NAME")
    expect(migration).toContain("NON_UNIQUE")

    for (const index of indexes) {
      const { blockStart, block } = preflightBlock(index)

      expect(blockStart).toBeGreaterThan(-1)
      expect(block).toContain(`@analytics_${index.key}_expected_name_exists`)
      expect(block).toContain(`@analytics_${index.key}_expected_name_matches`)
      expect(block).toContain(`@analytics_${index.key}_equivalent_definition_exists`)
      expect(block).toContain(`INDEX_NAME = '${index.name}'`)
      expect(block).toContain(`INDEX_NAME <> '${index.name}'`)
      expect(block).toContain(`COUNT(*) = ${index.columnCount}`)
      expect(block).toContain("MIN(NON_UNIQUE) = 1")
      expect(block).toContain("MAX(NON_UNIQUE) = 1")
      expect(block).toContain("ORDER BY SEQ_IN_INDEX")
      expect(block).toContain(`) = '${index.definition}'`)
    }
  })

  it("globally aborts incompatible expected names before any index DDL is prepared", () => {
    const firstCreatePosition = migration.indexOf("CREATE INDEX")
    const globalGuardPosition = migration.indexOf("SET @analytics_preflight_sql")
    const preflightPreparePosition = migration.indexOf("PREPARE analytics_preflight_statement")
    const notificationsDdlPreparePosition = migration.indexOf(
      "PREPARE analytics_notifications_index_statement",
    )

    expect(firstCreatePosition).toBeGreaterThan(-1)
    expect(globalGuardPosition).toBeGreaterThan(-1)
    expect(preflightPreparePosition).toBeGreaterThan(globalGuardPosition)
    expect(notificationsDdlPreparePosition).toBeGreaterThan(preflightPreparePosition)

    for (const index of indexes) {
      const { blockStart } = preflightBlock(index)
      expect(blockStart).toBeGreaterThan(-1)
      expect(blockStart).toBeLessThan(globalGuardPosition)
      expect(blockStart).toBeLessThan(firstCreatePosition)
      expect(migration.slice(globalGuardPosition, preflightPreparePosition)).toContain(
        `@analytics_${index.key}_expected_name_exists = 1`,
      )
      expect(migration.slice(globalGuardPosition, preflightPreparePosition)).toContain(
        `@analytics_${index.key}_expected_name_matches = 0`,
      )
    }

    expect(migration.slice(globalGuardPosition, preflightPreparePosition)).toContain(
      "information_schema.__analytics_index_definition_mismatch__",
    )
    expect(migration.slice(0, firstCreatePosition)).not.toContain(
      "PREPARE analytics_notifications_index_statement",
    )
  })

  it("reuses matching expected or legacy-named indexes without drop, rename, or duplicates", () => {
    for (const index of indexes) {
      const createPosition = migration.indexOf(`CREATE INDEX \`${index.name}\``)
      const ddlBlockStart = migration.indexOf(`SET @analytics_${index.key}_index_sql`)
      const preparePosition = migration.indexOf(
        `PREPARE analytics_${index.key}_index_statement`,
      )

      expect(createPosition).toBeGreaterThan(-1)
      expect(ddlBlockStart).toBeGreaterThan(-1)
      expect(ddlBlockStart).toBeLessThan(createPosition)
      expect(migration.slice(ddlBlockStart, createPosition)).toContain(
        `@analytics_${index.key}_expected_name_matches = 1`,
      )
      expect(migration.slice(ddlBlockStart, createPosition)).toContain(
        `@analytics_${index.key}_equivalent_definition_exists = 1`,
      )
      expect(preparePosition).toBeGreaterThan(createPosition)
    }

    expect(migration).toContain("legacy name; that non-destructive drift is")
    expect(migration).toContain("migration if either expected name is incompatible")
    expect(migration).toContain("Runtime compatibility and lock behavior must still be exercised in Task 12/14")
    expect(migration).not.toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i)
    expect(migration).not.toMatch(/^\s*CREATE\s+INDEX\b/im)
    expect(migration).not.toMatch(/\b(?:DROP|RENAME)\s+INDEX\b/i)
  })
})
