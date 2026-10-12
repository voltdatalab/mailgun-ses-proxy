import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertHistoricalDbReport, HISTORICAL_DB_MODES } from '../../scripts/assert-retention-historical-db-report.mjs'
import { runHistoricalCi } from '../../scripts/test-retention-historical-db.mjs'
import { readFile } from 'node:fs/promises'

// Synthetic schema tests only. Never write these objects to observed CI artifacts.
function report() {
    const attemptId = '11111111-1111-4111-8111-111111111111'
    const zero = { parents: 0, messages: 0, errors: 0, notifications: 0, orphans: 0, lateEvents: 0 }
    return { version: 1, status: 'passed', stage: 'complete', engine: 'mysql', expectedCases: 8, observed: { database: 'mailgun_ci', serverVersion: '8.0.44', nativeConnectionId: 1, transactionalTables: 5, allInnoDB: true, sqlSchemaFingerprint: 'c'.repeat(64), prismaFileFingerprint: 'd'.repeat(64) }, cases: HISTORICAL_DB_MODES.map((mode, i) => {
        const refused = ['unsigned', 'gate-refusal'].includes(mode), rollback = ['rollback-after-delete', 'precommit-divergence'].includes(mode)
        const committed = !refused && !rollback && mode !== 'commit-unknown'
        return { mode, state: ['committed_readback_ok', 'rollback_confirmed', 'rollback_confirmed', 'committed_readback_failed', 'committed_readback_failed', 'refused_before_transaction', 'refused_before_transaction', 'commit_unknown'][i], sqlDeletedRows: [4, 1, 0, 4, 4, 0, 0, 4][i], preservedUnrelated: true, cleanupVerified: true,
            attemptId: refused ? null : attemptId, rollbackAttemptId: rollback ? attemptId : null, transactionConnectionId: refused ? null : 2, isolation: refused ? null : 'SERIALIZABLE', nativeConnectionId: 1, postcommitReads: committed ? 1 : 0, beforeSha256: 'a'.repeat(64), afterSha256: (rollback || refused ? 'a' : 'b').repeat(64), committedNativeObservation: committed ? zero : null,
            remaining: { parents: rollback || refused || mode === 'postcommit-mismatch' ? 1 : 0, messages: rollback || refused ? 1 : 0, errors: rollback || refused ? 1 : 0, notifications: rollback || refused ? 1 : 0, orphans: 0, lateEvents: 0 } }
    }) }
}
for (const engine of ['mysql', 'mariadb']) test(`synthetic complete ${engine} evidence validates, not real DB certification`, () => {
    const r = report()
    r.engine = engine
    r.observed.serverVersion = engine === 'mysql' ? '8.0.44' : '11.4.8-MariaDB'
    assert.doesNotThrow(() => assertHistoricalDbReport(JSON.parse(JSON.stringify(r)), engine))
})
for (const [index, mode] of HISTORICAL_DB_MODES.entries()) {
    test(`synthetic evidence refuses contradictory snapshot relation: ${mode}`, () => {
        const r = report(), unchanged = ['rollback-after-delete', 'precommit-divergence', 'unsigned', 'gate-refusal'].includes(mode)
        r.cases[index].afterSha256 = unchanged ? 'b'.repeat(64) : r.cases[index].beforeSha256
        assert.throws(() => assertHistoricalDbReport(r, 'mysql'))
    })
}
// All malformed values survive JSON serialization; no custom coercion methods.
const malformed = [
    ['null', () => null], ['missing', () => undefined], ['array', value => [value]],
    ['nested-array', value => [[value]]], ['string-wrapper-object', value => ({ value })], ['number', () => 123],
]
const stringFields = [
    ...['sqlSchemaFingerprint', 'prismaFileFingerprint', 'serverVersion'].map(key => [`observed.${key}`, r => r.observed, key]),
    ...HISTORICAL_DB_MODES.flatMap((mode, index) => ['beforeSha256', 'afterSha256', 'attemptId', 'rollbackAttemptId'].map(key => [`${mode}.${key}`, r => r.cases[index], key])),
]
for (const [field, target, key] of stringFields) for (const [shape, convert] of malformed) {
    if (shape === 'null' && target(report())[key] === null) continue // Null is required for inactive attempt bindings.
    test(`synthetic evidence refuses JSON ${shape}: ${field}`, () => {
        const r = report(), row = target(r)
        row[key] = convert(row[key])
        assert.throws(() => assertHistoricalDbReport(JSON.parse(JSON.stringify(r)), 'mysql'))
    })
}
for (const [label, target, key] of [
    ['observed', r => r, 'observed'],
    ...HISTORICAL_DB_MODES.flatMap((mode, index) => [
        [mode, r => r.cases, index],
        [`${mode}.remaining`, r => r.cases[index], 'remaining'],
        ...(['commit', 'postcommit-failure', 'postcommit-mismatch'].includes(mode) ? [[`${mode}.committedNativeObservation`, r => r.cases[index], 'committedNativeObservation']] : []),
    ]),
]) test(`synthetic evidence refuses JSON record array: ${label}`, () => {
    const r = report(), row = target(r)
    row[key] = [row[key]]
    assert.throws(() => assertHistoricalDbReport(JSON.parse(JSON.stringify(r)), 'mysql'))
})
for (const [label, change] of [
    ['failed', r => { r.status = 'failed' }], ['missing-observed', r => { delete r.observed }],
    ['wrong-observed-database', r => { r.observed.database = 'production' }], ['wrong-observed-engine', r => { r.observed.serverVersion = '11.4.8-MariaDB' }],
    ['nontransactional', r => { r.observed.allInnoDB = false }], ['wrong-table-count', r => { r.observed.transactionalTables = 4 }],
    ['collapsed-schema-domains', r => { r.observed.sqlSchemaFingerprint = r.observed.prismaFileFingerprint }],
    ['wrong-native-session', r => { r.cases[0].nativeConnectionId = 3 }], ['startup', r => { r.stage = 'startup' }], ['wrong-engine', r => { r.engine = 'mariadb' }],
    ['missing-case', r => { r.cases.pop() }], ['duplicate-case', r => { r.cases[1] = r.cases[0] }], ['wrong-count', r => { r.expectedCases = 7 }],
    ['wrong-state', r => { r.cases[4].state = 'rollback_confirmed' }], ['no-delete', r => { r.cases[1].sqlDeletedRows = 0 }],
    ['same-session', r => { r.cases[0].transactionConnectionId = 1 }], ['missing-isolation', r => { delete r.cases[0].isolation }],
    ['unbound-rollback', r => { r.cases[1].rollbackAttemptId = '22222222-2222-4222-8222-222222222222' }],
    ['rollback-changes', r => { r.cases[1].afterSha256 = 'b'.repeat(64) }], ['refusal-changes', r => { r.cases[5].afterSha256 = 'b'.repeat(64) }],
    ['missing-native-commit', r => { r.cases[3].committedNativeObservation = null }], ['nonzero-native-commit', r => { r.cases[3].committedNativeObservation = { parents: 1 } }],
    ['mismatch-lost', r => { r.cases[4].remaining.parents = 0 }], ['unknown-called-postcommit', r => { r.cases[7].postcommitReads = 1 }],
    ['refusal-started-transaction', r => { r.cases[5].attemptId = r.cases[0].attemptId }], ['no-cleanup', r => { r.cases[0].cleanupVerified = false }],
    ['unrelated-modified', r => { r.cases[0].preservedUnrelated = false }],
]) test(`synthetic evidence refuses ${label}`, () => { const r = report(); change(r); assert.throws(() => assertHistoricalDbReport(r, 'mysql')) })
for (const phase of [0, 1]) for (const failed of [{ status: 0, error: new Error('timeout') }, { status: 0, signal: 'SIGTERM' }, { status: null }, { status: 2 }]) {
    test(`consuming entry rejects child/gate phase ${phase}`, () => {
        const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RETENTION_HISTORICAL_DB_CI: '1', RETENTION_HISTORICAL_DB_ENGINE: 'mysql', DATABASE_URL: 'mysql://ci:ci-password@127.0.0.1:3306/mailgun_ci' }
        let calls = 0
        assert.equal(runHistoricalCi(env, () => calls++ === phase ? failed : { status: 0 }), 1)
        assert.equal(calls, 2)
    })
}
test('connected workflow preserves audit gates, original reports and required isolated phases', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/ci.yaml', import.meta.url), 'utf8')
    assert.equal(workflow.match(/RETENTION_HISTORICAL_DB_CI: '1'/g)?.length, 2)
    assert.equal(workflow.match(/RETENTION_HISTORICAL_DB_ENGINE: mysql/g)?.length, 1)
    assert.equal(workflow.match(/RETENTION_HISTORICAL_DB_ENGINE: mariadb/g)?.length, 1)
    assert.equal(workflow.match(/path: artifacts\/retention-historical-db-report.json/g)?.length, 2)
    assert.equal(workflow.match(/artifacts\/vitest-db-report.json/g)?.length, 2)
    assert.equal(workflow.match(/artifacts\/vitest-safe-report.json/g)?.length, 2)
    assert.match(workflow, /npm audit --omit=dev --audit-level=high/)
    assert.match(workflow, /npm audit --audit-level=high/)
    assert.match(workflow, /run: node --test[^\n]*retention-historical-db-report.node.mjs/)
    const config = await readFile(new URL('../../vitest.historical-db.config.ts', import.meta.url), 'utf8')
    assert.match(config, /setupFiles: \[\]/)
    assert.match(config, /retention-historical-db.integration.ts/)
    const harness = await readFile(new URL('../integration/retention-historical-db.integration.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(harness, /(?:it|test)\.skip|from .*lib\/database|import .*dotenv|recheckAndApplyNewsletterRetentionArchiveBatchForFixture\(/)
    assert.match(harness, /createInternalHistoricalRetentionExecutor\(root\)/)
})
