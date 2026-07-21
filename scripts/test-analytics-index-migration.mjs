import { readFile } from "node:fs/promises"
import mariadb from "mariadb"

const migration = await readFile(
  new URL("../prisma/migrations/20260721120000_add_ghost_analytics_indexes/migration.sql", import.meta.url),
  "utf8",
)
const suffix = `${process.env.GITHUB_RUN_ID ?? "local"}_${process.pid}`.replace(/[^a-zA-Z0-9_]/g, "_")
const schemas = [`ci_analytics_clean_${suffix}`, `ci_analytics_legacy_${suffix}`, `ci_analytics_drift_${suffix}`]
const host = process.env.CI_DB_HOST
const password = process.env.CI_DB_ROOT_PASSWORD
if (!host || !password) throw new Error("CI_DB_HOST and CI_DB_ROOT_PASSWORD are required")

const connection = await mariadb.createConnection({
  host,
  port: Number(process.env.CI_DB_PORT ?? 3306),
  user: process.env.CI_DB_ROOT_USER ?? "root",
  password,
  multipleStatements: true,
})
const quote = (value) => "`" + value.replaceAll("`", "``") + "`"
const statements = migration.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").split(";").map((statement) => statement.trim()).filter(Boolean)

async function createTables(schema) {
  await connection.query(`CREATE DATABASE ${quote(schema)}`)
  await connection.query(`USE ${quote(schema)}`)
  await connection.query("CREATE TABLE `NewsletterNotifications` (`id` VARCHAR(191) NOT NULL, `type` VARCHAR(191) NOT NULL, `created` DATETIME(3) NOT NULL, PRIMARY KEY (`id`))")
  await connection.query("CREATE TABLE `NewsletterBatch` (`id` VARCHAR(191) NOT NULL, `siteId` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`))")
}
async function applyMigration(schema) {
  await connection.query(`USE ${quote(schema)}`)
  for (const statement of statements) await connection.query(statement)
}
async function signature(schema, table, name) {
  return connection.query(
    "SELECT GROUP_CONCAT(CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME) ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns_, GROUP_CONCAT(IFNULL(SUB_PART, 'NULL') ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS subParts, GROUP_CONCAT(COALESCE(COLLATION, 'NULL') ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS collations, MIN(NON_UNIQUE) AS nonUnique, MIN(INDEX_TYPE) AS indexType FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?",
    [schema, table, name],
  )
}
async function assertSignature(schema, table, name, expected) {
  const rows = await signature(schema, table, name)
  const actual = rows[0]
  if (rows.length !== 1 || actual.columns_ !== expected.columns || actual.subParts !== expected.subParts || actual.collations !== expected.collations || Number(actual.nonUnique) !== 1 || actual.indexType !== "BTREE") {
    throw new Error(`unexpected full index signature for ${table}.${name}: ${JSON.stringify(actual)}`)
  }
}
async function seedNotifications(schema) {
  const rows = Array.from({ length: 2400 }, (_, index) => [
    `notification-${index}`,
    index < 120 ? "delivered" : index < 240 ? "opened" : "bounced",
    new Date(Date.UTC(2025, 0, 1, 0, 0, index % 60)).toISOString().slice(0, 23).replace("T", " "),
  ])
  await connection.batch(`INSERT INTO ${quote(schema)}.\`NewsletterNotifications\` (\`id\`, \`type\`, \`created\`) VALUES (?, ?, ?)`, rows)
}
async function explain(schema, sql, label) {
  const plan = await connection.query(`EXPLAIN ${sql}`)
  console.log(`analytics ${label} EXPLAIN: ${JSON.stringify(plan)}`)
  return plan
}
function assertUsesAnalyticsIndex(plan, label) {
  if (!plan.some((row) => row.key === "idx_notifications_type_created_id")) {
    throw new Error(`${label} did not use idx_notifications_type_created_id: ${JSON.stringify(plan)}`)
  }
}

try {
  await createTables(schemas[0])
  await applyMigration(schemas[0])
  await assertSignature(schemas[0], "NewsletterNotifications", "idx_notifications_type_created_id", { columns: "1:type,2:created,3:id", subParts: "NULL,NULL,NULL", collations: "A,A,A" })
  await assertSignature(schemas[0], "NewsletterBatch", "NewsletterBatch_siteId_idx", { columns: "1:siteId", subParts: "NULL", collations: "A" })
  await seedNotifications(schemas[0])
  const singleTypePlan = await explain(schemas[0], `SELECT \`id\` FROM ${quote(schemas[0])}.\`NewsletterNotifications\` WHERE \`type\` = 'delivered' ORDER BY \`created\`, \`id\``, "single-type")
  assertUsesAnalyticsIndex(singleTypePlan, "single-type query")
  const orPlan = await explain(schemas[0], `SELECT \`id\` FROM ${quote(schemas[0])}.\`NewsletterNotifications\` WHERE \`type\` = 'delivered' OR \`type\` = 'opened' ORDER BY \`created\`, \`id\``, "OR")
  assertUsesAnalyticsIndex(orPlan, "OR query")

  await createTables(schemas[1])
  await connection.query(`USE ${quote(schemas[1])}`)
  await connection.query("CREATE INDEX `legacy_notifications` ON `NewsletterNotifications` (`type`, `created`, `id`)")
  await connection.query("CREATE INDEX `legacy_batch` ON `NewsletterBatch` (`siteId`)")
  await applyMigration(schemas[1])
  for (const [table, expected] of [["NewsletterNotifications", "idx_notifications_type_created_id"], ["NewsletterBatch", "NewsletterBatch_siteId_idx"]]) {
    const rows = await connection.query("SELECT COUNT(DISTINCT INDEX_NAME) AS count_ FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME <> 'PRIMARY'", [schemas[1], table])
    if (Number(rows[0].count_) !== 1 || (await signature(schemas[1], table, expected)).length !== 0) throw new Error("legacy equivalent index was duplicated")
  }

  await createTables(schemas[2])
  await connection.query(`USE ${quote(schemas[2])}`)
  await connection.query("CREATE INDEX `NewsletterBatch_siteId_idx` ON `NewsletterBatch` (`id`)")
  let aborted = false
  try { await applyMigration(schemas[2]) } catch { aborted = true }
  if (!aborted || (await signature(schemas[2], "NewsletterNotifications", "idx_notifications_type_created_id")).length !== 0) throw new Error("incompatible second expected name did not abort before the first index DDL")
  console.log("analytics migration cases: clean=pass legacy=pass incompatible-global-abort=pass")
} finally {
  for (const schema of schemas) await connection.query(`DROP DATABASE IF EXISTS ${quote(schema)}`)
  await connection.end()
}
