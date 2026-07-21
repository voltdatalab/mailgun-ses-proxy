/** Returns a bounded, non-sensitive error classification for structured logs. */
export function errorClass(error: unknown): string {
    if (!(error instanceof Error)) return "UnknownError"
    const name = error.name || "Error"
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error"
}
