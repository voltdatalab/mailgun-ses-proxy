// Linux-only, offline synthetic chroot in unprivileged user/mount/net/PID namespaces.
// Only newly allocated $TMPDIR tree + isolated procfs; no Docker or production mounts.
import { chmod, cp, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
if (!process.env.TMPDIR) throw new Error('TMPDIR required; no system-temp fallback')
const fixture = await mkdtemp(join(process.env.TMPDIR, 'ses-safe-'))
await chmod(fixture, 0o700)
async function copyAbsolute(path) {
    const target = join(fixture, path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(await realpath(path), target)
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
        await cp(source, join(fixture, 'repo/node_modules', name), { recursive: true, dereference: true })
        for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) await copyPackage(dependency)
    }
    await copyPackage('vitest')
    // Exact local synthetic test/source snapshot, no .env, evidence, git or DB data.
    for (const path of ['service', 'lib/database.ts', 'tests/service', 'tests/setup.ts', 'vitest.config.ts', 'tsconfig.json', 'package.json']) {
        await mkdir(dirname(join(fixture, 'repo', path)), { recursive: true, mode: 0o700 })
        await cp(path, join(fixture, 'repo', path), { recursive: true, dereference: true })
    }
    await copyFile(process.execPath, join(fixture, 'node'))
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
    const result = spawnSync('unshare', ['--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', 'sh', '-c',
        'ulimit -t 240; ulimit -f 1048576; mount -t proc proc "$1/proc" && root="$1" && shift && exec chroot "$root" /node /repo/run-vitest.mjs run --root /repo --maxWorkers 2 "$@"',
        'sh', resolve(fixture), ...process.argv.slice(2)], { stdio: 'inherit', timeout: 300_000,
        env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_OPTIONS: '--max-old-space-size=512', TMPDIR: '/scratch', RETENTION_SAFE_FIXTURE_ROOT: '/fixtures' } })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
} finally { await rm(fixture, { recursive: true, force: true }) }
