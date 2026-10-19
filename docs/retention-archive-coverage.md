# Historical archive preparation — apply remains refused

Status: **read-only executor preparation implemented; real payload consumption
and restore not exercised; not deployed**. The script
and CLI now have an explicit `--prepare-historical-archive` route. It consumes a
bounded RAM-only base/delta stream, binds the exact selected parent and children,
reads the live selection under Serializable isolation, and feeds the existing
archive coverage validator. Every successful preparation returns
`applyEnabled: false`, `admission: "refused"`. It does not create escrow files,
private artifact files, backup/restores, or delete rows.

## Executor contract

The legacy script binds the real clock, Prisma database, repository schema hash
and named-lock provider. The legacy CLI, planner, coordinator and apply-context
parser retain their **24-hour backup/restore TTL**. Existing apply still checks
manifest/private artifact/escrow commitments, holds the named lock, compares
complete records under Serializable isolation, deletes child-first, checks
affected counts and validates postconditions before commit. These paths were not
relaxed. No synthetic fresh timestamps or new SQL deletion path were introduced.

The explicit preparation mode branches before legacy backup/restore parsing.
Its operational evidence contains `health` (`queueCheckedAt`, `proxyCheckedAt`,
`queueHealthy`, `proxyHealthy`) and `dlq` (`checkedAt`, `healthy: true`,
`messageCount: 0`). Optional historical `backup`/`restore` metadata is ignored,
not promoted to proof. Unknown top-level/health/DLQ fields are rejected. The CLI
rereads the independently supplied health/DLQ evidence file **after** archive
streaming and the live transaction; it does not generate or refresh timestamps.
Stale evidence still refuses preparation. Health, DLQ and coverage are checked
against the trusted clock after streams, with the existing 15-minute boundary.
`--apply`, all output-file options, and legacy
apply-only arguments are forbidden in preparation mode.

The preparation holds the same named lock as apply, loads the archive before
selecting live rows, and requests a Serializable transaction containing:

1. An exact group parent-set query (at most two IDs; exactly one required).
2. The existing escrow loader for the bound parent, with complete M/E/N rows,
   exact child counts, unique keys, correlations and unresolved-orphan checks.
3. Canonical escrow serialization into RAM only.

The repository schema fingerprint is checked both before and after that live
read. Coverage is timestamped at read start, not artificially refreshed at the
end. The shared preflight compares canonical archive/live commitments and
reconstructs the private binding from observed identities and per-parent counts.
Resources and lock are released on success and failure. The result is a
preparation snapshot, **not** transaction-time authorization.

## Streaming format and bounded adapter

`service/newsletter-retention-historical-archive.ts` supports only the fixed
historical `rows.base64.tsv.gz` format:

- `B!<base64 vector>!`, then M, E and N phases, newline terminated.
- Vector fields are separated by byte `0x1f`; each field is canonical base64 or
  `-` for SQL NULL. Empty base64 is an empty string, not NULL.
- Column order is fixed by exported `HISTORICAL_COLUMNS`, matching the historical
  row-stream helper. Unknown tags, wrong field counts, invalid UTF-8/base64,
  duplicate row IDs, unordered phases and incomplete framing fail closed.
- SQL datetime strings are interpreted as UTC. Fractions beyond millisecond
  precision are accepted only when discarded digits are zero; invalid or lossy
  dates are refused. UTC source provenance remains an operator prerequisite.
- Delta contains **N afterimages only**, with unique IDs. Selected notifications
  are replaced/added, not concatenated. A selected notification cannot be moved
  outside the selected message set by a delta afterimage.

The adapter fully streams/hashes **compressed base and delta bytes**, including
excluded rows, and checks manifest byte counts/hash, pinned manifest hashes,
base/delta generation IDs, delta base generation, base rows hash, base index
hash and exact per-tag base counts plus delta row counts. SQLite hashes are chain
bindings, not substitutes for streaming the archived payload bytes. Limits:

- Base + delta **compressed total: 8 GiB**, with each object's exact byte count
  and SHA256 independently pinned through the raw manifest hash.
- Base + delta **decompressed total: 64 GiB**, enforced while streaming; this is
  a work/expansion ceiling, not a RAM allocation. Decompressed size is not in the
  existing commitment, so an expansion over this ceiling can only fail in-stream.
- Base + delta **8,000,000 rows**, with mandatory base `counts.B/M/E/N` and delta
  `deltaCounts.new/changed`; over-capacity commitments fail before payload reads.
- **1 MiB compressed chunks and framed lines**; gunzip uses its bounded 16 KiB
  output chunks. No excluded row payload survives its callback.
- Selection **20,000 rows / 8 MiB UTF-8 JSON row bytes**, enforced as each row is
  retained/replaced (including errors and notifications). Canonical archive and
  live buffers each have separate **16 MiB** ceilings and bounded line counts.
  These caps are additional to legacy canonical/policy limits; fixtures can only
  lower, never raise the hard ceilings.

Duplicate checking uses a fixed `Uint32Array` of eight SHA256 words per row,
not a global Set of identity strings. An in-place heapsort compares all eight
words and rejects repeated digests at end of each object; collisions also reject
conservatively. IDs within each phase need **not** be ordered. Base and delta
identity domains are separate so N afterimages may replace base IDs. Sort costs
O(n log n) time / O(1) auxiliary RAM. No disk or O_TMPFILE is used.

The non-secret locally inspected published metadata is **4,646,269,833 compressed
bytes / 6,130,269 base rows** (`B=1989,M=1848471,E=0,N=4279809`). It fits these
ceilings; its fixed base digest storage is **196,168,608 bytes**. The maximum
aggregate digest backing storage is **256,000,000 bytes** (base + delta, even if
GC has not reclaimed the base array). Selection maps, decoded transient rows,
canonical strings, parser copies and Node/V8/DB buffers are additional bounded
work structures, not part of that digest number. UTF-8 budgets are not exact
V8 heap/RSS promises: JS strings may use two bytes per code unit and object
headers add overhead. No full-scale RSS or runtime benchmark has been performed.
The DB driver can allocate its returned live rows before the preparation's
serialization budget rejects them; there is no claimed hard process-RSS limit.

The group SHA-256 is pinned in configuration; only exactly one matching parent
is supported, and its tenant, cutoff, children and caps are bound. A real selected
wave with a line over 1 MiB or selection over these budgets is intentionally
**refused**, not partially admitted. Actual expansion/line maxima, real delta
commitments, independent readback, and full-scale runtime/RSS remain unverified.

`schemaFingerprint` and fixed columns must be independently approved; matching
a repository schema hash is not itself a query of production information_schema
or proof of the restore engine/version. This implementation does not claim those
operational attestations from a count-only historical receipt.

## Runnable RAM-only transport

`service/newsletter-retention-archive-stream-source.ts` is wired into
`scripts/newsletter-retention.ts` using the explicitly configured environment
variable `NEWSLETTER_RETENTION_HISTORICAL_BINDING_FILE`. The binding file is
read through the existing descriptor-bound private JSON reader. It contains
**exactly**:

```
baseGenerationId, deltaGenerationId,
baseManifestSha256, deltaManifestSha256, baseIndexSha256,
schemaFingerprint, columns, batchGroupSha256,
expectedProcedureFingerprint
```

These are operator-pinned metadata, not inferred from a restore receipt. No
`restoreProof`, self-attestation, payload paths or source commands are accepted
in this file. The procedure expectation is reserved for independently verified
readback; the built-in stdin transport does not mint any such capability.

The stdin envelope is binary, with no filesystem payload staging:

```
uint32-BE baseManifest byte length
uint32-BE deltaManifest byte length
raw baseManifest bytes
raw deltaManifest bytes
exact base rows.base64.tsv.gz bytes
exact delta rows.base64.tsv.gz bytes
EOF
```

Manifest lengths are bounded to 1 MiB each. Pinned hashes are checked before
using manifest row sizes. The stream enforces base-before-delta access,
truncation and trailing-byte refusal; individual input chunks are bounded to
1 MiB. The adapter validates the gzip contents and commitments. Source cleanup
closes the input iterator. A future separately authorized producer may pipe
existing archive bytes directly in RAM; this change installs no SFTP/SSH client,
executes no remote commands and creates no source-side payload files/O_TMPFILE.

After the normal build, the invocation shape is:

```
NEWSLETTER_RETENTION_HISTORICAL_BINDING_FILE=/approved/private-binding.json \
  node dist/scripts/newsletter-retention.js \
  --prepare-historical-archive --site-id <tenant> --cutoff <UTC-ms> \
  --evidence-file /approved/live-health.json
```

Supply the above envelope on stdin from an approved RAM/stream producer. Without
the configured binding source the command refuses with
`historical archive trusted streaming source is not configured`. This command
was **not executed against production**. Its transport, adapter and CLI route
were exercised with synthetic in-memory fixtures and transaction delegates.

## Real remaining admission gap

Historical receipts containing `restore: "validated_chain"`, manifest hashes,
engine/container/volume metadata and counts do **not** contain an independent
content-bound restore readback. The built-in source therefore returns successful
coverage preparation with reason `independent_restore_readback_missing`, without
minting a restore proof. A retained container/volume is a possible source for a
future authorized readback, not a capability by itself.

A trusted in-process source can supply a capability originating from
`verifyNewsletterRetentionArchiveRestore`, which compares independent canonical
archive/readback streams and expected schema/procedure. The existing private
WeakMap refuses cloned or JSON/self-attested proof objects. Preparation then
feeds `preflightNewsletterRetentionArchiveCoverage`; even valid proof currently
returns refusal `archive_apply_admission_not_enabled`. No versioned **apply**
admission was introduced because production proof/provenance remains absent.
The transport's versioned preparation report must not be confused with admission.

Before destructive reuse, separately review independent restore provenance and
readback (or an authenticated content-bound certificate), actual compatible
engine/schema, fresh exact parity and late-event/queue/DLQ collectors, explicit
wave authorization, and apply-time health/schema/coverage renewal. Preserve the
existing Serializable/precommit comparison and counts/postconditions. Current
successful external coverage/parity/health checks do not fill the restore-proof
gap or authorize apply.

## Synthetic verification

Tests exercise the runtime-equivalent stdin stream -> adapter -> CLI preparation
-> admission refusal, B/M/E/N selection, delta afterimages, excluded content
integrity, malformed/truncated envelopes, chain/schema/generation mismatch,
cloned restore capabilities, same-count drift, new children, parent-set drift,
orphans, stale clocks, schema changes, named-lock overlap and cleanup. Adapter
artifacts are also passed to the existing protected applier: stale historical
legacy evidence fails before transaction; fresh **synthetic** legacy evidence
with concurrent content drift fails Serializable comparison before any delete.
Those fresh fixture dates are not generated production evidence or a bypass.

Both TypeScript projects and touched-file ESLint were run. The broader retention
suite still exposes the known local descriptor-bound filesystem/TOCTOU failures;
no filesystem guards or tests were relaxed. No production payload was read, no
real identifiers are fixtures, and dependencies/lockfiles were not changed.

## Rollback

Disable the explicit preparation configuration or revert these code changes.
Legacy TTL/apply behavior is unchanged; there is no schema/data migration. Any
future authorized deployment/rollback must use the configured CapRover Method 3
workflow. Code rollback cannot restore deleted data; no archives should be
removed as part of rollback.
