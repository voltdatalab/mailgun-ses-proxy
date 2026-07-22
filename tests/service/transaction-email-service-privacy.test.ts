import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    log: { error: vi.fn(), info: vi.fn() },
    send: vi.fn(),
    create: vi.fn(),
}))

vi.unmock("@/service/transaction-email-service")
vi.mock("@/lib/core/logger", () => ({ default: { child: () => mocks.log } }))
vi.mock("@/service/aws/awsHelper", () => ({ sesSystemClient: () => ({ send: mocks.send }) }))
vi.mock("@/service/database/db", () => ({ prisma: { systemMails: { create: mocks.create } } }))

import { sendSystemMail } from "@/service/transaction-email-service"

const email = {
    to: ["recipient.private@example.test"],
    from: "sender.private@example.test",
    subject: "private subject",
    html: "<p>private body</p>",
}

describe("transactional email logging privacy", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.env.TRANSACTIONAL_CONFIGURATION_SET_NAME = "transactional"
    })

    it("logs only a minimal success event, never SES response or email contents", async () => {
        mocks.send.mockResolvedValue({ MessageId: "private-ses-message-id", $metadata: { requestId: "private-request-id" } })
        mocks.create.mockResolvedValue({ id: "mail-id" })

        await expect(sendSystemMail(email)).resolves.toEqual({ messageId: "private-ses-message-id", dbId: "mail-id" })
        expect(mocks.log.info).toHaveBeenCalledWith("system mail sent")
        const output = JSON.stringify([...mocks.log.info.mock.calls, ...mocks.log.error.mock.calls])
        for (const secret of ["private-ses-message-id", "private-request-id", ...email.to, email.from, email.subject, email.html]) {
            expect(output).not.toContain(secret)
        }
    })

    it("logs only the error class for SES failures", async () => {
        const failure = new Error("private SES credential failure")
        mocks.send.mockRejectedValue(failure)

        await expect(sendSystemMail(email)).rejects.toBe(failure)
        expect(mocks.log.error).toHaveBeenCalledWith({ errorClass: "Error" }, "failed to send system mail")
        expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(failure.message)
    })
})
