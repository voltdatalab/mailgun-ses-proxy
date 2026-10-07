import { createHash } from 'node:crypto'
import { chmod, chown, link, mkdir, mkdtemp, open, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readPinnedNewsletterRetentionOperationalReport } from '@/service/newsletter-retention-cli'

const root = process.env.RETENTION_SAFE_FIXTURE_ROOT
const digest = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
// Explicit safe-runner suite: never chmod existing directories or pretend host
// scratch's unsafe ancestry is safe. Linux user/mount namespace runner documented.
describe.skipIf(!root)('real private operational metadata filesystem', () => {
    async function fixture(run: (dir: string, path: string) => Promise<void>) {
        const dir = await mkdtemp(join(root!, 'report-'))
        await chmod(dir, 0o700)
        const path = join(dir, 'report.json')
        await writeFile(path, ' {"fixture":true}\n', { mode: 0o400 })
        try { await run(dir, path) } finally { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) }
    }
    it('reads exact raw bytes with mode0400, not canonical JSON; never authenticates origin', async () => fixture(async (_dir, path) => {
        expect(await readPinnedNewsletterRetentionOperationalReport(path, digest(' {"fixture":true}\n'))).toEqual({ report: { fixture: true }, reportSha256: digest(' {"fixture":true}\n'), collectionAuthenticated: false })
        await expect(readPinnedNewsletterRetentionOperationalReport(path, digest('{"fixture":true}'))).rejects.toThrow('byte pin invalid')
    }))
    it('rejects real foreign owner metadata when runner can create it', async (context) => fixture(async (_dir, path) => {
        try { await chown(path, 1, 1) } catch (error) {
            if (['EINVAL', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) context.skip()
            throw error
        }
        await expect(readPinnedNewsletterRetentionOperationalReport(path, digest(' {"fixture":true}\n'))).rejects.toThrow('descriptor or byte pin invalid')
    }))
    it.each(['directory', 'mode', 'symlink', 'hardlink', 'parent-symlink', 'parent-mode', 'empty', 'oversize', 'invalid-utf8', 'malformed-json'])('rejects real %s metadata', async (attack) => fixture(async (dir, path) => {
        let input = path
        let pin = digest(' {"fixture":true}\n')
        if (attack === 'directory') { input = join(dir, 'directory'); await mkdir(input, { mode: 0o700 }) }
        if (attack === 'mode') await chmod(path, 0o600)

        if (attack === 'symlink') { input = join(dir, 'alias'); await symlink(path, input) }
        if (attack === 'hardlink') await link(path, join(dir, 'alias'))
        if (attack === 'parent-symlink') { await symlink(dir, join(dir, 'alias')); input = join(dir, 'alias', 'report.json') }
        if (attack === 'parent-mode') { const parent = join(dir, 'unsafe'); await mkdir(parent, { mode: 0o700 }); await chmod(parent, 0o770); input = join(parent, 'report'); await writeFile(input, '{}', { mode: 0o400 }) }
        if (['empty', 'oversize', 'invalid-utf8', 'malformed-json'].includes(attack)) {
            await chmod(path, 0o600)
            const badBytes = attack === 'empty' ? '' : attack === 'oversize' ? 'x'.repeat(1_048_577) : attack === 'invalid-utf8' ? Buffer.from([0xff]) : '{'
            await writeFile(path, badBytes)
            if (attack === 'invalid-utf8' || attack === 'malformed-json') pin = digest(badBytes)
            await chmod(path, 0o400)
        }
        await expect(readPinnedNewsletterRetentionOperationalReport(input, pin)).rejects.toThrow(attack === 'invalid-utf8' || attack === 'malformed-json' ? 'invalid' : 'descriptor or byte pin invalid')
    }))
    it('keeps descriptor-bound original across real parent replacement, never reads replacement', async () => fixture(async (dir) => {
        const parent = join(dir, 'parent'); await mkdir(parent, { mode: 0o700 })
        const path = join(parent, 'report.json'); await writeFile(path, '{"original":true}', { mode: 0o400 })
        const probe = await open(path); const prototype = Object.getPrototypeOf(probe); await probe.close()
        const originalStat = prototype.stat
        let replaced = false
        vi.spyOn(prototype, 'stat').mockImplementation(async function(this: typeof probe, ...args: unknown[]) {
            const stat = await originalStat.apply(this, args)
            if (stat.isFile() && !replaced) {
                replaced = true; await rename(parent, join(dir, 'held-parent')); await mkdir(parent, { mode: 0o700 })
                await writeFile(path, '{"original":false}', { mode: 0o400 })
            }
            return stat
        })
        expect((await readPinnedNewsletterRetentionOperationalReport(path, digest('{"original":true}'))).report).toEqual({ original: true })
        expect(replaced).toBe(true)
    }))
    it.each(['content', 'identity'])('rejects real fd %s mutation during read and closes acquired descriptors', async (attack) => fixture(async (_dir, path) => {
        await chmod(path, 0o600); const writer = await open(path, 'r+'); await chmod(path, 0o400)
        const prototype = Object.getPrototypeOf(writer), originalRead = prototype.read
        let mutated = false
        let close: ReturnType<typeof vi.spyOn> | undefined
        const before = (await readdir('/proc/self/fd')).length
        vi.spyOn(prototype, 'read').mockImplementation(async function(this: typeof writer, ...args: unknown[]) {
            const result = await originalRead.apply(this, args)
            if (!mutated) {
                close = vi.spyOn(this, 'close')
                mutated = true
                if (attack === 'content') await writer.write(Buffer.from(' {"fixture":null}\n'), 0, 17, 0)
                else await writer.chmod(0o600)
            }
            return result
        })
        try {
            await expect(readPinnedNewsletterRetentionOperationalReport(path, digest(' {"fixture":true}\n'))).rejects.toThrow('descriptor or byte pin invalid')
            expect(mutated).toBe(true)
            expect(close).toHaveBeenCalledOnce()
            expect((await readdir('/proc/self/fd')).length).toBe(before)
        } finally { await writer.close() }
    }))
})
