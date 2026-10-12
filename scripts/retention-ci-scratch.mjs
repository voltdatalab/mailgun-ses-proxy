// Dedicated ephemeral hosted scratch; never mutate an existing ancestor.
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run } from './test-ci-db.mjs'
import { validateSafeRunnerMode } from './retention-safe-runner-policy.mjs'

export async function assertMappedScratchAncestry(path, stat = lstat) {
    if (!isAbsolute(path)) throw new Error('mapped scratch ancestry requires an absolute path')
    for (;;) {
        const info = await stat(path)
        // Deliberately conservative: all ancestry is owned by mapped root and
        // searchable by it. Child-userns CAP_DAC_OVERRIDE cannot rescue unmapped
        // host owners; relative entry paths alone would not fix mount/chroot.
        if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || !(info.mode & 0o100) || (info.mode & 0o022)) {
            throw new Error(`mapped scratch ancestry requires root-owned searchable directories: ${path}`)
        }
        const parent = dirname(path)
        if (parent === path) return
        path = parent
    }
}
export async function runPrivateCiScratch(launch, operations = { mkdtemp, lstat, rm }) {
    // /run is not a world-writable fallback and no existing directory is changed.
    // mkdtemp creates only our new 0700 allocation; TMPDIR remains explicit.
    const scratch = await operations.mkdtemp('/run/ses-retention-ci-')
    try {
        await assertMappedScratchAncestry(scratch, operations.lstat)
        return await launch(scratch)
    } finally { await operations.rm(scratch, { recursive: true, force: true }) }
}
export function runPrivateCiSafeRunner(scratch, args, runChild = run) {
    // chroot is a system sbin tool. Keep lookup explicit; never inherit ambient PATH.
    return runChild(process.execPath, [
        'scripts/test-newsletter-retention-safe-filesystem.mjs', ...args,
    ], { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TMPDIR: scratch, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validateSafeRunnerMode({ multiUid: true, uid: process.getuid(), githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT })
    process.exitCode = await runPrivateCiScratch(scratch => runPrivateCiSafeRunner(scratch, process.argv.slice(2)))
}
