# SES existing-evidence READ-ONLY preflight

## Implemented boundary

Dedicated executable: `scripts/newsletter-retention-readonly-preflight.ts`, built by the existing server TypeScript project. After an ordinary build, invoke `npm run retention:newsletter:preflight` (equivalent to `node dist/scripts/newsletter-retention-readonly-preflight.js`). **No arguments** are accepted: apply, output, key, root-file and dynamic module overrides are refused before reading stdin. This process does not import the apply CLI/controller, applier, database client, Prisma initialization, production environment loader or SQL driver. No lock, action port, transaction or postcommit dependency is accepted by its root.

`executeHistoricalPreflightCommand` is the executable's consuming use case, not a disconnected verifier. A separately provisioned synthetic root has positively exercised it with genuine mode0400 metadata files through the shared secure descriptor adapter → original-byte signature verification → complete RAM-only envelope/base/delta/trailer selection → exact independent wave/policy/schema approval → existing six gate validators → `preflight_verified`. That status is a diagnostic only: **not `apply_ready`, an apply capability, restore certification, or permission to delete**. No archive rows, recipient emails, source paths, raw IDs or private exception text are returned. stdout is the bounded metadata-only report; no payload/report file writer is wired.

Shared code, not parallel validation:

- `newsletter-retention-secure-metadata.ts`: unchanged parent traversal, owned/single-link mode0400 descriptor identity, bounded capacity, nanosecond stat + double exact-byte SHA checks extracted from the existing CLI. Existing CLI re-exports its original error/readback API. A raw-byte variant also handles the detached signature; JSON is never reserialized before authentication.
- `newsletter-retention-historical-readonly-preparation.ts`: exact root schema/limits and selected chain/policy/manifest/artifact/count/digest comparisons factored from the internal executor and used by **both** paths. Existing executor one-shot admission/capability/transaction behavior remains private to the applier.
- Existing archive stream/selection, Ed25519 domain-v2 acquisition verifier and `checkHistoricalGates` are reused directly. Gate validator accepts only its read-only dependency subset. SQL catalog and exact Prisma-file fingerprints remain distinct.

Four pinned private metadata files are required **after root approval**. For each of `REPORT`, `CONFIG`, `ATTESTATION`, `SIGNATURE`, provide `NEWSLETTER_RETENTION_OPERATIONAL_<NAME>_FILE` and `NEWSLETTER_RETENTION_OPERATIONAL_<NAME>_SHA256`. REPORT and CONFIG are original exact JSON bytes; ATTESTATION has the existing exact seven-field v2 acquisition contract. SIGNATURE is a metadata JSON object with exactly `signatureBase64`, encoding the detached 64-byte Ed25519 signature in canonical base64. Local byte pins are transport-integrity constraints, not authority. The selected binding/policy/schema expectations come from the independently approved root, not metadata request files.

stdin uses the **existing** RAM-only transport: uint32-BE base/delta manifest lengths, exact manifests, exact compressed base/delta bytes. This increment does not create, download or save a dump, synthesize restored rows, initiate restore/readback, or run a production query. Producer idle/whole/cleanup bounds are inherited; gate waiting is raced against the same monotonic whole-work AbortSignal. Misbehaving underlying collectors must still honor cancellation to actually stop I/O. Cleanup failures demote a successful diagnostic to refusal; seven-digit source timestamps are retained and never refreshed.

## Controlled runtime provisioning — deliberately not installed

`getApprovedHistoricalReadOnlyPreflightRoot` is a fixed compiled application composition boundary and currently returns `undefined`. Only independently reviewed, out-of-band application code may provision its root: collector public key/principal/procedure, independent restored SQL observation + exact Prisma fingerprint, exact selected wave/policy approval, complete queue/DLQ inventory and observer-only gate collectors with bounded cancellation-aware I/O. It cannot load a key/root from env, report/config JSON, caller flags, an arbitrary module path, or expectations derived from an archive. No real key was created, read, signed or provisioned by this increment.

The actual executable therefore reports a safe root refusal with separate prerequisites for approved root, collector/procedure/restored-SQL attestation, independently acquired raw report and live read-only collectors. It does not silently infer these from authenticated manifest transport. Synthetic positive acceptance exercises the **same command function and real file adapters**, not this missing production provisioning boundary. The compiled executable itself has been run to refusal for missing root and forbidden apply/root arguments.

## Actual external acceptance matrix (parent acquisition evidence)

| Requirement | Actual state | Necessary external prerequisite |
|---|---|---|
| Exact existing base manifest | Partial metadata acquired by parent; 1357 bytes; pinned SHA `f2150f08c9be17fc9d6cb20ff0fe05c887ee3e2ae42017602f0548fa37a13f06` matched | Existing `escrow/nucleo-ses-candidate-escrow-20260921T122427Z/manifest.json`; no new dump |
| Exact existing delta manifest | Partial metadata acquired by parent; 813 bytes; pinned SHA `00c3b35b9226831797537e5aed2a395519cd87408e3b2503c74b21fcff24e9e8` matched | Existing `escrow/nucleo-ses-notification-delta-20260922T142923Z/manifest.json`; no new delta |
| Independent raw original Windows v2 report | **Not independently fetched** | Original `C:\Users\ztock\AppData\Local\NucliaReadback\v2-<GUID>\readback-result.json` must be delivered through an approved fixed-verb read broker/operator evidence delivery; actual GUID/path still needed. Restricted-account targeted listing returned not-found, which does **not** prove file absence. No ACL/elevation workaround or new readback |
| Local report currently available | Chat wrapper only, not authenticated raw acquisition | `evidence/ses-restore-readback-operator-20261007T195252Z.json` explicitly has `rawWindowsReportFileIndependentlyFetched=false`; cannot admit or sign wrapper as raw evidence. Preserve original `2026-10-07T19:52:52.4874872Z` |
| Original config + successful report commitment match | Raw config/report bytes and exact independent source pins still required | Approved evidence delivery of existing exact config/report, followed by descriptor acquisition and all chain/config/container/image/count/digest checks; no rewriting metadata |
| Collector origin/procedure/restored SQL schema | **Missing approved acquisition root and independent attestation** | Approved principal + public key, collection procedure defining canonical seven SQL catalog fields, independently observed restored SQL fingerprint, distinct exact Prisma-file fingerprint, detached signed v2 attestation over original bytes. Transport host-key trust is not collector trust; archive/Prisma expectations are not observed SQL schema |
| Full selected archive transport | Full payload **not acquired/exercised** by parent metadata-only operation | Existing authorized complete RAM-only base/delta envelope; no child remote operation or Linux dump file |
| Current Ghost/queue+DLQ/proxy/pressure/live SQL+Prisma/orphan+late gates | **Missing actual read-only collectors/observations** | Independently provisioned scoped, fresh observer-only ports; no arbitrary SSH shell or production query implemented here |
| Actual preflight | **Refused / incomplete external prerequisites** | All independent prerequisites above; no overall PASS from two matching manifests |

Parent's bounded transfer used the existing pinned-host SFTP route, RAM memfd only and source/destination metadata equality. This child performed **no remote operation**. Authentication of those two manifest transports is partial acquisition, not readback-collector authentication, new restored-schema evidence or preflight readiness.

## Verification and limits

TDD RED: the new connected suite failed to import the missing consuming preflight module before implementation. GREEN includes the actual positive secure-descriptor command and cryptographically signed negative status/wrapper evidence, unsigned/key/procedure/schema/binding/freshness/live-schema refusal, rejected mutation dependencies, whole/idle gate/stream stall and bounded cleanup refusal. Static tests traverse the emitted runtime import graph (including the secure reader and shared preparation), forbid action/database/controller dependencies, and execute the actual compiled entrypoint under a minimal environment with no DB URL/production secrets.

Commands:

```sh
node scripts/test-newsletter-retention-safe-filesystem.mjs tests/service/newsletter-retention-readonly-preflight.test.ts --reporter=dot
node --test tests/scripts/retention-readonly-preflight.node.mjs
npm run typecheck
npm run lint
git diff --check
```

Final local results: **56 passed / 1 explicitly filtered (57 tests), three files**, combining the new consuming preflight suite with existing secure-reader and CLI regressions. The filtered case is the unchanged mandatory real foreign-owner test. An earlier unfiltered four-file regression run returned **219 passed / 1 failed**: all historical preparation/executor cases passed, while genuine foreign-owner `chown` failed with local single-UID EINVAL. This is an external coverage gap, not a waived guard or passing ownership test. No additional full executor round was run. Static/compiled-entry tests: **2 passed**; both TypeScript projects, full zero-warning lint and diff-check passed. A second TDD RED reproduced stale evidence incorrectly returning `preflight_verified` after gate collection (**1 failed, 18 filtered**); GREEN now reauthenticates the unchanged original timestamp after gates.

Exact final local regression command (explicit exclusion only because this host lacks foreign-UID capability):

```sh
node scripts/test-newsletter-retention-safe-filesystem.mjs tests/service/newsletter-retention-readonly-preflight.test.ts tests/service/newsletter-retention-operational-filesystem.test.ts tests/service/newsletter-retention-cli.test.ts --reporter=dot -t '^(?!.*rejects real foreign owner metadata when runner can create it)'
```

Local namespace filesystem verification is synthetic/offline, **not Node22/MySQL/MariaDB certification**. The local one-UID runner cannot create foreign-owned files (chown EINVAL); mandatory foreign-owner coverage is not weakened or claimed. Broader actual CI baseline remains parent-verified eight cases on MySQL8.0.46/MariaDB11.4.13 at the previous exact head. No commit, push, deployment, production read/write, restore, key provisioning, ACL/policy change or apply enablement occurred here.

### CI run 37813787103: positive fixture temporary-directory correction

The quality log and both raw database Vitest reports identify the positive secure-descriptor fixture as failing before metadata acquisition: `join(process.env.TMPDIR!, ...)` received `undefined` in the minimal environment. Both database raw reports contain **840 passed, 1 failed, 22 pending / 863 tests**. This is failed execution, not pending coverage eligible for reconciliation; no aggregate certification follows from it.

Only the test fixture now uses `node:os.tmpdir()`: it honors an explicit local `TMPDIR` and supports the standard temporary base when CI omits it. The reader, ancestry checks, mode0700 fixture directory, mode0400 metadata files, negative hash test and cleanup remain unchanged. No runtime allocator, environment propagation, gate exception, skip or ownership-policy change was added.

Bounded TDD reproduced the exact TypeError with the entire 26-test suite in a disposable unprivileged chroot: the child environment omitted `TMPDIR`, and `/tmp` was a mode1777 directory **inside the scratch-local fixture**, not the host `/tmp`. RED: **25 passed / 1 failed**. With the fixture correction the same invocation returned GREEN: **26 passed / 0 failed**, including the real consuming command's authenticated descriptor read and its incorrect-hash refusal. The unchanged private runner with explicit `/scratch` also returned **26 passed / 0 failed**. Neither invocation used test-name filters or skips. The local foreign-owner capability probe still reports EINVAL and is not claimed as successful coverage.

The scratch-only unset-environment runner is an adaptation of `scripts/test-newsletter-retention-safe-filesystem.mjs`: it creates its own chroot `/tmp` and removes `TMPDIR` only from the isolated child's environment. Parent `TMPDIR` stays explicit. Reproduction commands and logs live under the active profile's scratch directory:

```sh
node "$TMPDIR/ses-readonly-unset-runner.mjs" tests/service/newsletter-retention-readonly-preflight.test.ts
node scripts/test-newsletter-retention-safe-filesystem.mjs tests/service/newsletter-retention-readonly-preflight.test.ts
node --test tests/scripts/retention-readonly-preflight.node.mjs
npm run typecheck
npm run lint
git diff --check
```

Static import-graph/compiled minimal-environment tests: **2 passed**. Both TypeScript projects, full zero-warning lint and diff check passed. These results correct the local fixture boot failure only; they do **not** certify a new hosted run, database aggregate, dependency audit or production readiness. The actual operational root remains unprovisioned and the external prerequisites above remain missing.
