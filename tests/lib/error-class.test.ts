import { describe, expect, it } from "vitest"
import { errorClass } from "@/lib/core/error-class"

describe("errorClass", () => {
    it("returns safe built-in error names", () => {
        expect(errorClass(new TypeError("private details"))).toBe("TypeError")
    })

    it("bounds hostile or oversized names", () => {
        const hostile = new Error("private details")
        hostile.name = "SensitiveError: recipient@example.test"
        expect(errorClass(hostile)).toBe("Error")

        hostile.name = "A".repeat(65)
        expect(errorClass(hostile)).toBe("Error")
    })

    it("does not classify non-Error values from their contents", () => {
        expect(errorClass({ name: "recipient@example.test" })).toBe("UnknownError")
    })
})