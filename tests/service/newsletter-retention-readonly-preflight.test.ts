import { describe, it, expect, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { HISTORICAL_ACQUISITION_DOMAIN, createHistoricalAcquisitionVerifier } from '../../service/newsletter-retention-historical-acquisition'
import { chmod, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHistoricalReadOnlyPreflight, executeHistoricalPreflightCommand, type HistoricalPreflightRoot } from '../../service/newsletter-retention-readonly-preflight'
import { chunks, fixedRows, frame, hash, signedFixture, type Tag } from './newsletter-retention-historical-ci-fixture'

const now = '2026-10-08T14:00:00.000Z'
async function fixture(reportedAt = now) {
    const rows = fixedRows('readonly-preflight'), digests = {} as Record<Tag, string>
    // Independent synthetic original scalar commitments, NOT restored SQL proof.
    for (const [tag, row] of [['B', rows.parent], ['M', rows.message], ['E', rows.error], ['N', rows.notification]] as const) digests[tag] = hash(`${tag}\t${Buffer.from(row.id!).toString('hex').toUpperCase()}\t${hash(frame(tag, row).split('!')[1])}\n`)
    const f = await signedFixture(rows, hash('synthetic Prisma'), hash('synthetic SQL'), digests, reportedAt)
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
async function historicalReuseFixture() {
    const { f, root } = await fixture('2026-10-01T14:00:00.000Z')
    const report = JSON.parse(f.acquisition.reportBytes.toString())
    const liveRows = fixedRows('readonly-preflight')
    const liveDigests = {} as Record<Tag, string>
    for (const [tag, row] of [['B', liveRows.parent], ['M', liveRows.message], ['E', liveRows.error], ['N', liveRows.notification]] as const) liveDigests[tag] = hash(`${tag}\t${Buffer.from(row.id!).toString('hex').toUpperCase()}\t${hash(frame(tag, row).split('!')[1])}\n`)
    const observedBinding = structuredClone(f.expected)
    root.historicalReuse = {
        approval: { reportSha256: hash(f.acquisition.reportBytes), configSha256: hash(f.acquisition.configBytes), reportedAt: report.timestampUtc, binding: structuredClone(f.expected) },
        // Separate fixture row observation, NOT values copied from report/expected.
        collect: vi.fn(async () => ({ checkedAt: now, scopeHash: observedBinding.artifactHash, binding: structuredClone(observedBinding), counts: { B: 1, M: 1, E: 1, N: 1 }, setSha256: { ...liveDigests } })),
    }
    return { f, root }
}
describe('immutable historical reuse (SYNTHETIC observer only)', () => {
    it('reuses genuinely signed old bytes with independent approval and a new coverage observer', async () => {
        const { f, root } = await historicalReuseFixture()
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).toMatchObject({ state: 'preflight_verified', reportedAt: '2026-10-01T14:00:00.0000000Z', reportSha256: hash(f.acquisition.reportBytes) })
        expect(root.historicalReuse!.collect).toHaveBeenCalledOnce()
    })
    it.each(['no-approval', 'no-collector', 'hash', 'config', 'timestamp', 'target', 'schema', 'count', 'digest', 'chain', 'selection', 'procedure', 'live-count', 'live-content', 'live-scope', 'live-binding', 'live-stale', 'live-future', 'live-malformed', 'gate-stale', 'gate-future', 'dlq', 'legacy'] as const)('refuses %s', async mode => {
        const { f, root } = await historicalReuseFixture()
        const reuse = root.historicalReuse!
        if (mode === 'no-approval') Object.assign(reuse, { approval: undefined })
        if (mode === 'no-collector') Object.assign(reuse, { collect: undefined })
        if (mode === 'hash') reuse.approval.reportSha256 = hash('wrong')
        if (mode === 'config') reuse.approval.configSha256 = hash('wrong')
        if (mode === 'timestamp') reuse.approval.reportedAt = '2026-10-02T14:00:00.0000000Z'
        if (mode === 'target') reuse.approval.binding.containerId = 'wrong'
        if (mode === 'schema') reuse.approval.binding.schemaFingerprint = hash('wrong')
        if (mode === 'count') reuse.approval.binding.counts.M++
        if (mode === 'digest') reuse.approval.binding.setSha256.M = hash('wrong')
        if (mode === 'chain') reuse.approval.binding.baseManifestSha256 = hash('wrong')
        if (mode === 'selection') reuse.approval.binding.artifactHash = hash('wrong')
        if (mode === 'procedure') reuse.approval.binding.procedureFingerprint = hash('wrong')
        const collect = reuse.collect
        if (mode.startsWith('live-')) reuse.collect = async request => {
            const observed = await collect(request)
            if (mode === 'live-count') observed.counts.M++
            if (mode === 'live-content') {
                const changed = fixedRows('readonly-preflight').message
                changed.toEmail = 'changed@example.invalid'
                observed.setSha256.M = hash(`M\t${Buffer.from(changed.id!).toString('hex').toUpperCase()}\t${hash(frame('M', changed).split('!')[1])}\n`)
            }
            if (mode === 'live-scope') observed.scopeHash = hash('wrong')
            if (mode === 'live-binding') observed.binding.imageId = 'wrong'
            if (mode === 'live-stale') observed.checkedAt = '2026-10-08T13:58:00.000Z'
            if (mode === 'live-future') observed.checkedAt = '2026-10-08T14:00:01.000Z'
            if (mode === 'live-malformed') observed.checkedAt = 'yesterday'
            return observed
        }
        if (mode === 'gate-stale' || mode === 'gate-future') root.gates.pressure = async () => ({ checkedAt: mode === 'gate-stale' ? '2026-10-08T13:58:00.000Z' : '2026-10-08T14:00:01.000Z', scopeHash: f.expected.artifactHash, activeQueries: 0 })
        if (mode === 'dlq') root.gates.queues = async () => ({ checkedAt: now, scopeHash: f.expected.artifactHash, queues: [{ id: 'main', visible: 0, inflight: 0, delayed: 0 }, { id: 'dlq', visible: 1, inflight: 0, delayed: 0 }] })
        if (mode === 'legacy') delete root.historicalReuse
        let state
        try { state = (await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).state } catch { state = 'root_refused' }
        expect(state).not.toBe('preflight_verified')
    })
    it.each(['root', 'buffers', 'request', 'observation'] as const)('owns original approvals and bytes across awaited work: %s', async mode => {
        const { f, root } = await historicalReuseFixture()
        const originalHash = hash(f.acquisition.reportBytes)
        const request = { stream: chunks(f.bytes), acquisition: f.acquisition }
        const collect = root.historicalReuse!.collect
        const observed = await collect({ artifactHash: f.expected.artifactHash, batchGroupSha256: root.binding.batchGroupSha256, attemptId: 'synthetic', signal: new AbortController().signal })
        root.historicalReuse!.collect = async () => {
            if (mode === 'root') { root.historicalReuse!.approval.binding.counts.M++; root.approval.expected.setSha256.M = hash('poison') }
            if (mode === 'buffers') for (const bytes of Object.values(f.acquisition)) bytes.fill(0)
            if (mode === 'request') request.acquisition = { ...f.acquisition, reportBytes: Buffer.from('poison') }
            return observed
        }
        if (mode === 'observation') {
            const ghost = root.gates.ghost
            root.gates.ghost = async r => { observed.setSha256.M = hash('poison'); return ghost(r) }
        }
        expect(await createHistoricalReadOnlyPreflight(root)(request)).toMatchObject({ state: 'preflight_verified', reportedAt: '2026-10-01T14:00:00.0000000Z', reportSha256: originalHash })
    })
    it.each(['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const)('snapshots %s as soon as it resolves, before another collector mutates its result', async name => {
        const { f, root } = await historicalReuseFixture()
        const gateRequest = { artifactHash: f.expected.artifactHash, batchGroupSha256: root.binding.batchGroupSha256, attemptId: 'synthetic', signal: new AbortController().signal }
        const healthy = await root.gates[name](gateRequest)
        const shared = structuredClone(healthy)
        const invalid = {
            ghost: { recipients: ['wrong@example.invalid'] },
            queues: { queues: [{ id: 'main', visible: 0, inflight: 0, delayed: 0 }, { id: 'dlq', visible: 1, inflight: 0, delayed: 0 }] },
            proxy: { accepting: false }, pressure: { activeQueries: 11 },
            schema: { liveDatabaseFingerprint: hash('wrong') }, correlation: { lateEvents: 1 },
        }
        Object.assign(shared, invalid[name])
        Object.assign(root.gates, { [name]: async () => shared })
        const blocker = name === 'schema' ? 'proxy' : 'schema'
        const collect = root.gates[blocker]
        Object.assign(root.gates, { [blocker]: async (r: Parameters<typeof collect>[0]) => {
            await new Promise<void>(resolve => setImmediate(resolve))
            Object.assign(shared, healthy)
            return collect(r)
        } })
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).toMatchObject({ state: 'refused', stage: 'gates' })
    })
    it.each(['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const)('keeps a private valid %s snapshot if the caller poisons its delivered reference', async name => {
        const { f, root } = await historicalReuseFixture()
        const gateRequest = { artifactHash: f.expected.artifactHash, batchGroupSha256: root.binding.batchGroupSha256, attemptId: 'synthetic', signal: new AbortController().signal }
        const shared = await root.gates[name](gateRequest)
        Object.assign(root.gates, { [name]: async () => shared })
        const blocker = name === 'schema' ? 'proxy' : 'schema'
        const collect = root.gates[blocker]
        Object.assign(root.gates, { [blocker]: async (r: Parameters<typeof collect>[0]) => {
            await new Promise<void>(resolve => setImmediate(resolve))
            shared.scopeHash = hash('poison')
            return collect(r)
        } })
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).toMatchObject({ state: 'preflight_verified', stage: 'complete' })
    })
    it.each(['all-expired', 'coverage-only', 'gates-only', 'legacy-original'] as const)('refuses %s when evidence expires during successful asynchronous cleanup', async mode => {
        const { f, root } = await (mode === 'legacy-original' ? fixture() : historicalReuseFixture())
        let clock = now, cleanupRan = false
        root.now = () => new Date(clock)
        if (mode === 'coverage-only') {
            for (const name of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) {
                const collect = root.gates[name]
                Object.assign(root.gates, { [name]: async (r: Parameters<typeof collect>[0]) => {
                    clock = '2026-10-08T14:00:30.000Z'
                    return { ...await collect(r), checkedAt: clock }
                } })
            }
        }
        if (mode === 'gates-only') {
            for (const name of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) {
                const collect = root.gates[name]
                Object.assign(root.gates, { [name]: async (r: Parameters<typeof collect>[0]) => ({ ...await collect(r), checkedAt: '2026-10-08T13:59:30.000Z' }) })
            }
        }
        if (mode === 'legacy-original') root.maxGateAgeMs = 900000
        for (const name of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) Object.assign(root.gates, { [name]: vi.fn(root.gates[name]) })
        const iterator = chunks(f.bytes)[Symbol.asyncIterator]()
        const stream = { [Symbol.asyncIterator]: () => ({
            next: () => iterator.next(),
            return: async () => {
                cleanupRan = true
                clock = mode === 'coverage-only' ? '2026-10-08T14:01:15.000Z' : mode === 'gates-only' ? '2026-10-08T14:00:45.000Z' : '2026-10-08T14:02:00.000Z'
                return iterator.return(undefined)
            },
        }) }
        const result = await createHistoricalReadOnlyPreflight(root)({ stream, acquisition: f.acquisition })
        expect(cleanupRan).toBe(true)
        expect(result).toMatchObject({ state: 'refused', stage: 'gates', cleanupFailures: [] })
        for (const collect of Object.values(root.gates)) expect(collect).toHaveBeenCalledOnce()
        if (root.historicalReuse) expect(root.historicalReuse.collect).toHaveBeenCalledOnce()
    })
    it.each(['legacy', 'reuse'] as const)('honors external cancellation during cleanup without mistaking ordinary disposal for cancellation: %s', async mode => {
        const { f, root } = await (mode === 'legacy' ? fixture() : historicalReuseFixture())
        const external = new AbortController()
        const iterator = chunks(f.bytes)[Symbol.asyncIterator]()
        const stream = { [Symbol.asyncIterator]: () => ({
            next: () => iterator.next(),
            return: async () => { external.abort(); return iterator.return(undefined) },
        }) }
        expect(await createHistoricalReadOnlyPreflight(root)({ stream, acquisition: f.acquisition, deadlines: { signal: external.signal } })).toMatchObject({ state: 'refused', stage: 'gates', cleanupFailures: [] })
    })
    it('isolates completed collector snapshots between concurrent readonly invocations', async () => {
        const { f, root } = await historicalReuseFixture()
        const healthy = await root.gates.queues({ artifactHash: f.expected.artifactHash, batchGroupSha256: root.binding.batchGroupSha256, attemptId: 'synthetic', signal: new AbortController().signal })
        const poisoned = structuredClone(healthy)
        poisoned.queues[1].visible = 1
        let collected = 0
        root.gates.queues = async () => ++collected === 1 ? poisoned : structuredClone(healthy)
        const schema = root.gates.schema
        root.gates.schema = async r => {
            await new Promise<void>(resolve => setImmediate(resolve))
            poisoned.queues[1].visible = 0
            return schema(r)
        }
        const preflight = createHistoricalReadOnlyPreflight(root)
        const receipts = await Promise.all([preflight({ stream: chunks(f.bytes), acquisition: f.acquisition }), preflight({ stream: chunks(f.bytes), acquisition: f.acquisition })])
        expect(receipts.map(r => r.state).sort()).toEqual(['preflight_verified', 'refused'])
    })
    it('legacy verifier still refuses the same correctly signed old report', async () => {
        const { f, root } = await historicalReuseFixture()
        expect(() => createHistoricalAcquisitionVerifier(root.acquisitionRoot)(f.acquisition, f.expected, new Date(now))).toThrow(/stale/)
    })
    it.each(['wrapper', 'negative', 'future', 'malformed', 'fraction-future', 'wrong-target', 'wrong-count', 'wrong-digest', 'sql-is-prisma'] as const)('refuses validly signed, exactly pinned invalid evidence: %s', async mode => {
        const { f, root } = await historicalReuseFixture()
        const signer = generateKeyPairSync('ed25519')
        root.acquisitionRoot.publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        let report = JSON.parse(f.acquisition.reportBytes.toString())
        if (mode === 'negative') report.status = 'failed'
        if (mode === 'future') report.timestampUtc = '2026-10-09T14:00:00.0000000Z'
        if (mode === 'fraction-future') report.timestampUtc = '2026-10-08T14:00:00.0000001Z'
        if (mode === 'malformed') report.timestampUtc = '2026-02-30T14:00:00.0000000Z'
        if (mode === 'wrong-target') report.containerId = 'wrong'
        if (mode === 'wrong-count') report.counts.M++
        if (mode === 'wrong-digest') report.setSha256.M = hash('wrong')
        if (mode === 'wrapper') report = { evidenceSource: 'operator_report_received_in_chat', originalOperatorReport: report }
        f.acquisition.reportBytes = Buffer.from(JSON.stringify(report))
        const attestation = { ...JSON.parse(f.acquisition.attestationBytes.toString()), reportSha256: hash(f.acquisition.reportBytes) }
        if (mode === 'sql-is-prisma') attestation.restoredSqlDatabaseFingerprint = root.acquisitionRoot.expectedPrismaFileFingerprint
        f.acquisition.attestationBytes = Buffer.from(JSON.stringify(attestation))
        f.acquisition.signature = sign(null, Buffer.concat([Buffer.from(HISTORICAL_ACQUISITION_DOMAIN), f.acquisition.attestationBytes]), signer.privateKey)
        root.historicalReuse!.approval.reportSha256 = hash(f.acquisition.reportBytes)
        root.historicalReuse!.approval.reportedAt = report.timestampUtc ?? report.originalOperatorReport.timestampUtc
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).toMatchObject({ state: 'refused', stage: 'acquisition' })
        expect(root.historicalReuse!.collect).not.toHaveBeenCalled()
    })
    it('owns approval and envelope even during archive streaming', async () => {
        const { f, root } = await historicalReuseFixture()
        const originalHash = hash(f.acquisition.reportBytes)
        const stream = { async *[Symbol.asyncIterator]() {
            root.historicalReuse!.approval.reportSha256 = hash('poison')
            root.approval.expected.counts.M++
            for (const bytes of Object.values(f.acquisition)) bytes.fill(0)
            yield* chunks(f.bytes)
        } }
        expect(await createHistoricalReadOnlyPreflight(root)({ stream, acquisition: f.acquisition })).toMatchObject({ state: 'preflight_verified', reportSha256: originalHash })
    })
    it('bounds a stalled coverage collector without running the six gates', async () => {
        const { f, root } = await historicalReuseFixture()
        root.historicalReuse!.collect = () => new Promise(() => {})
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition, deadlines: { idleMs: 20, wholeMs: 100, cleanupMs: 20 } })).toMatchObject({ state: 'refused', stage: 'gates', cleanupFailures: [] })
        expect(root.gates.ghost).not.toHaveBeenCalled()
    })
    it('cannot repair an unapproved original hash by swapping approvals while streaming', async () => {
        const { f, root } = await historicalReuseFixture()
        const correct = structuredClone(root.historicalReuse!.approval)
        root.historicalReuse!.approval.reportSha256 = hash('unapproved')
        const stream = { async *[Symbol.asyncIterator]() { root.historicalReuse!.approval = correct; yield* chunks(f.bytes) } }
        expect(await createHistoricalReadOnlyPreflight(root)({ stream, acquisition: f.acquisition })).toMatchObject({ state: 'refused', stage: 'acquisition' })
        expect(root.historicalReuse!.collect).not.toHaveBeenCalled()
    })
    it('rechecks coverage freshness after awaited gates', async () => {
        const { f, root } = await historicalReuseFixture()
        let clock = now
        root.now = () => new Date(clock)
        for (const name of ['ghost', 'queues', 'proxy', 'pressure', 'schema', 'correlation'] as const) {
            const collect = root.gates[name]
            Object.assign(root.gates, { [name]: async (r: Parameters<typeof collect>[0]) => { clock = '2026-10-08T14:02:00.000Z'; return { ...await collect(r), checkedAt: clock } } })
        }
        expect(await createHistoricalReadOnlyPreflight(root)({ stream: chunks(f.bytes), acquisition: f.acquisition })).toMatchObject({ state: 'refused', stage: 'gates' })
    })
})
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
    it.each(['legacy', 'historical-reuse'] as const)('actual secure descriptor command reads pinned raw metadata: %s', async mode => {
        const { f, root } = await (mode === 'historical-reuse' ? historicalReuseFixture() : fixture())
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
