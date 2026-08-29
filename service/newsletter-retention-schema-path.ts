import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate the Prisma schema relative to the retention runner, not the process cwd.
 * The runner is emitted from scripts/ to dist/scripts/, so compiled output needs
 * one additional parent traversal to reach the application root.
 */
export function resolveNewsletterRetentionSchemaPath(entrypointUrl: string): string {
    const runnerDirectory = dirname(fileURLToPath(entrypointUrl))
    const applicationRoot = basename(dirname(runnerDirectory)) === 'dist'
        ? resolve(runnerDirectory, '../..')
        : resolve(runnerDirectory, '..')
    return resolve(applicationRoot, 'prisma/schema.prisma')
}
