import { cookies } from "next/headers"
import { prisma } from "@/lib/database"

const COOKIE_NAME = "dashboard_token"
const SESSION_DURATION = 24 * 60 * 60 // 24 hours in seconds
const LEGACY_ADMIN_EMAIL = "admin@localhost"
const MIN_BOOTSTRAP_PASSWORD_LENGTH = 16
const MIN_DASHBOARD_JWT_SECRET_LENGTH = 32

export class DashboardBootstrapError extends Error {
    constructor() {
        super("Dashboard bootstrap is not configured")
        this.name = "DashboardBootstrapError"
    }
}

function dashboardJwtSecret(): string {
    const secret = process.env.DASHBOARD_JWT_SECRET
    if (!secret || secret.length < MIN_DASHBOARD_JWT_SECRET_LENGTH) throw new DashboardBootstrapError()
    return secret
}

export function hasValidDashboardJwtSecret(): boolean {
    return (process.env.DASHBOARD_JWT_SECRET?.length ?? 0) >= MIN_DASHBOARD_JWT_SECRET_LENGTH
}

function bootstrapCredentials(): { email: string; password: string } {
    const email = process.env.DASHBOARD_INITIAL_ADMIN_EMAIL?.trim()
    const password = process.env.DASHBOARD_INITIAL_ADMIN_PASSWORD
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
        throw new DashboardBootstrapError()
    }
    return { email, password }
}

function isPrismaUniqueError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}

// --- Password Hashing (PBKDF2 via Web Crypto) ---
const ITERATIONS = 100_000
const KEY_LENGTH = 64
const HASH_ALGORITHM = "SHA-512"

async function derivePBKDF2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
    const encoder = new TextEncoder()
    const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
    return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: HASH_ALGORITHM }, keyMaterial, KEY_LENGTH * 8)
}

function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBuf(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
    return bytes
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const derived = await derivePBKDF2(password, salt)
    return `${bufToHex(salt.buffer as ArrayBuffer)}:${bufToHex(derived)}`
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const [saltHex, hashHex] = storedHash.split(":")
    if (!saltHex || !hashHex) return false
    const derivedHex = bufToHex(await derivePBKDF2(password, hexToBuf(saltHex)))
    if (derivedHex.length !== hashHex.length) return false
    let mismatch = 0
    for (let i = 0; i < derivedHex.length; i++) mismatch |= derivedHex.charCodeAt(i) ^ hashHex.charCodeAt(i)
    return mismatch === 0
}

// --- JWT Session (HMAC-SHA256 via Web Crypto) ---
async function getSigningKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(dashboardJwtSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}

function base64UrlEncode(data: string | ArrayBuffer): string {
    const str = typeof data === "string" ? btoa(data) : btoa(String.fromCharCode(...new Uint8Array(data)))
    return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(str: string): string {
    return atob(str.replace(/-/g, "+").replace(/_/g, "/"))
}

interface JWTPayload { sub: string; email: string; name: string; iat: number; exp: number }

export async function createSession(userId: string, email: string, name: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const payload: JWTPayload = { sub: userId, email, name: name || email, iat: now, exp: now + SESSION_DURATION }
    const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    const body = base64UrlEncode(JSON.stringify(payload))
    const signingInput = `${header}.${body}`
    const signature = await crypto.subtle.sign("HMAC", await getSigningKey(), new TextEncoder().encode(signingInput))
    return `${signingInput}.${base64UrlEncode(signature)}`
}

export async function verifySession(token: string): Promise<JWTPayload | null> {
    try {
        const parts = token.split(".")
        if (parts.length !== 3) return null
        const signature = Uint8Array.from(base64UrlDecode(parts[2]), (c) => c.charCodeAt(0))
        const valid = await crypto.subtle.verify("HMAC", await getSigningKey(), signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
        if (!valid) return null
        const payload: JWTPayload = JSON.parse(base64UrlDecode(parts[1]))
        return payload.exp < Math.floor(Date.now() / 1000) ? null : payload
    } catch { return null }
}

export async function getSessionFromCookies(): Promise<JWTPayload | null> {
    const token = (await cookies()).get(COOKIE_NAME)?.value
    return token ? verifySession(token) : null
}

export function setSessionCookie(response: Response, token: string): void {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
    response.headers.append("Set-Cookie", `${COOKIE_NAME}=${token}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION}${secure}`)
}

export function clearSessionCookie(response: Response): void {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : ""
    response.headers.append("Set-Cookie", `${COOKIE_NAME}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0${secure}`)
}

/** Creates the configured first user or removes the known legacy default user before authentication. */
export async function ensureBootstrapUser(): Promise<void> {
    const [count, legacyUser] = await Promise.all([
        prisma.dashboardUser.count(),
        prisma.dashboardUser.findUnique({ where: { email: LEGACY_ADMIN_EMAIL } }),
    ])
    if (count !== 0 && !legacyUser) return

    const { email, password } = bootstrapCredentials()
    const passwordHash = await hashPassword(password)
    try {
        if (legacyUser) {
            const configuredUser = await prisma.dashboardUser.findUnique({ where: { email } })
            if (configuredUser && configuredUser.id !== legacyUser.id) {
                await prisma.dashboardUser.delete({ where: { id: legacyUser.id } })
                return
            }
            await prisma.dashboardUser.update({ where: { id: legacyUser.id }, data: { email, password: passwordHash } })
        } else {
            await prisma.dashboardUser.create({ data: { email, password: passwordHash, name: "Admin" } })
        }
    } catch (error) {
        if (isPrismaUniqueError(error) && !legacyUser) {
            // Concurrent bootstrap requests converge on the same configured account.
            const configuredUser = await prisma.dashboardUser.findUnique({ where: { email } })
            if (configuredUser) return
        }
        throw new DashboardBootstrapError()
    }
}
