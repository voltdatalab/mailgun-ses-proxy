import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

// Accidental-use guard, not authentication of hostile hosted PR code. No dotenv.
export function assertHistoricalCiTarget(env) {
    if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
        || env.RETENTION_HISTORICAL_DB_CI !== '1' || !['mysql', 'mariadb'].includes(env.RETENTION_HISTORICAL_DB_ENGINE)
        || env.DATABASE_URL !== 'mysql://ci:ci-password@127.0.0.1:3306/mailgun_ci') {
        throw new Error('historical DB integration requires the explicit isolated hosted CI target')
    }
    return { host: '127.0.0.1', port: 3306, user: 'ci', password: 'ci-password', database: 'mailgun_ci', engine: env.RETENTION_HISTORICAL_DB_ENGINE }
}
export function historicalNativeConnectionOptions(target) {
    if (!['mysql', 'mariadb'].includes(target.engine)) throw new Error('unsupported historical DB engine')
    return {
        host: target.host, port: target.port, user: target.user, password: target.password, database: target.database,
        timezone: 'Z', dateStrings: true, connectTimeout: 5000, socketTimeout: 10000,
        // Global queryTimeout initializes MariaDB max_statement_time; MySQL
        // rejects it before startup. Socket deadlines apply to both engines.
        ...(target.engine === 'mariadb' ? { queryTimeout: 10000 } : {}),
    }
}
export function runHistoricalCi(env = process.env, spawn = spawnSync) {
    assertHistoricalCiTarget(env)
    const result = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.historical-db.config.ts'], {
        stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL', env: {
            PATH: '/usr/bin:/bin', NODE_ENV: 'test', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
            RETENTION_HISTORICAL_DB_CI: '1', RETENTION_HISTORICAL_DB_ENGINE: env.RETENTION_HISTORICAL_DB_ENGINE,
            DATABASE_URL: env.DATABASE_URL,
        },
    })
    const gate = spawn(process.execPath, ['scripts/assert-retention-historical-db-report.mjs'], {
        stdio: 'inherit', timeout: 10000, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', RETENTION_HISTORICAL_DB_ENGINE: env.RETENTION_HISTORICAL_DB_ENGINE },
    })
    return result.error || result.signal || result.status !== 0 || gate.error || gate.signal || gate.status !== 0 ? 1 : 0
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // Overwrite stale success before startup: import/connect/timeout failures leave
    // failed evidence, never a previous run's successful report.
    await mkdir('artifacts', { recursive: true })
    await writeFile('artifacts/retention-historical-db-report.json', `${JSON.stringify({ version: 1, status: 'failed', stage: 'startup', engine: process.env.RETENTION_HISTORICAL_DB_ENGINE ?? null, expectedCases: 8, cases: [] })}\n`)
    process.exitCode = runHistoricalCi()
}
