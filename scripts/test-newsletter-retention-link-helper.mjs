import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'production'

const { writeNewsletterRetentionJsonFileExclusive } = await import(
    '../dist/service/newsletter-retention-cli.js'
)

const directory = await mkdtemp(join(tmpdir(), 'newsletter-retention-link-helper-'))
const output = join(directory, 'artifact.json')

try {
    await writeNewsletterRetentionJsonFileExclusive(output, { stable: true }, 0o600)
    await writeNewsletterRetentionJsonFileExclusive(output, { stable: true }, 0o600)

    let rejectedDifferentContent = false
    try {
        await writeNewsletterRetentionJsonFileExclusive(output, { stable: false }, 0o600)
    } catch {
        rejectedDifferentContent = true
    }
    if (!rejectedDifferentContent) {
        throw new Error('link helper overwrote a pre-existing output')
    }

    const metadata = await stat(output)
    if ((metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1) {
        throw new Error('link helper published unexpected output metadata')
    }
    if (await readFile(output, 'utf8') !== '{"stable":true}\n') {
        throw new Error('link helper published unexpected output content')
    }
} finally {
    await rm(directory, { recursive: true, force: true })
}
