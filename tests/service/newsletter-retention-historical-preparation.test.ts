import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { HISTORICAL_ACQUISITION_DOMAIN } from '@/service/newsletter-retention-historical-acquisition'
import { createInternalHistoricalRetentionExecutor } from '@/service/newsletter-retention-applier'
import type { HistoricalExecutorRoot } from '@/service/newsletter-retention-historical-executor-contract'
import { operationalChainBinding } from '@/service/newsletter-retention-operational-readback'
import { gzipSync, createGzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openNewsletterRetentionHistoricalArchiveFromEnvironment } from '@/service/newsletter-retention-operational-metadata-source'
import { describe, expect, it, vi } from 'vitest'
import { adaptNewsletterRetentionHistoricalArchive, validateHistoricalArchiveCapacity, HISTORICAL_COLUMNS, type HistoricalArchiveChain, type HistoricalArchiveBinding } from '@/service/newsletter-retention-historical-archive'
import { executeNewsletterRetentionCli, type NewsletterRetentionCliDependencies } from '@/service/newsletter-retention-cli'
import { openNewsletterRetentionHistoricalArchiveStream } from '@/service/newsletter-retention-archive-stream-source'
import { executeNewsletterRetentionApply, recheckAndApplyNewsletterRetentionArchiveBatchForFixture, type NewsletterRetentionApplyDatabase } from '@/service/newsletter-retention-applier'
import { verifyNewsletterRetentionArchiveRestore } from '@/service/newsletter-retention-archive-coverage'

const NOW = '2026-10-07T14:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'
const CUTOFF = '2026-01-02T00:00:00.000Z'
const SCHEMA = 'a'.repeat(64)
const PROCEDURE = 'b'.repeat(64)
const SQL_SCHEMA = 'c'.repeat(64)
const failedReadbacks: Record<string, Record<string, unknown>> = {
    'failed-status': { readbackStatus: 'failed', matches: false },
    'failed-flags': { failureFlags: ['sql_readback_failed'] }, 'unknown-failure': { failureFlags: ['unknown_failure'] },
    'false-matches': { matches: false }, 'malformed-readback-status': { readbackStatus: [] }, 'missing-all-status': { status: undefined, readbackStatus: undefined },
    'missing-label': { failureLabel: undefined }, 'empty-label': { failureLabel: '' },
    'missing-status': { status: undefined }, 'missing-readback-status': { readbackStatus: undefined },
    'malformed-status': { status: true }, 'conflicting-status': { status: 'readback_failed' },
    'failure-label': { failureLabel: 'sql_failed' }, 'malformed-label': { failureLabel: false },
    'mysql-errors': { mysqlErrorCodes: [1045] }, 'missing-errors': { mysqlErrorCodes: undefined },
    'malformed-errors': { mysqlErrorCodes: null }, 'malformed-flags': { failureFlags: false },
    'false-flags': { failureFlags: [false] }, 'null-flags': { failureFlags: null },
    'missing-matches': { matches: undefined }, 'malformed-matches': { matches: 'true' },
    'missing-bound': { archiveBoundDigestReadback: undefined }, 'false-bound': { archiveBoundDigestReadback: false },
    'wrong-scope': { archivedTablesOnly: false }, 'missing-scope': { archivedTablesOnly: undefined },
    'missing-live-gate': { liveOrphanGateRequiredBeforeApply: undefined },
    'started-container': { startedContainer: true }, 'missing-started-container': { startedContainer: undefined }, 'malformed-scope': { archivedTablesOnly: 'true' },
    'malformed-live-gate': { liveOrphanGateRequiredBeforeApply: null }, 'malformed-bound': { archiveBoundDigestReadback: 'true' },
    'malformed-started-container': { startedContainer: 0 }, 'nonarray-errors': { mysqlErrorCodes: 'none' },
}
const policy = { siteId: 'synthetic-site', cutoff: CUTOFF }
const hash = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')
const b64 = (s: string) => Buffer.from(s).toString('base64')
async function* chunks(b: Uint8Array) { for (let i = 0; i < b.length; i += 7) yield b.subarray(i, i + 7) }
async function* lines(values: string[]) { yield* values }
const parent = { id: 'synthetic-parent', siteId: policy.siteId, fromEmail: 'sender@example.invalid', contents: 'synthetic base', batchId: 'synthetic-group', created: CREATED }
const message = { id: 'synthetic-message-row', messageId: 'synthetic-message', toEmail: 'reader@example.invalid', newsletterBatchId: parent.id, created: CREATED, formatedContents: 'synthetic body', recipientData: null }
const error = { id: 'synthetic-error-row', toEmail: 'error@example.invalid', error: 'synthetic error', created: CREATED, newsletterBatchId: parent.id, messageId: 'synthetic-error-message', formatedContents: 'synthetic error body', recipientData: null }
const notification = { id: 'synthetic-event-row', type: 'delivered', notificationId: 'synthetic-event', messageId: message.messageId, rawEvent: '{"synthetic":true}', timestamp: CREATED, created: CREATED }
type Tag = keyof typeof HISTORICAL_COLUMNS
function frame(tag: Tag, row: Record<string, string | null>) {
    return `${tag}!${b64(HISTORICAL_COLUMNS[tag].map((key) => {
        const value = row[key]
        return value === null ? '-' : b64((key === 'created' || key === 'timestamp') ? value.replace('T', ' ').replace('Z', '') : value)
    }).join('\x1f'))}!\n`
}
function fixture(baseText?: string, deltaText?: string) {
    const excluded = { ...parent, id: 'synthetic-excluded-parent', batchId: 'synthetic-excluded-group' }
    const text = baseText ?? frame('B', excluded) + frame('B', parent) + frame('M', message) + frame('E', error) + frame('N', { ...notification, rawEvent: 'synthetic prior afterimage' })
    const base = gzipSync(text)
    const counts = { B: 0, M: 0, E: 0, N: 0 }
    for (const line of text.split('\n')) if (line[0] in counts) counts[line[0] as Tag] += 1
    const delta = gzipSync(deltaText ?? frame('N', notification))
    const baseObject = { generationId: 'synthetic-base', counts, files: [{ name: 'rows.base64.tsv.gz', bytes: base.length, sha256: hash(base) }] }
    const deltaObject = { generationId: 'synthetic-delta', baseGenerationId: 'synthetic-base', baseRowsSha256: hash(base), baseIndexSha256: 'c'.repeat(64), rows: { bytes: delta.length, sha256: hash(delta) }, deltaCounts: { new: 0, changed: 1 } }
    const baseManifest = Buffer.from(JSON.stringify(baseObject))
    const deltaManifest = Buffer.from(JSON.stringify(deltaObject))
    const binding: HistoricalArchiveBinding = { baseGenerationId: 'synthetic-base', deltaGenerationId: 'synthetic-delta', baseManifestSha256: hash(baseManifest), deltaManifestSha256: hash(deltaManifest), baseIndexSha256: deltaObject.baseIndexSha256, schemaFingerprint: SCHEMA, columns: HISTORICAL_COLUMNS, batchGroupSha256: hash(parent.batchId) }
    const chain: HistoricalArchiveChain = { baseManifest, deltaManifest, baseRows: chunks(base), deltaRows: chunks(delta) }
    return { chain, binding, base, delta, deltaObject }
}
function databaseRow<T extends Record<string, string | null>>(row: T) {
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'created' || k === 'timestamp' ? new Date(v!) : v]))
}
function envelope(f: ReturnType<typeof fixture>) {
    const prefix = Buffer.alloc(8)
    prefix.writeUInt32BE(f.chain.baseManifest.byteLength, 0)
    prefix.writeUInt32BE(f.chain.deltaManifest.byteLength, 4)
    return Buffer.concat([prefix, f.chain.baseManifest, f.chain.deltaManifest, f.base, f.delta])
}
function environment() {
    let held = false
    let current = NOW
    const tx = {
        newsletterBatch: { findMany: vi.fn(async () => [{ id: parent.id }]), findFirst: vi.fn(async () => databaseRow(parent)) },
        newsletterMessages: { findMany: vi.fn(async () => [databaseRow(message)]) },
        newsletterErrors: { findMany: vi.fn(async () => [databaseRow(error)]) },
        newsletterNotifications: { findMany: vi.fn(async () => [databaseRow(notification)]) },
        newsletterNotificationOrphan: { count: vi.fn(async () => 0) },
    }
    const writes = vi.fn(async () => { throw new Error('unexpected writer') })
    const close = vi.fn(async () => {})
    const evidence = { backup: { verifiedAt: CREATED, restoredAt: CREATED }, restore: { restore: 'validated_chain', counts: { batches: 1, messages: 1, notifications: 1 } }, health: { queueCheckedAt: NOW, proxyCheckedAt: NOW, queueHealthy: true, proxyHealthy: true }, dlq: { checkedAt: NOW, healthy: true, messageCount: 0 } }
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>, options: unknown) => {
        expect(options).toEqual({ isolationLevel: 'Serializable' })
        return callback(tx)
    })
    const deps = {
        database: { $transaction: transaction },
        now: () => new Date(current),
        schemaFingerprint: vi.fn(async () => SCHEMA),
        createLockProvider: () => ({ tryAcquire: async () => {
            if (held) return null
            held = true
            return { release: async () => { held = false } }
        } }),
        openHistoricalArchive: vi.fn(async () => {
            const f = fixture()
            const source = await openNewsletterRetentionHistoricalArchiveStream(chunks(envelope(f)), { ...f.binding, expectedProcedureFingerprint: PROCEDURE })
            return { ...source, close: async () => { await source.close(); await close() } }
        }),
        readJsonFile: vi.fn(async () => evidence),
        writeJsonFileExclusive: writes, writeEscrowFileExclusive: writes, openVerifiedEscrowSource: writes,
    } as unknown as NewsletterRetentionCliDependencies
    const args = ['--prepare-historical-archive', '--site-id', policy.siteId, '--cutoff', CUTOFF, '--evidence-file', '/synthetic-health.json']
    return { deps, args, tx, transaction, writes, close, evidence, setNow: (value: string) => { current = value }, held: () => held }
}

describe('historical streaming adapter -> executor preparation -> admission refusal', () => {
    it.each([...Object.keys(failedReadbacks), 'distinct-schema', 'empty-flags', 'swap-schema', 'wrong-prisma', 'missing-sql-root', 'missing-prisma-root', 'missing-sql-approval', 'missing-prisma-approval', 'malformed-sql', 'malformed-prisma', 'unapproved-sql', 'unapproved-prisma', 'concurrent-ghost', 'concurrent-success', 'concurrent-unsigned', 'concurrent-overlap-ghost', 'success', 'unsigned', 'wrong-key', 'wrapper', 'schema-attestation', 'prisma-attestation', 'policy', 'ghost', 'duplicate-ghost', 'dlq', 'missing-queue', 'unknown-queue', 'stale', 'future', 'pressure', 'live-schema', 'late', 'parent', 'content', 'count', 'postcommit', 'postcommit-throw', 'commit-unknown', 'rollback-confirmed', 'release', 'stall-prefix', 'stall-base', 'stall-delta', 'stall-trailer', 'abort', 'cleanup-stall', 'stale-afterstream', 'scope', 'null-dlq', 'precommit-late', 'postconditions', 'abort-beforemutation', 'clone-capability', 'self-attestation', 'acquisition-digest', 'binding-artifact', 'root-mutation', 'skip-callback', 'result-clone', 'wrong-rollback', 'live-cap'] as const)('integrated authenticated historical executor: %s', async (mode) => {
        const f = fixture(), env = environment()
        // Test-only random principal. Never provision these keys in application/runtime.
        const keys = generateKeyPairSync('ed25519')
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        const configBytes = Buffer.from(JSON.stringify({ expectedContainerId: SCHEMA, expectedImageId: `sha256:${SCHEMA}` }))
        const expected = { ...operationalChainBinding(f.binding), configSha256: hash(configBytes), procedureFingerprint: PROCEDURE,
            containerId: SCHEMA, imageId: `sha256:${SCHEMA}`, manifestHash: selected.manifest.hash, artifactHash: selected.artifact.hash,
            counts: { B: 1, M: 1, E: 1, N: 1 }, setSha256: selected.readbackDigests }
        const report = { status: 'readback_verified', readbackStatus: 'verified', failureLabel: null, mysqlErrorCodes: [],
            archivedTablesOnly: true, liveOrphanGateRequiredBeforeApply: true, matches: true, archiveBoundDigestReadback: true, startedContainer: false,
            diagnostic: 'synthetic diagnostic text is not authority', timestampUtc: '2026-10-07T13:59:52.4874872Z', containerId: expected.containerId, imageId: expected.imageId,
            provenance: { ...operationalChainBinding(f.binding), configSha256: expected.configSha256 }, counts: expected.counts, setSha256: expected.setSha256 }
        Object.assign(report, failedReadbacks[mode] ?? {})
        if (mode === 'empty-flags') Object.assign(report, { failureFlags: [] })
        if (mode === 'acquisition-digest') report.setSha256 = { ...report.setSha256, N: SCHEMA }
        const reportBytes = Buffer.from(JSON.stringify(mode === 'wrapper' ? { evidenceSource: 'operator_report_received_in_chat', originalOperatorReport: report } : report))
        const attestationBytes = Buffer.from(JSON.stringify({ version: 2, collectorId: 'synthetic-approved-collector', procedureFingerprint: PROCEDURE,
            restoredSqlDatabaseFingerprint: mode === 'schema-attestation' ? SCHEMA : SQL_SCHEMA, prismaFileFingerprint: mode === 'prisma-attestation' ? SQL_SCHEMA : SCHEMA, reportSha256: hash(reportBytes), configSha256: hash(configBytes) }))
        const acquisition = { reportBytes, configBytes, attestationBytes, signature: mode === 'unsigned' ? Buffer.alloc(64) : sign(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), attestationBytes]), mode === 'wrong-key' ? generateKeyPairSync('ed25519').privateKey : keys.privateKey) }
        if (Object.hasOwn(failedReadbacks, mode)) {
            expect(verify(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), attestationBytes]), keys.publicKey, acquisition.signature)).toBe(true)
            expect(report.counts).toEqual(expected.counts); expect(report.setSha256).toEqual(expected.setSha256)
        }
        const order: string[] = [], readback = vi.fn(async () => {
            if (mode === 'postcommit-throw') throw new Error('private postcommit failure')
            return { parents: mode === 'postcommit' ? 1 : 0, messages: 0, errors: 0, notifications: 0, orphans: 0, lateEvents: 0 }
        })
        for (const [name, delegate] of Object.entries(env.tx)) if (name !== 'newsletterNotificationOrphan') Object.assign(delegate, {
            deleteMany: async () => { order.push(name); return { count: mode === 'count' ? 2 : 1 } }, count: async () => mode === 'postconditions' ? 1 : 0,
        })
        if (mode === 'parent') env.tx.newsletterBatch.findMany.mockResolvedValue([{ id: parent.id }, { id: 'reused' }])
        if (mode === 'content') env.tx.newsletterBatch.findFirst.mockResolvedValue(databaseRow({ ...parent, contents: 'drift' }))
        const stamp = mode === 'stale' ? CREATED : mode === 'future' ? '2026-10-07T14:00:01.000Z' : NOW
        const baseObservation = { checkedAt: stamp, scopeHash: mode === 'scope' ? SCHEMA : selected.artifact.hash }
        const controller = new AbortController()
        if (mode === 'live-cap') env.tx.newsletterBatch.findFirst.mockResolvedValue(databaseRow({ ...parent, contents: 'x'.repeat(8 * 1024 ** 2) }))
        const release = vi.fn(async () => { if (mode === 'release') throw new Error('private lock failure') })
        let gateCalls = 0
        let transactionAttempt = ''
        const root: HistoricalExecutorRoot = {
            binding: f.binding, policy, approval: { expected, policy: mode === 'policy' ? { ...policy, maxMessages: 1 } : policy, schema: { expectedSqlDatabaseFingerprint: SQL_SCHEMA, expectedPrismaFileFingerprint: SCHEMA } },
            acquisitionRoot: { publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), collectorId: 'synthetic-approved-collector', expectedSqlDatabaseFingerprint: SQL_SCHEMA, expectedPrismaFileFingerprint: SCHEMA, procedureFingerprint: PROCEDURE, maxAgeMs: 60_000 },
            now: env.deps.now, lock: { tryAcquire: async () => ({ release }) },
            queueIds: ['main', 'dlq'], maxPressure: 10, maxGateAgeMs: 60_000,
            gates: {
                ghost: async () => { gateCalls++; if (mode === 'abort-beforemutation' && gateCalls === 3) controller.abort(); return { ...baseObservation, recipients: mode === 'ghost' ? ['different@example.invalid'] : mode === 'duplicate-ghost' ? [message.toEmail, message.toEmail] : [message.toEmail] } },
                queues: async () => ({ ...baseObservation, queues: mode === 'missing-queue' ? [{ id: 'main', visible: 0, inflight: 0, delayed: 0 }] : ['main', mode === 'unknown-queue' ? 'unknown' : 'dlq'].map(id => ({ id, visible: mode === 'null-dlq' && id === 'dlq' ? null : mode === 'dlq' && id === 'dlq' ? 1 : 0, inflight: 0, delayed: 0 })) }),
                proxy: async () => ({ ...baseObservation, accepting: true }), pressure: async () => ({ ...baseObservation, activeQueries: mode === 'pressure' ? 11 : 0 }),
                schema: async () => ({ ...baseObservation, liveDatabaseFingerprint: mode === 'live-schema' ? PROCEDURE : mode === 'swap-schema' ? SCHEMA : SQL_SCHEMA, prismaFileFingerprint: mode === 'wrong-prisma' ? PROCEDURE : mode === 'swap-schema' ? SQL_SCHEMA : SCHEMA }),
                correlation: async () => ({ ...baseObservation, orphans: 0, lateEvents: mode === 'late' || mode === 'precommit-late' && gateCalls >= 3 ? 1 : 0 }),
            },
            database: { $transaction: async (callback, options) => { transactionAttempt = options.attemptId; if (mode === 'skip-callback') return {} as never; const result = await env.transaction(callback as never, { isolationLevel: options.isolationLevel }); if (mode === 'commit-unknown') throw new Error('response lost'); return (mode === 'result-clone' ? structuredClone(result) : result) as never } },
            postcommit: { read: readback },
            confirmRollback: mode === 'wrong-rollback' ? async () => ({ attemptId: 'another-transaction', outcome: 'rollback_confirmed' }) : mode === 'rollback-confirmed' ? async attemptId => ({ attemptId, outcome: attemptId === transactionAttempt ? 'rollback_confirmed' : 'unknown' }) : undefined,
        }
        if (mode === 'rollback-confirmed' || mode === 'wrong-rollback') env.tx.newsletterBatch.findFirst.mockResolvedValue(databaseRow({ ...parent, contents: 'drift' }))
        if (mode === 'binding-artifact') root.approval.expected.artifactHash = SCHEMA
        const invalidRoot = ['missing-sql-root', 'missing-prisma-root', 'missing-sql-approval', 'missing-prisma-approval', 'malformed-sql', 'malformed-prisma', 'unapproved-sql', 'unapproved-prisma'].includes(mode)
        if (mode === 'missing-sql-root') Reflect.deleteProperty(root.acquisitionRoot, 'expectedSqlDatabaseFingerprint')
        if (mode === 'missing-prisma-root') Reflect.deleteProperty(root.acquisitionRoot, 'expectedPrismaFileFingerprint')
        if (mode === 'missing-sql-approval') Reflect.deleteProperty(root.approval.schema, 'expectedSqlDatabaseFingerprint')
        if (mode === 'missing-prisma-approval') Reflect.deleteProperty(root.approval.schema, 'expectedPrismaFileFingerprint')
        if (mode === 'malformed-sql') root.approval.schema.expectedSqlDatabaseFingerprint = 'not-a-hash'
        if (mode === 'malformed-prisma') root.approval.schema.expectedPrismaFileFingerprint = 'not-a-hash'
        if (mode === 'unapproved-sql') root.acquisitionRoot.expectedSqlDatabaseFingerprint = PROCEDURE
        if (mode === 'unapproved-prisma') root.acquisitionRoot.expectedPrismaFileFingerprint = SQL_SCHEMA
        if (invalidRoot) {
            expect(() => createInternalHistoricalRetentionExecutor(root)).toThrow('schema commitments')
            expect(env.transaction).not.toHaveBeenCalled(); expect(order).toEqual([])
            expect(readback).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); return
        }
        const concurrent = mode.startsWith('concurrent-')
        const overlap = mode === 'concurrent-overlap-ghost'
        let heldLeases = 0, peakLeases = 0, acquireCalls = 0
        const leaseOrder: string[] = []
        let unlock: (() => void) | undefined
        let firstGateEntered: (() => void) | undefined
        const firstGate = new Promise<void>(resolve => { firstGateEntered = resolve })
        if (concurrent) {
            // A real exclusive mutex: the second acquire is pending until release.
            // The overlap variant deliberately violates that port contract to test
            // the separate synchronous reservation guard, not to excuse mutex bugs.
            root.lock.tryAcquire = async () => {
                const call = ++acquireCalls
                leaseOrder.push(`request-${call}`)
                if (heldLeases && !overlap) await new Promise<void>(resolve => { unlock = resolve })
                heldLeases++
                peakLeases = Math.max(peakLeases, heldLeases)
                leaseOrder.push(`acquire-${call}`)
                return { release: async () => {
                    heldLeases--
                    leaseOrder.push(`release-${call}`)
                    await release()
                    unlock?.(); unlock = undefined
                } }
            }
            const ghost = root.gates.ghost
            root.gates.ghost = async request => {
                const observation = await ghost(request)
                firstGateEntered?.()
                return { ...observation, recipients: (mode === 'concurrent-ghost' || overlap) && gateCalls === 1 ? ['different@example.invalid'] : [message.toEmail] }
            }
        }
        const executor = createInternalHistoricalRetentionExecutor(root)
        if (concurrent) {
            const iterated = [0, 0], closed = [false, false]
            const streams = [0, 1].map(index => (async function* () {
                iterated[index]++
                try {
                    if (overlap && index === 1) await firstGate
                    yield* chunks(envelope(fixture()))
                } finally { closed[index] = true }
            })())
            const first = executor({ stream: streams[0], acquisition: mode === 'concurrent-unsigned' ? { ...acquisition, signature: Buffer.alloc(64) } : acquisition })
            const second = executor({ stream: streams[1], acquisition: { ...acquisition } })
            // Both entered before authentication; second is genuinely queued, not
            // invoked sequentially after the first result or consumption check.
            expect(acquireCalls).toBe(2)
            if (!overlap) expect(leaseOrder).toEqual(['request-1', 'acquire-1', 'request-2'])
            const results = await Promise.all([first, second])
            const success = mode === 'concurrent-success' || mode === 'concurrent-unsigned'
            expect(results.map(result => result.state)).toEqual(mode === 'concurrent-success'
                ? ['committed_readback_ok', 'refused_before_transaction']
                : mode === 'concurrent-unsigned' ? ['refused_before_transaction', 'committed_readback_ok']
                    : ['refused_before_transaction', 'refused_before_transaction'])
            expect(env.transaction).toHaveBeenCalledTimes(success ? 1 : 0)
            expect(readback).toHaveBeenCalledTimes(success ? 1 : 0)
            expect(order).toEqual(success ? ['newsletterNotifications', 'newsletterErrors', 'newsletterMessages', 'newsletterBatch'] : [])
            expect(release).toHaveBeenCalledTimes(2)
            expect(heldLeases).toBe(0)
            expect(peakLeases).toBe(overlap ? 2 : 1)
            if (!overlap) expect(leaseOrder).toEqual(['request-1', 'acquire-1', 'request-2', 'release-1', 'acquire-2', 'release-2'])
            expect(iterated).toEqual([1, mode === 'concurrent-unsigned' || overlap ? 1 : 0])
            expect(closed).toEqual([true, mode === 'concurrent-unsigned' || overlap])
            expect(results[1].stage).toBe(mode === 'concurrent-unsigned' ? 'postcommit' : overlap ? 'admission' : 'lock')
            if (!success) expect(gateCalls).toBe(1)
            expect(results.every(result => result.cleanupFailures.length === 0)).toBe(true)
            // Authentication failure does not consume, authenticated gate refusal
            // does; neither successful consumption nor failed gates may reset it.
            expect((await executor({ stream: chunks(envelope(fixture())), acquisition })).state).toBe('refused_before_transaction')
            expect(acquireCalls).toBe(2)
            return
        }
        if (mode === 'root-mutation') { root.approval.expected.artifactHash = SCHEMA; root.binding.schemaFingerprint = PROCEDURE; root.acquisitionRoot.collectorId = 'unapproved'; root.acquisitionRoot.expectedSqlDatabaseFingerprint = SCHEMA; root.approval.schema.expectedSqlDatabaseFingerprint = SCHEMA; root.approval.schema.expectedPrismaFileFingerprint = SQL_SCHEMA }
        let sourceClosed = false
        let stream: AsyncIterable<Uint8Array> = (async function* () { try { yield* chunks(envelope(fixture())) } finally { sourceClosed = true } })()
        const cleanup = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {}))
        if (mode.startsWith('stall-') || mode === 'cleanup-stall' || mode === 'abort') {
            const bytes = envelope(fixture())
            const prefixEnd = 8 + f.chain.baseManifest.byteLength + f.chain.deltaManifest.byteLength
            const end = mode === 'stall-prefix' || mode === 'abort' ? 0 : mode === 'stall-base' ? prefixEnd : mode === 'stall-delta' ? prefixEnd + f.base.length : bytes.length
            let sent = false
            stream = { [Symbol.asyncIterator]: () => ({ next: async () => {
                if (!sent && end) { sent = true; return { done: false, value: bytes.subarray(0, end) } }
                if (mode === 'cleanup-stall') return { done: true, value: undefined }
                return new Promise<IteratorResult<Uint8Array>>(() => {})
            }, return: cleanup }) }
        }
        if (mode === 'stale-afterstream') stream = (async function* () { yield* chunks(envelope(fixture())); env.setNow('2026-10-07T14:01:01.000Z') })()
        const timeout = mode === 'abort' ? setTimeout(() => controller.abort(), 5) : undefined
        const request = { stream, acquisition, deadlines: { signal: controller.signal, idleMs: 20, wholeMs: 1000, cleanupMs: 10 } }
        if (mode === 'clone-capability') Object.assign(request, { capability: JSON.parse(JSON.stringify({ authenticated: true, artifactHash: selected.artifact.hash })) })
        if (mode === 'self-attestation') Object.assign(request, { trusted: true, collectionAuthenticated: true })
        const result = await executor(request)
        if (timeout) clearTimeout(timeout)
        const committed = ['distinct-schema', 'empty-flags', 'success', 'postcommit', 'postcommit-throw', 'release', 'cleanup-stall', 'root-mutation'].includes(mode)
        expect(result.state).toBe(committed ? (mode.startsWith('postcommit') ? 'committed_readback_failed' : 'committed_readback_ok') : mode === 'rollback-confirmed' ? 'rollback_confirmed' : ['count', 'content', 'parent', 'commit-unknown', 'precommit-late', 'postconditions', 'abort-beforemutation', 'skip-callback', 'result-clone', 'wrong-rollback', 'live-cap'].includes(mode) ? 'commit_unknown' : 'refused_before_transaction')
        expect(readback).toHaveBeenCalledTimes(committed ? 1 : 0)
        if (Object.hasOwn(failedReadbacks, mode) || ['schema-attestation', 'prisma-attestation', 'swap-schema', 'wrong-prisma', 'unsigned'].includes(mode)) {
            expect(env.transaction).not.toHaveBeenCalled(); expect(order).toEqual([])
            expect(sourceClosed).toBe(true)
            if (Object.hasOwn(failedReadbacks, mode)) { expect(result.stage).toBe('admission'); expect(gateCalls).toBe(0) }
        }
        if (committed) expect(order).toEqual(['newsletterNotifications', 'newsletterErrors', 'newsletterMessages', 'newsletterBatch'])
        if (mode === 'release') expect(result.cleanupFailures).toContain('lock_release_failed')
        expect(release).toHaveBeenCalledTimes(['clone-capability', 'self-attestation'].includes(mode) ? 0 : 1)
        if (['ghost', 'late', 'precommit-late', 'abort-beforemutation', 'parent', 'content', 'live-cap'].includes(mode) || mode.startsWith('stall-') || mode === 'abort') expect(order).toEqual([])
        if (mode.startsWith('stall-') || mode === 'abort' || mode === 'cleanup-stall') expect(cleanup).toHaveBeenCalledOnce()
        if (mode === 'cleanup-stall') expect(result.cleanupFailures).toContain('source_cleanup_failed')
        expect(JSON.stringify(result)).not.toMatch(/example\.invalid|synthetic-parent|private .*failure|synthetic-group/)
        if (mode === 'success') {
            // Fresh clocks and a new stream cannot replay the consumed acquisition/wave.
            expect((await executor({ stream: chunks(envelope(fixture())), acquisition: { ...acquisition } })).state).toBe('refused_before_transaction')
        }
    })
    it.each(['baseRows', 'deltaRows'] as const)('bounds a stalled direct historical chain %s, not only the envelope adapter', async (part) => {
        const f = fixture()
        const next = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {}))
        const cleanup = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {}))
        f.chain[part] = { [Symbol.asyncIterator]: () => ({ next, return: cleanup }) }
        await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy, {}, { idleMs: 10, wholeMs: 1000, cleanupMs: 10 })).rejects.toThrow('deadline')
        expect(next).toHaveBeenCalledOnce()
        expect(cleanup).toHaveBeenCalledOnce()
    })
    it.skipIf(!process.env.RETENTION_SAFE_FIXTURE_ROOT).each(['raw-v2', 'chat-v2', 'wrong-report-pin', 'wrong-config-pin', 'config-drift', 'incomplete-pins', 'invalid-target'])('real private report/config -> runtime adapter -> CLI: %s', async (mode) => {
        const dir = await mkdtemp(join(process.env.RETENTION_SAFE_FIXTURE_ROOT!, 'composition-'))
        await chmod(dir, 0o700)
        const env = environment(), f = fixture()
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        const configBytes = ` ${JSON.stringify({ expectedContainerId: SCHEMA, expectedImageId: `sha256:${SCHEMA}` })}\n`
        const provenance = { baseGenerationId: f.binding.baseGenerationId, deltaGenerationId: f.binding.deltaGenerationId,
            baseManifestSha256: f.binding.baseManifestSha256, deltaManifestSha256: f.binding.deltaManifestSha256,
            indexSha256: f.binding.baseIndexSha256, groupSha256: f.binding.batchGroupSha256, configSha256: mode === 'config-drift' ? SCHEMA : hash(configBytes) }
        const report = { timestampUtc: '2026-10-07T13:59:52.4874872Z', containerId: SCHEMA, imageId: `sha256:${SCHEMA}`,
            provenance, counts: { B: 1, M: 1, E: 1, N: 1 }, setSha256: selected.readbackDigests, matches: true }
        const reportBytes = ` ${JSON.stringify(mode === 'chat-v2' ? { evidenceSource: 'operator_report_received_in_chat', rawWindowsReportFileIndependentlyFetched: false, originalOperatorReport: report } : report)}\n`
        const vars: NodeJS.ProcessEnv = { NODE_ENV: 'test', NEWSLETTER_RETENTION_HISTORICAL_BINDING_FILE: join(dir, 'binding.json'),
            NEWSLETTER_RETENTION_OPERATIONAL_REPORT_FILE: join(dir, 'report.json'), NEWSLETTER_RETENTION_OPERATIONAL_REPORT_SHA256: hash(reportBytes),
            NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_FILE: join(dir, 'config.json'), NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_SHA256: hash(configBytes) }
        await writeFile(vars.NEWSLETTER_RETENTION_HISTORICAL_BINDING_FILE!, JSON.stringify({ ...f.binding, expectedProcedureFingerprint: PROCEDURE }), { mode: 0o400 })
        await writeFile(vars.NEWSLETTER_RETENTION_OPERATIONAL_REPORT_FILE!, reportBytes, { mode: 0o400 })
        await writeFile(vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_FILE!, configBytes, { mode: 0o400 })
        if (mode === 'wrong-report-pin') vars.NEWSLETTER_RETENTION_OPERATIONAL_REPORT_SHA256 = SCHEMA
        if (mode === 'wrong-config-pin') vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_SHA256 = SCHEMA
        if (mode === 'incomplete-pins') delete vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_SHA256
        if (mode === 'invalid-target') {
            const bytes = '{}'; await chmod(vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_FILE!, 0o600)
            await writeFile(vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_FILE!, bytes); await chmod(vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_FILE!, 0o400)
            vars.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_SHA256 = hash(bytes)
        }
        let streamClosed = false
        async function* inputStream() {
            try { yield* chunks(envelope(fixture())) } finally { streamClosed = true }
        }
        env.deps.openHistoricalArchive = () => openNewsletterRetentionHistoricalArchiveFromEnvironment(inputStream(), vars)
        try {
            if (mode === 'raw-v2' || mode === 'chat-v2') {
                expect(await executeNewsletterRetentionCli(env.args, env.deps)).toMatchObject({ admission: 'refused', applyEnabled: false,
                    operationalAdmission: { reportedAt: report.timestampUtc, collectionAuthenticated: false,
                        derivedBindings: { manifestHash: selected.manifest.hash, artifactHash: selected.artifact.hash, schemaFingerprint: SCHEMA },
                        missingObservedCommitments: [], missingIndependentEvidence: ['schemaFingerprint', 'procedureFingerprint'] },
                    reason: mode === 'chat-v2' ? 'operator_report_not_independently_acquired' : 'readback_collection_provenance_unauthenticated' })
            } else await expect(executeNewsletterRetentionCli(env.args, env.deps)).rejects.toThrow()
            expect(env.writes).not.toHaveBeenCalled(); expect(env.held()).toBe(false)
            expect(streamClosed).toBe(true)
            if (!['raw-v2', 'chat-v2', 'config-drift'].includes(mode)) expect(env.transaction).not.toHaveBeenCalled()
        } finally { await rm(dir, { recursive: true, force: true }) }
    })
    it('admits existing pinned metadata capacity, not a claim of payload readback', () => {
        const capacity = validateHistoricalArchiveCapacity({ counts: { B: 1989, M: 1848471, E: 0, N: 4279809 } }, { deltaCounts: { new: 1, changed: 1 } }, 4646269833, 100)
        expect(capacity.baseRows).toBe(6130269)
        expect(capacity.baseRows * 32).toBe(196168608)
        expect(() => validateHistoricalArchiveCapacity({ counts: { B: 8000001, M: 0, E: 0, N: 0 } }, { deltaCounts: { new: 0, changed: 0 } }, 1, 1)).toThrow('capacity')
    })
    it('decodes a large bounded excluded payload without regexp stack growth or retained content', async () => {
        const f = fixture(frame('B', { ...parent, id: 'excluded', batchId: 'other', contents: 'x'.repeat(400_000) }) + frame('B', parent) + frame('M', message) + frame('E', error) + frame('N', notification))
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        expect(selected.records).toHaveLength(4)
        expect(selected.lines.join('').length).toBeLessThan(10_000)
    })
    it.each(['E', 'N', 'afterimage'])('enforces selection byte cap while retaining %s', async (kind) => {
        const large = 'x'.repeat(20_000)
        const f = kind === 'E' ? fixture(frame('B', parent) + frame('M', message) + frame('E', { ...error, error: large }))
            : kind === 'N' ? fixture(frame('B', parent) + frame('M', message) + frame('N', { ...notification, rawEvent: large }))
                : fixture(undefined, frame('N', { ...notification, rawEvent: large }))
        await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy, { selectionBytes: 10_000 })).rejects.toThrow('selection memory capacity')
    })
    it('opens real-scale committed envelope metadata without requesting payload bytes', async () => {
        const f = fixture()
        const base = { generationId: f.binding.baseGenerationId, counts: { B: 1989, M: 1848471, E: 0, N: 4279809 }, files: [{ name: 'rows.base64.tsv.gz', bytes: 4646269833, sha256: '0630ec94419311df83c098d9244bfe9d586e29a4c491440037ccfbcc5091055a' }] }
        f.chain.baseManifest = Buffer.from(JSON.stringify(base))
        f.binding.baseManifestSha256 = hash(f.chain.baseManifest)
        const prefix = Buffer.alloc(8)
        prefix.writeUInt32BE(f.chain.baseManifest.length, 0)
        prefix.writeUInt32BE(f.chain.deltaManifest.length, 4)
        let requested = false
        async function* input() {
            yield Buffer.concat([prefix, f.chain.baseManifest, f.chain.deltaManifest])
            requested = true
            throw new Error('payload access forbidden in metadata test')
        }
        const source = await openNewsletterRetentionHistoricalArchiveStream(input(), { ...f.binding, expectedProcedureFingerprint: PROCEDURE })
        expect(requested).toBe(false)
        await source.close()
    })
    it.each(['count', 'excluded-hash', 'delta-duplicate'])('fails closed on %s with otherwise valid pinned frames', async (change) => {
        let f = fixture()
        if (change === 'count') {
            const base = JSON.parse(Buffer.from(f.chain.baseManifest).toString())
            base.counts.N += 1
            f.chain.baseManifest = Buffer.from(JSON.stringify(base))
            f.binding.baseManifestSha256 = hash(f.chain.baseManifest)
        }
        if (change === 'excluded-hash') {
            f = fixture(frame('B', { ...parent, id: 'excluded', batchId: 'other-group', contents: 'original' }) + frame('B', parent) + frame('M', message) + frame('E', error) + frame('N', notification))
            // All selected rows are unchanged, but the full compressed binding is not.
            f.chain.baseRows = chunks(gzipSync(frame('B', { ...parent, id: 'excluded', batchId: 'other-group', contents: 'tampered' }) + frame('B', parent) + frame('M', message) + frame('E', error) + frame('N', notification)))
        }
        if (change === 'delta-duplicate') {
            f = fixture(undefined, frame('N', notification) + frame('N', notification))
            f.deltaObject.deltaCounts.changed = 2
            f.chain.deltaManifest = Buffer.from(JSON.stringify(f.deltaObject))
            f.binding.deltaManifestSha256 = hash(f.chain.deltaManifest)
        }
        await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)).rejects.toThrow()
    })
    it.each(['rows', 'compressedBytes', 'decompressedBytes', 'lineBytes', 'chunkBytes', 'selectionBytes', 'selectionRows'] as const)('enforces distinct %s budget', async (limit) => {
        const f = fixture()
        let read = false
        const source = f.chain.baseRows
        f.chain.baseRows = (async function* () { read = true; yield* source })()
        await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy, { [limit]: 1 })).rejects.toThrow()
        if (limit === 'rows' || limit === 'compressedBytes') expect(read).toBe(false)
    })
    it.each([false, true])('streams >250k unordered excluded rows with bounded digest storage, duplicate=%s', async (duplicate) => {
        const n = 250_010
        const f = fixture()
        function* text() {
            yield frame('B', parent)
            yield frame('M', message)
            yield frame('E', error)
            yield frame('N', notification)
            for (let i = n - 1; i >= 0; i -= 1) yield frame('N', { ...notification, id: `excluded-${duplicate && i === 0 ? 1 : i}`, messageId: 'excluded-message', rawEvent: 'excluded-payload' })
        }
        // Two deterministic streaming passes: measure commitment, then consume.
        // Neither pass collects compressed or excluded payload bytes.
        async function* compressed() { yield* Readable.from(text()).pipe(createGzip()) }
        let bytes = 0
        const digest = createHash('sha256')
        for await (const chunk of compressed()) { bytes += chunk.length; digest.update(chunk) }
        const base = { generationId: 'synthetic-base', counts: { B: 1, M: 1, E: 1, N: n + 1 }, files: [{ name: 'rows.base64.tsv.gz', bytes, sha256: digest.digest('hex') }] }
        f.chain.baseManifest = Buffer.from(JSON.stringify(base))
        f.binding.baseManifestSha256 = hash(f.chain.baseManifest)
        f.deltaObject.baseRowsSha256 = base.files[0].sha256
        f.chain.deltaManifest = Buffer.from(JSON.stringify(f.deltaObject))
        f.binding.deltaManifestSha256 = hash(f.chain.deltaManifest)
        f.chain.baseRows = compressed()
        if (duplicate) await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)).rejects.toThrow('duplicate identity')
        else {
            const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
            expect(selected.records).toHaveLength(4)
            expect(selected.lines.join('')).not.toContain('excluded-payload')
        }
    }, 120_000)
    it('rereads genuinely fresh health after long archive streaming without rewriting timestamps', async () => {
        const env = environment()
        const original = env.deps.openHistoricalArchive!
        env.deps.openHistoricalArchive = async () => {
            const source = await original()
            const rows = source.chain.baseRows
            source.chain.baseRows = (async function* () {
                yield* rows
                env.setNow('2026-10-07T15:00:00.000Z')
                env.evidence.health.queueCheckedAt = '2026-10-07T15:00:00.000Z'
                env.evidence.health.proxyCheckedAt = '2026-10-07T15:00:00.000Z'
                env.evidence.dlq.checkedAt = '2026-10-07T15:00:00.000Z'
            })()
            return source
        }
        expect(await executeNewsletterRetentionCli(env.args, env.deps)).toMatchObject({ applyEnabled: false })
        expect(env.deps.readJsonFile).toHaveBeenCalledTimes(2)
        expect(env.evidence.backup.verifiedAt).toBe(CREATED)
    })
    it('binds exact B/M/E/N subset and N afterimage, refuses count-only historical receipt without writes', async () => {
        const env = environment()
        const output = await executeNewsletterRetentionCli(env.args, env.deps)
        expect(output).toMatchObject({ mode: 'historical-archive-preparation-v1', applyEnabled: false, admission: 'refused', reason: 'independent_restore_readback_missing', coverage: { restoredAt: null } })
        expect(env.transaction).toHaveBeenCalledOnce()
        expect(env.writes).not.toHaveBeenCalled()
        expect(env.close).toHaveBeenCalledOnce()
        expect(env.held()).toBe(false)
        const adapted = await adaptNewsletterRetentionHistoricalArchive(fixture().chain, fixture().binding, policy)
        expect(adapted.artifact.escrow.counts).toEqual({ batches: 1, messages: 1, errors: 1, notifications: 1 })
        expect(adapted.records.at(-1)).toMatchObject({ row: notification })
        const outer = frame('N', notification).split('!')[1]
        const canonical = `N\t${Buffer.from(notification.id).toString('hex').toUpperCase()}\t${hash(outer)}\n`
        expect(adapted.readbackDigests.N).toBe(hash(canonical))
    })
    it('prepares the bounded synthetic 1-parent/466-message/1306-notification wave', async () => {
        const env = environment()
        const messages = Array.from({ length: 466 }, (_, index) => ({ ...message, id: `synthetic-m-${String(index).padStart(4, '0')}`, messageId: `synthetic-message-${index}` }))
        const notifications = Array.from({ length: 1306 }, (_, index) => ({ ...notification, id: `synthetic-n-${String(index).padStart(4, '0')}`, notificationId: `synthetic-notification-${index}`, messageId: messages[index % messages.length].messageId }))
        const baseText = frame('B', parent) + messages.map((row) => frame('M', row)).join('') + notifications.map((row) => frame('N', row)).join('')
        const f = fixture(baseText, frame('N', notifications[0]))
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        expect(selected.artifact.escrow.counts).toEqual({ batches: 1, messages: 466, notifications: 1306, errors: 0 })
        env.tx.newsletterMessages.findMany.mockResolvedValue(messages.map(databaseRow))
        env.tx.newsletterErrors.findMany.mockResolvedValue([])
        env.tx.newsletterNotifications.findMany.mockResolvedValue(notifications.map(databaseRow))
        env.deps.openHistoricalArchive = async () => {
            const source = await openNewsletterRetentionHistoricalArchiveStream(chunks(envelope(f)), { ...f.binding, expectedProcedureFingerprint: PROCEDURE })
            return { ...source, close: async () => { await source.close(); await env.close() } }
        }
        expect(await executeNewsletterRetentionCli(env.args, env.deps)).toMatchObject({ reason: 'independent_restore_readback_missing', coverage: { escrowContentHash: selected.artifact.escrow.contentHash } })
        expect(env.writes).not.toHaveBeenCalled()
    })
    it('feeds existing restore-capability preflight but still does not enable apply', async () => {
        const env = environment()
        const f = fixture()
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        const proof = await verifyNewsletterRetentionArchiveRestore({ now: env.deps.now, restoredAt: CREATED, procedureFingerprint: PROCEDURE, expectedProcedureFingerprint: PROCEDURE, expectedSchemaFingerprint: SCHEMA, archiveLines: lines(selected.lines), restoredLines: lines(selected.lines) })
        env.deps.openHistoricalArchive = async () => ({ ...fixture(), restoreProof: proof, expectedProcedureFingerprint: PROCEDURE, close: env.close })
        expect(await executeNewsletterRetentionCli(env.args, env.deps)).toMatchObject({ reason: 'archive_apply_admission_not_enabled', coverage: { restoredAt: CREATED } })
        env.deps.openHistoricalArchive = async () => ({ ...fixture(), restoreProof: JSON.parse(JSON.stringify(proof)), expectedProcedureFingerprint: PROCEDURE, close: env.close })
        await expect(executeNewsletterRetentionCli(env.args, env.deps)).rejects.toThrow('verified readback')
    })
    it.each(['contents', 'rawEvent', 'parent-set', 'orphan', 'new-child'])('rejects live drift %s and releases resources', async (drift) => {
        const env = environment()
        if (drift === 'contents') env.tx.newsletterBatch.findFirst.mockResolvedValue(databaseRow({ ...parent, contents: 'changed same-count contents' }))
        if (drift === 'rawEvent') env.tx.newsletterNotifications.findMany.mockResolvedValue([databaseRow({ ...notification, rawEvent: 'changed same-count event' })])
        if (drift === 'parent-set') env.tx.newsletterBatch.findMany.mockResolvedValue([{ id: parent.id }, { id: 'synthetic-extra-parent' }])
        if (drift === 'orphan') env.tx.newsletterNotificationOrphan.count.mockResolvedValue(1)
        if (drift === 'new-child') env.tx.newsletterNotifications.findMany.mockResolvedValue([databaseRow(notification), databaseRow({ ...notification, id: 'synthetic-extra-event', notificationId: 'synthetic-extra-notification' })])
        await expect(executeNewsletterRetentionCli(env.args, env.deps)).rejects.toThrow()
        expect(env.writes).not.toHaveBeenCalled()
        expect(env.close).toHaveBeenCalledOnce()
        expect(env.held()).toBe(false)
    })
    it('refreshes clock and current schema after streams', async () => {
        const env = environment()
        env.tx.newsletterNotifications.findMany.mockImplementation(async () => { env.setNow('2026-10-07T14:15:00.001Z'); return [databaseRow(notification)] })
        await expect(executeNewsletterRetentionCli(env.args, env.deps)).rejects.toThrow('stale')
        const next = environment()
        vi.mocked(next.deps.schemaFingerprint).mockResolvedValueOnce(SCHEMA).mockResolvedValueOnce('d'.repeat(64))
        await expect(executeNewsletterRetentionCli(next.args, next.deps)).rejects.toThrow('schema changed')
    })
    it('refuses overlapping preparation before opening second archive', async () => {
        const env = environment()
        let release!: () => void
        let entered!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const started = new Promise<void>((resolve) => { entered = resolve })
        env.tx.newsletterBatch.findFirst.mockImplementation(async () => { entered(); await gate; return databaseRow(parent) })
        const first = executeNewsletterRetentionCli(env.args, env.deps)
        await started
        await expect(executeNewsletterRetentionCli(env.args, env.deps)).rejects.toThrow('already running')
        release()
        await first
        expect(env.deps.openHistoricalArchive).toHaveBeenCalledOnce()
    })
    it.each(['--apply', '--escrow-out', '--private-artifact-out', '--manifest-out'])('forbids destructive/output mode %s before opening source', async (flag) => {
        const env = environment()
        await expect(executeNewsletterRetentionCli([...env.args, flag, ...(flag === '--apply' ? [] : ['/synthetic-out'])], env.deps)).rejects.toThrow('forbids')
        expect(env.deps.openHistoricalArchive).not.toHaveBeenCalled()
    })
    it('computes all digest sets from original archive encodings, not normalized rows or origin order', async () => {
        const late = { ...notification, id: 'z-last', notificationId: 'z-event', rawEvent: 'original precision', timestamp: '2026-01-01T00:00:00.0Z' }
        const early = { ...notification, id: 'a-first', notificationId: 'a-event' }
        const f = fixture(frame('B', parent) + frame('M', message) + frame('E', error) + frame('N', late) + frame('N', early), frame('N', early))
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        for (const [tag, rows] of [['B', [parent]], ['M', [message]], ['E', [error]], ['N', [early, late]]] as const) {
            const canonical = rows.map((row) => `${tag}\t${Buffer.from(row.id).toString('hex').toUpperCase()}\t${hash(frame(tag, row).split('!')[1])}\n`).join('')
            expect(selected.readbackDigests[tag]).toBe(hash(canonical))
        }
        expect(selected.records.at(-1)).toMatchObject({ row: { timestamp: CREATED } })
    })
    it('connects operational wrapper refusal to versioned CLI preparation without mutation', async () => {
        const env = environment()
        env.deps.openHistoricalArchive = async () => ({ ...fixture(), expectedProcedureFingerprint: PROCEDURE, close: env.close,
            operationalReadback: { report: { evidenceSource: 'operator_report_received_in_chat', originalOperatorReport: { matches: true } }, target: { configSha256: SCHEMA, containerId: SCHEMA, imageId: `sha256:${SCHEMA}` } } })
        expect(await executeNewsletterRetentionCli(env.args, env.deps)).toMatchObject({ admissionVersion: 2, admission: 'refused', reason: 'operator_report_not_independently_acquired', applyEnabled: false })
        expect(env.writes).not.toHaveBeenCalled()
    })
    it.each(['success', 'content', 'parent', 'count', 'orphan', 'postcommit'] as const)('rehearses historical selection through shared transactional delete core: %s (fixtures only)', async (mode) => {
        const env = environment()
        const f = fixture()
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        const order: string[] = []
        let commits = 0, rollbacks = 0
        if (mode === 'content') env.tx.newsletterBatch.findFirst.mockResolvedValue(databaseRow({ ...parent, contents: 'drift' }))
        if (mode === 'parent') env.tx.newsletterBatch.findMany.mockResolvedValue([{ id: parent.id }, { id: 'reused' }])
        if (mode === 'orphan') env.tx.newsletterNotificationOrphan.count.mockResolvedValue(1)
        for (const [name, delegate] of Object.entries(env.tx)) {
            if (name === 'newsletterNotificationOrphan') continue
            Object.assign(delegate, { deleteMany: async () => { order.push(name); return { count: mode === 'count' ? 2 : 1 } }, count: async () => 0 })
        }
        const lease = await env.deps.createLockProvider().tryAcquire('newsletter-retention-apply')
        const run = async () => {
            try {
                const result = await env.transaction(async (tx) => {
                    try { return await recheckAndApplyNewsletterRetentionArchiveBatchForFixture(tx as never, { policy, manifest: selected.manifest, artifact: selected.artifact } as never, selected.records) }
                    catch (error) { rollbacks++; throw error }
                }, { isolationLevel: 'Serializable' })
                commits++
                // Independent postcommit fixture readback; not rollback after commit.
                if (mode === 'postcommit') throw new Error('postcommit readback failed; committedBatchCount=1')
                return result
            } finally { await lease?.release() }
        }
        if (mode === 'success') {
            expect(await run()).toMatchObject({ deletedBatchCount: 1, deletedMessageCount: 1, deletedErrorCount: 1, deletedNotificationCount: 1 })
            expect(order).toEqual(['newsletterNotifications', 'newsletterErrors', 'newsletterMessages', 'newsletterBatch'])
            expect(commits).toBe(1)
        } else {
            await expect(run()).rejects.toThrow()
            expect(commits).toBe(mode === 'postcommit' ? 1 : 0)
            expect(rollbacks).toBe(mode === 'postcommit' ? 0 : 1)
            if (['content', 'parent', 'orphan'].includes(mode)) expect(order).toEqual([])
        }
        expect(env.held()).toBe(false)
    })
    it('cannot use adapter artifacts to bypass legacy apply TTL or Serializable content comparison', async () => {
        const env = environment()
        const f = fixture()
        const selected = await adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)
        const deleted = vi.fn(async () => ({ count: 1 }))
        for (const delegate of [env.tx.newsletterBatch, env.tx.newsletterMessages, env.tx.newsletterErrors, env.tx.newsletterNotifications]) Object.assign(delegate, { deleteMany: deleted, count: async () => 0 })
        const input = {
            policy: { ...policy, apply: true },
            evidence: { now: NOW, backup: { verifiedAt: CREATED, restoredAt: CREATED }, restore: { verifiedAt: CREATED, restoredAt: CREATED }, health: env.evidence.health },
            manifest: selected.manifest, artifact: selected.artifact,
            escrowSource: { verification: selected.artifact.escrow, readBatchRecords: async () => selected.records },
            database: env.deps.database as unknown as NewsletterRetentionApplyDatabase,
            lock: env.deps.createLockProvider(),
        }
        await expect(executeNewsletterRetentionApply(input)).rejects.toThrow('stale')
        expect(env.transaction).not.toHaveBeenCalled()
        // A genuinely fresh SYNTHETIC legacy evidence fixture is not historical admission.
        input.evidence.backup = { verifiedAt: NOW, restoredAt: NOW }
        input.evidence.restore = { verifiedAt: NOW, restoredAt: NOW }
        env.tx.newsletterNotifications.findMany.mockResolvedValue([databaseRow({ ...notification, rawEvent: 'same-count concurrent drift' })])
        await expect(executeNewsletterRetentionApply(input)).rejects.toThrow('apply failed')
        expect(env.transaction).toHaveBeenCalledOnce()
        expect(deleted).not.toHaveBeenCalled()
        expect(env.held()).toBe(false)
    })
    it('leaves legacy evidence TTL in its own path and refuses missing trusted transport', async () => {
        const env = environment()
        await expect(executeNewsletterRetentionCli(env.args.filter((s) => s !== '--prepare-historical-archive'), env.deps)).rejects.toThrow('invalid or stale')
        delete env.deps.openHistoricalArchive
        await expect(executeNewsletterRetentionCli(env.args, env.deps)).rejects.toThrow('not configured')
    })
    it.each(['truncated-prefix', 'truncated-base', 'trailing', 'untrusted-proof', 'sequence'])('rejects invalid RAM streaming envelope %s', async (change) => {
        const f = fixture()
        let bytes = envelope(f)
        if (change === 'truncated-prefix') bytes = bytes.subarray(0, 5)
        if (change === 'truncated-base') bytes = bytes.subarray(0, -10)
        if (change === 'trailing') bytes = Buffer.concat([bytes, Buffer.from('extra')])
        const config = { ...f.binding, expectedProcedureFingerprint: PROCEDURE }
        if (change === 'untrusted-proof') Object.assign(config, { restoreProof: { restore: 'validated_chain' } })
        if (change === 'truncated-prefix' || change === 'untrusted-proof') {
            await expect(openNewsletterRetentionHistoricalArchiveStream(chunks(bytes), config)).rejects.toThrow()
        } else {
            const source = await openNewsletterRetentionHistoricalArchiveStream(chunks(bytes), config)
            try {
                if (change === 'sequence') await expect(source.chain.deltaRows[Symbol.asyncIterator]().next()).rejects.toThrow('sequence')
                else await expect(adaptNewsletterRetentionHistoricalArchive(source.chain, source.binding, policy)).rejects.toThrow()
            } finally { await source.close() }
        }
    })
    it.each(['base-hash', 'delta-hash', 'generation', 'chain', 'schema', 'index'])('rejects binding mismatch %s', async (change) => {
        const f = fixture()
        if (change === 'base-hash') f.binding.baseManifestSha256 = 'd'.repeat(64)
        if (change === 'delta-hash') f.binding.deltaManifestSha256 = 'd'.repeat(64)
        if (change === 'generation') f.binding.deltaGenerationId = 'synthetic-wrong-generation'
        if (change === 'schema') f.binding.columns = { ...HISTORICAL_COLUMNS, N: [...HISTORICAL_COLUMNS.N].reverse() } as unknown as typeof HISTORICAL_COLUMNS
        if (change === 'index') f.binding.baseIndexSha256 = 'd'.repeat(64)
        if (change === 'chain') {
            f.deltaObject.baseRowsSha256 = 'd'.repeat(64)
            f.chain.deltaManifest = Buffer.from(JSON.stringify(f.deltaObject))
            f.binding.deltaManifestSha256 = hash(f.chain.deltaManifest)
        }
        await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)).rejects.toThrow()
    })
    it('checks full gzip integrity even for excluded payloads and validates trailer', async () => {
        for (const truncated of [false, true]) {
            const f = fixture()
            const bytes = truncated ? f.base.subarray(0, -5) : gzipSync('B!invalid!\n')
            f.chain.baseRows = chunks(bytes)
            await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)).rejects.toThrow()
        }
    })
    it.each(['duplicate', 'bad-frame', 'bad-fields', 'missing-newline', 'non-N-delta', 'precision', 'correlation'])('rejects malformed or ambiguous historical rows %s', async (change) => {
        let f = fixture()
        if (change === 'duplicate') f = fixture(frame('B', parent) + frame('B', parent))
        if (change === 'bad-frame') f = fixture('B!invalid!\n')
        if (change === 'bad-fields') f = fixture(`B!${b64(b64(parent.id))}!\n`)
        if (change === 'missing-newline') f = fixture(frame('B', parent).trimEnd())
        if (change === 'non-N-delta') f = fixture(undefined, frame('M', message))
        if (change === 'precision') f = fixture(frame('B', { ...parent, created: '2026-01-01T00:00:00.000123Z' }))
        if (change === 'correlation') f = fixture(undefined, frame('N', { ...notification, messageId: 'synthetic-other-message' }))
        await expect(adaptNewsletterRetentionHistoricalArchive(f.chain, f.binding, policy)).rejects.toThrow()
    })
})
