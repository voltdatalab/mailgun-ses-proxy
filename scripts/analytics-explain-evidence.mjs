const bigintToDecimalString = (_key, value) =>
  typeof value === "bigint" ? value.toString() : value

/**
 * Keep CI EXPLAIN logs useful without exposing SQL literals or generated schema names.
 * MariaDB/MySQL drivers may represent numeric estimates as bigint, which JSON cannot
 * serialize without a replacer.
 */
export function serializeExplainEvidence(plan) {
  const evidence = plan.map((row) => ({
    id: row.id,
    selectType: row.select_type,
    table: row.table,
    accessType: row.type,
    possibleKeys: row.possible_keys,
    key: row.key,
    keyLength: row.key_len,
    rows: row.rows,
    extra: row.Extra,
  }))

  return JSON.stringify(evidence, bigintToDecimalString)
}
