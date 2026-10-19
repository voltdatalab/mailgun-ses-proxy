import { describe, expect, it, vi } from 'vitest'
import { boundedHistoricalSource } from '@/service/newsletter-retention-historical-deadline'

describe('bounded historical producer contract', () => {
    it('bounds stalled next and uncooperative return; observes late rejection', async () => {
        let reject!: (error: Error) => void
        const next = vi.fn(() => new Promise<IteratorResult<Uint8Array>>((_, r) => { reject = r }))
        const cleanup = vi.fn(() => new Promise<IteratorResult<Uint8Array>>(() => {}))
        const source = boundedHistoricalSource({ [Symbol.asyncIterator]: () => ({ next, return: cleanup }) }, { idleMs: 10, wholeMs: 100, cleanupMs: 10 })
        await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow('deadline')
        reject(new Error('late producer failure'))
        await source.close()
        expect(cleanup).toHaveBeenCalledOnce()
        await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow('deadline')
        expect(next).toHaveBeenCalledOnce()
    })
    it('honors external abort without requesting another chunk', async () => {
        const controller = new AbortController()
        const next = vi.fn(async () => ({ done: false as const, value: new Uint8Array() }))
        const source = boundedHistoricalSource({ [Symbol.asyncIterator]: () => ({ next }) }, { signal: controller.signal, idleMs: 20, wholeMs: 100, cleanupMs: 10 })
        controller.abort()
        await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow('cancelled')
        expect(next).not.toHaveBeenCalled()
        await source.close()
    })
    it('whole deadline applies even to empty chunks', async () => {
        const source = boundedHistoricalSource({ async *[Symbol.asyncIterator]() { while (true) { await new Promise(r => setTimeout(r, 2)); yield new Uint8Array() } } }, { idleMs: 30, wholeMs: 15, cleanupMs: 10 })
        const iterator = source[Symbol.asyncIterator]()
        await expect((async () => { while (true) await iterator.next() })()).rejects.toThrow('deadline')
        await source.close()
    })
})
