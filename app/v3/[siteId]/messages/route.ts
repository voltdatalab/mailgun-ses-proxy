import { ApiResponse } from "@/lib/api-response"
import { formDataToObject } from "@/lib/core/common"
import logger from "@/lib/core/logger"
import { addNewsletterToQueue } from "@/service/newsletter-service"
import { MailgunMessage } from "@/types/mailgun"

const log = logger.child({ module: "app:v3:messages" })
type pathParam = { params: Promise<{ siteId: string }> }

function errorClass(error: unknown): string {
    return error instanceof Error && error.name ? error.name : "UnknownError"
}

export async function POST(req: Request, { params }: pathParam) {
    const { siteId } = await params
    if (!siteId) return ApiResponse.badRequest("siteId is required")
    try {
        const message = await validateRequest(req)
        const { batchId } = await addNewsletterToQueue(message, siteId)
        log.info("message queued to newsletter SQS")
        return ApiResponse.raw({ id: batchId, message: "message queued to SQS" }, 200)
    } catch (error) {
        log.error({ errorClass: errorClass(error) }, "Unable to queue newsletter message")
        return ApiResponse.internalError("Unable to queue message. Please retry.")
    }
}

async function validateRequest(req: Request): Promise<MailgunMessage> {
    const data = formDataToObject(await req.formData()) as unknown as MailgunMessage
    data["v:email-id"] = (data["v:email-id"] as string) || "no-batch-id-provided"
    return data
}
