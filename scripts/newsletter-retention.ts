import { prisma } from '../lib/database.js'
import {
    executeNewsletterRetentionCli,
    NewsletterRetentionCliError,
    readNewsletterRetentionJsonFile,
    writeNewsletterRetentionJsonFileExclusive,
    type NewsletterRetentionCliDatabase,
} from '../service/newsletter-retention-cli.js'
import { NewsletterRetentionApplyError } from '../service/newsletter-retention-applier.js'
import {
    createNewsletterRetentionMariaDbLockProvider,
    getNewsletterRetentionApplyDatabase,
} from '../service/newsletter-retention-runtime.js'

async function main(): Promise<void> {
    const database = getNewsletterRetentionApplyDatabase() as NewsletterRetentionCliDatabase
    const output = await executeNewsletterRetentionCli(process.argv.slice(2), {
        database,
        createLockProvider: () => createNewsletterRetentionMariaDbLockProvider(),
        now: () => new Date(),
        readJsonFile: readNewsletterRetentionJsonFile,
        writeJsonFileExclusive: writeNewsletterRetentionJsonFileExclusive,
    })

    process.stdout.write(`${JSON.stringify(output)}\n`)
}

async function run(): Promise<void> {
    let commandFailed = false
    try {
        await main()
    } catch (error: unknown) {
        commandFailed = true
        const message = error instanceof NewsletterRetentionCliError || error instanceof NewsletterRetentionApplyError
            ? error.message
            : 'newsletter retention command failed'
        process.stderr.write(`${message}\n`)
        process.exitCode = 1
    }

    try {
        await prisma.$disconnect()
    } catch {
        if (!commandFailed) {
            process.stderr.write('newsletter retention command cleanup failed\n')
        }
        process.exitCode = 1
    }
}

void run().catch(() => {
    process.stderr.write('newsletter retention command failed\n')
    process.exitCode = 1
})
