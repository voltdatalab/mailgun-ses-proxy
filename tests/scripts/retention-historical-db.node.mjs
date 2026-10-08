import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertHistoricalCiTarget, historicalNativeConnectionOptions, runHistoricalCi } from '../../scripts/test-retention-historical-db.mjs'
// Call only the installed driver's session-initialization method: no connection
// constructor, socket, SQL executor, dotenv or integration test import.
const { default: DriverConnection } = await import(new URL('./lib/connection.js', import.meta.resolve('mariadb')).href)
function offlineSessionTimeout(opts, engine) {
    const queries = []
    const receiver = {
        opts: { ...opts, logger: {} },
        info: { isMariaDB: () => engine === 'mariadb', hasMinVersion: () => true },
        query: (command, resolve) => { queries.push(command.sql); resolve() },
    }
    return { completion: DriverConnection.prototype.executeSessionTimeout.call(receiver), queries }
}

test('actual harness MySQL options initialize installed driver offline without unsupported queryTimeout', async () => {
    const options = historicalNativeConnectionOptions(assertHistoricalCiTarget(valid))
    const observed = offlineSessionTimeout(options, 'mysql')
    await observed.completion
    assert.equal(Object.hasOwn(options, 'queryTimeout'), false)
    assert.deepEqual(observed.queries, [])
})
test('actual harness MariaDB options initialize installed driver with ten-second session statement limit offline', async () => {
    const options = historicalNativeConnectionOptions(assertHistoricalCiTarget({ ...valid, RETENTION_HISTORICAL_DB_ENGINE: 'mariadb' }))
    const observed = offlineSessionTimeout(options, 'mariadb')
    await observed.completion
    assert.equal(options.queryTimeout, 10000)
    assert.deepEqual(observed.queries, ['SET max_statement_time=10'])
})
test('both engines retain explicit connection, socket and scalar options', () => {
    for (const engine of ['mysql', 'mariadb']) {
        const target = assertHistoricalCiTarget({ ...valid, RETENTION_HISTORICAL_DB_ENGINE: engine })
        const common = { ...historicalNativeConnectionOptions(target) }
        delete common.queryTimeout
        assert.deepEqual(common, { host: target.host, port: target.port, user: target.user, password: target.password, database: target.database, timezone: 'Z', dateStrings: true, connectTimeout: 5000, socketTimeout: 10000 })
    }
})
test('connection options refuse unsupported engines instead of falling back to MySQL', () => {
    for (const engine of ['unknown', undefined, '', 'MYSQL', ['mysql']]) {
        assert.throws(() => historicalNativeConnectionOptions({ ...assertHistoricalCiTarget(valid), engine }), /unsupported historical DB engine/)
    }
})

const valid = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RETENTION_HISTORICAL_DB_CI: '1', RETENTION_HISTORICAL_DB_ENGINE: 'mysql', DATABASE_URL: 'mysql://ci:ci-password@127.0.0.1:3306/mailgun_ci' }
test('explicit isolated CI target is accepted without any connection', () => {
    assert.deepEqual(assertHistoricalCiTarget(valid), { host: '127.0.0.1', port: 3306, user: 'ci', password: 'ci-password', database: 'mailgun_ci', engine: 'mysql' })
    assert.equal(assertHistoricalCiTarget({ ...valid, RETENTION_HISTORICAL_DB_ENGINE: 'mariadb' }).engine, 'mariadb')
})
for (const [key, value] of [
    ['GITHUB_ACTIONS', undefined], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RETENTION_HISTORICAL_DB_CI', undefined],
    ['RETENTION_HISTORICAL_DB_ENGINE', 'unknown'], ['DATABASE_URL', undefined],
    ...['mysql://ci:ci-password@localhost:3306/mailgun_ci', 'mysql://ci:ci-password@127.0.0.1:3306/production',
        'mysql://root:ci-password@127.0.0.1:3306/mailgun_ci', 'mysql://ci:other@127.0.0.1:3306/mailgun_ci',
        'mysql://ci:ci-password@127.0.0.1:3307/mailgun_ci', 'mysql://ci:ci-password@127.0.0.1:3306/mailgun_ci?ssl=false',
        'mysql://ci:ci-password@127.0.0.1:3306/mailgun_ci#production', 'mysql://ci:ci-password@remote:3306/mailgun_ci']
        .map(value => ['DATABASE_URL', value]),
]) test(`refuses non-isolated target ${key} (${value?.includes('://') ? 'URL variant' : value}) before spawning`, () => {
    let calls = 0
    assert.throws(() => runHistoricalCi({ ...valid, [key]: value }, () => { calls++; return { status: 0 } }), /isolated/)
    assert.equal(calls, 0)
})
test('dedicated entry forwards only explicit synthetic configuration, not host secrets', () => {
    let options
    assert.equal(runHistoricalCi({ ...valid, HOST_SECRET: 'must-not-forward', NODE_OPTIONS: '--require=dotenv/config' }, (_command, args, opts) => {
        if (args.includes('vitest.historical-db.config.ts')) options = opts
        else assert.deepEqual(args, ['scripts/assert-retention-historical-db-report.mjs'])
        return { status: 0 }
    }), 0)
    assert.equal(options.env.HOST_SECRET, undefined)
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.equal(options.env.DATABASE_URL, valid.DATABASE_URL)
    assert.equal(options.killSignal, 'SIGKILL')
    assert.equal(options.timeout, 180000)
})
for (const result of [{ status: 0, error: new Error('timeout') }, { status: 0, signal: 'SIGTERM' }, { status: null }, { status: 1 }]) {
    test('dedicated entry cannot mask child errors or termination', () => assert.equal(runHistoricalCi(valid, () => result), 1))
}
