import { NewsletterRetentionCliError, readPinnedNewsletterRetentionOperationalReport, readNewsletterRetentionJsonFile } from './newsletter-retention-cli.js'
import { openNewsletterRetentionHistoricalArchiveStream } from './newsletter-retention-archive-stream-source.js'

/** Shared runtime adapter: real secure readers only, no injectable trust bypass.
 * Local SHA pins bind exact metadata bytes, never independent collector origin. */
export async function openNewsletterRetentionHistoricalArchiveFromEnvironment(
    stream: AsyncIterable<Uint8Array>, env: NodeJS.ProcessEnv,
) {
    const bindingPath = env.NEWSLETTER_RETENTION_HISTORICAL_BINDING_FILE
    if (!bindingPath) throw new NewsletterRetentionCliError('historical archive binding file missing')
    const source = await openNewsletterRetentionHistoricalArchiveStream(stream,
        await readNewsletterRetentionJsonFile(bindingPath, 'private'))
    try {
        const values = ['NEWSLETTER_RETENTION_OPERATIONAL_REPORT_FILE', 'NEWSLETTER_RETENTION_OPERATIONAL_REPORT_SHA256', 'NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_FILE', 'NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_SHA256'].map((key) => env[key])
        if (values.some(Boolean)) {
            if (!values.every(Boolean)) throw new NewsletterRetentionCliError('historical archive operational metadata pins incomplete')
            const report = await readPinnedNewsletterRetentionOperationalReport(values[0]!, values[1]!)
            const config = await readPinnedNewsletterRetentionOperationalReport(values[2]!, values[3]!)
            const target = config.report as { expectedContainerId?: unknown; expectedImageId?: unknown }
            if (!target || typeof target.expectedContainerId !== 'string' || !/^[a-f0-9]{64}$/.test(target.expectedContainerId)
                || typeof target.expectedImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(target.expectedImageId)) throw new NewsletterRetentionCliError('historical archive operational target invalid')
            source.operationalReadback = { report: report.report, target: { configSha256: config.reportSha256, containerId: target.expectedContainerId, imageId: target.expectedImageId } }
        }
        return source
    } catch (error) { await source.close(); throw error }
}
