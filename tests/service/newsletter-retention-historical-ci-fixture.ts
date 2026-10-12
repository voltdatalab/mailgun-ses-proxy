import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { HISTORICAL_COLUMNS, adaptNewsletterRetentionHistoricalArchive, type HistoricalArchiveBinding } from '../../service/newsletter-retention-historical-archive'
import { HISTORICAL_ACQUISITION_DOMAIN } from '../../service/newsletter-retention-historical-acquisition'
import { operationalChainBinding } from '../../service/newsletter-retention-operational-readback'

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const CREATED = '2026-01-01T00:00:00.000Z'
export type Tag = keyof typeof HISTORICAL_COLUMNS
export type Row = Record<string, string | null>
export function frame(tag: Tag, row: Row) {
    const b64 = (value: string) => Buffer.from(value).toString('base64')
    return `${tag}!${b64(HISTORICAL_COLUMNS[tag].map(key => {
        const value = row[key]
        if (value === null) return '-'
        if (typeof value !== 'string') throw new Error('missing synthetic scalar')
        return b64(key === 'created' || key === 'timestamp' ? value.replace('T', ' ').replace('Z', '') : value)
    }).join('\x1f'))}!\n`
}
export async function* chunks(bytes: Buffer) {
    for (let i = 0; i < bytes.length; i += 31) yield bytes.subarray(i, i + 31)
}
export function fixedRows(mode: string) {
    const prefix = `historical-ci-${mode}`
    const parent: Row = { id: `${prefix}-b`, siteId: 'historical-ci-site', fromEmail: 'sender@example.invalid', contents: 'synthetic parent', batchId: `${prefix}-group`, created: CREATED }
    const message: Row = { id: `${prefix}-m`, messageId: `${prefix}-message`, toEmail: 'recipient@example.invalid', newsletterBatchId: parent.id, created: CREATED, formatedContents: 'synthetic body', recipientData: null }
    const error: Row = { id: `${prefix}-e`, toEmail: 'error@example.invalid', error: 'synthetic error', created: CREATED, newsletterBatchId: parent.id, messageId: `${prefix}-error-message`, formatedContents: 'synthetic error body', recipientData: null }
    const notification: Row = { id: `${prefix}-n`, type: 'delivered', notificationId: `${prefix}-event`, messageId: message.messageId, rawEvent: '{"synthetic":true}', timestamp: CREATED, created: CREATED }
    const otherParent: Row = { ...parent, id: `${prefix}-other-b`, batchId: `${prefix}-other-group`, siteId: 'historical-ci-other-site' }
    const otherMessage: Row = { ...message, id: `${prefix}-other-m`, messageId: `${prefix}-other-message`, newsletterBatchId: otherParent.id }
    const otherNotification: Row = { ...notification, id: `${prefix}-other-n`, notificationId: `${prefix}-other-event`, messageId: otherMessage.messageId }
    const orphan: Row = { id: `${prefix}-other-o`, notificationId: `${prefix}-other-orphan`, messageId: `${prefix}-unrelated-missing`, type: 'delivered', timestamp: CREATED, rawEvent: 'synthetic orphan', reason: 'synthetic-unmatched', created: CREATED, reconciledAt: null }
    return { parent, message, error, notification, otherParent, otherMessage, otherNotification, orphan }
}
export async function signedFixture(rows: ReturnType<typeof fixedRows>, prismaFingerprint: string, sqlFingerprint: string, nativeDigests: Record<Tag, string>, now: string) {
    const keys = generateKeyPairSync('ed25519') // Exists only in this synthetic harness.
    const policy = { siteId: rows.parent.siteId!, cutoff: '2026-01-02T00:00:00.000Z' }
    const base = gzipSync(frame('B', rows.otherParent) + frame('B', rows.parent) + frame('M', rows.message) + frame('E', rows.error) + frame('N', { ...rows.notification, rawEvent: 'prior synthetic afterimage' }))
    const delta = gzipSync(frame('N', rows.notification))
    const baseManifest = Buffer.from(JSON.stringify({ generationId: 'historical-ci-base', counts: { B: 2, M: 1, E: 1, N: 1 }, files: [{ name: 'rows.base64.tsv.gz', bytes: base.length, sha256: hash(base) }] }))
    const deltaManifest = Buffer.from(JSON.stringify({ generationId: 'historical-ci-delta', baseGenerationId: 'historical-ci-base', baseRowsSha256: hash(base), baseIndexSha256: hash('synthetic index'), rows: { bytes: delta.length, sha256: hash(delta) }, deltaCounts: { new: 0, changed: 1 } }))
    const binding: HistoricalArchiveBinding = { baseGenerationId: 'historical-ci-base', deltaGenerationId: 'historical-ci-delta', baseManifestSha256: hash(baseManifest), deltaManifestSha256: hash(deltaManifest), baseIndexSha256: hash('synthetic index'), schemaFingerprint: prismaFingerprint, columns: HISTORICAL_COLUMNS, batchGroupSha256: hash(rows.parent.batchId!) }
    const selected = await adaptNewsletterRetentionHistoricalArchive({ baseManifest, deltaManifest, baseRows: chunks(base), deltaRows: chunks(delta) }, binding, policy)
    // Native SQL digest acquisition is supplied by the independent connection,
    // never generated from selected.records/readbackDigests to simulate restoration.
    if (JSON.stringify(nativeDigests) !== JSON.stringify(selected.readbackDigests)) throw new Error('native acquisition differs from synthetic archive')
    const procedureFingerprint = hash('historical-ci/native-scalar-query-and-frame/v1')
    const configBytes = Buffer.from(JSON.stringify({ expectedContainerId: hash('ephemeral service'), expectedImageId: `sha256:${hash('synthetic image identity')}` }))
    const expected = { ...operationalChainBinding(binding), procedureFingerprint, configSha256: hash(configBytes), containerId: hash('ephemeral service'), imageId: `sha256:${hash('synthetic image identity')}`, manifestHash: selected.manifest.hash, artifactHash: selected.artifact.hash, counts: { B: 1, M: 1, E: 1, N: 1 }, setSha256: nativeDigests }
    const reportBytes = Buffer.from(JSON.stringify({ status: 'readback_verified', readbackStatus: 'verified', failureLabel: null, mysqlErrorCodes: [], archivedTablesOnly: true, liveOrphanGateRequiredBeforeApply: true, matches: true, archiveBoundDigestReadback: true, startedContainer: false, timestampUtc: now.replace(/Z$/, '0000Z'), containerId: expected.containerId, imageId: expected.imageId, provenance: { ...operationalChainBinding(binding), configSha256: expected.configSha256 }, counts: expected.counts, setSha256: nativeDigests }))
    const attestationBytes = Buffer.from(JSON.stringify({ version: 2, collectorId: 'historical-ci-test-collector', procedureFingerprint, restoredSqlDatabaseFingerprint: sqlFingerprint, prismaFileFingerprint: prismaFingerprint, reportSha256: hash(reportBytes), configSha256: hash(configBytes) }))
    const acquisition = { reportBytes, configBytes, attestationBytes, signature: sign(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), attestationBytes]), keys.privateKey) }
    const prefix = Buffer.alloc(8)
    prefix.writeUInt32BE(baseManifest.length, 0); prefix.writeUInt32BE(deltaManifest.length, 4)
    return { policy, binding, expected, acquisition, procedureFingerprint, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), bytes: Buffer.concat([prefix, baseManifest, deltaManifest, base, delta]) }
}
