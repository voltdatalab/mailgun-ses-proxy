const bigintToDecimalString = (_key, value) =>
  typeof value === "bigint" ? value.toString() : value

/**
 * Aggregate signature queries return one row even when no index matches. In that
 * case GROUP_CONCAT returns NULL, so row count alone is not an existence check.
 */
export function aggregateSignatureExists(rows) {
  return rows.length === 1 && rows[0]?.columns_ != null
}

/** Keep index-signature failures useful without serializing arbitrary driver data. */
export function serializeIndexSignatureEvidence(row) {
  const evidence = row == null
    ? null
    : {
        columns: row.columns_,
        subParts: row.subParts,
        collations: row.collations,
        nonUnique: row.nonUnique,
        indexType: row.indexType,
      }

  return JSON.stringify(evidence, bigintToDecimalString)
}
