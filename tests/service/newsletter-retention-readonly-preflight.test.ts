import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { HISTORICAL_ACQUISITION_DOMAIN } from '../../service/newsletter-retention-historical-acquisition'
import { chmod, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHistoricalReadOnlyPreflight, executeHistoricalPreflightCommand, type HistoricalPreflightRoot } from '../../service/newsletter-retention-readonly-preflight'
import { chunks, fixedRows, frame, hash, signedFixture, type Tag } from './newsletter-retention-historical-ci-fixture'

const now = '2026-10-08T14:00:00.000Z'
async function fixture() {
    const rows = fixedRows('readonly-preflight'), digests = {} as Record<Tag, string>
    // Independent synthetic original scalar commitments, NOT restored SQL proof.
    for (const [tag, row] of [['B', rows.parent], ['M', rows.message], ['E', rows.error], ['N', rows.notification]] as const) digests[tag] = hash(`${tag}\t${Buffer.from(row.id!).toString('hex').toUpperCase()}\t${hash(frame(tag, row).split('!')[1])}\n`)
    const f = await signedFixture(rows, hash('synthetic Prisma'), hash('synthetic SQL'), digests, now)
    const observation = { checkedAt: now, scopeHash: f.expected.artifactHash }
    const root: HistoricalPreflightRoot = {
        binding: f.binding, policy: f.policy, approval: { expected: f.expected, policy: f.policy, schema: { expectedSqlDatabaseFingerprint: hash('synthetic SQL'), expectedPrismaFileFingerprint: hash('synthetic Prisma') } },
        acquisitionRoot: { publicKeyPem: f.publicKeyPem, collectorId: 'historical-ci-test-collector', procedureFingerprint: f.procedureFingerprint, expectedSqlDatabaseFingerprint: hash('synthetic SQL'), expectedPrismaFileFingerprint: hash('synthetic Prisma'), maxAgeMs: 60000 },
        now: () => new Date(now), queueIds: ['main', 'dlq'], maxGateAgeMs: 60000, maxPressure: 10,
        gates: {
            ghost: vi.fn(async () => ({ ...observation, recipients: [rows.message.toEmail!] })),
            queues: async () => ({ ...observation, queues: ['main', 'dlq'].map(id => ({ id, visible: 0, inflight: 0, delayed: 0 })) }),
            proxy: async () => ({ ...observation, accepting: true }), pressure: async () => ({ ...observation, activeQueries: 0 }),
            schema: async () => ({ ...observation, liveDatabaseFingerprint: hash('synthetic SQL'), prismaFileFingerprint: hash('synthetic Prisma') }),
            correlation: async () => ({ ...observation, orphans: 0, lateEvents: 0 }),
        },
    }
    return { f, root }
}
describe('connected READ ONLY acquisition/preflight (synthetic, not SQL certification)', () => {
    it('authenticates original metadata and complete stream, checks shared live gates, returns no capability/payload', async () => {
        const { f, root } = await fixture()
        const result = await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })
        expect(result).toMatchObject({ state: 'preflight_verified', reportedAt: now.replace('Z', '0000Z'), cleanupFailures: [] })
        const text = JSON.stringify(result)
        expect(text).not.toMatch(/apply_ready|capability|recipient@example|synthetic body|readonly-preflight-b/)
        expect(root.gates.ghost).toHaveBeenCalledOnce()
    })
    it.each(['swap-envelope', 'overwrite-buffers'] as const)('refuses originally stale evidence despite valid newer signed %s during gates', async mode => {
        const { f, root } = await fixture()
        const signer = generateKeyPairSync('ed25519')
        root.acquisitionRoot.publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        const envelope = (timestamp: string) => {
            const reportBytes = Buffer.from(JSON.stringify({ ...JSON.parse(f.acquisition.reportBytes.toString()), timestampUtc: timestamp.replace('Z', '0000Z') }))
            const attestationBytes = Buffer.from(JSON.stringify({ ...JSON.parse(f.acquisition.attestationBytes.toString()), reportSha256: hash(reportBytes) }))
            return { reportBytes, configBytes: Buffer.from(f.acquisition.configBytes), attestationBytes, signature: sign(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), attestationBytes]), signer.privateKey) }
        }
        const original = envelope(now), newer = envelope('2026-10-08T14:02:00.000Z')
        const request = { stream: chunks(f.bytes), acquisition: original }
        let clock = now
        root.now = () => new Date(clock)
        for (const name of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) {
            const collect = root.gates[name]
            Object.assign(root.gates, { [name]: async (gateRequest: Parameters<typeof collect>[0]) => {
                if (name === 'ghost') {
                    clock = '2026-10-08T14:02:00.000Z'
                    if (mode === 'swap-envelope') request.acquisition = newer
                    else for (const key of ['reportBytes', 'configBytes', 'attestationBytes', 'signature'] as const) {
                        expect(original[key].length).toBe(newer[key].length)
                        original[key].set(newer[key])
                    }
                }
                return { ...await collect(gateRequest), checkedAt: clock }
            } })
        }
        const result = await createHistoricalReadOnlyPreflight(root)(request)
        expect(result).toEqual({ version: 1, state: 'refused', stage: 'gates', cleanupFailures: [] })
        // Independently prove the replacement really is signed and fresh under
        // exactly the same root/approval: refusing it is not the test's premise.
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: newer })).toMatchObject({ state: 'preflight_verified', reportedAt: '2026-10-08T14:02:00.0000000Z', reportSha256: hash(newer.reportBytes) })
    })
    it('keeps original fresh timestamp/hash when caller swaps in another valid signed fresh envelope', async () => {
        const { f, root } = await fixture()
        const signer = generateKeyPairSync('ed25519')
        root.acquisitionRoot.publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        const resign = (reportBytes: Buffer) => {
            // Whitespace is intentionally signed verbatim, never reserialized
            // by the private replay path.
            const attestationBytes = Buffer.from(`\n${JSON.stringify({ ...JSON.parse(f.acquisition.attestationBytes.toString()), reportSha256: hash(reportBytes) }, null, 2)}\n`)
            return { ...f.acquisition, reportBytes, attestationBytes, signature: sign(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), attestationBytes]), signer.privateKey) }
        }
        const original = resign(Buffer.from(f.acquisition.reportBytes))
        const newer = resign(Buffer.from(JSON.stringify({ ...JSON.parse(original.reportBytes.toString()), timestampUtc: '2026-10-08T14:00:30.0000000Z' })))
        const request = { stream: chunks(f.bytes), acquisition: original }
        let clock = now
        root.now = () => new Date(clock)
        const collect = root.gates.ghost
        root.gates.ghost = async gateRequest => {
            clock = '2026-10-08T14:00:30.000Z'
            request.acquisition = newer
            return collect(gateRequest)
        }
        const preflight = createHistoricalReadOnlyPreflight(root)
        expect(await preflight(request)).toMatchObject({ state: 'preflight_verified', reportedAt: now.replace('Z', '0000Z'), reportSha256: hash(original.reportBytes) })
        expect(hash(newer.reportBytes)).not.toBe(hash(original.reportBytes))
        expect(await preflight({ stream: chunks(f.bytes), acquisition: newer })).toMatchObject({ state: 'preflight_verified', reportedAt: '2026-10-08T14:00:30.0000000Z', reportSha256: hash(newer.reportBytes) })
    })
    it.each(['reportBytes', 'configBytes', 'attestationBytes', 'signature'] as const)('retains original fresh identity despite caller in-place %s poisoning during gates', async key => {
        const { f, root } = await fixture()
        const reportSha256 = hash(f.acquisition.reportBytes)
        const collect = root.gates.ghost
        root.gates.ghost = async request => {
            f.acquisition[key].fill(0)
            return collect(request)
        }
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).toMatchObject({ state: 'preflight_verified', stage: 'complete', reportedAt: now.replace('Z', '0000Z'), reportSha256, cleanupFailures: [] })
    })
    it.each(['unsigned', 'wrapper', 'failed-status', 'binding', 'stale', 'stale-after-gates', 'live-schema', 'schema-root', 'procedure-root', 'coerced-root', 'key', 'root-flag', 'mutation-port', 'stall', 'gate-stall', 'cleanup-stall'])('fails closed through consuming entry: %s', async mode => {
        const { f, root } = await fixture()
        if (mode === 'schema-root') root.acquisitionRoot.expectedSqlDatabaseFingerprint = ''
        if (mode === 'procedure-root') root.acquisitionRoot.procedureFingerprint = ''
        if (mode === 'coerced-root') Object.assign(root.acquisitionRoot, { procedureFingerprint: [f.procedureFingerprint] })
        if (mode === 'key') root.acquisitionRoot.publicKeyPem = 'invalid private key text'
        const mutation = vi.fn(() => { throw new Error('must never call SQL/mutation dependency') })
        if (mode === 'mutation-port') Object.assign(root, { database: { $transaction: mutation }, postcommit: { read: mutation } })
        if (mode === 'root-flag') Object.assign(root, { apply: true })
        if (mode === 'binding') root.approval.expected.artifactHash = hash('different')
        if (mode === 'stale') root.now = () => new Date('2026-10-08T14:02:00.000Z')
        if (mode === 'stale-after-gates') {
            let clockReads = 0
            root.now = () => new Date(++clockReads <= 2 ? now : '2026-10-08T14:02:00.000Z')
        }
        if (mode === 'live-schema') root.gates.schema = async () => ({ checkedAt: now, scopeHash: f.expected.artifactHash, liveDatabaseFingerprint: hash('wrong'), prismaFileFingerprint: hash('synthetic Prisma') })
        if (mode === 'gate-stall') root.gates.ghost = () => new Promise(() => {})
        if (mode === 'unsigned') f.acquisition.signature.fill(0)
        if (mode === 'wrapper') f.acquisition.reportBytes = Buffer.from(JSON.stringify({ evidenceSource: 'operator_report_received_in_chat', originalOperatorReport: JSON.parse(f.acquisition.reportBytes.toString()) }))
        if (mode === 'failed-status') f.acquisition.reportBytes = Buffer.from(JSON.stringify({ ...JSON.parse(f.acquisition.reportBytes.toString()), status: 'failed' }))
        if (mode === 'wrapper' || mode === 'failed-status') {
            const signer = generateKeyPairSync('ed25519')
            root.acquisitionRoot.publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
            f.acquisition.attestationBytes = Buffer.from(JSON.stringify({ ...JSON.parse(f.acquisition.attestationBytes.toString()), reportSha256: hash(f.acquisition.reportBytes) }))
            f.acquisition.signature = sign(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), f.acquisition.attestationBytes]), signer.privateKey)
        }
        let closed = false
        const stream = mode === 'stall' ? { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => {}), return: async () => { closed = true; return { done: true as const, value: undefined } } }) } : mode === 'cleanup-stall' ? { [Symbol.asyncIterator]: () => { const it = chunks(f.bytes)[Symbol.asyncIterator](); return { next: () => it.next(), return: () => new Promise<IteratorResult<Uint8Array>>(() => {}) } } } : chunks(f.bytes)
        let result
        try { result = await createHistoricalReadOnlyPreflight(root)({ stream, acquisition: f.acquisition, deadlines: { idleMs: 20, wholeMs: 150, cleanupMs: 20 } }) }
        catch { result = { state: 'root_refused' } }
        expect(result.state).not.toBe('preflight_verified')
        expect(mutation).not.toHaveBeenCalled()
        if (['unsigned', 'wrapper', 'failed-status', 'binding', 'stale'].includes(mode)) expect(root.gates.ghost).not.toHaveBeenCalled()
        if (mode === 'stall') expect(closed).toBe(true)
        if (mode === 'cleanup-stall') expect(result).toMatchObject({ cleanupFailures: ['source_cleanup_failed'] })
    })
    it('executable command refuses unapproved root and every argument before touching transport', async () => {
        const stream = { [Symbol.asyncIterator]: vi.fn(() => { throw new Error('must not consume') }) }
        expect(await executeHistoricalPreflightCommand([], { NODE_ENV: 'test' }, stream)).toMatchObject({ state: 'refused', stage: 'root' })
        expect(await executeHistoricalPreflightCommand(['--apply'], { NODE_ENV: 'test' }, stream)).toMatchObject({ state: 'refused', stage: 'arguments' })
        expect(stream[Symbol.asyncIterator]).not.toHaveBeenCalled()
    })
    it('actual secure descriptor command reads pinned raw metadata, authenticates and returns safe result', async () => {
        const { f, root } = await fixture()
        // Minimal CI environments may omit TMPDIR; tmpdir() still honors it
        // in local private runners, without changing the secure reader's guards.
        const dir = await mkdtemp(join(tmpdir(), 'preflight-'))
        await chmod(dir, 0o700)
        const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
        try {
            for (const [name, bytes] of [['REPORT', f.acquisition.reportBytes], ['CONFIG', f.acquisition.configBytes], ['ATTESTATION', f.acquisition.attestationBytes], ['SIGNATURE', Buffer.from(JSON.stringify({ signatureBase64: f.acquisition.signature.toString('base64') }))]] as const) {
                const path = join(dir, name + '.json')
                await writeFile(path, bytes, { mode: 0o400 })
                env[`NEWSLETTER_RETENTION_OPERATIONAL_${name}_FILE`] = path
                env[`NEWSLETTER_RETENTION_OPERATIONAL_${name}_SHA256`] = hash(bytes)
            }
            expect(await executeHistoricalPreflightCommand([], env, chunks(f.bytes), root)).toMatchObject({ state: 'preflight_verified' })
            const original = await readFile(env.NEWSLETTER_RETENTION_OPERATIONAL_REPORT_FILE!)
            expect(original).toEqual(f.acquisition.reportBytes)
            env.NEWSLETTER_RETENTION_OPERATIONAL_CONFIG_SHA256 = hash('wrong')
            expect(await executeHistoricalPreflightCommand([], env, chunks(f.bytes), root)).toMatchObject({ state: 'refused', stage: 'metadata' })
        } finally { await rm(dir, { recursive: true, force: true }) }
    })
})
