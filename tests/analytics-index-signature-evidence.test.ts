import { describe, expect, it } from "vitest"
import {
  aggregateSignatureExists,
  serializeIndexSignatureEvidence,
} from "../scripts/analytics-index-signature-evidence.mjs"

describe("analytics index signature evidence", () => {
  it("treats the aggregate NULL row returned for an absent index as non-existent", () => {
    expect(aggregateSignatureExists([{ columns_: null }])).toBe(false)
    expect(aggregateSignatureExists([{ columns_: "1:type,2:created,3:id" }])).toBe(true)
    expect(aggregateSignatureExists([])).toBe(false)
  })

  it("serializes only allowlisted signature fields and supports bigint driver values", () => {
    const serialized = serializeIndexSignatureEvidence({
      columns_: "1:type",
      subParts: "NULL",
      collations: "A",
      nonUnique: BigInt("1"),
      indexType: "BTREE",
      generatedSchema: "ci_analytics_unsafe",
    })

    expect(serialized).toContain('"nonUnique":"1"')
    expect(serialized).not.toContain("generatedSchema")
    expect(serialized).not.toContain("ci_analytics_unsafe")
  })
})
