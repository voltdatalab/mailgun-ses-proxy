# Branch governance

This repository uses two long-lived branches with distinct responsibilities.

## `main`: integration

- Default branch for development and upstream synchronization.
- Does not deploy to CapRover.
- Changes arrive through pull requests with the required CI checks green.
- Short-lived topic branches are deleted after merge.

## `caprover`: production

- Exact source tracked by the CapRover Method 3 applications.
- A push to this branch is a production deployment event.
- Production changes are promoted by pull request from `main` to `caprover`.
- Required CI checks must pass before merge.
- Force pushes and branch deletion are prohibited.

## Promotion procedure

1. Merge reviewed work into `main` after all required checks pass.
2. Open a promotion pull request from `main` to `caprover`.
3. Confirm the promotion diff contains only the intended commits.
4. Require the four CI jobs to pass: `quality`, `mysql`, `mariadb`, and `bun-parity`.
5. Merge only during an approved deployment window. The resulting `caprover` push triggers Method 3.
6. Verify the deployed commit, build status, health endpoints, worker telemetry, and queue backlog.
7. For high-risk changes, use a reversible canary and a bounded observation window before declaring promotion complete.

## Emergency changes

- Do not force-push either long-lived branch.
- Create a short-lived hotfix branch from `caprover` and open a pull request back to `caprover`.
- After production validation, merge or cherry-pick the same fix into `main` to prevent drift.
- Preserve the previous production commit with an annotated archive tag before a high-risk promotion.

## Deployment invariants

- CapRover applications must remain configured for branch `caprover`.
- Use CapRover Method 3 for application deployment; do not deploy with direct Docker commands.
- Never publish secrets, webhook tokens, queue URLs, database URLs, or API keys in issues, pull requests, logs, or artifacts.
- A successful GitHub Actions run is necessary but not sufficient: production health and queue telemetry must also be verified.