# Historical executor: owned observations and durable one-shot approval (draft)

Internal, unactivated increment. No commit, push, deploy, real key/root provisioning,
SQL execution, production DELETE/OPTIMIZE, resume or new apply CLI was performed.
The existing read-only historical-age reuse work is preserved. Apply acquisition
TTL remains at most 24 hours; diagnostic reuse does not admit the original 7 October
report for apply on 12 October.

## Connected changes

`createInternalHistoricalRetentionExecutor` remains the only historical executor.
The shared six-collector checker captures each method and receiver before scheduling,
and structured-clones each individual result in its completion continuation, before
waiting for other collectors. Ghost recipients and the complete main/DLQ nested queue
inventory are private snapshots, as are proxy, pressure, schema and correlation.
The existing gate assertion and freshness rules remain shared with read-only finalization.

The executor now requires a trusted `authorization` port with an independently
approved identity, complete scope commitment and irreversible `claim()`. There is
no RAM-only fallback. The commitment covers the full archive binding, policy,
independent wave/schema approval, acquisition trust root including TTL/public key,
complete queue inventory and pressure/freshness limits. Each source-root property,
port, scalar identity/scope and method is read once; methods retain their original
receivers. There is no top-level spread that incidentally invokes getters again.
Only after the private data snapshot and captured ports are complete is the
independent approval commitment compared against `historicalAuthorizationScope`
of that final private root, synchronously before any await. An accessor side effect
cannot substitute an unapproved queue inventory between checking and copying.
Identity and scope are not read from requests, archives, reports or environment flags.

Ordering: private original acquisition bytes before the first await; lock; connected
stream verification; exact selected-wave approval; original acquisition authentication;
synchronous local reservation; durable exclusive claim; cancellation/deadline and
original-authentication recheck; gates; private capability; existing transaction/core.
The original private signed bytes are reauthenticated after each awaited gate round,
including before transaction entry, inside the transaction and before mutation.
Caller envelope substitution or buffer poisoning cannot refresh or replace them.

A successful claim is never returned after gate refusal, cancellation, rollback,
unknown commit, successful commit or failed postcommit readback. A new factory cannot
replay it. Unsigned/wrong-key/malformed attempts do not reach the durable claim.
Ledger absence, scope mismatch, invalid identity, rejection or unavailable storage
fail closed before any gate, capability or transaction. Receipts expose no ledger
path/identity/state; existing outcome honesty and cleanup semantics are preserved.

The asynchronous claim acknowledgement is raced against the existing monotonic
whole-work deadline and its internal signal (including external cancellation).
Refusal enters existing bounded source cleanup and lease release without waiting
for a never-settling acknowledgement. Both late fulfillment and rejection keep
handlers attached and cannot continue into gates or rearm the local reservation or
ledger marker. This bounds a cooperative JS promise wait, not the underlying claim
operation: a synchronous blocked Linux filesystem syscall blocks the event loop
and cannot be interrupted by an AbortSignal or JS timer. The trusted lease release
port must also settle; this increment adds no universal lock-adapter deadline.

## Filesystem adapter and custody boundary

The Linux-only adapter is separate from read-only modules. Independent offline
provisioning creates `<identity>.approved`; opening a port requires that exact
provision already exist and match the approved identity/scope. Re-provisioning the
same identity cannot replace its binding or remove its consumed marker. The executor
never calls the provisioning function. No real application root is wired to it.

Each operation traverses ancestors through pinned descriptors under `/proc/self/fd`,
with `O_DIRECTORY|O_NOFOLLOW`, rejecting symlinks, foreign owners and group/other-writable
ancestry. The ledger leaf must belong to the current UID and have exact mode 0700.
Approval records require regular single-link files, current ownership, exact mode
0400, bounded descriptor reads and exact canonical bytes. The port pins directory
and approval device/inode; claim validates both again. Claims use
`O_CREAT|O_EXCL|O_NOFOLLOW`, validate their descriptors/linked inode, fsync the file
and directory, then recheck the directory path. Every descriptor is closed. No
existing ancestor is chmod/chowned. No code unlinks, resets or automatically rearms
an approval, including after partial writes, errors or ambiguous fsync outcomes.
Any existing consumed entry refuses replay even if its contents are incomplete.

**Independent operational approval is still required** for the persistent backing
filesystem, absolute directory, ownership, identity and scope, and its custody
across restarts. Do not put it in a container ephemeral layer or rotate to a fresh
directory on restart. Do not restore an older ledger backup as though an approval
were unconsumed, invent a fresh identity for the same authorization, or permit the
same UID/operator to delete markers. Ownership/mode/inode checks cannot prevent a
privileged custodian, same-UID adversary, changed mount namespace or storage rollback
from replacing an entire ledger between processes. Pins are process-local; restart
requires the same independently controlled persistent directory. Local O_EXCL and
fsync semantics are assumed; network filesystems and hardware flush guarantees have
not been certified. Normal process exit/reconstruction is tested, not physical
power-loss, kernel crash or interruption at every fsync boundary. A partial marker
test proves refusal of an actual incomplete file, not a crash simulation certificate.

## Executed evidence (local Node v26.7.0)

- **TOCTOU RED:** 167 passing / 36 failing / 0 pending in the connected historical
  suite before collector ownership was fixed. Each of six collector references
  was mutated in both directions at all three executor gate rounds. The initial
  reproduction used freshness fields; final regressions also exercise collector-
  specific scalar/nested values, including DLQ visible 1 -> 0. Current 36 cases pass.
- **Replay RED:** after the collector fix, 202 passing / 1 failing / 0 pending;
  reconstructing the old executor admitted a second commit. The durable port fixes it.
- **Focused GREEN:** four complete files, **396/396**, no pending: historical
  preparation 216, actual ledger 16, read-only preflight 88, CI report consumer 76.
- The adapter runs on real private files under `/fixtures` in the existing offline
  user/mount/network/PID namespace runner. Native Node subprocesses prove that an
  irreversible claim persists after process exit, re-opening and re-provisioning;
  eight independently started processes yield exactly one winner and seven refusals.
- A separate Node/Vitest child reconstructs the **actual executor** using the same
  durable directory, independently reconstructed complete scope, synthetic signing
  principal and actual archive stream. It refuses at admission with zero collectors,
  transactions, mutation delegates and postcommit reads. Its selected assertion is
  explicitly checked as passing; filter-excluded assertions are not counted as proof.
- Connected new-factory regressions cover success, gate refusal, rollback-confirmed,
  commit-unknown, postcommit failure and cancellation after authorization. Queued
  distinct factories, exclusive mutex ordering and deliberately overlapping-lock
  defense are tested separately. Valid retries after unsigned/wrong-key/malformed
  attempts remain possible.
- **Full suite is NOT GREEN:** 24 files, 632 enumerated assertions, **631 passed / 1
  failed / 0 pending**. The sole existing failure is foreign-owner `chown` EINVAL
  in the one-UID namespace. No mapping, ownership guard or skip was changed to hide it.
- Both repository TypeScript projects and full ESLint (`--max-warnings=0`) pass;
  `git diff --check` passes. Node script suites: **270/270**, including the two
  read-only graph/entry checks and synthetic integration-report validation.
- The real server TypeScript project was emitted into scratch with incremental
  compilation disabled. Its read-only executable has **16 runtime modules**, no
  historical applier or new durable-ledger module, and no filesystem mutation
  functions. The emitted command in a minimal environment refuses absent root,
  `--apply` and hidden `--root-file` overrides. The legacy pure escrow-writer-named
  module already in that graph contains no filesystem writer.

Full command:

```
node scripts/test-newsletter-retention-safe-filesystem.mjs tests/service/newsletter-retention*.test.ts --reporter=json
```

Local reports and build probe are retained under the active profile's scratch
namespace (`historical-red.json`, `historical-ledger-red.json`,
`historical-verified-focused.json`, `historical-verified-full.json`,
`historical-verified-node.txt`, `historical-ledger-built-graph.json`). Counts were
parsed from the reports and reconciled with every enumerated assertion, not inferred.

## SPEC follow-up: connected claim wait and final private-root capture

- RED command: `node scripts/test-newsletter-retention-safe-filesystem.mjs tests/service/newsletter-retention-historical-preparation.test.ts --reporter=json`.
  Actual report: **217 passed / 5 failed / 0 pending**. Four signed, complete-stream
  claim cases exceeded the 150ms observation bound despite wholeMs=20 or external
  cancellation; the capture case observed two claim getter reads rather than one.
  The extra first-read scope-mismatch case already refused and remains regression
  coverage, not an additional reproduced RED failure.
- Final focused command adds the complete ledger, read-only preflight and CI-report
  files to that launcher: **402/402 passed / 0 pending** (222 preparation, 16 ledger,
  88 preflight, 76 consumer). Both TypeScript projects, full ESLint and diff check pass.
- The four claim regressions use the real Linux ledger to reserve irreversibly
  **before** holding acknowledgement unresolved. They observe source return and lease
  release before manually fulfilling/rejecting it, and a new actual executor refuses
  both before and after that late completion. All six collectors, transaction,
  mutation delegates and postcommit read remain untouched; the same factory refuses
  at lock and the independently reopened ledger still refuses a claim.
- Getter coverage counts every source-root property once, checks the bound claim
  receiver, admits only the original approved main/DLQ inventory, and refuses a
  getter-induced scope mismatch before lock/consumption. These are synthetic signed
  fixtures on a real private filesystem, never operational approval or production proof.
- Reports: active-profile scratch `spec-two-findings-red-20261012.json`,
  `spec-two-findings-green-20261012.json` (first 222/222 GREEN), and
  `spec-two-findings-final-focused-20261012.json` (final four-file verification).
  The older full-suite evidence above predates this follow-up; no new full-suite
  certification is asserted here. No shared gate/deadline port or CI workflow changed.

## CI and remaining verification

The required CI launcher explicitly includes the real ledger suite in the isolated
phase. Its report consumer requires every ordinary ledger assertion to have an exact
passing isolated counterpart and does not reconcile skipped ledger tests. Existing
foreign-owner, teardown and 22 exact legacy filesystem-skip reconciliation gates
remain mandatory. Synthetic report fixtures test this consumer but do not certify
hosted namespace capability or real SQL.

The dedicated SQL integration harness now provisions a real disposable private
ledger for each synthetic case, connects the mandatory port and cleans only its
own ledger fixture directories. That harness was typechecked, not executed locally.
Hosted CI uses Node 22; this local evidence is Node 26, not a hosted Node-22/runtime,
SQL-engine or storage crash certification. Independent specification/security and
quality reviews by the parent are still required before publication. Production
composition, custody approval, real evidence acquisition and activation remain
unprovisioned and unauthorized.
