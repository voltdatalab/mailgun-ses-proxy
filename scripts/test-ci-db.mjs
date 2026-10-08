import { mkdir, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function run(command, args, env = process.env, spawn = spawnSync) {
    // Bound direct-child termination even if it ignores SIGTERM; not a process-tree kill.
    const result = spawn(command, args, { stdio: 'inherit', env, timeout: 600_000, killSignal: 'SIGKILL' })
    if (result.error) console.error(result.error)
    // spawnSync can report ETIMEDOUT together with status 0. Never mask it.
    return result.error || result.signal ? 1 : result.status ?? 1
}
export function runDatabaseCoverage(runPhase = run) {
    const dbStatus = runPhase(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile=artifacts/vitest-db-report.json'], { ...process.env, runPrismaTests: 'true' })
    // This is the only privileged bootstrap, only in ephemeral hosted CI. Tests run
    // after chroot in a private offline user namespace with exactly UID/GID 0 and 1.
    // No Docker, host mounts, sysctl changes, ancestor chmod or production payloads.
    const safeStatus = runPhase('sudo', ['-n', 'env', '-i', 'PATH=/usr/bin:/bin', 'GITHUB_ACTIONS=true', 'RUNNER_ENVIRONMENT=github-hosted',
        process.execPath, 'scripts/retention-ci-scratch.mjs', '--ci-multi-uid', '--report-file', 'artifacts/vitest-safe-report.json',
        'tests/service/newsletter-retention-operational-filesystem.test.ts', 'tests/service/newsletter-retention-historical-preparation.test.ts'])
    const safeGate = runPhase(process.execPath, ['scripts/assert-vitest-report.mjs', 'artifacts/vitest-safe-report.json'])
    const mergeStatus = runPhase(process.execPath, ['scripts/merge-retention-vitest-reports.mjs', 'artifacts/vitest-db-report.json', 'artifacts/vitest-safe-report.json', 'artifacts/vitest-report.json'])
    const finalGate = runPhase(process.execPath, ['scripts/assert-vitest-report.mjs', 'artifacts/vitest-report.json'])
    // Separate mandatory real-DB executor phase, never merged into skip reconciliation.
    const historicalStatus = runPhase(process.execPath, ['scripts/test-retention-historical-db.mjs'])
    return dbStatus || safeStatus || safeGate || mergeStatus || finalGate || historicalStatus ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // Required DB jobs keep the entire ordinary suite. Only exact safe-only pending
    // identities may be reconciled against a second, offline real-filesystem run.
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('required DB coverage requires an ephemeral GitHub-hosted runner')
    await mkdir('artifacts', { recursive: true })
    for (const name of ['vitest-db-report.json', 'vitest-safe-report.json', 'vitest-report.json', 'retention-historical-db-report.json']) await rm(`artifacts/${name}`, { force: true })
    process.exitCode = runDatabaseCoverage()
}
