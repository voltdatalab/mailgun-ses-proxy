import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { validateTeardownEvidence, probeBootstrapTeardown } from '../../scripts/retention-ci-teardown.mjs'
import { syntheticStartup, malformedStartupCases } from '../service/retention-teardown-fixtures.mjs'

test('local guard refuses hosted probe before filesystem or launcher access', async () => {
    // Explicit invalid hosted identity; even local UID 0 must refuse this env.
    const previous = process.env.GITHUB_ACTIONS
    delete process.env.GITHUB_ACTIONS
    try { await assert.rejects(probeBootstrapTeardown({ launcher: '/does-not-exist', fixture: '/does-not-exist' }), /hosted/) }
    finally { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous }
})
test('actual fixed leaf records own host identities and self-expires (not hosted proof)', async () => {
    assert.ok(process.env.TMPDIR)
    const scratch = await mkdtemp(join(process.env.TMPDIR, 'teardown-leaf-unit-'))
    try {
        const leaf = join(scratch, 'leaf.mjs')
        await copyFile(resolve('scripts/retention-ci-teardown-leaf.mjs'), leaf)
        const result = spawnSync(process.execPath, [leaf, 'leaf'], { cwd: scratch, stdio: 'inherit', timeout: 3500, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin' } })
        assert.equal(result.error, undefined)
        assert.equal(result.status, 0)
        const started = JSON.parse(await readFile(join(scratch, 'started.json'), 'utf8'))
        assert.equal(started.leaf.pid, result.pid)
        assert.equal(started.leaf.ppid, process.pid)
        assert.equal(started.descendant.ppid, started.leaf.pid)
        assert.match(started.leaf.startTime, /^\d+$/)
        assert.match(started.descendant.startTime, /^\d+$/)
        assert.equal(started.leaf.nspid[0], result.pid)
        assert.equal(started.descendant.nspid[0], started.descendant.pid)
        assert.equal(started.leaf.uid, process.getuid())
        assert.equal(await readFile(join(scratch, 'leaf-completed'), 'utf8'), 'unexpected completion')
        assert.equal(await readFile(join(scratch, 'descendant-completed'), 'utf8'), 'unexpected completion')
    } finally { await rm(scratch, { recursive: true, force: true }) }
})
test('static consuming entry point requires actual probe before Vitest and exports its result', async () => {
    const source = await readFile('scripts/test-newsletter-retention-safe-filesystem.mjs', 'utf8')
    assert.match(source, /const bootstrapTeardown = multiUid \? await probeBootstrapTeardown\(\{ launcher, fixture \}\) : null/)
    assert.ok(source.indexOf('await probeBootstrapTeardown') < source.indexOf('const result = runSafeNamespace'))
    assert.match(source, /report\.retentionSafeRunner = \{ \.\.\.probe, bootstrapTeardown, exitCode:/)
})
// Synthetic validator fixtures only; never kernel/hosted certification.
function evidence() {
    return { result: { error: { code: 'ETIMEDOUT' }, signal: 'SIGKILL', status: null }, elapsed: 910,
        started: syntheticStartup(),
        completed: false, remaining: [] }
}
test('synthetic complete teardown evidence validates', () => assert.equal(validateTeardownEvidence(evidence()).verified, true))
for (const [name, mutate] of malformedStartupCases) {
    test(`synthetic producer rejects malformed startup ${name}`, () => {
        const input = evidence()
        input.started = mutate(syntheticStartup())
        if (name === 'missing') Reflect.deleteProperty(input, 'started')
        assert.throws(() => validateTeardownEvidence(input), /teardown probe/)
    })
}
for (const mode of ['startup-missing', 'bad-identity', 'bad-parent', 'bad-map', 'no-pidns', 'kill-error', 'status-zero', 'wrong-signal', 'completion', 'still-alive', 'over-budget']) {
    test(`synthetic teardown refuses ${mode}`, () => {
        const input = evidence()
        if (mode === 'startup-missing') input.started = null
        if (mode === 'bad-identity') input.started.leaf.startTime = ''
        if (mode === 'bad-parent') input.started.descendant.ppid = 999
        if (mode === 'bad-map') input.started.leaf.uidMap = '0 0 1'
        if (mode === 'no-pidns') input.started.leaf.nspid = [101]
        if (mode === 'kill-error') input.result.error.code = 'EPERM'
        if (mode === 'status-zero') input.result.status = 0
        if (mode === 'wrong-signal') input.result.signal = 'SIGTERM'
        if (mode === 'completion') input.completed = true
        if (mode === 'still-alive') input.remaining = [101]
        if (mode === 'over-budget') input.elapsed = 1600
        assert.throws(() => validateTeardownEvidence(input))
    })
}
