# C13 persistent bounded reduction — Replacement Execution Plan

## Overview

- **Outcome:** Complete one offline, unpublished persistent reducer through an exactly sized `reduction_ready` request. Preserve R1–R8 from the technical plan.
- **Replacement strategy:** One capacity-reserved primary integrator, continuous ownership, and an early end-to-end PostgreSQL resume proof. Replace the stopped S1–S3 worker sequence; do not retry S1 as another package or subdivide it into file-sized assignments.
  - Four capacity stops show an execution-capacity problem, not demonstrated technical infeasibility. More package labels do not solve that problem.
  - Retain the validated partial sizing work. Spend new implementation capacity on the missing protocol, durable transitions and execution proof, not predecessor reconstruction.
- **Technical decisions retained:** v4 JSONB checkpoint; immutable finalized levels and one pending level; revision/owner fencing; atomic ordered batch commits; original-evidence lineage; whole-classifier sizing; eight-level limit; no automatic reducer-output repair.
- **Unchanged / excluded:** Direct score behavior, original-chunk repair policy, no-store `unsupported_chunks`; no final oversized classifier dispatch or publication. No production/provider activation, workflow/queue wiring, P9, C21, D4/D8, APIs/UI, new migration/schema/dependency, deployment, environment pruning, staging, commit, push or merge.
- **Status: `needs_input` — replacement attempt stopped for capacity before source edits.** User approved this plan and authorized proceeding with sensible capacity values. One retained worker attempt still reported insufficient execution capacity for the coherent C1–C7 scope; no technical infeasibility established. Do not start another implementation attempt or subdivide the work without a new user decision and genuinely sufficient execution capacity.
- **Material risks:** Provenance may prevent fit or strict shrink; checkpoint/work bounds may reject an article. Lost uncommitted responses may cause repeat admitted work on explicit resume. Structural lineage is not a semantic-faithfulness guarantee.

## Planned changes

This planning task creates only this document. The table is the complete future implementation ownership boundary. “Modify” includes existing untracked worktree files; their contents are predecessor work, not blank files.

| ID | File / area | Planned change and purpose |
| --- | --- | --- |
| C1 | `src/server/domain/context-reduction.ts` (modify) | Extend existing evidence types with bounded v4 reduction types, canonical identities, graph/lineage validation and immutable transition invariants. Preserve store type re-exports. |
| C2 | `src/server/application/score-context-request.ts` (modify); `src/server/application/score-reduction-protocol.ts` (new) | Keep current validation/measurement/renderers; add immutable counted requests and the pure shared basis/render/whole-level/batch/recount contract used by persistence and execution. |
| C3 | `src/server/adapters/postgres/context-store.ts`, `src/server/application/generate-score-evidence.ts` (modify) | Strict v4/legacy codec, revision-fenced transitions and evidence saves; share the unchanged extraction-plan builder. Preserve markers, coverage and changed-only completion writes. |
| C4 | `src/server/application/reduce-score-evidence.ts` (new); `src/server/application/process-context-chunks.ts` (modify) | Sequential admitted reducer/resume; integrate only the unwired oversized helper through `reduction_ready`. Retain direct sizing reuse and exported type compatibility. |
| C5 | `tests/unit/context-reduction.test.ts`, `tests/unit/score-reduction-protocol.test.ts`, `tests/unit/reduce-score-evidence.test.ts` (new); `tests/unit/score-context-request.test.ts`, `tests/unit/process-context-chunks.test.ts` (modify) | Complete missing contract/adversarial/execution vectors; retain predecessor assertions and evidence-only coverage. |
| C6 | `tests/integration/context-reduction.test.ts` (new); `tests/integration/context-persistence.test.ts`, `tests/integration/context-recovery.test.ts` (modify) | Early real-store resume spine, then codec/race/rollback/bounds/write-count and assembled recovery proof. Replace writable-placeholder tests, not their safety assertions. |
| C7 | `docs/verification.md` (append-only modification during implementation) | Record actual evidence, cumulative stops, baseline/result transfer and remaining gates. Never promote supplied results to independently rerun evidence. |

No planned source removals. Retire the writable placeholder-reduction API and its reset behavior in C3, not historical documents. No edits to the technical/staged plans, planner, text-safety helper, summary implementation/tests, AI ports/adapters, settings, production entry points or SQL/schema. Existing tests outside the owned paths remain regression gates.

## Implementation details

### Basis and source precedence

- **Technical authority:** `.ai/c13-reduction-plan.md`, “Acceptance criteria” R1–R8 and technical C1–C4 in full. Those sections define the exact persisted shapes, identity inputs, bounds, compatibility, failure codes and behavior; they remain required.
  - References to **technical C1–C4** below mean that document, not this table.
  - This replacement overrides its obsolete approval status, file-newness, single-worker handoff order and historical baseline, not its technical requirements.
- **Historical execution source:** `.ai/c13-reduction-staged-plan.md`, including its cumulative ledger and stopped S1 status. Preserve it unchanged.
  - On explicit approval of this replacement, its S1–S3 sequencing is replaced by the capacity-gated continuous sequence here. Do not fabricate an S1 exit or describe S2/S3 as started.
- **Other accessible sources:** `.ai/news-reader-plan.md` C13; `docs/dev-agentic-news-reader-spec.md` AC6, AC10–AC11, AC20; `docs/architecture.md` §§5–7; `docs/verification.md`, especially “Final bounded correction verification” and “C13 staged S1 — partial request-sizing checkpoint, stopped”.
- **Method/instructions:** `to-plan` skill and example read; supplied `/home/matthias/.pi/agent/AGENTS.md` applies. No repository `AGENTS.md` found by file search.
- **Verified by current file inspection:**
  - `score-context-request.ts` already exports `VerifiedModel`, `validateVerifiedModel`, `measureVerifiedRequest`, `renderFinalEvidenceState` and `renderScoreRequest`. Keep these working helpers/tests; measurement currently does not snapshot/freeze the request.
  - `processContextChunks` uses shared measurement and re-exports `VerifiedModel`. Its direct mapping is `100 * nativeIndex / 4`, including fractional indices. Its oversized-with-store path still returns original evidence.
  - `context-reduction.ts` contains only `ChunkEvidence` and `ChunkCompletion`; their store re-export already exists. No repeated type extraction is needed.
  - `generateScoreEvidence` constructs its extraction plan inline, writes `reductionLevels: []`, returns `evidence_ready`, and claims original repair before dispatch.
  - `ContextStore` remains v3 with v2 compatibility and placeholder string levels. It has no revision or `advanceReduction`; its article → task fence and `isDeepStrictEqual` changed-only completion writes must be retained.
  - `selectContext` orders title, category, tag weights, source weight, content. The current final-evidence renderer replaces content with ordered evidence after selected metadata.
  - The JSONB constraint is 1,048,576 PostgreSQL text bytes; application checkpoint and original-completion caps are separately 500,000 serialized bytes. `isPostgresJsonText` rejects NUL/unpaired surrogates, not valid pairs.
  - New protocol, reducer and reduction-specific unit/integration test files in the table are absent. Store call sites found are the evidence helper and the listed context tests; no production activation is needed.
- **Coordinator-supplied current evidence — not independently rerun here:**
  - HEAD `843452b4204b13696cf20d2448e696ad00e59561`; heavily dirty workspace; no staged paths. HEAD alone is not the implementation/review base.
  - Node 24.21.0 via mise; approximately 106 GB free at coordinator V0. These are supplied observations, not a capacity reservation or fresh environment measurement.
  - Partial S1 touched the two application files and `tests/unit/score-context-request.test.ts`, plus the verification append. Those three source/test paths were already untracked before S1.
  - Five focused files / 81 tests passed; typecheck, lint, build, Drizzle and staged/unstaged diff checks passed. No DB/provider call in that S1 execution. Exact focused command is V1 below.
  - Earlier six-file / 95 correction evidence and older full-suite reports remain historical. None proves the missing reducer; no new formal review or S1 acceptance follows from the partial checks.
- **Planning limitation:** File inspection only. No shell/command runner is exposed here; no Git, runtime, disk, Docker, test or review check was independently executed. `docs/verification.md` was read fully.
- **Acceptance/success:** R1–R8 remain defined once in the technical authority. Completion requires their assembled implementation plus V0–V8, not just helper/static success. Full C13/V13/D2, final oversized classification/publication and excluded work remain incomplete afterward.

### C1 — Complete the existing domain, do not rebuild the foundation

- Implement the technical C1 persisted types and validation rules in full: `ReductionNode`, `BatchPlan`, `BatchState`, `PendingLevel`, `FinalizedLevel`, reduction basis/pending/failure fields and finite failure codes.
- Expose pure validators/identity/ref-resolution functions for both C2 and C3. Type declarations alone are not a contract exit.
  - IDs bind the protocol domain and ordered canonical tuples specified in technical C1. Never depend on JSONB key order, a generated ID, or caller-supplied digests.
  - Revalidate the entire bounded graph on reload: contiguous levels; immutable finalized history; pending level exactly next; committed output prefix then null suffix; partitioned immediate parents; canonical IDs/digests; no dangling/cyclic/cross-batch lineage.
  - Strict raw reducer schema has only `items`, with `questionId`, `polarity`, `text`, `parentIds` per item. Every input parent appears exactly once. Same question/polarity only within a merged item; preserve support, counter and uncertain roots.
  - Canonicalize parent/item ordering before host IDs. Resolve transitive refs from validated originals; deduplicate identical `(start,end,quote)` using earliest planner-chunk ordinal, never merge distinct intervals or accept generated refs.
- Keep all technical bounds: eight levels; 4,096 nodes/batches per level; 32 outputs per batch; 16,384 UTF-8 bytes per text; 500,000 raw response bytes checked before parse; valid PostgreSQL text and safe counts/offsets/digests.
  - Checkpoint normal progress cap 498,976 bytes, hard cap 500,000, reserving 1,024 for failure; original completions keep a separate 500,000 cap. Never retain malformed raw output.
  - Empty completions provide original coverage, not synthetic evidence nodes. Complete originals with all-empty evidence are valid; incomplete original completion sets cannot enter reduction.
- Add a small protocol-neutral `ReductionSource` view: `{planId, chunks, questions, evidenceDigest, completions}`; chunks carry planner `id/start/end` in planner order. Add `ReductionState` for the technical reduction fields.
  - This view contains validated originals, not caller assertions of coverage. C3 constructs it from loaded rows and its exact current plan; C4 constructs it from the fenced returned checkpoint/completions and the shared plan builder.
- **References:** R2–R7; V2, V4, V5.

### C2 — Preserve helpers; add the missing immutable executable contract

- Keep existing `measureVerifiedRequest` as the low-level measurement helper and preserve its return shape. Add these new shared interfaces:

```ts
type CountedRequest<T extends ClassificationRequest | GenerationRequest> = Readonly<{
  request: T;                 // detached, recursively frozen runtime snapshot
  verifiedModel: VerifiedModel; // frozen model/limits copy, same tokenizer function
  serialized: string;        // exact JSON.stringify(request), original key order
  requestDigest: string;     // SHA-256 of serialized
  inputTokens: number;
  fits: boolean;
}>;
countImmutableRequest<T extends ClassificationRequest | GenerationRequest>(
  model: VerifiedModel, request: T
): CountedRequest<T>;
recountImmutableRequest<T extends ClassificationRequest | GenerationRequest>(
  model: VerifiedModel, counted: CountedRequest<T>
): void;
```

- Snapshot nested model/state/questions/criteria/refs before counting; recursively freeze the private request, not caller objects. Never reconstruct/normalize it after counting. Keep existing AiPort types; no broad readonly-port refactor.
  - Require the request's provider/model to equal the verified model. Snapshot/freeze its model reference and limits; retain the tokenizer function without trying to clone it. Recount first rejects a changed provider/model/limit descriptor, then requires identical serialized bytes/digest and a valid identical count/fit result against that snapshot. Mutation or tokenizer drift fails closed before dispatch.
  - Retain all existing verified-limit validation, safe input/framing/output totals, context and optional max-input checks. No nominal catalog fallback or truncation.
- New entry `createScoreReductionProtocol(task)` accepts only prompt, selected article/field data and the two verified models; snapshot them. Return a frozen descriptor and pure functions with this shared surface:

```ts
basis(source: ReductionSource): string;
verify(source: ReductionSource, state: ReductionState): void;
measureLevel(source: ReductionSource, state: ReductionState): CountedRequest<ClassificationRequest>;
planLevel(source: ReductionSource, state: ReductionState): PendingLevel;
batchRequest(source: ReductionSource, state: ReductionState, batchId: string): CountedRequest<GenerationRequest>;
validateOutput(source: ReductionSource, state: ReductionState, batchId: string, text: string): ReductionNode[];
promotion(source: ReductionSource, state: ReductionState): FinalizedLevel;
```

- Export its `ScoreReductionProtocol` type for C3/C4. No AiPort, database, session or execution-loop capability inside the factory. Never capture caller progress as authoritative persisted state.
  - `verify` delegates graph/identity checks to C1 and rebuilds/recounts saved manifests against the current descriptor. `measureLevel` never treats a pending prefix as a current complete level. `promotion` measures all pending outputs and requires a strictly smaller complete classifier count, not a smaller text/batch/reducer count.
  - The descriptor binds both models/limits, fixed system text, exact empty-item generator envelope and empty-evidence classifier envelope. The basis additionally binds plan ID and original evidence digest, including empty completions.
  - Generator shape/order remains `{model,role:'context_reduction',system,user}`; `user = JSON.stringify({question:prompt,context:selectedNonContent,items})`; items are `{id,questionId,polarity,text}`. Treat evidence as untrusted data. Extraction's quote schema stays separate.
  - Final classifier rendering uses the existing score renderer and final-evidence renderer with host-resolved original refs. Selected metadata, IDs, all refs and full request overhead count toward shrink/fit.
- Implement technical C4's deterministic contiguous greedy batch planner without splitting/dropping nodes or assuming tokenizer monotonicity. First failing extension closes the preceding fitting prefix; an unfit singleton fails before AI.
  - Manifests contain ranges/IDs/request digests/counts, not duplicated payloads. Require an exact partition and stable rebuild/recount; persisted manifests cannot be repacked on drift.
  - Bound each level's planning to 4,096 probes and 16 MiB aggregate serialized probe input. Preflight the next probe's conservative byte work before serialization, following `prepareContext`'s guard pattern. Fixed-envelope checks and per-batch recounts remain separately bounded operations.
  - Both fixed envelopes must fit before reduction probes/calls. Representability failures after a valid basis is available use C3's durable bounded failure path; invalid verified models fail before AI.
- C4 reuses immutable counting/recounting on the direct path too. Preserve exact preliminary/planner/pre-dispatch byte order and count equality, score mapping, pauses and selected-field isolation; keep `VerifiedModel` re-export compatibility.
- **References:** R1, R2, R4–R7; V1–V3, V5.

### C3 — Store authority and unchanged original extraction identity

- Implement technical C2 in full at `ContextProgress`, `ContextCheckpoint`, `checkpoint`, `validateState`, `save`, `claimRepair`, `resume`, and new `advanceReduction`. Preserve `fenced`, plan/chunk validation, completion validation/digest and changed-only writes.
- Required write boundary:

```ts
save(owner, input, progress, at, completions, expectedRevision: number | null)
// progress permits original completed IDs / repair markers, no reduction fields.
// null: absent creation or explicit EMPTY v1 recomputation.
// 0: first mutation of strictly validated v2/v3; positive: exact v4 revision.

advanceReduction(owner, input, expectedRevision, protocol: ScoreReductionProtocol, transition, at)
// Returns the same {planId,state,completions} checkpoint shape as save/resume.
// transition is one of:
// {kind:'bind_basis'} | {kind:'start'} | {kind:'promote'}
// {kind:'commit_batch',level,batchId,output:ReductionNode[]}
// {kind:'fail',failure:{code,level,batchId}}
```

- C3 computes basis/start/promotion from loaded originals and C2, rather than accepting replacement states/counts/manifests from callers. Revalidate batch output and host IDs against the loaded pending batch even after C4 validated raw output.
- Under article → task locks, recheck running token, target/action/generation, content text/revisions, assignment basis and newer same-target generation, including terminal newer tasks. Then load/validate state and compare revision.
  - Same-owner stale revision is a bounded conflict, never merge/reset. Existing stale-owner/basis `null` may remain; C4 must stop before any following call for either rejection.
  - Fresh v4 revision is 1; every actual mutation, including repair claim, increments atomically. Current-revision exact no-op need not write. Original IDs/repair markers are monotonic; originals become immutable once basis binds.
  - `claimRepair` keeps its existing signature/guard, derives next state from the loaded FULL checkpoint and returns its new revision. It must not strip reduction fields.
- Transitions obey technical C2: bind only complete originals; start a non-fitting whole level; persist manifest before dispatch; commit only the next batch; promote only complete strictly smaller output; terminal fail preserves all prior originals/levels/pending committed outputs.
  - Normal size overflow persists only `checkpoint_limit` on prior state using reserved headroom. Actual PostgreSQL write/commit failure rolls back and propagates. No completion upserts during reduction transitions.
- Compatibility remains exact: validate v2/v3 with original codecs before normalization, discard only their validated placeholder reductions, preserve v3 markers, expose virtual revision 0 without writing on read, upgrade on first fenced mutation to v4 revision 1 without completion rewrites.
  - Oversized conversion leaves legacy state untouched. v1 requires explicit empty recomputation and atomic deletion of only that plan's untrusted `context-evidence-v2` result rows. Unknown/malformed/extra-key objects are not absence or v1.
  - v4 cannot be read by older writers; no operational deployment/downgrade/reset is authorized.
- Extract new `buildScoreEvidencePlan(task)` in `generate-score-evidence.ts`, returning `{input,plan,requestFor}`. It must preserve the existing extraction system string, tools text, exact request property order, `forceChunks`, score target and resulting identities.
  - Reuse it in `generateScoreEvidence` and C4. Pass returned current revisions to evidence saves and remove hard-coded reduction resets. Keep `generateScoreEvidence` callable as evidence-only with its existing completion/typed-pause shape.
- **References:** R1–R3, R5–R7; V3–V5.

### C4 — One sequential unpublished executor

- New entry `reduceScoreEvidence(task: ScoreContextTask, ai: AiPort, store: ReductionStore)`; `ReductionStore = Pick<ContextStore,'save'|'resume'|'claimRepair'|'advanceReduction'>`.
- Follow technical C4's loop with the real C2 contract and C3 state; do not duplicate pure planning in the executor:
  1. Snapshot task data; validate models; rebuild the shared original plan; fenced resume and require all original completions/coverage.
  2. Verify the immutable basis/current graph/manifests, or bind once, including zero-level success. Persisted failure is call-free on resume. A changed bound basis is rejection, never automatic rebind.
  3. Finish/promote pending work before considering fit. Otherwise return a fitting complete-level request, or start the next persisted manifest. A non-fitting eighth finalized level fails without a ninth call.
  4. Rebuild/recount each next uncommitted batch immediately before `ai.generate`; strictly validate response; await atomic batch commit before any next call. Promote only a complete strictly smaller level.
- Every reducer call uses `{bucket:'automatic',taskId:task.owner.taskId,signal:task.signal}`, serially; no session, fallback, repair, implicit retry or AI inside a transaction.
  - Keep typed budget reasons/auth/configuration pauses with last committed progress and admitted auth mapping. Generic provider/admitted errors, abort, fence/revision rejection and persistence errors prevent subsequent calls.
  - Invalid reduction output durably fails `invalid_output`; non-shrink fails with committed outputs retained, without promotion. The technical finite codes also cover bounds/levels/recounts. Return/throw bounded protocol diagnostics, never malformed raw output. Failure-marker persistence errors remain persistence errors.
  - After ambiguous commit, explicit resume reloads first. Committed output is reused; response loss before commit may repeat that uncommitted request. No exactly-once assertion or automatic recovery-dispatch chain.
- `processContextChunks` retains its fitting direct call and no-store path. With a store, complete/resume original evidence, forward pauses, then run C4. Its integrated oversized success becomes only:
  - `{kind:'reduction_ready',request,inputTokens,progress,coverage,basis}` with exact immutable fitting `ClassificationRequest` and completion-derived original coverage.
  - Basis: `{taskId,executionToken,scoreId,articleId,contentRevision,assignmentRevision,generation,condensed:true,limited:false}`.
  - No numeric score, final oversized `classify`, score write or publication. Captured ownership is not a later publication fence. An incompatible store is failure, not evidence-ready fallback success.
- **References:** R1–R8; V3, V5–V8.

### C5–C7 — Preserve proof and historical evidence

- Unit memory-store fixtures must model revision conflicts and preserve full checkpoints, not return unconditional success/reset state. Real store tests use C2's actual factory, never a competing fake protocol/token-count authority.
- Keep original-stage repair/pause/quote tests by calling `generateScoreEvidence` directly where appropriate. Separately assert integrated `reduction_ready`; do not mechanically rename `evidence_ready` expectations or remove old assertions.
- Replace tests granting placeholder-level replacement/reset with new transition rejection proof; seed exact legacy fixtures separately. Missing v4 fields are malformed, not an unknown version; use a genuinely unknown version for that case.
- Append C7 only for checks actually run, recording runtime/commands, result counts, covered cases, unrun gates, baseline-relative paths and the ledger below. Report worker/coordinator/reviewer evidence with its actual provenance.

## Capacity gate, execution order and transfer

### Required before another implementation attempt

- **Authorization:** User approves this replacement strategy and explicitly authorizes a new implementation attempt. Earlier staged approval authorized the stopped attempt, not a fresh retry allowance.
- **Capacity commitment:** Coordinator identifies one accountable primary integrator and records a finite effort/context-continuation budget covering C1–C7, disposable-PG tests, final full checks and diagnosis time—not merely the remaining pure-helper work.
  - Require supported retained-context/checkpoint continuation or a suitably staffed maintainer, plus a protected final-verification allowance. Do not select another worker with the same exhausted allowance and label it a new plan.
  - No numeric capacity threshold can be inferred from disk space or supplied test counts. Actual available budget/support is missing input. If it cannot cover the whole outcome, defer/escalate resourcing; do not silently reduce R1–R8 or invent further micro-slices.
- **Tools/environment:** Command runner, Node 24.21.0 and installed locked dependencies, private baseline/evidence storage, exclusive source-writer access, Docker socket/cached `postgres:18` and disposable-test space. No dependency on completing P9/C21 or production composition.
- **Gate result:** Record these commitments in coordinator execution evidence before V0/source writes. Missing authorization, capacity, transfer or tools → `needs_input`, with existing work intact.

### One delivery, not another worker ladder

1. **Capture/reconcile baseline and run V1.** Preserve the current post-S1 bytes. Compare supplied predecessor records if available; do not try to recreate pre-S1 work from HEAD.
2. **Finish shared executable contracts C1/C2 with their tests.** Reuse the current renderers/measurement. Implement actual safety validators, not placeholders that persistence later bypasses.
3. **Build a vertical durable spine across C3/C4/C5/C6 and run V3 early.** Complete original evidence → bind → persist multi-batch manifest → commit one → pause → new owner/store → suffix-only resume → promotion → `reduction_ready`.
   - Exercise the real protocol/store/loop together before spending the entire allowance on standalone protocol breadth. Source stays unwired. All implemented transitions enforce their invariants; no temporary unsafe store API or activated incomplete reducer.
   - This is an internal behavioral checkpoint, not a separately delivered package or permission to claim R1–R8.
4. **Complete the adversarial/compatibility matrix V2/V4/V5 and preserved regressions.** Resolve integration issues within the same ownership/context; do not hand every failing file to a new worker.
5. **Run V6/V7, append C7, then obtain V8.** Only the assembled delivery is eligible for scoped completion assessment. Test success is neither user acceptance nor workflow-state advancement.

- **Execution ownership:** Primary owns the entire planned-change table and assembles/verifies it. Do not launch separate source writers for each ID/checkpoint.
- **Useful independent help:** A read-only investigator may audit missing R2–R7 vectors against C1–C3 and return exact case/source references while the primary works. No source/doc ownership or concurrent test/container writes. Final independent review remains V8, after integration, not a review/repair chain per artifact.
- **Parallelism:** No parallel writers in the canonical dirty checkout. This plan assumes no isolated worktree/result-merge permission. Any alternate writable workspace or writer transfer needs an explicit safe transfer arrangement first, not merely disjoint file lists.

### Dirty baseline and predecessor transfer

- **Canonical cwd:** `/home/matthias/feedrafter`; retain existing branch and worktree. Review base is supplied HEAD plus the actual post-S1 tracked/staged/untracked baseline from V0.
- **V0 evidence location:** Host-managed private directory outside the checkout, identified as `E` in coordinator evidence before execution. Use `E/baseline/` and `E/checkpoints/<label>/`; these are evidence locations, not extra repository plan artifacts.
  - Capture complete starting contents, path status and SHA-256 manifest of every existing owned path, including untracked files and the full current verification record. Record proposed absent paths explicitly.
  - Preserve tracked/staged binary diffs and Git path/status inventory for the wider dirty tree; fingerprint non-owned dirty paths so unrelated loss/change is detectable. Keep sensitive baseline contents private, not in test logs or published reports.
  - No `git clean`, reset, checkout, stash, staging, branch/worktree creation, commit or merge. A Git patch alone omits predecessor untracked files and is not a sufficient backup/transfer.
- **Predecessor data:** The current files are the actual S1 transfer. Preserve the stopped technical/staged plans, cumulative ledger and S1 verification append. Carry coordinator's pre-S1 V0/delta evidence if available; absence limits historical attribution but does not justify overwriting present bytes.
- **Internal checkpoint transfer:** Save baseline-relative file hashes/deltas (including complete new/untracked contents), interface signatures, actual commands/results, last green checks and known missing contracts under `E/checkpoints/<label>/`. Append only factual summaries to C7.
  - Continued work uses those same canonical bytes; no code transfer/commit/merge is implied by a completion message.
  - A planned context checkpoint is not a capacity-stop retry. A capacity stop ends the attempt. Replacing its executor/restarting after that stop needs another explicit disposition/authorization and another ledger entry.
  - If a successor is explicitly authorized, freeze writes; read this plan, technical requirements, ledger, baseline/current manifests and evidence; verify canonical hashes and interfaces before writing. Missing predecessor output or mismatched hashes → stop, not silently reimplement.
- **Rollback:** Preserve/report the delta. No whole-tree revert or automatic restore is authorized; any later correction/restoration must distinguish predecessor bytes from newly owned changes.

### Cumulative attempt ledger and stop policy

| Known event | Supplied disposition | Required carry-forward |
| --- | --- | --- |
| Large-package handoff 1 | Capacity stop; no reducer implementation; no technical infeasibility established | First known capacity stop remains recorded. |
| Large-package handoff 2 | Capacity stop; no reducer implementation; no technical infeasibility established | Second stop; not erased by preparatory changes. |
| Preparatory renderer/type extraction and bounded corrections | Safe partial foundations/corrections with scoped evidence; no full reducer | Preserve working-tree bytes and qualified evidence; not a successful reducer attempt. |
| Approved staged S1 | Capacity stop incomplete after partial sizing/direct reuse/tests and verification append | Third known capacity stop; missing S1 contracts stay open. |
| Staged S2 / S3 | Never started | No successful predecessor gate, implementation or acceptance to inherit. |
| Replacement plan approval and execution authorization | User approved the strategy and authorized sensible capacity values; one retained worker attempt stopped before source edits because available execution capacity could not cover the coherent package | Fourth known capacity stop. Do not retry or reset the ledger; V1 baseline rerun only. |
| Current user choice | “Use sensible values and just make it happen” | Authorization was exercised; attempt stopped for capacity. No further implementation attempt authorized. |

- Retain any more detailed coordinator attempt IDs/timestamps; none are invented here. Reconcile a conflicting ledger before execution. No fresh “two retries” budget per checkpoint, file, replacement plan or executor.
- **Capacity exhaustion:** Preserve files/evidence, list completed/missing contracts and checks, append factual stop evidence if possible, return `needs_input`. No automatic replacement worker, new slicing or reset to HEAD.
- **Material failed gate:** Stop progression; diagnose the concrete cause and report impact. One bounded correction/rerun may occur only with explicit coordinator disposition within the authorized scope/effort; a material design/safety/scope change requires user decision. Record failed and rerun evidence, not just the final success.
- **Repository/prerequisite mismatch:** Missing symbols/tools/transfer, unexpected external edits, apparent migration need, contradictory protocol or exhausted effort → stop and report. Do not invent a replacement design, drop checks, call providers, prune storage or expand scope.

## Verification

- **Strategy:** Unit vectors prove canonical lineage and exact envelopes; fake AI proves admitted call order/negative dispatch boundaries; real disposable PostgreSQL proves revision/owner fences, atomicity and restart. Final review covers the assembled baseline-relative delta.
- **Status:** All checks below are proposed. None was run during replacement planning. V1 reuses the predecessor command, not its prior result as a new pass.
- **Commands:** Repository root under Node 24.21.0; use `mise exec node@24.21.0 -- <command>` when not already active. Existing locked tools only; no install/update/live command.
- **PostgreSQL prerequisite:** `tests/helpers/usage-database.ts:createUsageDatabase`, `/var/run/docker.sock`, cached `postgres:18`, `--pull=never`, random loopback port. Apply existing migrations only inside disposable fixtures with `migrateDatabase`; always release barriers/pools/fixtures in `finally`/`dispose`.
  - No authored or operational migration, production URL/credential, image pull or separate cleanup/pruning. Unavailable real PG is an unmet gate, never replaced by mocks.

| ID | Changes / criteria | Check / command | Expected signal |
| --- | --- | --- | --- |
| V0 | All / R8 | After authorization/capacity gate: `git rev-parse HEAD`; `git status --short --untracked-files=all`; `git diff --name-only`; `git diff --cached --name-only`; `node --version`; `df -h .`; baseline capture described above | Actual post-S1 baseline, private evidence destination, exclusive writer, runner/runtime/space established; differences from supplied observations reconciled before writes. |
| V1 | C2, C4, C5 / R1, R4, R7 | `npm exec -- vitest run tests/unit/score-context-request.test.ts tests/unit/process-context-chunks.test.ts tests/unit/prepare-context.test.ts tests/unit/postgres-json-text.test.ts tests/unit/summarize-article.test.ts` | Before edits, predecessor behavior independently re-established; later, original protections remain green. No assumed fixed future test count. |
| V2 | C1, C2, C5 / R2, R4–R7 | `npm exec -- vitest run tests/unit/context-reduction.test.ts tests/unit/score-context-request.test.ts tests/unit/score-reduction-protocol.test.ts` | Complete pure vectors below; real shared protocol compiles and has no DB/provider capability. |
| V3 | C1–C6 / R1–R6, R8 | New early spine: `npm exec -- vitest run tests/integration/context-reduction.test.ts -t 'commits one batch before the next and resumes the pending suffix'` | Real PG/fake AI crosses actual shared interfaces and returns only a fitting complete-level request after suffix resume; no final classifier. |
| V4 | C1–C3, C6 / R2–R3, R5–R7 | `npm exec -- vitest run tests/integration/context-reduction.test.ts tests/integration/context-persistence.test.ts` | Full transition/codec/fence/rollback/bounds/write-count vectors below pass. |
| V5 | C3–C6 / R1–R7 | `npm exec -- vitest run tests/unit/reduce-score-evidence.test.ts tests/unit/process-context-chunks.test.ts tests/integration/context-recovery.test.ts` | Execution/admission/failure/restart matrix below; existing original-evidence regressions retained. |
| V6 | C1–C6 / R7–R8 | Rerun V1–V5, then `npm run typecheck && npm run lint && npm run build && npm exec -- drizzle-kit check && npm run test:unit && npm run test:integration` | Fresh scoped and full non-live regression/static evidence. No schema/migration delta; unrelated failures separately reported, not silently repaired. |
| V7 | All, C7 / R1, R4, R7–R8 | `git diff --check && git diff --cached --check`; inspect baseline-relative owned delta/new files, wider dirty-path fingerprints, production imports/call sites and evidence append | Predecessor/unrelated work preserved; approved paths only; no activation/final oversized classification/publication; ledger/results truthful. Git diff alone does not check untracked files. |
| V8 | Assembled C1–C7 / R1–R8 | Fresh final scoped independent review of baseline-relative source/tests and V0–V7 evidence against this plan and technical R1–R8 | Every criterion traced; material findings explicitly disposed/verified; no broader acceptance claim. |

### V1 / V2 — Pure and preserved cases

- Follow current order-sensitive tests in `score-context-request.test.ts` and `process-context-chunks.test.ts`; capture tokenizer strings and sent/returned requests for byte equality.
  - Escaped quotes/backslashes/newlines/control characters, non-ASCII/valid supplementary pairs; selected metadata/prompt isolation; distinct classifier/generator tokenizers/capacities; exact context/max-input boundaries and one-token overflow.
  - Reject invalid/missing limits, negative/fractional/non-finite/unsafe counts and overflowing totals. Mutating caller model/limits/state/questions/ref arrays after capture cannot change counted bytes; immutable request mutation is impossible or detected. Recount drift rejects before dispatch.
- Add canonical identity vectors in `context-reduction.test.ts`: equivalent object key orders and permuted valid model item/parent ordering yield identical host IDs/digests; changed basis/model/limits/selected metadata change identity.
  - Many-to-one multilevel lineage resolves exact UTF-16 quotes; identical overlap refs deduplicate deterministically, distinct intervals remain. Missing/unknown/duplicate/cross-batch/self/future parents, different questions/polarities, generated IDs/refs/quotes/offsets/coverage/scores and extra keys reject.
  - Test committed-prefix/finalized immutability, zero/eighth/ninth boundaries, malformed graphs/counts/IDs, all bounds, empty-output rejection for nonempty parents, NUL/lone high/lone low surrogate rejection and valid pairs.
- In `score-reduction-protocol.test.ts`, compare complete rendered parent/output classifier counts. Equal/increased count fails promotion despite shorter batch text; one-token whole-request decrease succeeds. Provenance-heavy unfit requests retain every ref.
  - Deterministic contiguous manifest/range/digest/count rebuild, fixed-envelope overflow, oversized singleton, non-monotonic tokenizer, planning probe/byte exhaustion and pre-dispatch drift. No split/drop/repacking to pass.
  - Complete all-empty/mixed-empty originals retain original coverage; incomplete originals cannot enter reduction even when present nodes fit.
- Preserve title-only direct call, preliminary/planner/dispatch exact order, native fractional index mapping, original one-repair/consumed-marker/auth/provider/quote/text safety and selected-field assertions.
  - Summary non-usable-quality rejection before AI and usable limitation metadata remain existing regression gates; no summary feature work.

### V3 — Early assembled behavioral checkpoint

- New test owns its fixture independently. Use real C2, C3, C4 and actual parent IDs from generated requests, not guessed IDs or a fake store/protocol.
- Complete originals and produce at least three pending reducer batches. Gate the first batch commit and assert the second call cannot begin until it settles; then return a typed pause on the second.
- Reacquire the task with a new token, construct a new `ContextStore`, resume; assert only the pending suffix generates, all outputs commit before promotion, and full original coverage/refs survive reload.
- Final `reduction_ready` serializes exactly as counted, fits actual classifier limits, carries the current basis, and has no score. No `classify`, session or publication call. Passing this single checkpoint is not the full verification matrix.

### V4 — Durable protocol and compatibility matrix

- Follow `context-persistence.test.ts` seed/migration/trigger patterns and its article-lock `pg_stat_activity` barrier. Use independent sessions and deterministic barriers, not sleep-only races.
- Test bind/start/each ordered commit/promote/fail; current-revision no-op; immutable originals after binding; immutable finalized/pending/failure state; out-of-order or incomplete promotion rejection; no ninth level.
  - Tamper original evidence/digest/coverage/quotes, host IDs, parent/basis/manifest/level digests, ranges and counts; reload/transition rejects without mutation.
  - Old/wrong token/target/action/generation, changed content/assignment/text and newer generation including terminal tasks reject. Ownership changed while blocked is rechecked after lock acquisition.
- Two same-token sessions at one revision: exactly one mutation wins. Stale evidence save/batch commit/promotion cannot overwrite, reset or remove progress, repair claims or failure. Changed protocol basis/models/limits cannot silently reuse/reset state.
- Inject checkpoint-write and deferred COMMIT failures for evidence, repair, start, commit, promotion and failure writes. Independently reread unchanged prior revision/evidence/markers/graph; retain plan/chunk creation rollback proof.
- Seed exact v2/v3 with placeholders, repaired/incomplete-consumed markers; strict validation precedes normalization. Read exposes virtual 0 without a write; first fenced mutation gives revision 1 with zero completion rewrites. Oversized conversion preserves legacy bytes.
  - Seed v1 with untrusted purpose-specific result rows; resume cannot trust them. Explicit empty recomputation deletes only the intended plan/purpose rows atomically; injected rollback restores them. Unknown/malformed/extra-key/missing-v4-field objects fail closed.
- Test just below/at/above normal/hard serialized limits with escaping-heavy text, reserved failure headroom and oversized next output. Prior committed outputs survive `checkpoint_limit`; no raw malformed output stored. Independently exercise PostgreSQL's own size constraint rollback.
- Keep trigger-count regression: current fixture's 13 incremental completions → 13 inserts, allowed pre-bind replacement → one update, identical save → zero writes. Bind/start/commit/promote/fail/legacy conversion → zero completion upserts.

### V5 — Execution, failure and recovery matrix

- Follow `fake()`/`vi.fn<AiPort['generate']>()` patterns. Extraction responses keep their quote schema; reducer responses derive parent IDs from the actual request. Capture exact counted/sent bytes and automatic/task/signal scopes.
- Zero-level/all-empty success still binds basis; mixed empties preserve coverage; missing original completion forbids reduction. Multilevel success, fitting eighth, non-fitting eighth without ninth dispatch, pending eighth suffix-only resume; fitting pending prefix is never final success.
- Crash after final batch commit/before promotion resumes by promotion without generation. Response loss before commit leaves no output and may repeat that uncommitted admitted request on explicit resume. Application error after a successful DB commit reloads/reuses output without redispatch.
- Both budget reasons, auth/configuration pauses, admitted auth failure, generic provider error, abort, stale owner/revision and write/commit failure preserve progress and forbid following calls.
  - Invalid output durably fails with no repair; resumed terminal failure is call-free. Non-shrink preserves all outputs without promotion. Bound/level/recount failure uses the finite codes. Failed failure-marker write propagates persistence failure.
- Carry an original v3 repair marker through conversion, several reducer batches, pause, promotion/failure and owner reacquisition unchanged. Incomplete consumed original repair fails before reduction.
- Maintain separate evidence-only helper tests and integrated oversized tests. Never weaken original-stage assertions to make the new boundary pass.

### Evidence exclusions

- No external provider/live tests or production DB. Applying existing migrations in disposable test fixtures is test setup, not operational migration authorization.
- E2E/container deployment/target-host tests are not required for an unwired application/domain/storage change with no serving/lifecycle/UI/schema edits; no claims about those gates. An unexpected need to change those paths is a stop condition, not permission to broaden verification/implementation.
- Full C13/V13/D2, final oversized classifier/publication, workflow, P9, C21, D4/D8 and operator/user acceptance remain open even after this bounded delivery passes.

## Readiness and required decisions

- **Artifact:** `.ai/c13-reduction-replacement-plan.md`; canonical replacement execution plan. Earlier files remain technical authority/history, not parallel active worker sequences.
- **Product/safety decisions:** None newly unresolved; R1–R8 and prior failure/result boundaries are unchanged. No scope reduction proposed.
- **Missing execution inputs:** Named continuous owner, finite reserved capacity/continuation and final-verification allowance, private evidence destination, current writer exclusion and actual runner/Node/Docker/storage prerequisites. Coordinator must establish these, not infer them from past passes.
- **Another user decision is required:** Approve this revised capacity-aware strategy and explicitly authorize one further implementation attempt after capacity is confirmed. Plan approval alone is not implementation authorization. If capacity cannot be supplied, recommend deferral or a suitably staffed maintainer, not another unchanged worker retry.
- **Stop/report:** Any material mismatch or missing prerequisite returns `needs_input` to coordinator with preserved work and the cumulative ledger. This planning artifact starts no implementation, review, migration, deployment or workflow transition.
