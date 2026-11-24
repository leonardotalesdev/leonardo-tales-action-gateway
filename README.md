# Leonardo Tales Action Gateway

Action Gateway guards consequential tool calls with exact approval, a Task-wide allowance, and inspectable local receipts. It exports `createActionGateway` for ordinary execution and `createTrustedReconciliationHost` for adjudicating eligible ambiguous attempts. Both run on Linux with Node.js 22.18.0 or later.

## Try ordinary execution

Run from the repository root. The example uses the checked-in compiled public entry point and needs no network or credentials.

```sh
node examples/row-export/index.mjs
```

A synthetic operator approves the requests. The example counts the tool's effects independently of the Gateway receipts.

```text
Task case-17   cap 10 rows
export-1 4 rows EXECUTED remaining 6
export-2 3 rows EXECUTED remaining 3
export-3 4 rows BLOCKED remaining 3
reason task_limit available_at_decision 3
tool effects = 2
replay export-2   recorded result   tool effects = 2
```

In an installed consumer, run the same file at `node_modules/@leonardo-tales/action-gateway/examples/row-export/index.mjs`.

## Use the ordinary Gateway

Create a canonical absolute directory owned by the process user with mode `0700`. Reuse it for every Run and restart of the same Task. A different Task or store has an independent allowance.

```ts
import { createActionGateway } from '@leonardo-tales/action-gateway'

const gateway = await createActionGateway({
  directory,
  task: { id: taskId, cap: 10, unit: 'rows', expiresAt },
  approverId: operatorId,
  review: reviewWithOperator,
  tool: {
    id: 'customer.export', revision: 1,
    amount(input) {
      if (!Array.isArray(input.rowIds)) throw new Error('Expected row IDs')
      return input.rowIds.length
    },
    execute: exportReviewedRows,
  },
})
const receipt = await gateway.execute({
  runId: 'run-a', operationKey: 'export-1', input: { rowIds: [1, 2, 3, 4] },
})
const latest = await gateway.inspect('export-1')
```

The immutable Task configuration pins the cap, unit, expiry, tool and revision, approver and handler timeout. Supply `expiresAt` as a UTC ISO timestamp with milliseconds. The optional `timeoutMs` defaults to ten seconds and is capped at thirty seconds. The optional `now` supplies the host clock. For historical stores, see [Legacy and mixed-version compatibility](#legacy-and-mixed-version-compatibility).

Measure a positive safe integer from the canonical input and immutable host data. The handler receives that input and an `AbortSignal` and must bound its actual effect to the measured amount. Return `{ outcome: 'executed', evidenceId }` after confirming the effect, `{ outcome: 'no-effect', evidenceId }` after establishing its absence, or `{ outcome: 'unknown' }` when uncertain. Numeric signed zero is normalized before hashing, metering, review and dispatch.

- **Pending approval.** `review` receives the canonical input, amount, unit, cap, operation key, Task, Run, request ID, request digest and expiry. The host callback returns `APPROVED`, `DENIED` or `PENDING` for that exact request on behalf of the authenticated operator. Approval requests expire after at most five minutes. For `APPROVAL_REQUIRED` with a pending review, resubmit the same operation in its original Run while the request is valid. Exact approval can permit its first dispatch. A denial is durable.
- **Recorded result.** Replaying a recorded result with the same operation key and canonical input returns the existing result without calling the handler. Changing the canonical input or measured amount can return `CONFLICT`.
- **Ambiguous result.** After `UNKNOWN` or a lost response, inspect the original operation key. A recorded ambiguity retains the hold. Do not redispatch the business action to resolve it. Use trusted reconciliation only for eligible histories in promoted stores. A fresh operation key starts a new business operation and cannot confer recovery authority for the earlier attempt.

`inspect` returns the observed receipt, including in-flight state, or `null` for an absent key. Storage integrity errors and writer contention can prevent inspection. Receipts report `decision`, `reason`, bindings, approval and evidence references, and current Task totals. `remaining = cap - settled - held`. A cap refusal stays `BLOCKED` if capacity later becomes available. Its `refusalBasis` records the decision-time reason, requested amount and totals when that historical balance exists. Confirmed execution is `EXECUTED`. Receipts convey no dispatch authority.

## Authority and safety model

The host owns the private directory, Task and operation identity, allowance, metering, tool and credentials, handler, and approver authentication. Give an agent only a narrower wrapper that accepts business input. The host must control every route to the handler and its credentials.

Trusted reconciliation requires separate host authorization. The application authenticates the actor, controls access to the controller, provides the clock and resolver, owns any provider credentials, and decides what the evidence establishes. Keep the controller outside agent-facing tool registries. The package validates structural bindings and maintains local records, writer serialization, replay protection and accounting. The host establishes evidence truth, directory custody, worker quiescence and any operator recovery decision.

## Use trusted reconciliation

Open the same directory and logical `taskId` after offline Task manifest promotion. `createTrustedReconciliationHost` validates the store prerequisites and fixes the actor for that controller. The `now` callback synchronously returns a trusted UTC ISO timestamp with milliseconds. The optional `legacyDigestLocale` is a construction setting.

```ts
import { createTrustedReconciliationHost } from '@leonardo-tales/action-gateway'

const controller = await createTrustedReconciliationHost({
  directory,
  taskId,
  host: { actorId, now: trustedNow, resolveEvidence: resolveWithHostEvidence },
})
const result = await controller.reconcile({
  requestId: 'reconcile-export-1',
  operationKey: 'export-1',
  evidenceRef: { id: 'export-dossier-1', revision: 1 },
})
```

`evidenceRef` is a selector with a positive integer revision. Proof comes from the evidence the host independently verifies for the original attempt. The request contains only the fields above. The host supplies the actor, time and assessment. Its resolver receives a frozen context with the request, actor, evidence reference and original subject, including approval, action, amount and attempt binding. The resolver runs outside the writer locks with a 30-second deadline and an `AbortSignal`. Aborting the signal cannot establish that any worker has stopped.

Implement `resolveEvidence` as an ordinary `async` function returning a native Promise. Avoid subclasses, custom thenables, `then` overrides and Proxy wrappers. An already-rejected non-ordinary Promise supplied by the host may surface a host-side unhandled rejection when the controller rejects it without invoking its hooks.

## Try trusted reconciliation

From a consumer directory with the candidate tarball installed, run its shipped example with the absolute path to the installed promotion executable.

```sh
node node_modules/@leonardo-tales/action-gateway/examples/trusted-reconciliation/index.mjs \
  "$PWD/node_modules/.bin/lt-action-gateway-promote-r2"
```

The synthetic handler writes its effect to a separate host-owned ledger and returns `unknown` to model a lost acknowledgement. After the example's writers finish, the CLI promotes the store offline. A trusted resolver reads the effect record and verifies its original-operation correlation before settling four rows. A fresh controller replays the exact reconciliation request with one total handler invocation. The example needs no provider, credentials or network.

## Assessments, receipts and restart

Use `TrustedReconciliationAssessment` for the resolver result. A final assessment supplies `binding` with the request ID, actor ID, evidence reference, subject digest and expected state. It also supplies `evidenceDigest` for the immutable evidence dossier, the original trusted `qualifiedAt`, and the appropriate finding digests. The package checks format and exact binding. A valid digest commits to what the host assessed. The host still has to verify the evidence.

| Assessment | Evidence and accounting |
| --- | --- |
| `confirmed-effect` | Evidence that the original attempt produced the effect, committed in `effectOccurredDigest`. Application settles the held amount. Ordinary inspection projects `EXECUTED` with reason `reconciled-effect`. |
| `confirmed-no-effect` | Requires **both** evidence that the effect did not occur (`effectAbsentDigest`) and evidence that the original attempt can no longer produce it (`attemptFinalityDigest`). Application releases the hold. Ordinary inspection projects `BLOCKED` with reason `reconciled-no-effect`. |
| `unresolved` | Return `{ status: 'unresolved' }` when the host cannot make a final assessment. There is no final decision or accounting transition. The hold remains, with no retry authority or automatic release. |

A timeout, cancellation, worker exit, process crash, HTTP failure, provider “not found” or missing callback is insufficient on its own to establish `confirmed-no-effect`. Use `unresolved` when either required finding is missing. Reconciliation leaves the original Run blocked and the original operation non-dispatchable, including after a no-effect release.

`applied` and `replayed` receipts echo the request and carry `reconciled-effect` or `reconciled-no-effect`. `unresolved` echoes the request. `refused` carries a `code`. Factory construction can reject with a bounded error code. These codes are programmatic outcomes and carry no provider diagnostics.

| Concern | Refusal codes |
| --- | --- |
| Host or request | `invalid-host-config`, `invalid-request` |
| Store or prerequisites | `store-not-found`, `unsafe-store`, `promotion-required`, `legacy-locale-required` |
| Eligibility or conflict | `ineligible`, `stale-state`, `request-conflict`, `attempt-conflict` |
| Resolver or evidence | `resolver-timeout`, `resolver-failed`, `invalid-assessment`, `evidence-mismatch` |
| Clock or integrity | `invalid-clock`, `corrupt-storage` |
| Contention or persistence | `store-busy`, `write-uncertain`, `storage-failure`, `internal-failure` |

- **Decision revision 1, `qualified`.** A persisted qualification cannot authorize application on its own. On restart the resolver runs again and must exactly re-attest the canonical assessment, including the original `qualifiedAt` and the same request, actor, evidence and subject binding. Different evidence or `unresolved` cannot apply the pending decision.
- **Decision revision 2, `applied`.** When the durable record and its required history validate, an exact replay needs no provider, resolver, trusted clock, handler call or new accounting mutation. A changed binding for the same request ID conflicts. This replays a reconciliation receipt.

These decision revisions are distinct from the Task manifest revisions used for store promotion.

## Offline Task store promotion

The first ordinary execution in a new Task initializes revision-1 Task state. The promotion executable explicitly upgrades an existing Task manifest from revision 1 to revision 2. Follow this lifecycle for a Task with an ambiguous result.

1. Inspect the original operation. Stop new admission and workers, disable restart loops, and drain or terminate callbacks and continuations that could access the Task directory. Establish quiescence externally. Either writer lock blocks promotion, and free locks cannot establish quiescence.
2. Promote offline against the same private directory and logical Task ID. If historical digests require a locale, supply the original compatible locale as described below.

   ```sh
   ./node_modules/.bin/lt-action-gateway-promote-r2 \
     --directory /absolute/private/gateway-root --task-id case-17
   ```

3. Verify successful exit and record the generation reported on stdout. Repeating successful promotion returns the same generation. Use the candidate-capable runtime for this lineage, construct the trusted controller, then assess eligible operations. Keep the maintenance fence through promotion verification and any crash assessment. Retain the directory for audit and investigation.

Promotion atomically replaces the manifest, preserves its verified revision-1 history and leaves the other durable business and audit files byte-for-byte unchanged. It establishes a format and generation transition. Adjudication and accounting require the separate trusted reconciliation flow. Promotion gives no authority to retry an operation.

## Crash, incomplete history and uncertain writes

`UNKNOWN` with `reconciliation-required` warrants inspection. Only fully recorded eligible ambiguous attempts can be reconciled. `reserved` histories remain ineligible even after promotion. A crash before attempt creation may retain a hold. An interruption before proposal persistence can also leave an ineligible pending history with recorded digests but no stored preimage. When that pending operation resumes under ordinary approval semantics, the Gateway verifies the supplied input and recomputed proposal against those digests.

A handler timeout aborts its signal and leaves an ambiguous outcome with capacity held. The handler may still produce a late effect. A late result cannot replace the recorded `UNKNOWN`. A malformed record or damaged audit chain can block dispatch or prevent a receipt from being projected. Inspection of a reconciled result depends on validated history.

Ordinary writers can fail with `locked`. The trusted controller distinguishes `store-busy` from `write-uncertain`. A decision revision-2 rename may be visible while durability is uncertain. A retained writer lock fences protected consumers, and visible data gives no authority on its own. A persistence refusal can leave durable data that requires assessment. There is no automatic lock recovery. Preserve the directory, stop or restrain relevant processes and restart loops, establish externally that the previous writer and its continuations cannot resume, and investigate before resuming use.

## Legacy and mixed-version compatibility

New `utf16-v1` digests use compact UTF-8 JSON and UTF-16 key ordering with JavaScript's numeric array-index key ordering. They require no ambient legacy locale. The ordinary Gateway can read legacy `v0.1.0` records with its default Node/ICU collation when that reproduces their checksums. Historical checksums and exact approval bindings are retained. Stop `v0.1.0` writers before upgrading. They cannot read records in the later envelope format.

Promotion and trusted reconciliation require one explicit original compatible collation when legacy history needs it. Supply `--legacy-digest-locale` to the promotion CLI and `legacyDigestLocale` when constructing the trusted controller. The ordinary Gateway also accepts `legacyDigestLocale` for historical reads. The strict recovery path uses no ambient fallback, locale guessing or per-request override. Incompatible evidence fails closed. Redundant default-script forms such as `en-Latn-GB` may fail closed even where the simpler `en-GB` form works. Use only a collation known to reproduce the historical digests. Preserve the directory for investigation if the original collation cannot be reproduced.

**After Task manifest revision-2 promotion, do not resume normal operation with published `0.1.1`.** The old binary refuses known-key inspection, replay and fresh execution when they reach the manifest fence. Factory construction can still succeed and create missing directories. An absent-key inspection can return `null` and execution can briefly take a writer lock. This fence provides neither a supported downgrade procedure nor mixed-version writer safety.

## Scope and non-goals

The supported model is a trusted host, cooperating processes on one Linux machine, Node.js 22.18.0 or later, and a supported local filesystem with durable rename and fsync semantics. Keep the store private. Symlink directory components and symlinked or hard-linked record and audit files are rejected. Same-user hostile writes are outside the storage contract.

The process tests cover local contention and specific crash and persistence cases. They establish no guarantees for NFS, distributed filesystem writers, multi-host locking, distributed transactions, arbitrary storage power loss, or provider-side exactly-once effects. A generation identifies a lineage. Copies of a promoted store can share it, and restoring an older snapshot can roll it back. The package provides no rollback detection or copied-store uniqueness.

## Build and verify

```sh
npm ci
npm test
npm run typecheck
npm run test:packed
```

The package ships compiled ESM and TypeScript declarations and has zero runtime npm dependencies. The packed verifier installs the local archive offline into a disposable consumer with an empty npm cache, compiles a strict TypeScript import, checks public entry points and the installed promotion executable, and runs both installed examples. To retain the verified archive, pass one new absolute `.tgz` path in an existing directory outside the checkout to `npm run test:packed -- /absolute/external/path/action-gateway-0.2.0.tgz`.

## Version and distribution

`0.2.0` is a local, unpublished candidate. Compared with published `0.1.1`, it introduces explicit offline Task store promotion and trusted-host reconciliation for eligible attempts. Both installed examples and the compatibility checks are exercised by the packed verifier. The public API and local process proofs are scoped to the model above.

Extracted from the Leonardo Tales Core governance and execution research program. Maintained by Hakan Demirci. Copyright 2026 Hakan Demirci for maintainer-owned Action Gateway contributions.

The project is licensed under Apache-2.0. The adapted Leonardo Tales Policy Engine evaluator retains its Apache-2.0 license and modification notice. [Project license](LICENSE) · [Component license](LICENSES/Apache-2.0.txt)

The development toolchain uses TypeScript (Apache-2.0), Node type declarations (MIT), and transitive `undici-types` (MIT).
