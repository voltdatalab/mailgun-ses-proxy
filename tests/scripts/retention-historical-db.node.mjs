import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { serializeHistoricalCatalogRows } from '../../scripts/retention-historical-catalog.mjs'

// Synthetic native-shaped rows: offline serialization, never SQL evidence.
const catalogRow = ordinal => ({ TABLE_NAME: 'NewsletterBatch', COLUMN_NAME: 'id', ORDINAL_POSITION: ordinal, COLUMN_TYPE: 'varchar(191)', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', EXTRA: '' })
const digest = text => createHash('sha256').update(text).digest('hex')
test('catalog numeric MySQL JSON bytes remain unchanged, including empty scalar strings', () => {
    const rows = [catalogRow(1), { ...catalogRow(2), COLUMN_NAME: 'contents', COLUMN_TYPE: 'longtext', COLUMN_KEY: '' }]
    rows.meta = ['synthetic driver metadata not catalog rows']
    assert.equal(serializeHistoricalCatalogRows(rows), JSON.stringify(Array.from(rows)))
})
test('catalog MariaDB BigInt ordinals serialize identically to matching MySQL numbers without mutating native rows', () => {
    const mysql = [catalogRow(1), { ...catalogRow(2), COLUMN_NAME: 'contents' }]
    const maria = mysql.map(row => Object.freeze({ ...row, ORDINAL_POSITION: BigInt(row.ORDINAL_POSITION) }))
    assert.throws(() => JSON.stringify(Array.from(maria)), /BigInt/)
    const actual = serializeHistoricalCatalogRows(Object.freeze(maria))
    assert.equal(actual, JSON.stringify(mysql))
    assert.equal(digest(actual), digest(serializeHistoricalCatalogRows(mysql)))
    assert.equal(typeof maria[0].ORDINAL_POSITION, 'bigint')
    assert.equal(BigInt.prototype.toJSON, undefined)
})
test('catalog positive safe ordinal boundaries are exact for both representations', () => {
    for (const ordinal of [1, Number.MAX_SAFE_INTEGER]) {
        assert.equal(serializeHistoricalCatalogRows([catalogRow(BigInt(ordinal))]), serializeHistoricalCatalogRows([catalogRow(ordinal)]))
    }
})
test('catalog preserves actual row order and all seven fields in the fingerprint', () => {
    const rows = [catalogRow(1), { ...catalogRow(2), COLUMN_NAME: 'contents' }]
    const baseline = digest(serializeHistoricalCatalogRows(rows))
    assert.notEqual(digest(serializeHistoricalCatalogRows([...rows].reverse())), baseline)
    for (const key of Object.keys(rows[0])) {
        const changed = { ...rows[0], [key]: key === 'ORDINAL_POSITION' ? 3 : `${rows[0][key]}-different` }
        assert.notEqual(digest(serializeHistoricalCatalogRows([changed, rows[1]])), baseline, key)
    }
    const reorderedKeys = Object.fromEntries(Object.entries(rows[0]).reverse())
    assert.equal(serializeHistoricalCatalogRows([reorderedKeys]), serializeHistoricalCatalogRows([rows[0]]))
})
test('catalog refuses unsafe, nonpositive, fractional and coercible ordinals before serialization', () => {
    for (const ordinal of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2n ** 100n, '1', '', true, false, null, undefined, [1], [[1]], {}, new Number(1)]) {
        assert.throws(() => serializeHistoricalCatalogRows([catalogRow(ordinal)]), /catalog/, typeof ordinal)
    }
})
test('catalog refuses coercible or non-string values in each scalar string field', () => {
    for (const key of Object.keys(catalogRow(1)).filter(key => key !== 'ORDINAL_POSITION')) {
        for (const value of [null, undefined, 1, 1n, true, [], ['NO'], {}, new String('NO')]) {
            assert.throws(() => serializeHistoricalCatalogRows([{ ...catalogRow(1), [key]: value }]), /catalog/, key)
        }
    }
})
test('catalog requires a nonempty native row array and exact own data fields on scalar records', () => {
    for (const rows of [null, undefined, {}, 'rows', new Set([catalogRow(1)]), [], Array(1)]) {
        assert.throws(() => serializeHistoricalCatalogRows(rows), /catalog/)
    }
    const missing = catalogRow(1); delete missing.EXTRA
    const inherited = Object.create(catalogRow(1))
    const accessor = catalogRow(1); Object.defineProperty(accessor, 'EXTRA', { get() { throw new Error('getter must not run') } })
    const symbol = { ...catalogRow(1), [Symbol('extra')]: 'hidden' }
    for (const row of [null, undefined, [], Object.values(catalogRow(1)), 'row', 1, missing, inherited, accessor, symbol, { ...catalogRow(1), extra: '' }, { ...catalogRow(1), toJSON: () => catalogRow(1) }]) {
        assert.throws(() => serializeHistoricalCatalogRows([row]), /catalog/)
    }
    assert.equal(serializeHistoricalCatalogRows([Object.assign(Object.create(null), catalogRow(1))]), serializeHistoricalCatalogRows([catalogRow(1)]))
})
test('real catalogFingerprint hashes pure serializer output from the unchanged ordered native SQL query', async () => {
    const source = await readFile(new URL('../integration/retention-historical-db.integration.ts', import.meta.url), 'utf8')
    assert.match(source, /import \{ serializeHistoricalCatalogRows \} from '..\/..\/scripts\/retention-historical-catalog\.mjs'/)
    assert.match(source, /async function catalogFingerprint\(native: Connection\) \{\s*const rows = await native\.query\('SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME IN \(\?, \?, \?, \?, \?\) ORDER BY TABLE_NAME, ORDINAL_POSITION', \[\.\.\.TABLES\]\)\s*assert\.ok\(rows\.length > 0\)\s*return hash\(serializeHistoricalCatalogRows\(rows\)\)/)
})
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
