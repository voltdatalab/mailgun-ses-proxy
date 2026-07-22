import { describe, expect, it } from "vitest"
import { serializeExplainEvidence } from "../scripts/analytics-explain-evidence.mjs"

describe("analytics EXPLAIN evidence serialization", () => {
  it("serializes driver bigint estimates without logging unallowlisted plan fields", () => {
    const serialized = serializeExplainEvidence([
      {
        id: BigInt("1"),
        select_type: "SIMPLE",
        table: "NewsletterNotifications",
        type: "ref",
        possible_keys: "idx_notifications_type_created_id",
        key: "idx_notifications_type_created_id",
        key_len: "767",
        rows: BigInt("2400"),
        Extra: "Using where",
        queryLiteral: "delivered",
        generatedSchema: "ci_analytics_clean_unsafe",
      },
    ])

    expect(serialized).toContain('"id":"1"')
    expect(serialized).toContain('"rows":"2400"')
    expect(serialized).toContain('"key":"idx_notifications_type_created_id"')
    expect(serialized).not.toContain("queryLiteral")
    expect(serialized).not.toContain("generatedSchema")
    expect(serialized).not.toContain("delivered")
    expect(serialized).not.toContain("ci_analytics_clean_unsafe")
  })
})