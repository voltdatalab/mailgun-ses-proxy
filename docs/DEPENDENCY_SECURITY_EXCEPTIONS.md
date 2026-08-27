# Dependency-security exceptions

This file records temporary dependency overrides that intentionally cross an upstream package's declared version range. They are not a relaxation of CI security checks.

## `deepmerge-ts@8.0.2`

`prisma@7.10.0` depends on `@prisma/config@7.10.0`, which exact-pins
`deepmerge-ts@7.1.5`. That version is affected by
[CVE-2026-40345 / GHSA-ggr8-5vv4-36mx](https://github.com/prisma/orm/issues/30052).
The fix is available only in `deepmerge-ts` 8.x.

The repository therefore uses a temporary `package.json` override for
`deepmerge-ts@8.0.2`:

- Bun 1.3.6 does not support a nested override scoped to `@prisma/config`, so
  the override must be global for npm and Bun lockfile parity.
- The resolved graph contains this package through Prisma configuration only.
  The upstream issue identifies the `deepmerge` call site as the merger for
  this repository-owned `prisma.config.ts`; it does not process untrusted
  request data.
- The exception is validated by frozen Bun installation, `prisma generate`,
  lint, typecheck, tests, build, and both npm high-severity audit gates.

Remove this override as soon as Prisma publishes a supported release that
uses `deepmerge-ts` 8.x, then regenerate both `package-lock.json` and
`bun.lock` and rerun the full validation matrix.
