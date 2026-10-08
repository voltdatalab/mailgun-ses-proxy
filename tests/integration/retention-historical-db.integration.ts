import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import mariadb, { type Connection } from 'mariadb'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { PrismaClient } from '../../lib/generated'
import { test } from 'vitest'
import { assertHistoricalCiTarget, historicalNativeConnectionOptions } from '../../scripts/test-retention-historical-db.mjs'
import { createInternalHistoricalRetentionExecutor } from '../../service/newsletter-retention-applier'
import type { HistoricalExecutorRoot, HistoricalTransaction } from '../../service/newsletter-retention-historical-executor-contract'
import { chunks, fixedRows, signedFixture, frame, hash, type Row, type Tag } from '../service/newsletter-retention-historical-ci-fixture'

const MODES = ['commit', 'rollback-after-delete', 'precommit-divergence', 'postcommit-failure', 'postcommit-mismatch', 'unsigned', 'gate-refusal', 'commit-unknown'] as const
const TABLES = ['NewsletterBatch', 'NewsletterMessages', 'NewsletterErrors', 'NewsletterNotifications', 'NewsletterNotificationOrphan'] as const
type Table = typeof TABLES[number]
type Snapshot = Record<Table, Row[]>
function fixtureTables(rows: ReturnType<typeof fixedRows>): Snapshot {
    return { NewsletterBatch: [rows.parent, rows.otherParent], NewsletterMessages: [rows.message, rows.otherMessage], NewsletterErrors: [rows.error], NewsletterNotifications: [rows.notification, rows.otherNotification], NewsletterNotificationOrphan: [rows.orphan] }
}
function normalized(row: Record<string, unknown>): Row {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => {
        if (value === null) return [key, null]
        if (['created', 'timestamp', 'reconciledAt'].includes(key)) return [key, new Date(`${String(value).replace(' ', 'T')}Z`).toISOString()]
        assert.equal(typeof value, 'string', 'native scalar must not be synthesized')
        return [key, value as string]
    }))
}
async function snapshot(native: Connection, fixtures: Snapshot, locking = false): Promise<Snapshot> {
    const result = {} as Snapshot
    for (const table of TABLES) {
        const ids = fixtures[table].map(row => row.id)
        const actual = await native.query(`SELECT * FROM \`${table}\` WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id${locking ? ' FOR UPDATE' : ''}`, ids) as Record<string, unknown>[]
        result[table] = actual.map(normalized)
    }
    return result
}
async function insert(native: Connection, table: Table, row: Row) {
    const keys = Object.keys(row)
    const values = keys.map(key => ['created', 'timestamp', 'reconciledAt'].includes(key) && row[key] !== null ? row[key]!.replace('T', ' ').replace('Z', '') : row[key])
    await native.query(`INSERT INTO \`${table}\` (${keys.map(key => `\`${key}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, values)
}
async function cleanup(native: Connection, fixtures: Snapshot) {
    // Exact finite fixture IDs only. No broad DELETE, truncate or shared test data.
    for (const table of [...TABLES].reverse()) {
        const ids = fixtures[table].map(row => row.id)
        await native.query(`DELETE FROM \`${table}\` WHERE id IN (${ids.map(() => '?').join(',')})`, ids)
    }
    const remaining = await snapshot(native, fixtures)
    assert.equal(Object.values(remaining).flat().length, 0, 'own fixture cleanup readback')
}
async function catalogFingerprint(native: Connection) {
    const rows = await native.query('SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?, ?) ORDER BY TABLE_NAME, ORDINAL_POSITION', [...TABLES])
    assert.ok(rows.length > 0)
    return hash(JSON.stringify(Array.from(rows)))
}
async function counts(native: Connection, rows: ReturnType<typeof fixedRows>, since: string) {
    const count = async (sql: string, values: (string | null)[]) => {
        const result = await native.query(sql, values)
        const n = Number(result[0].n)
        assert.ok(Number.isSafeInteger(n) && n >= 0)
        return n
    }
    return {
        parents: await count('SELECT COUNT(*) AS n FROM NewsletterBatch WHERE batchId = ?', [rows.parent.batchId]),
        messages: await count('SELECT COUNT(*) AS n FROM NewsletterMessages WHERE newsletterBatchId = ?', [rows.parent.id]),
        errors: await count('SELECT COUNT(*) AS n FROM NewsletterErrors WHERE newsletterBatchId = ?', [rows.parent.id]),
        notifications: await count('SELECT COUNT(*) AS n FROM NewsletterNotifications WHERE messageId = ?', [rows.message.messageId]),
        orphans: await count('SELECT COUNT(*) AS n FROM NewsletterNotificationOrphan WHERE messageId = ? AND reconciledAt IS NULL', [rows.message.messageId]),
        lateEvents: await count('SELECT COUNT(*) AS n FROM NewsletterNotifications WHERE messageId = ? AND created > ?', [rows.message.messageId, since.replace('T', ' ').replace('Z', '')]),
    }
}
function nativeDigests(before: Snapshot, rows: ReturnType<typeof fixedRows>) {
    const result = {} as Record<Tag, string>
    for (const [tag, table, id] of [['B', 'NewsletterBatch', rows.parent.id], ['M', 'NewsletterMessages', rows.message.id], ['E', 'NewsletterErrors', rows.error.id], ['N', 'NewsletterNotifications', rows.notification.id]] as const) {
        const actual = before[table].find(row => row.id === id)
        assert.ok(actual, 'independent native acquisition row missing')
        const outer = frame(tag, actual).split('!')[1]
        result[tag] = hash(`${tag}\t${Buffer.from(actual.id!).toString('hex').toUpperCase()}\t${hash(outer)}\n`)
    }
    return result
}
function sentinelRows(snapshot: Snapshot, fixtures: Snapshot) {
    return Object.fromEntries(TABLES.map(table => [table, snapshot[table].filter(row => fixtures[table].some(f => f.id === row.id && row.id!.includes('-other-')))]))
}

// No skipIf and no tests/setup.ts / lib/database / dotenv imports. Guard before
// constructing either connection; this file is excluded by ordinary test naming.
test('mandatory connected historical executor with real Serializable SQL and native evidence', async () => {
    const target = assertHistoricalCiTarget(process.env)
    const artifact: { version: number; status: string; engine: string; expectedCases: number; cases: Record<string, unknown>[]; stage: string; observed?: Record<string, unknown> } = { version: 1, status: 'failed', engine: target.engine, expectedCases: MODES.length, cases: [], stage: 'startup' }
    let native: Connection | undefined
    let prisma: PrismaClient | undefined
    let activeFixtures: Snapshot | undefined
    try {
        const connection = { host: target.host, port: target.port, user: target.user, password: target.password, database: target.database }
        native = await mariadb.createConnection(historicalNativeConnectionOptions(target))
        const observed = await native.query('SELECT DATABASE() AS db, CURRENT_USER() AS principal, VERSION() AS version, CONNECTION_ID() AS connectionId')
        assert.equal(observed[0].db, 'mailgun_ci'); assert.match(observed[0].principal, /^ci@/)
        if (target.engine === 'mariadb') assert.match(observed[0].version, /^11\.4\..*MariaDB/)
        else { assert.match(observed[0].version, /^8\.0\./); assert.doesNotMatch(observed[0].version, /MariaDB/) }
        const engines = await native.query('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?, ?)', [...TABLES])
        assert.equal(engines.length, TABLES.length)
        assert.ok(engines.every((row: { ENGINE: string }) => row.ENGINE === 'InnoDB'))
        await native.query('SET SESSION innodb_lock_wait_timeout = 1')
        prisma = new PrismaClient({ adapter: new PrismaMariaDb({ ...connection, connectionLimit: 2, connectTimeout: 5000, acquireTimeout: 5000 }) })
        const prismaIdentity = await prisma.$queryRawUnsafe<Array<{ db: string; principal: string }>>('SELECT DATABASE() AS db, CURRENT_USER() AS principal')
        assert.equal(prismaIdentity[0].db, 'mailgun_ci'); assert.match(prismaIdentity[0].principal, /^ci@/)
        const prismaFingerprint = hash(await readFile('prisma/schema.prisma'))
        const sqlFingerprint = await catalogFingerprint(native)
        assert.notEqual(sqlFingerprint, prismaFingerprint, 'independent schema domains')
        artifact.observed = { database: observed[0].db, serverVersion: observed[0].version, nativeConnectionId: Number(observed[0].connectionId), transactionalTables: TABLES.length, allInnoDB: true, sqlSchemaFingerprint: sqlFingerprint, prismaFileFingerprint: prismaFingerprint }
        artifact.stage = 'cases'
        for (const mode of MODES) {
            artifact.stage = mode
            const rows = fixedRows(mode), fixtures = fixtureTables(rows)
            const absent = await snapshot(native, fixtures)
            assert.equal(Object.values(absent).flat().length, 0, 'refuse collision with any existing fixture ID')
            // Take ownership only after absence is observed. Seed finite rows using
            // native SQL, not archive expectations impersonating database reads.
            activeFixtures = fixtures
            for (const table of TABLES) for (const row of fixtures[table]) await insert(native, table, row)
            const now = new Date().toISOString()
            const acquired = await snapshot(native, fixtures)
            const fixture = await signedFixture(rows, prismaFingerprint, sqlFingerprint, nativeDigests(acquired, rows), now)
            if (mode === 'precommit-divergence') await native.query('UPDATE NewsletterBatch SET contents = ? WHERE id = ?', ['synthetic live divergence', rows.parent.id])
            const before = await snapshot(native, fixtures)
            let attemptId = '', rollbackAttempt = '', callbackFailed = false, deleteCount = 0, txConnectionId = 0, isolation = '', postReads = 0, rollbackConfirmations = 0
            let committedObservation: Awaited<ReturnType<typeof counts>> | undefined
            const injection = new Error('bounded synthetic callback failure')
            const db = prisma, reader = native
            const stamp = (scopeHash: string) => ({ checkedAt: new Date().toISOString(), scopeHash })
            const root: HistoricalExecutorRoot = {
                binding: fixture.binding, policy: fixture.policy, approval: { expected: fixture.expected, policy: fixture.policy, schema: { expectedSqlDatabaseFingerprint: sqlFingerprint, expectedPrismaFileFingerprint: prismaFingerprint } },
                acquisitionRoot: { publicKeyPem: fixture.publicKeyPem, collectorId: 'historical-ci-test-collector', expectedSqlDatabaseFingerprint: sqlFingerprint, expectedPrismaFileFingerprint: prismaFingerprint, procedureFingerprint: fixture.procedureFingerprint, maxAgeMs: 60000 },
                now: () => new Date(), lock: { tryAcquire: async () => ({ release: async () => {} }) }, queueIds: ['synthetic-main', 'synthetic-dlq'], maxGateAgeMs: 60000, maxPressure: 10,
                gates: {
                    ghost: async request => ({ ...stamp(request.artifactHash), recipients: [rows.message.toEmail!] }),
                    queues: async request => ({ ...stamp(request.artifactHash), queues: ['synthetic-main', 'synthetic-dlq'].map(id => ({ id, visible: mode === 'gate-refusal' ? 1 : 0, inflight: 0, delayed: 0 })) }),
                    proxy: async request => ({ ...stamp(request.artifactHash), accepting: true }),
                    pressure: async request => ({ ...stamp(request.artifactHash), activeQueries: 0 }),
                    schema: async request => ({ ...stamp(request.artifactHash), liveDatabaseFingerprint: await catalogFingerprint(reader), prismaFileFingerprint: hash(await readFile('prisma/schema.prisma')) }),
                    correlation: async request => { const live = await counts(reader, rows, now); return { ...stamp(request.artifactHash), orphans: live.orphans, lateEvents: live.lateEvents } },
                },
                database: { $transaction: async (callback, options) => {
                    assert.equal(options.isolationLevel, 'Serializable'); assert.ok(options.attemptId)
                    attemptId = options.attemptId
                    try {
                        const result = await db.$transaction(async tx => {
                            const identity = await tx.$queryRawUnsafe<Array<{ id: bigint }>>('SELECT CONNECTION_ID() AS id')
                            txConnectionId = Number(identity[0].id)
                            // Adapter uses SET TRANSACTION (one transaction), so
                            // @@transaction_isolation is only the session default
                            // and cannot prove this transaction's isolation.
                            assert.notEqual(txConnectionId, Number(observed[0].connectionId), 'native reader must be a distinct SQL session')
                            // Proxy only instruments/injects around real Prisma SQL;
                            // reads, mutations, commit and rollback are never mocked.
                            const wrapped = new Proxy(tx, { get(client, property) {
                                const delegate = Reflect.get(client, property)
                                if (!['newsletterBatch', 'newsletterMessages', 'newsletterErrors', 'newsletterNotifications'].includes(String(property))) return delegate
                                return new Proxy(delegate, { get(model, method) {
                                    const value = Reflect.get(model, method)
                                    if (property === 'newsletterBatch' && method === 'findFirst') return async (args: unknown) => {
                                        const parent = await value.call(model, args)
                                        // An ordinary Prisma SELECT in a Serializable
                                        // transaction holds a read lock. Independent
                                        // native UPDATE must timeout, then roll back.
                                        // Session-default variables cannot prove this.
                                        await reader.beginTransaction()
                                        let lockTimeout = false
                                        try { await reader.query('UPDATE NewsletterBatch SET contents = contents WHERE id = ?', [rows.parent.id]) }
                                        catch (error) { lockTimeout = (error as { errno?: number }).errno === 1205 }
                                        finally { await reader.rollback() }
                                        assert.equal(lockTimeout, true, 'actual Serializable read lock blocks independent writer')
                                        isolation = 'SERIALIZABLE'
                                        return parent
                                    }
                                    if (method !== 'deleteMany') return typeof value === 'function' ? value.bind(model) : value
                                    return async (args: unknown) => {
                                        const deleted = await value.call(model, args)
                                        deleteCount += deleted.count
                                        if (mode === 'rollback-after-delete') {
                                            assert.equal(deleteCount, 1)
                                            const within = await tx.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT COUNT(*) AS n FROM NewsletterNotifications WHERE id = ?', rows.notification.id)
                                            assert.equal(Number(within[0].n), 0, 'actual SQL DELETE visible inside the real transaction')
                                            throw injection
                                        }
                                        return deleted
                                    }
                                } })
                            } })
                            try { return await callback(wrapped as unknown as HistoricalTransaction) }
                            catch (error) {
                                callbackFailed = mode === 'rollback-after-delete' ? error === injection : mode === 'precommit-divergence' && error instanceof Error && error.message === 'transactional escrow record mismatch'
                                throw error
                            }
                        }, { isolationLevel: 'Serializable', timeout: 30000, maxWait: 5000 })
                        if (mode === 'commit-unknown') throw new Error('synthetic lost commit response')
                        return result
                    } catch (error) {
                        // Rejection alone is not confirmation: require a known
                        // callback refusal, unchanged native rows, and released
                        // locks through a distinct real native transaction.
                        if (callbackFailed && (mode === 'rollback-after-delete' && error === injection || mode === 'precommit-divergence')) {
                            await reader.beginTransaction()
                            try { assert.deepEqual(await snapshot(reader, fixtures, true), before); rollbackAttempt = options.attemptId }
                            finally { await reader.rollback() }
                        }
                        throw error
                    }
                } },
                confirmRollback: async id => {
                    rollbackConfirmations++
                    const verified = id === attemptId && id === rollbackAttempt && JSON.stringify(await snapshot(reader, fixtures)) === JSON.stringify(before)
                    return { attemptId: id, outcome: verified ? 'rollback_confirmed' : 'unknown' }
                },
                postcommit: { read: async request => {
                    postReads++; assert.equal(request.attemptId, attemptId)
                    assert.equal(request.batchRecordId, rows.parent.id); assert.equal(request.batchId, rows.parent.batchId); assert.deepEqual(request.messageIds, [rows.message.messageId])
                    committedObservation = await counts(reader, rows, now)
                    assert.ok(Object.values(committedObservation).every(n => n === 0), 'native connection observes committed deletion BEFORE injected read failure/mismatch')
                    if (mode === 'postcommit-failure') throw new Error('synthetic postcommit dependency failure')
                    if (mode === 'postcommit-mismatch') await insert(reader, 'NewsletterBatch', rows.parent) // actual native reappearance, never a fabricated count
                    return counts(reader, rows, now)
                } },
            }
            const acquisition = mode === 'unsigned' ? { ...fixture.acquisition, signature: Buffer.alloc(64) } : fixture.acquisition
            const receipt = await createInternalHistoricalRetentionExecutor(root)({ stream: chunks(fixture.bytes), acquisition, deadlines: { idleMs: 10000, wholeMs: 60000, cleanupMs: 1000 } })
            const after = await snapshot(reader, fixtures)
            const finalCounts = await counts(reader, rows, now)
            assert.deepEqual(sentinelRows(after, fixtures), sentinelRows(before, fixtures), 'unrelated parents, transactional rows and orphan preserved')
            assert.deepEqual(receipt.cleanupFailures, [])
            const rolledBack = ['rollback-after-delete', 'precommit-divergence'].includes(mode)
            const refused = ['unsigned', 'gate-refusal'].includes(mode)
            const committed = !rolledBack && !refused && mode !== 'commit-unknown'
            const expectedState = rolledBack ? 'rollback_confirmed' : refused ? 'refused_before_transaction' : mode === 'commit-unknown' ? 'commit_unknown' : mode.startsWith('postcommit') ? 'committed_readback_failed' : 'committed_readback_ok'
            assert.equal(receipt.state, expectedState)
            if (rolledBack || refused) assert.deepEqual(after, before, 'native before/after full scalar rows equal')
            assert.equal(deleteCount, mode === 'rollback-after-delete' ? 1 : refused || mode === 'precommit-divergence' ? 0 : 4)
            assert.equal(postReads, committed ? 1 : 0)
            assert.equal(rollbackConfirmations, rolledBack || mode === 'commit-unknown' ? 1 : 0)
            if (rolledBack) assert.equal(rollbackAttempt, attemptId)
            if (refused) assert.equal(attemptId, '')
            if (committed || mode === 'commit-unknown') assert.deepEqual(finalCounts, { parents: mode === 'postcommit-mismatch' ? 1 : 0, messages: 0, errors: 0, notifications: 0, orphans: 0, lateEvents: 0 })
            await cleanup(reader, fixtures); activeFixtures = undefined
            artifact.cases.push({ mode, state: receipt.state, attemptId: attemptId || null, rollbackAttemptId: rollbackAttempt || null, transactionConnectionId: txConnectionId || null, isolation: isolation || null, nativeConnectionId: Number(observed[0].connectionId), sqlDeletedRows: deleteCount, beforeSha256: hash(JSON.stringify(before)), afterSha256: hash(JSON.stringify(after)), preservedUnrelated: true, postcommitReads: postReads, committedNativeObservation: committedObservation ?? null, remaining: finalCounts, cleanupVerified: true })
        }
        assert.equal(artifact.cases.length, MODES.length)
        assert.deepEqual(artifact.cases.map(row => row.mode), [...MODES])
        artifact.stage = 'complete'; artifact.status = 'passed'
    } finally {
        try { if (native && activeFixtures) await cleanup(native, activeFixtures) }
        finally {
            try {
                const closed = await Promise.allSettled([prisma?.$disconnect(), native?.end()])
                if (closed.some(result => result.status === 'rejected')) throw new Error('disconnect failed')
            }
            catch { artifact.status = 'failed'; artifact.stage = 'disconnect'; throw new Error('historical CI disconnect failed') }
            finally { await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/retention-historical-db-report.json', `${JSON.stringify(artifact, null, 2)}\n`) }
        }
    }
})
