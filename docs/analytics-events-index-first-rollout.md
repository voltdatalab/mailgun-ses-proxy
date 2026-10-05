# Analytics events: index-first rollout gate

Scope: `/v3/[siteId]/events` only. This branch changes the read path, not the retention job, SES sending, schema or database volume. It has **not** been deployed.

## Preflight (read-only)

1. Confirm `idx_notifications_type_created_id (type, created, id)`, `NewsletterMessages_messageId_key` and `NewsletterBatch` primary key in the target DB. The first is part of the existing Prisma migration. No online index build is included.
2. In staging, compare the previous and candidate responses for one/multiple event types, both orders, `start`, duplicate timestamps, cursor continuation, tenant isolation, and Mailgun-formatted payload. Compare ordered IDs and `paging.next`; do not log recipient addresses or raw events.
3. Run `npm run typecheck`, the events pagination/route tests, and lint. Run a bounded read-only `EXPLAIN` for representative queries; inspect scanned rows, file sorting and duration, including an empty time range. Verify that the query timeout returns a retryable error rather than missing events.
4. Check app/DB health, analytics error rate, query duration, processlist, available disk and queues before considering a production change.

## Deployment and rollback (approval required)

Preserve the app's existing CapRover deployment method/configuration (including dashboard Method 3 if that is the current method). Do not substitute CLI/tarball without explicitly announcing it. Deploy the tested branch in staging first. For production, record the currently deployed branch/commit, plan a short observation window, then request explicit approval. If analytics errors, timeouts, pagination parity or DB pressure regress, redeploy the recorded original branch/commit by the same method and verify readback/health. Do not stop the DB or run `KILL QUERY` as an implicit step.

This optimization only reduces read pressure. The 466-message retention wave still requires renewed Ghost/queue parity, exact escrow, isolated restore and fail-closed counts before a separately approved deletion. Deletes alone do not shrink the InnoDB volume.
