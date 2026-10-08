import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const operational = 'tests/service/newsletter-retention-operational-filesystem.test.ts'
const historical = 'tests/service/newsletter-retention-historical-preparation.test.ts'
function fileIdentity(name) {
    const file = name.slice(name.lastIndexOf('/tests/') + 1)
    if (!file.startsWith('tests/') || file.split('/').some(part => part === '..' || part === '.')) throw new Error('invalid report file identity')
    return file
}
function indexReport(report) {
    const assertions = new Map(), counts = { passed: 0, failed: 0, pending: 0, todo: 0 }
    if (report.success === false || report.numFailedTestSuites > 0) throw new Error('unsuccessful test execution')
    if (!Array.isArray(report.testResults) || !report.testResults.length) throw new Error('empty report')
    for (const suite of report.testResults) {
        const file = fileIdentity(suite.name)
        if (suite.status === 'failed' || suite.message) throw new Error(`failed suite: ${file}`)
        for (const assertion of suite.assertionResults) {
            const status = assertion.status === 'skipped' ? 'pending' : assertion.status
            if (!assertion.fullName || !Object.hasOwn(counts, status)) throw new Error('invalid assertion')
            let id = JSON.stringify([file, assertion.fullName])
            if (assertions.has(id)) {
                // Existing ordinary it.each cases can render the same title.
                // Preserve every passed occurrence; never reconcile ambiguous
                // safe-only identities or hide duplicate skipped assertions.
                if ([operational, historical].includes(file) || status !== 'passed' || assertions.get(id).assertion.status !== 'passed') throw new Error(`duplicate assertion: ${id}`)
                let occurrence = 1
                while (assertions.has(JSON.stringify([file, assertion.fullName, occurrence]))) occurrence++
                id = JSON.stringify([file, assertion.fullName, occurrence])
            }
            assertions.set(id, { file, assertion })
            counts[status]++
        }
    }
    if (!assertions.size || report.numTotalTests !== assertions.size || report.numPassedTests !== counts.passed || report.numFailedTests !== counts.failed || report.numPendingTests !== counts.pending || report.numTodoTests !== counts.todo) throw new Error('report counts disagree with assertions')
    if (counts.failed || counts.todo) throw new Error('failed/todo assertions cannot be replaced')
    return assertions
}
export function mergeRetentionReports(database, safe) {
    const db = indexReport(database), isolated = indexReport(safe)
    const capability = safe.retentionSafeRunner
    if (capability?.foreignOwner?.uid !== 1 || capability?.foreignOwner?.gid !== 1 || capability.isolated !== true || capability.exitCode !== 0) throw new Error('missing successful isolated foreign-owner probe')
    for (const map of [capability.uidMap, capability.gidMap]) {
        if (typeof map !== 'string' || !/^\s*0\s+0\s+2\s*$/.test(map)) throw new Error('expected exactly UID/GID 0+1 mapped')
    }
    const ownerId = JSON.stringify([operational, 'real private operational metadata filesystem rejects real foreign owner metadata when runner can create it'])
    if (isolated.get(ownerId)?.assertion.status !== 'passed') throw new Error('missing actual foreign-owner rejection test')
    for (const [id, { file, assertion }] of isolated) {
        if (![operational, historical].includes(file) || assertion.status !== 'passed' || !db.has(id)) throw new Error(`unexpected or non-passing safe assertion: ${id}`)
    }
    const replaced = [], counts = { operational: 0, historical: 0 }
    for (const [id, { file, assertion }] of db) {
        if (assertion.status === 'passed') continue
        const permitted = file === operational && assertion.fullName.startsWith('real private operational metadata filesystem ')
            ? 'operational' : file === historical && assertion.fullName.includes('real private report/config -> runtime adapter -> CLI: ') ? 'historical' : null
        if (!permitted || isolated.get(id)?.assertion.status !== 'passed') throw new Error(`uncovered skipped assertion: ${id}`)
        counts[permitted]++
        replaced.push(id)
    }
    if (counts.operational !== 15 || counts.historical !== 7) throw new Error('expected all 15 filesystem and 7 composition assertions')
    const result = structuredClone(database)
    for (const suite of result.testResults) {
        const file = fileIdentity(suite.name)
        suite.assertionResults = suite.assertionResults.map(assertion => {
            const id = JSON.stringify([file, assertion.fullName])
            return replaced.includes(id) ? structuredClone(isolated.get(id).assertion) : assertion
        })
        suite.status = 'passed'
    }
    Object.assign(result, { numPassedTests: db.size, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
        retentionCoverage: { replaced, safeAssertions: isolated.size, capability, databaseReport: 'vitest-db-report.json', safeReport: 'vitest-safe-report.json' } })
    return result
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [databasePath, safePath, outputPath] = process.argv.slice(2)
    if (!databasePath || !safePath || !outputPath) throw new Error('database, safe and output report paths required')
    const database = JSON.parse(await readFile(databasePath, 'utf8')), safe = JSON.parse(await readFile(safePath, 'utf8'))
    const merged = mergeRetentionReports(database, safe)
    await writeFile(outputPath, JSON.stringify(merged, null, 2))
    console.log(`retention coverage: ${merged.retentionCoverage.replaced.length} exact skipped identities executed; ${merged.numPassedTests} total passed`)
}
