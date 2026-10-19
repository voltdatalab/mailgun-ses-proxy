import { executeHistoricalPreflightCommand } from '../service/newsletter-retention-readonly-preflight.js'
import { getApprovedHistoricalReadOnlyPreflightRoot } from '../service/newsletter-retention-readonly-root.js'

// Dedicated nonapply process: no Prisma initialization, DB URL, apply CLI or
// production credential lookup. stdin accepts the existing RAM-only envelope.
void executeHistoricalPreflightCommand(process.argv.slice(2), process.env, process.stdin, getApprovedHistoricalReadOnlyPreflightRoot()).then(receipt => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    process.exitCode = receipt.state === 'preflight_verified' ? 0 : 1
}).catch(() => {
    process.stdout.write('{"version":1,"state":"refused","stage":"root","cleanupFailures":[]}\n')
    process.exitCode = 1
})
