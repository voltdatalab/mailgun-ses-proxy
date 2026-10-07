import { createHash, createPublicKey, verify } from 'node:crypto'
import { inspectHistoricalOperationalReadback, type HistoricalOperationalBinding } from './newsletter-retention-operational-readback.js'

export const HISTORICAL_ACQUISITION_DOMAIN = 'newsletter-retention/existing-acquisition/v2\0'
export interface HistoricalAcquisitionEnvelope {
    reportBytes: Uint8Array
    configBytes: Uint8Array
    attestationBytes: Uint8Array
    signature: Uint8Array
}
export interface HistoricalAcquisitionTrustRoot {
    /** Provisioned OUTSIDE envelopes/files by an approved application composition root. */
    publicKeyPem: string
    collectorId: string
    procedureFingerprint: string
    /** Approved SQL catalog canonicalization is specified by procedureFingerprint. */
    expectedSqlDatabaseFingerprint: string
    /** Exact Prisma file bytes; legacy archive/escrow schemaFingerprint keeps this meaning. */
    expectedPrismaFileFingerprint: string
    maxAgeMs: number
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
/** Positive v2 collection contract, separate from read-only diagnostics.
 * Optional failureFlags may be absent (original v2) or []; null/malformed/nonempty
 * are refused. Required failureLabel must be explicit null, not an empty string.
 * Diagnostic text and extra non-authoritative fields do not grant admission. */
function assertPositiveHistoricalReadback(raw: Record<string, unknown>) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || raw.status !== 'readback_verified' || raw.readbackStatus !== 'verified'
        || raw.failureLabel !== null || !Array.isArray(raw.mysqlErrorCodes) || raw.mysqlErrorCodes.length !== 0
        || (Object.hasOwn(raw, 'failureFlags') && (!Array.isArray(raw.failureFlags) || raw.failureFlags.length !== 0))
        || raw.archivedTablesOnly !== true || raw.liveOrphanGateRequiredBeforeApply !== true
        || raw.matches !== true || raw.archiveBoundDigestReadback !== true || raw.startedContainer !== false) {
        throw new Error('historical acquisition positive readback contract refused')
    }
}
/** Signature authenticates a principal's attestation, NOT SQL execution by itself.
 * Root provisioning must approve that collector's procedure and schema observation.
 * No default key, env lookup, caller `trusted` flag, or generated restore rows. */
export function createHistoricalAcquisitionVerifier(root: HistoricalAcquisitionTrustRoot) {
    const pinned = Object.freeze({ ...root })
    const key = createPublicKey(pinned.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519' || !pinned.collectorId || !/^[a-f0-9]{64}$/.test(pinned.procedureFingerprint)
        || !/^[a-f0-9]{64}$/.test(pinned.expectedSqlDatabaseFingerprint) || !/^[a-f0-9]{64}$/.test(pinned.expectedPrismaFileFingerprint) || !Number.isSafeInteger(pinned.maxAgeMs) || pinned.maxAgeMs <= 0 || pinned.maxAgeMs > 86_400_000) throw new Error('historical acquisition trust root invalid')
    return (input: HistoricalAcquisitionEnvelope, expected: HistoricalOperationalBinding, now: Date) => {
        for (const bytes of [input.reportBytes, input.configBytes, input.attestationBytes]) {
            if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 1_048_576) throw new Error('historical acquisition byte capacity')
        }
        // Own bytes before parsing/authentication; caller mutation cannot alter admission.
        const report = Buffer.from(input.reportBytes), config = Buffer.from(input.configBytes), metadata = Buffer.from(input.attestationBytes)
        if (!(input.signature instanceof Uint8Array) || input.signature.byteLength !== 64
            || !verify(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), metadata]), key, Buffer.from(input.signature))) throw new Error('historical acquisition signature invalid')
        const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        const attestation = decode(metadata)
        const wanted = { version: 2, collectorId: pinned.collectorId, procedureFingerprint: pinned.procedureFingerprint,
            restoredSqlDatabaseFingerprint: pinned.expectedSqlDatabaseFingerprint, prismaFileFingerprint: pinned.expectedPrismaFileFingerprint, reportSha256: sha(report), configSha256: sha(config) }
        if (!attestation || Object.keys(attestation).sort().join(',') !== Object.keys(wanted).sort().join(',')
            || Object.entries(wanted).some(([k, v]) => attestation[k] !== v)
            || expected.procedureFingerprint !== pinned.procedureFingerprint || expected.schemaFingerprint !== pinned.expectedPrismaFileFingerprint
            || sha(config) !== expected.configSha256) throw new Error('historical acquisition attestation mismatch')
        const target = decode(config)
        if (target.expectedContainerId !== expected.containerId || target.expectedImageId !== expected.imageId) throw new Error('historical acquisition target mismatch')
        const raw = decode(report)
        // Chat wrappers are never acquisition evidence, even with a signature.
        if (raw.evidenceSource || raw.originalOperatorReport) throw new Error('historical acquisition wrapper refused')
        assertPositiveHistoricalReadback(raw)
        const diagnostic = inspectHistoricalOperationalReadback(raw, expected, now)
        if (diagnostic.missingObservedCommitments.length || !diagnostic.reportedAt
            || now.getTime() - Date.parse(diagnostic.reportedAt) > pinned.maxAgeMs) throw new Error('historical acquisition incomplete or stale')
        return Object.freeze({ collectorId: pinned.collectorId, procedureFingerprint: pinned.procedureFingerprint,
            restoredSqlDatabaseFingerprint: pinned.expectedSqlDatabaseFingerprint, prismaFileFingerprint: pinned.expectedPrismaFileFingerprint, reportedAt: diagnostic.reportedAt,
            reportSha256: sha(report), configSha256: sha(config), attestationSha256: sha(metadata), signatureSha256: sha(input.signature),
            authenticatedBytes: Object.freeze({ report, config, metadata, signature: Buffer.from(input.signature) }) })
    }
}
