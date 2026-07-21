import dotenv from 'dotenv'
dotenv.config()

import { createServer, IncomingMessage, Server, ServerResponse } from "http"
import next from "next"
import logger, { flushLogger } from "./lib/core/logger"
import { errorClass } from "./lib/core/error-class"
import { requestShutdown } from "./lib/core/sqs-worker"
import { createWorkerSupervisor } from "./lib/core/worker-supervisor"
import { processNewsletterEventsQueue, processNewsletterQueue, processSystemEventsQueue } from "./service/background-process"

const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || "10000")
let httpServer: Server | undefined
let shutdownInProgress = false
let intendedExitCode: 0 | 1 = 0
let shutdownTimer: NodeJS.Timeout | undefined

const workerSupervisor = createWorkerSupervisor(
    ['newsletter-sender', 'newsletter-events', 'system-events'],
    {
        onUnexpectedStop: (stop) => {
            initiateShutdown('worker stopped unexpectedly', 1, stop)
        },
        onAllWorkersSettled: (exitCode) => {
            finishShutdown(exitCode)
        },
    },
)

// ── Coordinated shutdown ─────────────────────────────────────────────────────
// Stop accepting HTTP traffic, abort worker polls, and let active handlers drain.
// A worker that exits before shutdown is requested is fatal: it has already been
// marked unhealthy by the worker loop and this process must exit for CapRover to
// replace the container.
function initiateShutdown(
    reason: string,
    exitCode: 0 | 1,
    details: Record<string, unknown> = {},
): void {
    if (shutdownInProgress) return
    shutdownInProgress = true
    intendedExitCode = exitCode
    workerSupervisor.requestGracefulShutdown()

    logger.info({ reason, exitCode, graceMs: SHUTDOWN_GRACE_MS, ...details }, "Coordinated shutdown started — draining workers")
    httpServer?.close(() => logger.info("HTTP server stopped accepting connections"))
    requestShutdown()

    // The normal path exits in finishShutdown after every worker settles. This
    // protects the platform from a handler that cannot drain in the grace time.
    shutdownTimer = setTimeout(() => {
        logger.warn({ reason, intendedExitCode }, "Shutdown grace period expired — forcing exit")
        process.exit(1)
    }, SHUTDOWN_GRACE_MS)
    shutdownTimer.unref()
}

function finishShutdown(workerExitCode: 0 | 1): void {
    const exitCode: 0 | 1 = intendedExitCode === 1 || workerExitCode === 1 ? 1 : 0
    if (shutdownTimer) clearTimeout(shutdownTimer)
    logger.info({ exitCode }, "All workers settled — exiting process")
    flushLogger()
    process.exit(exitCode)
}

// ── Process-level error handlers ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    logger.error({ errorClass: errorClass(reason) }, 'Unhandled promise rejection')
})

process.on('uncaughtException', (error) => {
    logger.fatal({ errorClass: errorClass(error) }, 'Uncaught exception — shutting down')
    initiateShutdown('uncaught exception', 1, { errorClass: errorClass(error) })
})

process.on('SIGTERM', () => initiateShutdown('SIGTERM', 0))
process.on('SIGINT', () => initiateShutdown('SIGINT', 0))

// ── Server startup ───────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || "3000")
const dev = process.env.NODE_ENV !== "production"
const app = next({ dev })
const handle = app.getRequestHandler()

const handler = (req: IncomingMessage, res: ServerResponse) => {
    const baseURL = `http://${req.headers.host || 'localhost'}`
    const parsedUrl = new URL(req.url!, baseURL)
    handle(req, res, {
        pathname: parsedUrl.pathname,
        query: Object.fromEntries(parsedUrl.searchParams),
    } as any)
}

app.prepare().then(() => {
    httpServer = createServer(handler)
    httpServer.listen(port)
    const type = dev ? "development" : process.env.NODE_ENV
    logger.info(`> Server listening at http://localhost:${port} as ${type}`)

    workerSupervisor.watch('newsletter-sender', processNewsletterQueue())
    workerSupervisor.watch('newsletter-events', processNewsletterEventsQueue())
    workerSupervisor.watch('system-events', processSystemEventsQueue())
}).catch((error) => {
    logger.error({ errorClass: errorClass(error) }, "Server preparation failed — shutting down")
    initiateShutdown('server preparation failed', 1, { errorClass: errorClass(error) })
})
