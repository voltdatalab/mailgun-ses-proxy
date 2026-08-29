import { prisma } from "../lib/database"
import { reconcileNewsletterNotificationOrphan } from "../service/database/db"

const notificationId = process.env.RECONCILE_ORPHAN_NOTIFICATION_ID

async function main() {
    if (!notificationId || !/^[A-Za-z0-9_-]{1,128}$/.test(notificationId)) {
        throw new Error("RECONCILE_ORPHAN_NOTIFICATION_ID must be a bounded opaque identifier")
    }

    const result = await reconcileNewsletterNotificationOrphan(notificationId)
    process.stdout.write(`${JSON.stringify({ result })}\n`)
}

main()
    .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.name : "Error"}\n`)
        process.exitCode = 1
    })
    .finally(async () => {
        await prisma.$disconnect()
    })
