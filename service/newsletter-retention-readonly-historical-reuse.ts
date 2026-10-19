import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createHistoricalAcquisitionVerifier, type HistoricalAcquisitionEnvelope, type HistoricalAcquisitionTrustRoot } from './newsletter-retention-historical-acquisition.js'
import { inspectHistoricalOperationalReadback, type HistoricalOperationalBinding } from './newsletter-retention-operational-readback.js'
import type { HistoricalGateRequest } from './newsletter-retention-historical-executor-contract.js'

export interface HistoricalReadOnlyReuseApproval {
    reportSha256: string
    configSha256: string
    reportedAt: string
    /** Complete independently approved chain/schema/selection/procedure/target/count/digest binding. */
    binding: HistoricalOperationalBinding
}
export interface HistoricalLiveCoverageObservation {
    checkedAt: string
    scopeHash: string
    binding: HistoricalOperationalBinding
    counts: HistoricalOperationalBinding['counts']
    /** Complete per-tag ID AND original scalar-content sets, using archive encoding.
     * Collector must observe live rows; copying expectations is not observation. */
    setSha256: HistoricalOperationalBinding['setSha256']
}
export interface HistoricalReadOnlyReuse {
    approval: HistoricalReadOnlyReuseApproval
    /** Independently provisioned observer; never supplied by env, files or request. */
    collect(request: HistoricalGateRequest): Promise<HistoricalLiveCoverageObservation>
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function exactBinding(actual: HistoricalOperationalBinding, expected: HistoricalOperationalBinding) {
    if (!isDeepStrictEqual(actual, expected)) throw new Error('read-only historical binding refused')
}
/** Specific diagnostic-only historical authentication. Legacy verifier/apply TTL
 * remains unchanged. This helper produces no admission or mutation capability. */
export function createReadOnlyHistoricalReuseVerifier(root: HistoricalAcquisitionTrustRoot, approval: HistoricalReadOnlyReuseApproval) {
    const pinned = structuredClone(approval)
    if (!pinned || [pinned.reportSha256, pinned.configSha256].some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
        || typeof pinned.reportedAt !== 'string' || !pinned.binding) throw new Error('read-only historical approval missing')
    const authenticate = createHistoricalAcquisitionVerifier(root)
    return (input: HistoricalAcquisitionEnvelope, expected: HistoricalOperationalBinding, now: Date) => {
        exactBinding(pinned.binding, expected)
        if (sha(input.reportBytes) !== pinned.reportSha256 || sha(input.configBytes) !== pinned.configSha256) throw new Error('read-only historical original byte pins refused')
        const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.reportBytes))
        // Validate calendar, exact fractional precision and future against LIVE time.
        const diagnostic = inspectHistoricalOperationalReadback(raw, expected, now)
        if (diagnostic.reportedAt !== pinned.reportedAt) throw new Error('read-only historical original timestamp refused')
        // Replay unchanged v2 authenticity/positive/schema/target checks at the
        // original collection instant (ceil fractional millisecond), not a new
        // timestamp in the report. Age is replaced ONLY here by exact live coverage.
        const originalInstant = Date.parse(pinned.reportedAt) + (/[1-9]/.test(pinned.reportedAt.slice(23, 27)) ? 1 : 0)
        return authenticate(input, expected, new Date(originalInstant))
    }
}
export function assertReadOnlyHistoricalLiveCoverage(observed: HistoricalLiveCoverageObservation, expected: HistoricalOperationalBinding, now: Date, maxAgeMs: number) {
    const time = Date.parse(observed.checkedAt), current = now.getTime()
    if (!Number.isFinite(current) || !Number.isFinite(time) || new Date(time).toISOString() !== observed.checkedAt
        || time > current || current - time > maxAgeMs || observed.scopeHash !== expected.artifactHash) throw new Error('read-only live coverage freshness/scope refused')
    exactBinding(observed.binding, expected)
    for (const tag of ['B', 'M', 'E', 'N'] as const) {
        if (observed.counts?.[tag] !== expected.counts[tag] || typeof observed.setSha256?.[tag] !== 'string'
            || observed.setSha256[tag] !== expected.setSha256[tag]) throw new Error('read-only live identity/content coverage refused')
    }
}
