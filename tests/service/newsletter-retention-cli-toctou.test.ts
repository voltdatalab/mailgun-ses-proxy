import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

const raceHook = vi.hoisted(() => ({
    suffix: null as string | null,
    beforeFinalOperation: null as (() => Promise<void>) | null,
    triggerOnTmpfile: false,
    failWriteAfterPartial: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()

    async function trigger(path: unknown): Promise<void> {
        const suffix = raceHook.suffix
        const operation = raceHook.beforeFinalOperation
        if (!suffix || !operation || !String(path).endsWith(`/${suffix}`)) return
        raceHook.beforeFinalOperation = null
        await operation()
    }

    return {
        ...actual,
        open: async (path: unknown, flags: number | string, mode?: number) => {
            const isTmpfile = typeof flags === 'number' && (flags & 0o20000000) !== 0
            if (isTmpfile && raceHook.triggerOnTmpfile && raceHook.beforeFinalOperation) {
                const operation = raceHook.beforeFinalOperation
                raceHook.beforeFinalOperation = null
                await operation()
            } else {
                await trigger(path)
            }
            const handle = mode === undefined
                ? await actual.open(path as string, flags)
                : await actual.open(path as string, flags, mode)
            if (!raceHook.failWriteAfterPartial || !isTmpfile) {
                return handle
            }
            raceHook.failWriteAfterPartial = false
            return new Proxy(handle, {
                get(target, property) {
                    if (property === 'writeFile') {
                        return async () => {
                            await target.writeFile('partial')
                            throw new Error('injected write failure')
                        }
                    }
                    const value = Reflect.get(target, property, target) as unknown
                    return typeof value === 'function' ? value.bind(target) : value
                },
            })
        },
    }
})

import {
    readNewsletterRetentionJsonFile,
    writeNewsletterRetentionJsonFileExclusive,
} from '@/service/newsletter-retention-cli'

const temporaryDirectories: string[] = []

afterEach(async () => {
    raceHook.suffix = null
    raceHook.beforeFinalOperation = null
    raceHook.triggerOnTmpfile = false
    raceHook.failWriteAfterPartial = false
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })))
})

async function makeRaceFixture() {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const root = await fs.mkdtemp(join(tmpdir(), 'newsletter-retention-toctou-'))
    temporaryDirectories.push(root)
    const vetted = join(root, 'vetted')
    const moved = join(root, 'vetted-moved')
    const attacker = join(root, 'attacker')
    await fs.mkdir(vetted, { mode: 0o700 })
    await fs.mkdir(attacker, { mode: 0o700 })

    const swapAncestor = async () => {
        await fs.rename(vetted, moved)
        await fs.symlink(attacker, vetted, 'dir')
    }

    return { fs, vetted, moved, attacker, swapAncestor }
}

describe('newsletter retention CLI descriptor-bound file operations', () => {
    it('reads from the opened parent when the original ancestor is replaced before final open', async () => {
        const fixture = await makeRaceFixture()
        await fixture.fs.writeFile(join(fixture.vetted, 'input.json'), '{"source":"vetted"}\n', { mode: 0o600 })
        await fixture.fs.writeFile(join(fixture.attacker, 'input.json'), '{"source":"attacker"}\n', { mode: 0o600 })
        raceHook.suffix = 'input.json'
        raceHook.beforeFinalOperation = fixture.swapAncestor

        await expect(readNewsletterRetentionJsonFile(join(fixture.vetted, 'input.json'), 'private')).resolves.toEqual({
            source: 'vetted',
        })
    })

    it('writes into the opened parent when the original ancestor is replaced before final open', async () => {
        const fixture = await makeRaceFixture()
        raceHook.suffix = 'output.json'
        raceHook.triggerOnTmpfile = true
        raceHook.beforeFinalOperation = fixture.swapAncestor

        await writeNewsletterRetentionJsonFileExclusive(
            join(fixture.vetted, 'output.json'),
            { destination: 'vetted' },
            0o600,
        )

        expect(JSON.parse(await fixture.fs.readFile(join(fixture.moved, 'output.json'), 'utf8'))).toEqual({
            destination: 'vetted',
        })
        await expect(fixture.fs.stat(join(fixture.attacker, 'output.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('discards a partially written anonymous inode without publishing any path', async () => {
        const fixture = await makeRaceFixture()
        raceHook.failWriteAfterPartial = true

        await expect(writeNewsletterRetentionJsonFileExclusive(
            join(fixture.vetted, 'output.json'),
            { destination: 'vetted' },
            0o600,
        )).rejects.toThrow('newsletter retention output file could not be created')

        await expect(fixture.fs.stat(join(fixture.vetted, 'output.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await fixture.fs.readdir(fixture.vetted)).toEqual([])
    })
})
