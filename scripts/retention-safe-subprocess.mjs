import { spawnSync } from 'node:child_process'

// unshare --fork ignores SIGTERM while waiting. SIGKILL makes timeout effective
// and triggers --kill-child; PID namespace teardown then kills descendants.
// Shared by the real fixture entry point and the bounded-process regression.
export function runSafeNamespace(args, options = {}) {
    const { launcher = 'unshare', ...spawnOptions } = options
    return spawnSync(launcher, args, { timeout: 300_000, ...spawnOptions, killSignal: 'SIGKILL' })
}
