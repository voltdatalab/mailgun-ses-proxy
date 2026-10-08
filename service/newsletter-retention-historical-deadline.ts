import { performance } from 'node:perf_hooks'

export interface HistoricalDeadlineOptions {
    signal?: AbortSignal
    idleMs?: number
    wholeMs?: number
    cleanupMs?: number
    /** Cooperative producer cancellation. Bounding a promise does not kill it. */
    cancel?: (reason: Error) => void | Promise<void>
}
/** One iterator, monotonic work deadline, bounded cleanup, late rejection handlers.
 * Producers must honor signal/cancel to actually stop their underlying work. */
export function boundedHistoricalSource(input: AsyncIterable<Uint8Array>, options: HistoricalDeadlineOptions = {}) {
    const idle = options.idleMs ?? 30_000, whole = options.wholeMs ?? 30 * 60_000, cleanup = options.cleanupMs ?? 1_000
    for (const [value, maximum] of [[idle, 30_000], [whole, 30 * 60_000], [cleanup, 1_000]]) {
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error('historical deadline invalid')
    }
    const deadline = performance.now() + whole
    const iterator = input[Symbol.asyncIterator]()
    let stopped: Error | null = null, closing: Promise<void> | null = null, cleanupIncomplete = false
    const controller = new AbortController()
    const externalAbort = () => stop(new Error('historical source cancelled'))
    options.signal?.addEventListener('abort', externalAbort, { once: true })
    const wholeTimer = setTimeout(() => stop(new Error('historical source whole deadline')), whole)
    function stop(error: Error) {
        if (stopped) return
        stopped = error
        controller.abort(error)
        if (options.cancel) void Promise.resolve().then(() => options.cancel!(error)).catch(() => {})
    }
    function check() {
        if (stopped || options.signal?.aborted) { stop(new Error('historical source cancelled')); throw stopped }
        if (performance.now() >= deadline) { stop(new Error('historical source whole deadline')); throw stopped }
    }
    async function next(): Promise<IteratorResult<Uint8Array>> {
        check()
        const remaining = Math.min(idle, deadline - performance.now())
        const value = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', abort) }
            const fail = (error: Error) => { finish(); stop(error); reject(error) }
            const abort = () => fail(stopped ?? new Error('historical source cancelled'))
            const timer = setTimeout(() => fail(new Error('historical source deadline')), remaining)
            options.signal?.addEventListener('abort', abort, { once: true })
            controller.signal.addEventListener('abort', abort, { once: true })
            // Handlers remain attached to producer promise after timeout/abort.
            Promise.resolve().then(() => { check(); return iterator.next() }).then(v => { finish(); resolve(v) }, error => { finish(); reject(error) })
        })
        check()
        return value
    }
    function close(): Promise<void> {
        if (closing) return closing
        clearTimeout(wholeTimer)
        options.signal?.removeEventListener('abort', externalAbort)
        stop(new Error('historical source cancelled'))
        closing = new Promise<void>((resolve) => {
            const timer = setTimeout(() => { cleanupIncomplete = true; resolve() }, cleanup)
            Promise.resolve().then(() => iterator.return?.()).then(() => resolve(), () => { cleanupIncomplete = true; resolve() }).finally(() => clearTimeout(timer)).catch(() => {})
        })
        return closing
    }
    return { signal: controller.signal, check, close, get cleanupIncomplete() { return cleanupIncomplete }, [Symbol.asyncIterator]() { return { next, return: async () => { await close(); return { done: true as const, value: undefined } } } } }
}
