import { describe, expect, it } from 'vitest'
import { validateSafeRunnerMode } from '../../scripts/retention-safe-runner-policy.mjs'
import { mergeRetentionReports } from '../../scripts/merge-retention-vitest-reports.mjs'
import { syntheticStartup, malformedStartupCases } from './retention-teardown-fixtures.mjs'

const operational = 'tests/service/newsletter-retention-operational-filesystem.test.ts'
const historical = 'tests/service/newsletter-retention-historical-preparation.test.ts'
function reports() {
    const assertions = [
        ...Array.from({ length: 15 }, (_, i) => ({ file: operational, fullName: i === 0 ? 'real private operational metadata filesystem rejects real foreign owner metadata when runner can create it' : `real private operational metadata filesystem case ${i}`, status: 'skipped' })),
        ...Array.from({ length: 7 }, (_, i) => ({ file: historical, fullName: `historical preparation real private report/config -> runtime adapter -> CLI: ${i}`, status: 'skipped' })),
        { file: historical, fullName: 'historical preparation pure case', status: 'passed' },
    ]
    const make = (safe: boolean) => ({
        numTotalTests: 23, numPassedTests: safe ? 23 : 1, numFailedTests: 0, numPendingTests: safe ? 0 : 22, numTodoTests: 0,
        testResults: [operational, historical].map(file => ({ name: `${safe ? '/repo' : '/checkout'}/${file}`, assertionResults: assertions.filter(a => a.file === file).map(a => ({ fullName: a.fullName, status: safe ? 'passed' : a.status })) })),
    })
    // Synthetic report schema, not a real hosted root/teardown certification.
    return { database: make(false), safe: { ...make(true), retentionSafeRunner: { foreignOwner: { uid: 1, gid: 1 }, uidMap: '0 0 2\n', gidMap: '0 0 2\n', isolated: true, exitCode: 0, bootstrapTeardown: { version: 1, verified: true, descendantsGone: true, timeoutMs: 900, elapsedMs: 910, started: syntheticStartup() } } } }
}

describe('required CI retention report reconciliation', () => {
    it('permits privileged bootstrap only in explicit ephemeral hosted CI, and maps exactly two owners', () => {
        expect(validateSafeRunnerMode({ multiUid: true, uid: 0, githubActions: 'true', runnerEnvironment: 'github-hosted' })).toEqual([])
        expect(validateSafeRunnerMode({ multiUid: false, uid: 1003, githubActions: undefined, runnerEnvironment: undefined })).toEqual(['--user', '--map-root-user'])
    })
    it.each([
        { multiUid: true, uid: 1003, githubActions: 'true', runnerEnvironment: 'github-hosted' },
        { multiUid: true, uid: 0, githubActions: undefined, runnerEnvironment: 'github-hosted' },
        { multiUid: true, uid: 0, githubActions: 'true', runnerEnvironment: 'self-hosted' },
        { multiUid: false, uid: 0, githubActions: 'true', runnerEnvironment: 'github-hosted' },
    ])('refuses unsafe bootstrap %j', mode => expect(() => validateSafeRunnerMode(mode)).toThrow())
    it('synthetic valid schema reconciles all 22 pending identities and retains all DB assertions', () => {
        const { database, safe } = reports()
        const merged = mergeRetentionReports(database, safe)
        expect(merged.numPassedTests).toBe(23)
        expect(merged.numPendingTests).toBe(0)
        expect(merged.retentionCoverage.replaced.length).toBe(22)
        expect(merged.testResults.flatMap((r: { assertionResults: unknown[] }) => r.assertionResults)).toHaveLength(23)
    })
    it('preserves distinct ordinary parameterized assertions even when Vitest renders identical titles', () => {
        const { database, safe } = reports()
        database.testResults.push({ name: '/checkout/tests/lib/event-processor.test.ts', assertionResults: [{ fullName: 'parameterized case', status: 'passed' }, { fullName: 'parameterized case', status: 'passed' }] })
        database.numTotalTests += 2; database.numPassedTests += 2
        expect(mergeRetentionReports(database, safe).numPassedTests).toBe(25)
    })
    // These reports are synthetic gate fixtures, not hosted capability proof.
    it.each(malformedStartupCases)('rejects synthetic malformed startup %s before declaring success', (name, mutate) => {
        const { database, safe } = reports()
        Object.assign(safe.retentionSafeRunner.bootstrapTeardown, { started: mutate(syntheticStartup()) })
        if (name === 'missing') Reflect.deleteProperty(safe.retentionSafeRunner.bootstrapTeardown, 'started')
        const before = structuredClone(database)
        expect(() => mergeRetentionReports(database, safe)).toThrow('teardown probe')
        expect(database).toEqual(before)
        expect(database.numPendingTests).toBe(22)
        expect(Object.hasOwn(database, 'success')).toBe(false)
    })
    it.each(['missing', 'false', 'wrong-version', 'still-present', 'wrong-timeout', 'over-budget'])('rejects synthetic %s teardown certification', mode => {
        const { database, safe } = reports()
        const teardown = safe.retentionSafeRunner.bootstrapTeardown
        if (mode === 'missing') Reflect.deleteProperty(safe.retentionSafeRunner, 'bootstrapTeardown')
        if (mode === 'false') teardown.verified = false
        if (mode === 'wrong-version') teardown.version = 2
        if (mode === 'still-present') teardown.descendantsGone = false
        if (mode === 'wrong-timeout') teardown.timeoutMs = 300000
        if (mode === 'over-budget') teardown.elapsedMs = 1600
        expect(() => mergeRetentionReports(database, safe)).toThrow('bootstrap teardown probe')
    })
    it.each(['missing', 'wrong-name', 'duplicate', 'safe-skip', 'safe-fail', 'db-fail', 'wrong-total', 'unexpected-skip', 'no-probe', 'bad-probe', 'bad-map', 'missing-owner-test', 'unsuccessful-execution', 'nonzero-exit'])('fails closed for %s evidence', mode => {
        const { database, safe } = reports()
        if (mode === 'missing') safe.testResults[0].assertionResults.pop()
        if (mode === 'wrong-name') safe.testResults[0].assertionResults[0].fullName += ' other'
        if (mode === 'duplicate') safe.testResults[0].assertionResults.push(safe.testResults[0].assertionResults[0])
        if (mode === 'safe-skip') { safe.testResults[0].assertionResults[0].status = 'pending'; safe.numPassedTests--; safe.numPendingTests++ }
        if (mode === 'safe-fail') { safe.testResults[0].assertionResults[0].status = 'failed'; safe.numPassedTests--; safe.numFailedTests++ }
        if (mode === 'db-fail') { database.testResults[1].assertionResults[7].status = 'failed'; database.numPassedTests--; database.numFailedTests++ }
        if (mode === 'wrong-total') safe.numTotalTests++
        if (mode === 'unexpected-skip') database.testResults[0].assertionResults[0].fullName = 'unrelated skipped test'
        if (mode === 'no-probe') Reflect.deleteProperty(safe, 'retentionSafeRunner')
        if (mode === 'bad-probe') safe.retentionSafeRunner.foreignOwner.uid = 0
        if (mode === 'bad-map') safe.retentionSafeRunner.uidMap = '0 0 1\n'
        if (mode === 'missing-owner-test') { safe.testResults[0].assertionResults[0].fullName = 'real private operational metadata filesystem other case'; database.testResults[0].assertionResults[0].fullName = safe.testResults[0].assertionResults[0].fullName }
        if (mode === 'unsuccessful-execution') Object.assign(safe, { success: false })
        if (mode === 'nonzero-exit') safe.retentionSafeRunner.exitCode = 1
        expect(() => mergeRetentionReports(database, safe)).toThrow()
    })
})
