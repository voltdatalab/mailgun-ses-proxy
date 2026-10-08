// Linux-only offline synthetic chroot in private user/mount/net/PID namespaces.
// Default is unprivileged one-UID; explicit hosted CI bootstrap maps only UID/GID 0+1.
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runSafeNamespace } from './retention-safe-subprocess.mjs'
import { validateSafeRunnerMode } from './retention-safe-runner-policy.mjs'
const args = process.argv.slice(2)
const multiUid = args[0] === '--ci-multi-uid'
if (multiUid) args.shift()
let reportPath
if (args[0] === '--report-file') {
    args.shift()
    reportPath = resolve(args.shift() ?? '')
    // Privileged bootstrap may export only a new, fixed CI artifact, never overwrite.
    if (reportPath !== resolve('artifacts/vitest-safe-report.json')) throw new Error('report must be artifacts/vitest-safe-report.json')
}
const userArgs = validateSafeRunnerMode({ multiUid, uid: process.getuid(), githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT })
if (!process.env.TMPDIR) throw new Error('TMPDIR required; no system-temp fallback')
const fixture = await mkdtemp(join(process.env.TMPDIR, 'ses-safe-'))
await chmod(fixture, 0o700)
let copiedBytes = 0, copiedFiles = 0, copiedDirectories = 0
async function copyBounded(source, target, depth = 0) {
    if (depth > 64) throw new Error('safe fixture depth budget exceeded')
    const info = await lstat(source)
    if (info.isDirectory()) {
        if (++copiedDirectories > 25_000) throw new Error('safe fixture directory budget exceeded')
        await mkdir(target, { recursive: true, mode: 0o700 })
        for (const name of await readdir(source)) await copyBounded(join(source, name), join(target, name), depth + 1)
    } else {
        // Resolve only explicitly selected package roots and loader libraries;
        // never follow links/special files nested in a source snapshot.
        if (!info.isFile()) throw new Error(`non-regular fixture source: ${source}`)
        copiedFiles++; copiedBytes += info.size
        if (copiedFiles > 25_000 || copiedBytes > 512 * 1024 * 1024) throw new Error('safe fixture copy budget exceeded')
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copyFile(source, target)
    }
}
async function copyAbsolute(path) {
    await copyBounded(await realpath(path), join(fixture, path))
}
try {
    const modules = await realpath('node_modules'), seen = new Set()
    async function copyPackage(name) {
        if (seen.has(name)) return
        seen.add(name)
        const source = join(modules, name)
        let pkg
        try { pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) }
        catch (error) { if (error.code === 'ENOENT') return; throw error }
        await mkdir(dirname(join(fixture, 'repo/node_modules', name)), { recursive: true, mode: 0o700 })
        await copyBounded(await realpath(source), join(fixture, 'repo/node_modules', name))
        for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) await copyPackage(dependency)
    }
    await copyPackage('vitest')
    // Exact local synthetic test/source snapshot, no .env, evidence, git or DB data.
    for (const path of ['service', 'lib/database.ts', 'tests/service', 'tests/setup.ts', 'vitest.config.ts', 'tsconfig.json', 'package.json', 'scripts/merge-retention-vitest-reports.mjs', 'scripts/retention-safe-runner-policy.mjs']) {
        await mkdir(dirname(join(fixture, 'repo', path)), { recursive: true, mode: 0o700 })
        await copyBounded(path, join(fixture, 'repo', path))
    }
    await copyBounded(await realpath(process.execPath), join(fixture, 'node'))
    // Preserve repository cwd for tests that read package metadata. The database
    // source above is copied only for vi.mock resolution; no generated client/env.
    await writeFile(join(fixture, 'repo/run-vitest.mjs'), 'process.chdir("/repo"); await import("./node_modules/vitest/vitest.mjs")\n')
    // Existing legacy publisher, compiled ONLY into the disposable scratch chroot.
    // No production install/capability grant and no weakened file guards.
    const helper = join(fixture, 'repo/scripts/newsletter-retention-linkat')
    await mkdir(dirname(helper), { recursive: true, mode: 0o700 })
    const build = spawnSync(process.env.CC ?? 'cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'scripts/newsletter-retention-linkat.c', '-o', helper], { encoding: 'utf8' })
    if (build.status !== 0) throw new Error(`offline legacy fixture helper build failed: ${build.stderr}`)
    const helperLibraries = spawnSync('ldd', [helper], { encoding: 'utf8' })
    if (helperLibraries.status !== 0) throw new Error('legacy fixture helper library discovery failed')
    for (const path of new Set(helperLibraries.stdout.match(/\/[^\s()]+/g))) await copyAbsolute(path)
    const libs = spawnSync('ldd', [process.execPath], { encoding: 'utf8' })
    if (libs.status !== 0) throw new Error('node shared-library discovery failed')
    for (const path of new Set(libs.stdout.match(/\/[^\s()]+/g))) await copyAbsolute(path)
    async function copyNativeLibraries(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name)
            if (entry.isDirectory()) await copyNativeLibraries(path)
            else if (entry.name.endsWith('.node')) {
                const result = spawnSync('ldd', [path], { encoding: 'utf8' })
                if (result.status === 0) for (const library of new Set(result.stdout.match(/\/[^\s()]+/g))) await copyAbsolute(library)
            }
        }
    }
    await copyNativeLibraries(join(fixture, 'repo/node_modules'))
    for (const path of ['fixtures', 'scratch', 'proc', 'dev']) await mkdir(join(fixture, path), { mode: 0o700 })
    // /dev/null is a synthetic regular file: no host device bind mount.
    await writeFile(join(fixture, 'dev/null'), '')
    // Probe inside the same chroot/namespaces as Vitest, not a mocked chown.
    await writeFile(join(fixture, 'repo/probe-owner.mjs'), `
import { writeFile, chown, stat, readFile, unlink } from 'node:fs/promises';
const path = '/fixtures/foreign-owner-probe';
await writeFile(path, 'synthetic probe', { mode: 0o400 });
try {
  await chown(path, 1, 1);
  const owner = await stat(path);
  if (owner.uid !== 1 || owner.gid !== 1 || process.getuid() !== 0) throw new Error('foreign owner probe failed');
  const uidMap = await readFile('/proc/self/uid_map', 'utf8');
  const gidMap = await readFile('/proc/self/gid_map', 'utf8');
  await writeFile('/repo/owner-probe.json', JSON.stringify({ foreignOwner: { uid: owner.uid, gid: owner.gid }, uidMap, gidMap, isolated: true }));
} finally { await unlink(path); }
`)
    const command = 'ulimit -t 240; ulimit -f 1048576; mount -t proc proc "$1/proc" && root="$1" && shift && exec chroot "$root" /node /repo/run-vitest.mjs run --root /repo --maxWorkers 2 "$@"'
    // Probe is mandatory in hosted CI. Local one-UID runs still execute every
    // selected test, honestly failing foreign ownership instead of skipping it.
    await writeFile(join(fixture, 'repo/run-vitest.mjs'), `process.chdir('/repo'); try { await import('./probe-owner.mjs') } catch (error) { if (${multiUid}) throw error; console.error('foreign-owner capability unavailable:', error.message) }; await import('./node_modules/vitest/vitest.mjs');\n`)
    const reportArgs = reportPath ? ['--reporter=json', '--outputFile=/repo/vitest-safe-report.json'] : []
    const result = runSafeNamespace([...userArgs, '--mount', '--net', '--pid', '--fork', '--kill-child', 'sh', '-c', command,
        'sh', resolve(fixture), ...args, ...reportArgs], { stdio: 'inherit', timeout: 300_000,
        env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_OPTIONS: '--max-old-space-size=512', TMPDIR: '/scratch', RETENTION_SAFE_FIXTURE_ROOT: '/fixtures' } })
    if (reportPath) {
        if (await realpath(dirname(reportPath)) !== dirname(reportPath)) throw new Error('artifact parent must not be a symlink')
        try {
            const report = JSON.parse(await readFile(join(fixture, 'repo/vitest-safe-report.json'), 'utf8'))
            let probe
            try { probe = JSON.parse(await readFile(join(fixture, 'repo/owner-probe.json'), 'utf8')) } catch { probe = { isolated: true, foreignOwner: null } }
            report.retentionSafeRunner = { ...probe, exitCode: result.error || result.signal ? 1 : result.status ?? 1 }
            await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o644 })
        } catch (error) { if (error.code !== 'ENOENT') throw error; console.error('safe runner produced no report') }
    }
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
} finally { await rm(fixture, { recursive: true, force: true }) }
