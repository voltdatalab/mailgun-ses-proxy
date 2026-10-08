import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

// Traverse the exact emitted runtime graph, not a hand-maintained allowlist.
async function runtimeGraph(entry) {
    const modules = new Map()
    async function visit(path) {
        if (modules.has(path)) return
        const source = await readFile(path, 'utf8')
        const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
        modules.set(path, emitted)
        const ast = ts.createSourceFile(path, emitted, ts.ScriptTarget.ES2022, true)
        for (const stmt of ast.statements) {
            if ((!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) || !stmt.moduleSpecifier) continue
            const specifier = stmt.moduleSpecifier.text
            if (!specifier.startsWith('.')) { assert.ok(specifier.startsWith('node:'), `external runtime dependency: ${specifier}`); continue }
            const target = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'))
            assert.doesNotMatch(target, /newsletter-retention-(?:applier|cli|runtime|coordinator|archive-preparation)\.ts|\/lib\/database/)
            await visit(target)
        }
        assert.doesNotMatch(emitted, /\b(?:deleteMany|\$transaction|createInternalHistoricalRetentionExecutor|executeNewsletterRetentionApply|eval)\b/)
    }
    await visit(resolve(entry))
    return modules
}
test('dedicated executable has no mutation/SQL/application-controller runtime dependency', async () => {
    const modules = await runtimeGraph('scripts/newsletter-retention-readonly-preflight.ts')
    assert.ok(modules.has(resolve('service/newsletter-retention-historical-acquisition.ts')))
    assert.ok(modules.has(resolve('service/newsletter-retention-secure-metadata.ts')))
    assert.ok(modules.has(resolve('service/newsletter-retention-historical-readonly-preparation.ts')))
})
test('real compiled executable refuses missing approved root and hidden apply/root overrides', async () => {
    assert.ok(process.env.TMPDIR, 'TMPDIR required')
    const scratch = await mkdtemp(join(process.env.TMPDIR, 'ses-preflight-entry-'))
    try {
        const graph = await runtimeGraph('scripts/newsletter-retention-readonly-preflight.ts')
        const repository = resolve('.')
        for (const [path, output] of graph) {
            const destination = join(scratch, path.slice(repository.length + 1).replace(/\.ts$/, '.js'))
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
            await writeFile(destination, output, { mode: 0o600 })
        }
        await writeFile(join(scratch, 'package.json'), '{"type":"module"}', { mode: 0o600 })
        for (const args of [[], ['--apply'], ['--root-file', '/not-trusted.json']]) {
            const result = spawnSync(process.execPath, [join(scratch, 'scripts/newsletter-retention-readonly-preflight.js'), ...args], { encoding: 'utf8', timeout: 5000, env: { PATH: dirname(process.execPath) }, input: 'not consumed' })
            assert.ifError(result.error)
            assert.equal(result.signal, null)
            assert.equal(result.status, 1)
            assert.equal(result.stderr, '')
            const receipt = JSON.parse(result.stdout)
            assert.equal(receipt.state, 'refused')
            assert.equal(receipt.stage, args.length ? 'arguments' : 'root')
            if (!args.length) assert.ok(receipt.missingPrerequisites.includes('independently_acquired_raw_readback'))
        }
    } finally { await rm(scratch, { recursive: true, force: true }) }
})
