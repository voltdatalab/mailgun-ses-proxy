# Archive coverage preflight foundation — not apply integration

Status: **read-only, opt-in library foundation; not deployed**. The legacy CLI,
selection planner, coordinator and apply-context parser retain the 24-hour
backup/restore gate. There is no new CLI flag, evidence JSON bypass, scheduler,
or deletion path. `apply: true` is rejected by this preflight and every successful
result includes `applyEnabled: false`.

## Pipeline inspected

The script binds a runtime clock, Prisma database and named-lock provider to the
CLI. The CLI parses operational evidence (including a separate 15-minute DLQ
check) **before** loading manifest/private artifact/escrow. The planner and
coordinator reparse the legacy evidence. The apply context also reparses it,
validates canonical manifest, private binding/hash, escrow commitment and caps.
The descriptor-bound CLI escrow reader validates private file metadata, canonical
framing/hash/limits, and identity before/after batch reads. The applier binds this
source to the artifact, takes the named lock, and compares the actual complete
batch records with escrow under a Serializable transaction, deletes child-first,
and validates counts and postconditions before commit. None of these paths was
relaxed. Archive proof is not accepted by any of them.

## Separate validity model

`verifyNewsletterRetentionArchiveRestore` consumes two independent canonical
escrow line streams: archive subset and retained isolated-restore readback. It
checks complete framing, canonical encoding, checksum, row identities,
dependencies and counts using the existing bounded accumulator. The complete
commitments must match, including schema. The compatible restore-procedure
fingerprint must match an explicit expected fingerprint. The actual historical
restore timestamp is preserved; only invalid/future timestamps are rejected.

A successful comparison mints an immutable in-process capability backed by a
private WeakMap. A JSON receipt, cloned object or `verified: true` cannot replace
that readback. This capability is not persisted and is not an authorization.
To reuse a historical restore, a future trusted adapter must load independently
retained historical readback bytes and validated provenance, not rename archive
bytes as restore output. This module does not execute a restore.

`preflightNewsletterRetentionArchiveCoverage` re-verifies archive bytes against
that capability, expected schema/procedure and the private artifact. It rebuilds
the artifact from observed parent identities and **per-batch** child counts and
compares its hash, thereby binding to the exact canonical manifest and private
selection, not just aggregate counts. It enforces tenant/cutoff/policy/caps. An
independent current live subset stream must have the same complete commitment;
same-count changed contents, substituted identities and new/missing children fail.
Coverage, queue, proxy and DLQ checks must all be non-future and no older than
15 minutes; unhealthy queue/proxy, nonzero DLQ or unresolved orphans fail closed.
Unknown top-level/live evidence keys fail rather than silently choosing a mode.
No timestamp is rewritten and no backup/restore TTL is removed globally.

## Trust boundary and integration still missing

This is a validator for **trusted adapters**, not an authenticator of supplied
streams or dates. Its inputs must never be wired directly from evidence JSON.
Schema/procedure expectations must come from independently approved runtime
configuration, not the same untrusted receipt. Live streams/counts/health and the
clock must be gathered independently; the read-only result is a snapshot, not
transactional proof or permission to delete.

Only the existing bounded exact-selection canonical escrow format is supported
(512 MiB, 250,000 records, existing line/batch/message limits). A full historical
SQL dump or base+delta archive cannot be passed as this format. No production
payload was read and no real artifact/group/recipient identifiers are fixtures.

Before enabling reuse in apply, a separate reviewed change must provide:

1. A descriptor-bound, bounded streaming archive/base+delta adapter that verifies
   generation/chain transport and artifact integrity, restore provenance,
   compatible engine/schema/procedure, then derives the exact selected canonical
   subset and maps private identities without count-only membership assertions.
2. An independently bound historical restore readback source (or authenticated,
   content-bound persistent certificate with a reviewed trust model). The current
   in-process capability deliberately cannot be restored from JSON.
3. A fresh live subset, orphan/parity/late-event and operational-health collector.
   The trusted clock is refreshed after streams in this preflight; a future
   executor must also refresh health and coverage at each transaction.
4. Explicit versioned admission in CLI/planner/coordinator/apply **after binding**
   selection and proof, with regression tests preventing dropped JSON fields from
   choosing a permissive mode. Do not synthesize fresh backup dates to fit legacy
   parsers. Preserve locks, caps, child-first deletion, affected-count checks and
   exact transactional record comparison; preflight cannot replace them.
5. Apply-time current schema compatibility and exact subset readback, including
   concurrency/TOCTOU tests and same-count drift, plus separately approved wave
   authorization. Existing Serializable per-batch checks remain mandatory;
   multiple batches are not one all-or-nothing wave transaction.

## Rollout (separate authorization required)

No production rollout is part of this change. First review/test this foundation,
then separately review the adapters/admission integration and synthetic staging
restore/drift/concurrency tests. Continue using the configured **CapRover Method
3** workflow for any future authorized deployment; do not switch to tarball/CLI
or direct Docker changes. Keep archive reuse disabled until integration and
independent provenance checks are complete. CI security gates remain unchanged.

## Rollback

Because the new module is not imported by the production retention pipeline,
removing it restores the same legacy behavior; no schema/data migration is
needed. For any future separately authorized deployment, revert through the same
CapRover Method 3 workflow and keep apply disabled while investigating evidence
mismatches. A code rollback does not restore deleted rows: any future destructive
wave needs its own approved, independently verified recovery procedure and
post-restore readback. Do not delete archives as part of rollback.
