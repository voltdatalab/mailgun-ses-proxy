import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm, readFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runSafeNamespace } from '../../scripts/retention-safe-subprocess.mjs'

// C unit harness exercises actual bootstrap functions with regular scratch files.
// This is NOT evidence of a successful kernel multi-UID mapping or ownership probe.
test('CI userns bootstrap guards, mapping order, exact readback and I/O failures', async () => {
    assert.ok(process.env.TMPDIR, 'TMPDIR required')
    const root = await mkdtemp(join(process.env.TMPDIR, 'userns-unit-'))
    try {
        const source = resolve('scripts/retention-ci-userns.c')
        const harness = join(root, 'unit.c'), binary = join(root, 'unit')
        await writeFile(harness, `
#define main bootstrap_main
#include ${JSON.stringify(source)}
#undef main
#include <assert.h>
int main(int argc, char **argv) {
    assert(argc == 3);
    assert(hosted_mode(0, 0, "true", "github-hosted", 3, "--ci-multi-uid"));
    assert(!hosted_mode(1003, 1003, "true", "github-hosted", 3, "--ci-multi-uid"));
    assert(!hosted_mode(0, 1003, "true", "github-hosted", 3, "--ci-multi-uid"));
    assert(!hosted_mode(0, 0, NULL, "github-hosted", 3, "--ci-multi-uid"));
    assert(!hosted_mode(0, 0, "true", "self-hosted", 3, "--ci-multi-uid"));
    assert(!hosted_mode(0, 0, "true", "github-hosted", 2, "--ci-multi-uid"));
    assert(!hosted_mode(0, 0, "true", "github-hosted", 3, "--other"));
    assert(exact_map("         0          0          2\\n"));
    assert(!exact_map("0 0 1\\n"));
    assert(!exact_map("0 0 3\\n"));
    assert(!exact_map("0 1 2\\n"));
    assert(!exact_map("0 0 2\\n2 2 1\\n"));
    assert(!exact_map("0 0 2x"));
    // Same namespace must be rejected BEFORE any map write.
    assert(map_child(getpid()) == -1);
    int dir = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    assert(dir >= 0);
    int result = initialize_maps(dir);
    close(dir);
    return result == atoi(argv[2]) ? 0 : 1;
}
`)
        const built = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', harness, '-o', binary], { encoding: 'utf8' })
        assert.equal(built.status, 0, built.stderr)
        for (const [name, files, expected] of [
            ['success', { uid_map: '', gid_map: '', setgroups: 'allow' }, 1],
            ['uid-already-mapped', { uid_map: '0 0 1\n', gid_map: '', setgroups: 'allow' }, 0],
            ['gid-already-mapped', { uid_map: '', gid_map: '0 0 1\n', setgroups: 'allow' }, 0],
            ['missing-setgroups', { uid_map: '', gid_map: '' }, 0],
            ['bad-setgroups-readback', { uid_map: '', gid_map: '', setgroups: 'allow-extra' }, 0],
            ['missing-gid', { uid_map: '', setgroups: 'allow' }, 0],
            ['oversized-read', { uid_map: 'x'.repeat(128), gid_map: '', setgroups: 'allow' }, 0],
        ]) {
            const dir = join(root, name)
            await mkdir(dir)
            for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text)
            const run = spawnSync(binary, [dir, String(expected)], { encoding: 'utf8' })
            assert.equal(run.status, 0, `${name}: ${run.stderr}`)
            if (expected === 1) {
                assert.equal(await readFile(join(dir, 'uid_map'), 'utf8'), '0 0 2\n')
                assert.equal(await readFile(join(dir, 'gid_map'), 'utf8'), '0 0 2\n')
                assert.equal(await readFile(join(dir, 'setgroups'), 'utf8'), 'deny\n')
            } else {
                assert.equal(await readFile(join(dir, 'uid_map'), 'utf8'), files.uid_map)
                if ('gid_map' in files) assert.equal(await readFile(join(dir, 'gid_map'), 'utf8'), files.gid_map)
            }
        }
        // Reject a selected mapping-file symlink without touching its target.
        const linked = join(root, 'linked'), untouched = join(root, 'untouched')
        await mkdir(linked)
        await writeFile(untouched, 'allow')
        await writeFile(join(linked, 'uid_map'), '')
        await writeFile(join(linked, 'gid_map'), '')
        await symlink(untouched, join(linked, 'setgroups'))
        assert.equal(spawnSync(binary, [linked, '0'], { encoding: 'utf8' }).status, 0)
        assert.equal(await readFile(untouched, 'utf8'), 'allow')
        assert.equal(await readFile(join(linked, 'uid_map'), 'utf8'), '')
        assert.equal(await readFile(join(linked, 'gid_map'), 'utf8'), '')
        const launcher = join(root, 'bootstrap')
        const compiled = spawnSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', launcher], { encoding: 'utf8' })
        assert.equal(compiled.status, 0, compiled.stderr)
        // No credentials/root elevation: this invocation must fail before fork.
        const refused = runSafeNamespace(['--ci-multi-uid', '/bin/true'], { launcher, encoding: 'utf8', env: {} })
        assert.equal(refused.status, 1)
        assert.match(refused.stderr, /requires explicit ephemeral hosted CI root mode/)
    } finally { await rm(root, { recursive: true, force: true }) }
})
