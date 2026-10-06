# Dependency security remediation — 2026-10-06

Scope: independent integration-branch change, not a production rollout or retention apply.

## Changes

- Raise Next.js to 16.3.8, eslint-config-next to 16.3.8 and Vitest to 4.1.11; remain on the existing major lines.
- Replace vulnerable overrides with sharp 0.35.5 and fast-uri 3.1.8; pin mysql2 3.24.5 to address the transitive Prisma dependency without upgrading Prisma to a release candidate or another major.
- Refresh compatible locked browserslist, brace-expansion and fast-copy dependencies.
- Regenerate Bun's lockfile with the CI-pinned Bun 1.3.6, using package-lock.json as the starting point.
- Use Next.js router navigation for the existing dashboard newsletter button to comply with the updated Next.js ESLint rule. The destination remains `/dashboard/newsletters`.

## Measured local verification

- Initial complete `npm audit --package-lock-only --json`: 18 findings (1 critical, 13 high, 4 moderate).
- Final `npm audit --omit=dev --json`: **0 findings**, exit 0.
- Final complete `npm audit --json`: **7 high findings**, exit 1; all seven package entries lead to the unresolved `braces` advisory.
- `npm run lint` and `npm run typecheck`: passed.
- Node 22.23.3 production build, including generated Prisma client and retention helper compilation/artifact assertions: passed.
- Node 22.23.3 complete test suite: 508 passed, 4 failed, 2 skipped. Failures are the private descriptor-bound file tests in `newsletter-retention-cli.test.ts` and `newsletter-retention-cli-toctou.test.ts`; the same four fail under the host's Node 26.7.0. No tests or filesystem safety checks were disabled. Remote CI must verify these independently.
- The compiled retention link-helper smoke test also fails on this host with `newsletter retention output file could not be created`; a successful build does not certify the smoke test.
- Bun 1.3.6 frozen lockfile check: passed. Remote bun-parity remains required.

## Unresolved security gate

GHSA-vfj7-8cjw-p6xm (braces stack-exhaustion denial of service through deeply nested patterns) covers `<=3.0.3`. GitHub's advisory API reports `first_patched_version: null`, and npm's published `latest` tag remains 3.0.3 at inspection time.

The remaining high-severity package entries are braces, chokidar, nodemon, micromatch, fast-glob, @next/eslint-plugin-next and eslint-config-next. These are development/tooling paths, not findings in the production dependency audit. This distinction is not a waiver: the existing complete audit gate remains unchanged and blocked. Do not accept npm's suggested historical major downgrades, run `audit fix --force`, suppress the advisory, or claim CI is green.

A separate decision is needed if no upstream patch becomes available: review a maintained replacement for the affected tooling, or an explicitly approved, time-bounded security exception with a concrete threat model. Neither is included or implicitly authorized here.

## Rollout and rollback

Do not push to `caprover`, deploy, run migrations or delete production records as part of this PR. Validate this dependency change together with analytics PR #28 in isolated staging after the full CI gate is resolved. Production promotion requires its own approval and the existing CapRover Method 3 path.

Before any approved rollout, record the currently deployed branch and commit. Roll back using that original branch/commit through the same deployment method; do not treat this dependency-only change as authorization to alter deployment configuration.
