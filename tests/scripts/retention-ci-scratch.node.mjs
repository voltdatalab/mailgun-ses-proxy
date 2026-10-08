import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, lstat, rm, mkdir, writeFile, chmod, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { runPrivateCiScratch, runPrivateCiSafeRunner, assertMappedScratchAncestry } from '../../scripts/retention-ci-scratch.mjs'
import { runDatabaseCoverage } from '../../scripts/test-ci-db.mjs'

test('actual allocator safe caller uses only curated system PATH and explicit environment', async () => {
    const args = ['--ci-multi-uid', '--report-file', 'artifacts/vitest-safe-report.json', 'tests/service/newsletter-retention-ci-reports.test.ts']
    assert.equal(runPrivateCiSafeRunner('/run/ses-retention-ci-own', args, (command, forwarded, env) => {
        assert.equal(command, process.execPath)
        assert.deepEqual(forwarded, ['scripts/test-newsletter-retention-safe-filesystem.mjs', ...args])
        assert.deepEqual(env, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', TMPDIR: '/run/ses-retention-ci-own', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' })
        return 17
    }), 17)
    const allocator = await readFile('scripts/retention-ci-scratch.mjs', 'utf8')
    assert.match(allocator, /runPrivateCiScratch\(scratch => runPrivateCiSafeRunner\(scratch, process.argv.slice\(2\)\)\)/)
})
test('real shell resolves exec chroot under actual safe caller environment without root', () => {
    assert.notEqual(process.getuid(), 0, 'version diagnostic must be unprivileged')
    runPrivateCiSafeRunner('/run/ses-retention-ci-own', ['--ci-multi-uid'], (_command, _args, env) => {
        // Same bare exec lookup as the live namespace shell; --version performs
        // no chroot, namespace operation or filesystem mutation.
        const result = spawnSync('/bin/sh', ['-c', 'exec chroot --version'], { env, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' })
        assert.equal(result.error, undefined)
        assert.equal(result.signal, null)
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /^chroot \(GNU coreutils\)/)
        return 0
    })
})
const directory = (uid = 0, gid = 0, mode = 0o40755) => ({ uid, gid, mode, isDirectory: () => true })
test('bounded maps reject runner-owned restrictive ancestry before launch', async () => {
    await assert.rejects(assertMappedScratchAncestry('/runner/private', async path => path === '/runner' ? directory(1001, 1001, 0o40700) : directory()), /mapped scratch ancestry/)
})
test('mapped ancestry rejects links, unmapped IDs and non-searchable directories', async () => {
    for (const bad of [directory(1001), directory(0, 1001), directory(0, 0, 0o40600), directory(0, 0, 0o40777), directory(0, 0, 0o40775), { ...directory(), isDirectory: () => false }]) {
        await assert.rejects(assertMappedScratchAncestry('/run/private', async () => bad), /mapped scratch ancestry/)
    }
})
test('mapped root-owned private scratch and root ancestry are accepted read-only', async () => {
    const paths = []
    await assertMappedScratchAncestry('/run/private', async path => { paths.push(path); return directory(0, 0, path === '/run/private' ? 0o40700 : 0o40755) })
    assert.deepEqual(paths, ['/run/private', '/run', '/'])
})
for (const outcome of [0, 1, new Error('launch failed')]) {
    test(`private allocator cleans only its new directory: ${outcome}`, async () => {
        const events = []
        const operations = {
            mkdtemp: async prefix => { assert.equal(prefix, '/run/ses-retention-ci-'); events.push('allocate'); return '/run/ses-retention-ci-own' },
            lstat: async () => directory(0, 0, 0o40700),
            rm: async (path, options) => { assert.equal(path, '/run/ses-retention-ci-own'); assert.deepEqual(options, { recursive: true, force: true }); events.push('cleanup') },
        }
        const promise = runPrivateCiScratch(async scratch => { assert.equal(scratch, '/run/ses-retention-ci-own'); events.push('launch'); if (outcome instanceof Error) throw outcome; return outcome }, operations)
        if (outcome instanceof Error) await assert.rejects(promise, /launch failed/)
        else assert.equal(await promise, outcome)
        assert.deepEqual(events, ['allocate', 'launch', 'cleanup'])
    })
}
test('ancestry failure cleans allocation and refuses connected child', async () => {
    let launched = false, cleaned = false
    await assert.rejects(runPrivateCiScratch(async () => { launched = true }, {
        mkdtemp: async () => '/run/ses-retention-ci-own',
        lstat: async path => directory(path === '/run' ? 1001 : 0),
        rm: async () => { cleaned = true },
    }), /mapped scratch ancestry/)
    assert.equal(launched, false); assert.equal(cleaned, true)
})
test('real unprivileged allocation is private and cleaned; no root capability claim', async () => {
    let allocated
    await runPrivateCiScratch(async path => {
        allocated = path
        const info = await lstat(path)
        assert.equal(info.mode & 0o777, 0o700)
        assert.equal(info.uid, process.getuid())
    }, {
        mkdtemp: async prefix => { assert.equal(prefix, '/run/ses-retention-ci-'); return mkdtemp(join(process.env.TMPDIR, 'scratch-regression-')) },
        // Host ancestry is not hosted mapped-root ancestry: schema seam only.
        lstat: async path => { const info = await lstat(path); return { ...directory(), isDirectory: () => info.isDirectory() } },
        rm,
    })
    await assert.rejects(lstat(allocated), { code: 'ENOENT' })
})
test('Node masks genuine ancestor EACCES as missing module; file remains present', async () => {
    assert.notEqual(process.getuid(), 0, 'run this diagnostic without host root')
    const scratch = await mkdtemp(join(process.env.TMPDIR, 'node-dac-regression-'))
    const parent = join(scratch, 'private'), leaf = join(parent, 'leaf.mjs')
    try {
        await mkdir(parent, { mode: 0o700 })
        await writeFile(leaf, 'console.log("leaf reached")\n')
        await chmod(parent, 0o600) // Only our own new fixture; never host ancestry.
        await assert.rejects(lstat(leaf), { code: 'EACCES' })
        const result = spawnSync(process.execPath, [leaf], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', env: {} })
        assert.equal(result.status, 1)
        assert.match(result.stderr, /Cannot find module/)
        assert.equal(result.error, undefined)
        await chmod(parent, 0o700)
        assert.equal(await readFile(leaf, 'utf8'), 'console.log("leaf reached")\n')
    } finally { await chmod(parent, 0o700); await rm(scratch, { recursive: true, force: true }) }
})
test('workflow and real safe runner retain connected preflight and mandatory scratch suite', async () => {
    const runner = await readFile('scripts/test-newsletter-retention-safe-filesystem.mjs', 'utf8')
    assert.match(runner, /if \(multiUid\) await assertMappedScratchAncestry\(resolve\(process.env.TMPDIR\)\)/)
    assert.ok(runner.indexOf('await assertMappedScratchAncestry') < runner.indexOf('const fixture = await mkdtemp'))
    assert.match(runner, /TMPDIR required; no system-temp fallback/)
    const workflow = await readFile('.github/workflows/ci.yaml', 'utf8')
    assert.match(workflow, /run: node --test[^\n]*tests\/scripts\/retention-ci-scratch.node.mjs/)
    assert.equal(workflow.match(/run: npm run test:ci:db/g).length, 2)
})
test('actual six-phase DB entry selects private allocator, never RUNNER_TEMP', () => {
    const phases = []
    assert.equal(runDatabaseCoverage((command, args) => { phases.push([command, args]); return 0 }), 0)
    assert.equal(phases.length, 6)
    assert.equal(phases[1][0], 'sudo')
    assert.ok(phases[1][1].includes('scripts/retention-ci-scratch.mjs'))
    assert.ok(!phases[1][1].some(arg => arg.startsWith('TMPDIR=')))
    assert.ok(phases[1][1].includes('--ci-multi-uid'))
})
