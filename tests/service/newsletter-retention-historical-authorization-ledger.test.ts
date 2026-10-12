import { afterEach, describe, expect, it } from 'vitest'
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { openHistoricalAuthorizationLedger, provisionHistoricalAuthorization } from '@/service/newsletter-retention-historical-authorization-ledger'
const paths: string[] = []
const scope = 'a'.repeat(64)
async function fixture() {
    const directory = await mkdtemp(join(process.env.RETENTION_SAFE_FIXTURE_ROOT ?? process.cwd(), '.durable-'))
    paths.push(directory)
    return directory
}
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
const moduleUrl = pathToFileURL(resolve('service/newsletter-retention-historical-authorization-ledger.ts')).href
function childScript(directory: string) {
    return `import {openHistoricalAuthorizationLedger} from ${JSON.stringify(moduleUrl)};const port=openHistoricalAuthorizationLedger(${JSON.stringify(directory)},'approved',${JSON.stringify(scope)});console.log(await port.claim());`
}
function child(directory: string) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childScript(directory)], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env: { NODE_ENV: 'test', PATH: '/none' } })
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
}
describe('actual durable private filesystem authorization (native Node subprocesses)', () => {
    it('persists an irreversible claim across independent process exits and port reconstruction', async () => {
        const directory = await fixture()
        provisionHistoricalAuthorization(directory, 'approved', scope)
        expect(child(directory)).toBe('true')
        expect(child(directory)).toBe('false')
        expect(await openHistoricalAuthorizationLedger(directory, 'approved', scope).claim()).toBe(false)
        provisionHistoricalAuthorization(directory, 'approved', scope)
        expect(child(directory)).toBe('false')
    })
    it('gives exactly one winner to independently started processes without a shared RAM guard', async () => {
        const directory = await fixture()
        provisionHistoricalAuthorization(directory, 'approved', scope)
        const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolveResult, reject) => {
            const processChild = spawn(process.execPath, ['--input-type=module', '-e', childScript(directory)], { env: { NODE_ENV: 'test', PATH: '/none' }, stdio: ['ignore', 'pipe', 'pipe'] })
            let output = '', error = ''
            const deadline = setTimeout(() => processChild.kill('SIGKILL'), 10000)
            processChild.stdout.on('data', data => { output += data }); processChild.stderr.on('data', data => { error += data })
            processChild.on('error', reject)
            processChild.on('exit', (code, signal) => { clearTimeout(deadline); if (code !== 0 || signal) reject(new Error(`child failed: ${error}`)); else resolveResult(output.trim()) })
        })))
        expect(results.filter(value => value === 'true')).toHaveLength(1)
        expect(results.filter(value => value === 'false')).toHaveLength(7)
        expect(child(directory)).toBe('false')
    })
    it.each(['unprovisioned', 'rebind', 'approval-replacement', 'approval-corrupt', 'approval-removed', 'approval-symlink', 'approval-hardlink', 'approval-mode', 'directory-mode', 'directory-symlink', 'ancestor-symlink', 'ancestor-mode', 'directory-replacement', 'partial-claim'] as const)('fails closed: %s', async mode => {
        const directory = await fixture()
        if (mode === 'unprovisioned') { expect(() => openHistoricalAuthorizationLedger(directory, 'approved', scope)).toThrow(); return }
        provisionHistoricalAuthorization(directory, 'approved', scope)
        const ledger = openHistoricalAuthorizationLedger(directory, 'approved', scope)
        const approved = join(directory, 'approved.approved')
        if (mode === 'rebind') { expect(() => provisionHistoricalAuthorization(directory, 'approved', 'b'.repeat(64))).toThrow(); expect(() => openHistoricalAuthorizationLedger(directory, 'approved', 'b'.repeat(64))).toThrow(); return }
        if (mode === 'partial-claim') { await writeFile(join(directory, 'approved.consumed'), '', { mode: 0o400 }); expect(await ledger.claim()).toBe(false); return }
        if (mode === 'approval-replacement') { await rename(approved, join(directory, 'original')); provisionHistoricalAuthorization(directory, 'approved', scope) }
        if (mode === 'approval-corrupt') { await chmod(approved, 0o600); await writeFile(approved, '{}'); await chmod(approved, 0o400) }
        if (mode === 'approval-removed') await rm(approved)
        if (mode === 'approval-symlink') { await rename(approved, join(directory, 'original')); await symlink('original', approved) }
        if (mode === 'approval-hardlink') await link(approved, join(directory, 'hardlink'))
        if (mode === 'approval-mode') await chmod(approved, 0o600)
        if (mode === 'directory-mode') await chmod(directory, 0o755)
        if (mode === 'directory-replacement') { const moved = directory + '-moved'; paths.push(moved); await rename(directory, moved); await mkdir(directory, { mode: 0o700 }); provisionHistoricalAuthorization(directory, 'approved', scope) }
        if (mode === 'directory-symlink') { const alias = directory + '-alias'; paths.push(alias); await symlink(directory, alias); expect(() => openHistoricalAuthorizationLedger(alias, 'approved', scope)).toThrow(); return }
        if (mode.startsWith('ancestor-')) {
            const parent = await fixture(), nested = join(parent, 'nested')
            await mkdir(nested, { mode: 0o700 }); provisionHistoricalAuthorization(nested, 'approved', scope)
            if (mode === 'ancestor-mode') { await chmod(parent, 0o777); expect(() => openHistoricalAuthorizationLedger(nested, 'approved', scope)).toThrow() }
            else { const alias = parent + '-alias'; paths.push(alias); await symlink(parent, alias); expect(() => openHistoricalAuthorizationLedger(join(alias, 'nested'), 'approved', scope)).toThrow() }
            return
        }
        await expect(ledger.claim()).rejects.toThrow()
    })
})
