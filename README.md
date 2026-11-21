# Leonardo Tales Action Gateway

Guard the call to a consequential tool. An operator can approve an exact export and still need a hard limit across several Runs, protection against repeated dispatch, and a record of what happened if the process dies. This local TypeScript gateway enforces a Task's allowance before it calls the host's handler and returns an inspectable receipt.

## Try it

On Linux with Node.js 22.18 or later, run this from the repository root:

```sh
node examples/row-export/index.mjs
```

The example uses the compiled public entry point checked into this repository. It needs no install, network, API key, or other checkout. A synthetic operator approves each request. The handler appends to a private temporary file, which the example counts independently.

```text
Task case-17   cap 10 rows
export-1 4 rows EXECUTED remaining 6
export-2 3 rows EXECUTED remaining 3
export-3 4 rows BLOCKED remaining 3
reason task_limit available_at_decision 3
tool effects = 2
replay export-2   recorded result   tool effects = 2
```

## Use the gateway

Import `createActionGateway` from `@leonardo-tales/action-gateway`. Create a private directory once, owned by the process user with mode `0700`. Supply its absolute canonical path and reuse it for every Run and restart of the same Task.

```ts
import { createActionGateway } from '@leonardo-tales/action-gateway'

const gateway = await createActionGateway({
  directory,                          // Stable private directory supplied by the host
  task: { id: taskId, cap: 10, unit: 'rows', expiresAt },
  approverId: operatorId,
  review: reviewWithOperator,         // APPROVED, DENIED, or PENDING for this exact request
  tool: {
    id: 'customer.export', revision: 1,
    amount(input) {
      if (!Array.isArray(input.rowIds)) throw new Error('Expected row IDs')
      return input.rowIds.length
    },
    execute: exportReviewedRows,      // Returns the confirmed outcome and an evidence ID
  },
})
const receipt = await gateway.execute({
  runId: 'run-a', operationKey: 'export-1', input: { rowIds: [1, 2, 3, 4] },
})
const latest = await gateway.inspect('export-1')
```

`expiresAt` is a UTC ISO timestamp with milliseconds. The immutable Task configuration pins the cap, unit, expiry, tool and revision, approver and timeout. Approval requests expire after at most five minutes. The default handler timeout is ten seconds. `review` receives the exact canonical input, amount, unit, cap, operation key, Task, Run, request ID, request digest and expiry. The host supplies the authenticated operator's decision for that request. Return `PENDING` to defer, then resubmit the same operation in its original Run. A denial is durable.

Return `{ outcome: 'executed', evidenceId }` after confirming the effect, `{ outcome: 'no-effect', evidenceId }` only after positively establishing that it did not occur, or `{ outcome: 'unknown' }` when uncertain. Evidence IDs are opaque host references. Reuse the host-assigned operation key on retry. Changing its canonical input or measured amount conflicts. A confirmed operation can be replayed from a fresh Run without calling the handler again. Numeric signed zero is normalized before hashing, metering, review and dispatch.

Receipts expose `decision`, `reason`, original identities, digests, requested units, approval and evidence references, and the observed Task totals. `remaining = cap - settled - held`. A cap refusal also has a durable `refusalBasis` with the original reason, requested amount and decision-time totals. The operation stays blocked even if capacity later becomes available. Earlier records without that historical balance return `refusalBasis: null`. Inspection can observe in-flight state. A receipt conveys no dispatch authority.

## Persisted digests

New operations use SHA-256 of compact UTF-8 JSON. Object keys sort by UTF-16 code units, with array-index keys emitted first in numeric order by JSON serialization. Arrays keep their original order and strings keep their original Unicode form. New record envelopes checksum their version and contents using this format.

The gateway reads v0.1.0 records automatically when the runtime's default Node/ICU collation reproduces their legacy checksums. Each historical operation keeps its original digests and exact approval binding. A pending request retains its request ID, request digest, original Run and expiry. Resubmitting it still requires the host to endorse that exact request through `review`.

Stop v0.1.0 writers before opening the directory with the updated gateway. If the host locale changed, configure the original collation with `legacyDigestLocale`, for example `'sv-SE'`. The gateway verifies legacy records with one configured collation. If validation fails, keep the original directory and recover the original Node/ICU runtime and locale before retrying. A store with incompatible legacy collations or one whose original collation cannot be reproduced requires maintainer-assisted recovery. The original v0.1.0 release cannot open records written in the new envelope format.

## Scope and recovery

- The trusted host must control the only route to the handler and its credential. The host assigns Task and operation identities, owns the cap, and authenticates the approver. Expose only ordinary input arguments to an agent. Creating another Task or choosing another store creates an independent allowance.
- Measure a positive safe integer from the canonical input and immutable host data. The handler must bound its actual effect to the measured amount. Keep the tool's meaning, meter and implementation consistent with its revision.
- Use cooperating processes on one trusted Linux local filesystem with durable rename and fsync. The Gateway rejects group or other access to its private root, symlink directory components, and symlink or hard-linked record and audit files. Same-user hostile writes, filesystem rollback and distributed exactly-once execution are outside the storage contract.
- The project writer serializes admission across Runs. A competing writer can receive an error with code `locked`. An abandoned `.writer.lock` continues blocking writes after restart. Operator intervention requires establishing that the old writer cannot resume.
- When `timeoutMs` elapses, the Gateway aborts the handler's `AbortSignal` and records an ambiguous outcome. The handler must cooperate with cancellation and may still produce a late effect. A late success or no-effect response leaves the recorded `UNKNOWN` receipt with reason `reconciliation-required` and its capacity hold in place. Reopen the same directory to inspect the operation. Replay preserves the hold and skips handler dispatch.
- An interruption or uncertain response also keeps capacity held. A crash between the durable hold and attempt creation can retain capacity even before the handler ran. Ambiguous effects require operator reconciliation against independent evidence.
- A malformed record or a failed envelope check raises `corrupt-record` when read. A damaged audit chain refuses appends and blocks new dispatch. The public receipt can report `storage-or-review-failure` when an audit write fails during approval. Existing receipts can still be read from validated operation records. Preserve the directory for investigation.
- v0.1 validates a local tool under a fixed approval-gated policy. The example uses synthetic effects. External integrations, production data, provider authentication and distributed transactions require their own controls.

## Build and verify

```sh
npm install
npm test
npm run typecheck
npm run build
npm run example
npm run test:packed
```

`npm ci` installs the locked development toolchain. The package has zero runtime npm dependencies. The compiled ESM and TypeScript declarations in `dist/` support an offline clone and the same entry point used by tarball consumers. Rebuild them when editing `src/`. The packed test installs the local tarball in a disposable consumer with an empty npm cache, compiles a strict TypeScript import and runs the shipped example.

## Origin and distribution

Version 0.1.0 supports Linux and Node.js 22.18 or later. Extracted from the Leonardo Tales Core governance and execution research program.

Maintained by Hakan Demirci. Copyright 2026 Hakan Demirci for maintainer-owned Action Gateway contributions.

The project is licensed under [Apache-2.0](LICENSE). The adapted Leonardo Tales Policy Engine evaluator retains its Apache-2.0 license and modification notice. [Component license](LICENSES/Apache-2.0.txt)

The development toolchain uses TypeScript (Apache-2.0), Node type declarations (MIT), and transitive `undici-types` (MIT). The npm archive contains the compiled Gateway and ships zero external runtime npm dependencies.
