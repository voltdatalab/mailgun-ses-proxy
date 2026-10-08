import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtemp, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { run, runDatabaseCoverage } from '../../scripts/test-ci-db.mjs'
import { runSafeNamespace } from '../../scripts/retention-safe-subprocess.mjs'

test('actual unshare fork timeout is bounded and kills its child', async () => {
    assert.ok(process.env.TMPDIR, 'TMPDIR required')
    const dir = await mkdtemp(join(process.env.TMPDIR, 'retention-timeout-'))
    const marker = join(dir, 'child-survived')
    const startedMarker = join(dir, 'child-started')
    try {
        const started = performance.now()
        const result = runSafeNamespace(['--fork', '--kill-child', process.execPath, '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1000)`],
            { timeout: 200, encoding: 'utf8' })
        const elapsed = performance.now() - started
        console.log(JSON.stringify({ elapsed, status: result.status, signal: result.signal, error: result.error?.code }))
        assert.equal(result.error?.code, 'ETIMEDOUT')
        assert.equal(result.signal, 'SIGKILL')
        assert.ok(elapsed < 700, `timeout returned after ${elapsed}ms`)
        await access(startedMarker) // Prove a real child ran, not only a failed launch.
        await setTimeout(1200)
        await assert.rejects(access(marker), { code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
})

test('connected DB run deadline forcibly terminates a real SIGTERM-ignoring direct child', async () => {
    assert.ok(process.env.TMPDIR, 'TMPDIR required')
    const dir = await mkdtemp(join(process.env.TMPDIR, 'retention-db-timeout-'))
    const startedMarker = join(dir, 'child-started')
    const marker = join(dir, 'child-completed')
    try {
        let result
        const started = performance.now()
        const status = run(process.execPath, ['-e',
            `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started'); setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed'); process.exit(0) }, 1000)`],
            process.env, (command, args, options) => {
                assert.equal(options.timeout, 600_000)
                // Exercise the production run; the seam changes ONLY the time budget.
                result = spawnSync(command, args, { ...options, timeout: 200 })
                return result
            })
        const elapsed = performance.now() - started
        console.log(JSON.stringify({ runner: 'DB direct child', elapsed, status: result.status, signal: result.signal, error: result.error?.code, wrapperStatus: status }))
        await access(startedMarker) // The SIGTERM handler was installed before this marker.
        assert.equal(result.error?.code, 'ETIMEDOUT')
        assert.equal(status, 1, 'timeout must fail closed even with status 0')
        assert.ok(elapsed < 700, `timeout returned after ${elapsed}ms`)
        assert.equal(result.signal, 'SIGKILL')
        assert.equal(result.status, null)
        await setTimeout(1200)
        await assert.rejects(access(marker), { code: 'ENOENT' })
    } finally { await rm(dir, { recursive: true, force: true }) }
})

for (const failure of [
    { status: 0, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    { status: 0, signal: 'SIGTERM' },
    { status: null, signal: 'SIGKILL' },
    { status: 2 },
]) {
    for (let phase = 0; phase < 6; phase++) {
        test(`connected DB orchestration rejects phase ${phase}: ${failure.error?.code ?? failure.signal ?? failure.status}`, () => {
            let calls = 0
            const status = runDatabaseCoverage((command, args, env) => run(command, args, env, () => calls++ === phase ? failure : { status: 0 }))
            assert.equal(calls, 6, 'all phases remain diagnostic and mandatory')
            assert.equal(status, 1)
        })
    }
}
test('connected DB orchestration succeeds only when all six phases succeed', () => {
    const commands = []
    assert.equal(runDatabaseCoverage((command, args, env) => run(command, args, env, () => { commands.push([command, args]); return { status: 0 } })), 0)
    assert.equal(commands.length, 6)
    assert.equal(commands[5][1][0], 'scripts/test-retention-historical-db.mjs')
    assert.equal(commands[0][1][0], 'node_modules/vitest/vitest.mjs')
    assert.equal(commands[1][0], 'sudo')
    assert.ok(commands[1][1].includes('--ci-multi-uid'))
    assert.equal(commands[4][1][0], 'scripts/assert-vitest-report.mjs')
})
