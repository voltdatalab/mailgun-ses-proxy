import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const HISTORICAL_DB_MODES = ['commit', 'rollback-after-delete', 'precommit-divergence', 'postcommit-failure', 'postcommit-mismatch', 'unsigned', 'gate-refusal', 'commit-unknown']
const keys = ['parents', 'messages', 'errors', 'notifications', 'orphans', 'lateEvents']
const states = ['committed_readback_ok', 'rollback_confirmed', 'rollback_confirmed', 'committed_readback_failed', 'committed_readback_failed', 'refused_before_transaction', 'refused_before_transaction', 'commit_unknown']
const deleted = [4, 1, 0, 4, 4, 0, 0, 4]
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const digest = /^[a-f0-9]{64}$/
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => typeof value === 'string' && digest.test(value)
const attempt = value => typeof value === 'string' && uuid.test(value)
const id = value => Number.isSafeInteger(value) && value > 0
export function assertHistoricalDbReport(report, engine) {
    const refuse = () => { throw new Error('historical real-DB evidence incomplete or inconsistent') }
    if (!['mysql', 'mariadb'].includes(engine) || !record(report) || report.version !== 1 || report.status !== 'passed' || report.stage !== 'complete'
        || report.engine !== engine || report.expectedCases !== HISTORICAL_DB_MODES.length || !Array.isArray(report.cases) || report.cases.length !== HISTORICAL_DB_MODES.length) refuse()
    const observed = report.observed
    if (!record(observed) || observed.database !== 'mailgun_ci' || !id(observed.nativeConnectionId) || observed.transactionalTables !== 5 || observed.allInnoDB !== true
        || !hash(observed.sqlSchemaFingerprint) || !hash(observed.prismaFileFingerprint) || observed.sqlSchemaFingerprint === observed.prismaFileFingerprint
        || typeof observed.serverVersion !== 'string' || (engine === 'mysql' ? !/^8\.0\./.test(observed.serverVersion) || /MariaDB/.test(observed.serverVersion) : !/^11\.4\..*MariaDB/.test(observed.serverVersion))) refuse()
    for (const [index, mode] of HISTORICAL_DB_MODES.entries()) {
        const row = report.cases[index], refused = ['unsigned', 'gate-refusal'].includes(mode), rollback = ['rollback-after-delete', 'precommit-divergence'].includes(mode)
        const committed = !refused && !rollback && mode !== 'commit-unknown'
        if (!record(row) || row.mode !== mode || row.state !== states[index] || row.sqlDeletedRows !== deleted[index] || row.preservedUnrelated !== true || row.cleanupVerified !== true
            || !hash(row.beforeSha256) || !hash(row.afterSha256) || !id(row.nativeConnectionId) || row.nativeConnectionId !== observed.nativeConnectionId || row.postcommitReads !== (committed ? 1 : 0)) refuse()
        if (refused) { if (row.attemptId !== null || row.transactionConnectionId !== null) refuse() }
        else if (!attempt(row.attemptId) || !id(row.transactionConnectionId) || row.transactionConnectionId === row.nativeConnectionId || row.isolation !== 'SERIALIZABLE') refuse()
        if (rollback) { if (!attempt(row.rollbackAttemptId) || row.rollbackAttemptId !== row.attemptId) refuse() }
        else if (row.rollbackAttemptId !== null) refuse()
        if ((row.beforeSha256 === row.afterSha256) !== (rollback || refused)) refuse()
        const expectedCounts = { parents: rollback || refused || mode === 'postcommit-mismatch' ? 1 : 0, messages: rollback || refused ? 1 : 0, errors: rollback || refused ? 1 : 0, notifications: rollback || refused ? 1 : 0, orphans: 0, lateEvents: 0 }
        if (!record(row.remaining) || Object.keys(row.remaining).length !== keys.length || keys.some(key => row.remaining[key] !== expectedCounts[key])) refuse()
        if (committed) {
            if (!record(row.committedNativeObservation) || Object.keys(row.committedNativeObservation).length !== keys.length || keys.some(key => row.committedNativeObservation[key] !== 0)) refuse()
        } else if (row.committedNativeObservation !== null) refuse()
    }
    return report
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    assertHistoricalDbReport(JSON.parse(await readFile('artifacts/retention-historical-db-report.json', 'utf8')), process.env.RETENTION_HISTORICAL_DB_ENGINE)
}
