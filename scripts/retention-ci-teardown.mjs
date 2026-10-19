import { copyFile, mkdir, readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { runSafeNamespace } from './retention-safe-subprocess.mjs'
import { validateSafeRunnerMode } from './retention-safe-runner-policy.mjs'
import { validateTeardownStartup } from './retention-ci-teardown-validation.mjs'
export function validateTeardownEvidence({ result, elapsed, started, completed, remaining }) {
    validateTeardownStartup(started)
    if (result.error?.code !== 'ETIMEDOUT' || result.signal !== 'SIGKILL' || result.status !== null) throw new Error('teardown probe: expected SIGKILL timeout, not success/kill error')
    if (!Number.isFinite(elapsed) || elapsed < 850 || elapsed > 1500) throw new Error('teardown probe: launcher exceeded deadline budget')
    if (completed) throw new Error('teardown probe: delayed completion occurred')
    if (!Array.isArray(remaining) || remaining.length) throw new Error('teardown probe: descendants did not disappear')
    return { version: 1, verified: true, timeoutMs: 900, elapsedMs: Math.round(elapsed), started, descendantsGone: true }
}
async function exists(path) {
    try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function sameIdentity(identity) {
    try {
        const text = await readFile(`/proc/${identity.pid}/stat`, 'utf8')
        const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
        // Zombies still occupy this identity: require disappearance, not merely death.
        return fields[19] === identity.startTime
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error }
}
export async function probeBootstrapTeardown({ launcher, fixture }) {
    validateSafeRunnerMode({ multiUid: true, uid: process.getuid(), githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT })
    const scratch = join(fixture, 'teardown')
    await mkdir(scratch, { mode: 0o700 })
    const leaf = join(scratch, 'leaf.mjs')
    await copyFile(resolve('scripts/retention-ci-teardown-leaf.mjs'), leaf)
    const begin = performance.now()
    const result = runSafeNamespace(['--ci-multi-uid', process.execPath, leaf, 'leaf'], {
        launcher, cwd: scratch, stdio: 'inherit', timeout: 900,
        env: { PATH: '/usr/bin:/bin', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' },
    })
    const elapsed = performance.now() - begin
    let started
    try { started = JSON.parse(await readFile(join(scratch, 'started.json'), 'utf8')) }
    catch (error) { throw new Error('teardown probe: startup missing/invalid', { cause: error }) }
    validateTeardownStartup(started)
    // Fixed <= 3-second observer budget; no kill(), process-group or arbitrary
    // host signals. Only spawnSync signals its own newly spawned C launcher.
    let remaining = []
    const deadline = performance.now() + 3000
    do {
        remaining = []
        for (const identity of [started.leaf, started.descendant]) {
            if (await sameIdentity(identity)) remaining.push(identity.pid)
        }
        if (!remaining.length && performance.now() - begin >= 2200) break
        await delay(50)
    } while (performance.now() < deadline)
    const completed = await exists(join(scratch, 'leaf-completed')) || await exists(join(scratch, 'descendant-completed'))
    return validateTeardownEvidence({ result, elapsed, started, completed, remaining })
}
