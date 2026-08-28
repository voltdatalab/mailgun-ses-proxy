import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

const raceHook = vi.hoisted(() => ({
    suffix: null as string | null,
    beforeFinalOperation: null as (() => Promise<void>) | null,
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
            await trigger(path)
            return mode === undefined
                ? actual.open(path as string, flags)
                : actual.open(path as string, flags, mode)
        },
        lstat: async (path: unknown) => {
            await trigger(path)
            return actual.lstat(path as string)
        },
    }
})

import {
    readNewsletterRetentionJsonFile,
    removeNewsletterRetentionOutputFile,
    writeNewsletterRetentionJsonFileExclusive,
} from '@/service/newsletter-retention-cli'

const temporaryDirectories: string[] = []

afterEach(async () => {
    raceHook.suffix = null
    raceHook.beforeFinalOperation = null
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

    it('removes only from the opened parent when the original ancestor is replaced before unlink', async () => {
        const fixture = await makeRaceFixture()
        await fixture.fs.writeFile(join(fixture.vetted, 'output.json'), '{"owner":"vetted"}\n', { mode: 0o600 })
        await fixture.fs.writeFile(join(fixture.attacker, 'output.json'), '{"owner":"attacker"}\n', { mode: 0o600 })
        raceHook.suffix = 'output.json'
        raceHook.beforeFinalOperation = fixture.swapAncestor

        await removeNewsletterRetentionOutputFile(join(fixture.vetted, 'output.json'))

        await expect(fixture.fs.stat(join(fixture.moved, 'output.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(JSON.parse(await fixture.fs.readFile(join(fixture.attacker, 'output.json'), 'utf8'))).toEqual({
            owner: 'attacker',
        })
    })
})
