import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getSessionFromCookies: vi.fn(),
    hashPassword: vi.fn(),
    dashboardUserUpdate: vi.fn(),
    log: { error: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/dashboard/auth', () => ({
    getSessionFromCookies: mocks.getSessionFromCookies,
    hashPassword: mocks.hashPassword,
}))
vi.mock('@/lib/database', () => ({
    prisma: {
        dashboardUser: { update: mocks.dashboardUserUpdate },
    },
}))
vi.mock('@/lib/core/logger', () => ({
    default: { child: vi.fn(() => mocks.log) },
}))
vi.mock('@/lib/core/error-class', () => ({
    errorClass: vi.fn(() => 'Error'),
}))

import { GET, PUT } from '@/app/dashboard/api/settings/route'

function request(body: unknown) {
    return new Request('http://localhost/dashboard/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

describe('dashboard settings API', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getSessionFromCookies.mockResolvedValue({ sub: 'dashboard-user-1' })
        mocks.hashPassword.mockResolvedValue('hashed-password')
        mocks.dashboardUserUpdate.mockResolvedValue({ id: 'dashboard-user-1' })
    })

    it('requires an authenticated dashboard session', async () => {
        mocks.getSessionFromCookies.mockResolvedValue(null)

        const getResponse = await GET()
        const putResponse = await PUT(request({ credentials: {} }))

        expect(getResponse.status).toBe(401)
        expect(putResponse.status).toBe(401)
        expect(mocks.dashboardUserUpdate).not.toHaveBeenCalled()
    })

    it('returns configuration provenance without environment values or database overrides', async () => {
        process.env.NEWSLETTER_QUEUE = 'private-queue-url'

        const response = await GET()
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toEqual({
            operationalConfiguration: {
                source: 'deployment_environment',
                dashboardOverridesEnabled: false,
            },
        })
        expect(JSON.stringify(body)).not.toContain('private-queue-url')
        delete process.env.NEWSLETTER_QUEUE
    })

    it('rejects operational settings even when the supplied collection is empty', async () => {
        const response = await PUT(request({ settings: [] }))

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Operational settings are managed in the deployment environment',
        })
        expect(mocks.dashboardUserUpdate).not.toHaveBeenCalled()
    })

    it('rejects unknown request fields fail-closed', async () => {
        const response = await PUT(request({ credentials: {}, unexpected: true }))

        expect(response.status).toBe(400)
        expect(mocks.dashboardUserUpdate).not.toHaveBeenCalled()
    })

    it('updates only validated dashboard credentials', async () => {
        const response = await PUT(request({
            credentials: {
                email: ' admin@example.test ',
                password: 'sixteen-characters-plus',
            },
        }))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, credentialsUpdated: true })
        expect(mocks.hashPassword).toHaveBeenCalledWith('sixteen-characters-plus')
        expect(mocks.dashboardUserUpdate).toHaveBeenCalledWith({
            where: { id: 'dashboard-user-1' },
            data: { email: 'admin@example.test', password: 'hashed-password' },
        })
        expect(mocks.log.info).toHaveBeenCalledWith({ credentialsUpdated: true }, 'Settings updated')
    })
})
