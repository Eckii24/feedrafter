# C13 persistent bounded reduction — Revised Implementation Plan

## Overview

- **Outcome:** Finish the persistent hierarchical reducer for the existing oversized-score evidence path. Return a fitting, unpublished classifier request; do not execute that final classifier.
- **Scope:** One coherent delivery: bounded reduction, atomic per-batch checkpoints, fenced recovery, exact sizing, original-evidence lineage, and fake-AI/PostgreSQL verification.
- **Unchanged / excluded:** Full D2 workflow, task scheduling/publication, P9, C21, D4, D8, APIs/UI, production composition, deployment, commits, and publication. Direct scores retain their current behavior.
- **Design:** Extend the existing JSONB checkpoint to v4; retain immutable finalized levels and one pending level. No SQL migration or dependency addition.
  - Existing schema already accommodates a bounded versioned object. Do not introduce tables merely to implement this protocol.
- **Failure policy:** No automatic reduction-output repair in this slice. Invalid reduction output fails durably; existing original-chunk repair policy remains unchanged.
  - This is the smallest bounded policy within C13's repair ceiling. It avoids another durable repair-dispatch protocol and additional implicit spend.
- **Readiness: `needs_input` — approval required.** Re-planning is authorized; implementation is not. The earlier general implementation request is not renewed by this document.
- **Material risks:** Provenance-heavy requests may not shrink or fit; aggregate checkpoint bounds may reject otherwise valid work. Uncommitted provider work may repeat after a lost response. These are visible failures/limitations, never truncation or exactly-once guarantees.

## Planned changes

This table describes future changes only. This planning task writes only this document.

| ID | File / area | Planned change and purpose |
| --- | --- | --- |
| C1 | `src/server/domain/context-reduction.ts` (new) | Shared bounded reduction types, canonical IDs/digests, graph/lineage validation, and transition invariants. |
| C2 | `src/server/adapters/postgres/context-store.ts` (modify) | Strict v4 codec, known legacy compatibility, revision-checked evidence saves and reduction transitions under existing fences; atomic batches and durable failures. Preserve repair markers and changed-only completion writes. |
| C3 | `src/server/application/score-context-request.ts` (new); `src/server/application/process-context-chunks.ts` (modify) | Share the exact score request renderer and verified sizing between direct requests, whole-level shrink checks, and final-fit checks. Preserve direct-score behavior. |
| C4 | `src/server/application/reduce-score-evidence.ts` (new); `src/server/application/generate-score-evidence.ts`, `src/server/application/process-context-chunks.ts` (modify) | Deterministic exact-envelope batching, admitted reducer execution and resume, then `reduction_ready`. Share evidence-plan construction and pass current checkpoint revisions. No final classifier dispatch for this path. |
| C5 | `tests/unit/context-reduction.test.ts`, `tests/unit/score-context-request.test.ts`, `tests/unit/reduce-score-evidence.test.ts` (new); `tests/unit/process-context-chunks.test.ts` (modify) | Protocol, renderer, adversarial-output, bounds, fake-AI sequencing, and direct-path regression tests. |
| C6 | `tests/integration/context-reduction.test.ts` (new); `tests/integration/context-persistence.test.ts`, `tests/integration/context-recovery.test.ts` (modify) | Real PostgreSQL batch recovery, revision/owner races, rollback, compatibility, write-count and repair-marker regressions. Adapt old placeholder-level tests to the real protocol. |
| C7 | `docs/verification.md` (modify after implementation verification) | Append actual bounded reducer evidence and remaining gates; preserve historical attempts/results. Do not claim full C13/V13/D2 acceptance. |

No planned edits to migrations, database schema, AI ports/adapters, settings, production entry points, source spec, or the parent implementation plan.

## Implementation details

### Basis

- **Authoritative scope:** Coordinator request for this revised plan; necessary facts and selected policies are recorded here so execution does not require the planning conversation.
- **Source:** `.ai/news-reader-plan.md`, C13, lines 366–387.
  - Parent criteria: `docs/dev-agentic-news-reader-spec.md` AC6, AC10–AC11, AC20; parent verification V13 is broader than this delivery.
- **Conventions:** `docs/architecture.md` §§5–7: PostgreSQL-owned durable progress, visible bounded failure, regular-model reduction, no exactly-once external-call guarantee.
- **Verified source evidence:**
  - `prepareContext` / `selectContext` in `src/server/application/prepare-context.ts`: selected-field isolation, exact planner envelope, UTF-16 boundaries, fixed-envelope check, and bounded provider probes.
  - `processContextChunks` currently dispatches fitting direct classifiers; oversized requests with a store call `generateScoreEvidence`. Without a store they return `unsupported_chunks`.
  - `generateScoreEvidence` currently ends at `evidence_ready`; no reduction loop or reducer dispatch exists. Its regular generations use `automatic` admission and strict original-quote validation.
  - `ContextStore` currently validates v2/v3 evidence and coverage, stores original completions in `chunk_results`, and claims original-chunk repair markers before dispatch. Its placeholder `reductionLevels: {level,evidence:string[]}[]` is not an implemented reducer protocol.
  - Current `save` permits placeholder level replacement/reset. Ownership locks alone do not prevent an older snapshot from the same execution token overwriting newer reduction progress. C2 replaces that capability.
  - `context_checkpoints.state` in `src/server/adapters/postgres/schema/enrichment.ts` is JSONB, constrained to an object of at most 1,048,576 PostgreSQL bytes. Current application checkpoint/evidence limits are 500,000 serialized bytes each.
  - `isPostgresJsonText` in `src/server/domain/postgres-json-text.ts` rejects NUL and unpaired UTF-16 surrogates. Valid surrogate pairs are allowed.
  - Current `save` validates previous evidence and writes only new/changed completions using `isDeepStrictEqual`. Preserve this verified correction.
- **Supplied Git/runtime evidence; not rerun during planning:**
  - HEAD `843452b4204b13696cf20d2448e696ad00e59561`; highly dirty/untracked worktree. The inspected working tree, not HEAD alone, contains the relevant corrections. Preserve all existing contents.
  - Node 24.21.0; latest scoped C13/correction suite: six files / 95 tests passed. Typecheck, lint, build, Drizzle check and diff checks passed. Fresh scoped full review of the corrections reported no findings.
  - Exact supplied suite and qualifications are recorded in `docs/verification.md`, “Final bounded correction verification”. Older counts and `.ai/news-reader-handoff.md` are historical, not the current baseline.
  - Disposable PostgreSQL works following explicitly authorized prior pruning; 112.3 GB reclaimed and approximately 117 GB free at the last check. This plan authorizes no further pruning.
  - Two earlier reducer handoffs made no reducer-source edits. P9 remains fail-closed; D2 remains incomplete.
- **Planning evidence limitation:** File inspection only. No command-execution tool is exposed in this planning session; Git status/HEAD, runtime, free space, test execution and review results above are coordinator-supplied evidence, not independent new measurements.
- **Execution dependencies:** Explicit approval of this revised plan; preservation/baseline capture for the dirty worktree; Node 24.21.0 and installed locked dependencies; a command runner; Docker socket and cached `postgres:18` for the existing disposable helper.
  - No implementation dependency on completing P9, C21, D4, D8 or full D2. Existing `AiPort` injection is sufficient for this delivery.
- **Stop rule:** If repository reality contradicts this plan, a required prerequisite is absent, or a migration appears necessary, stop and report the concrete mismatch. Do not invent a replacement design, prune storage, or expand scope.

### Acceptance criteria

These reduction-specific criteria refine the parent criteria; they do not redefine full C13 acceptance.

- **R1 — Entry and boundary:** Reduction starts only after every original planned chunk has a validated completion and completion-derived coverage is complete. Direct scores and the no-store `unsupported_chunks` path remain unchanged. The oversized path returns `reduction_ready`, not a score or publication.
- **R2 — Persistent progression:** A reduction basis binds the original evidence and actual request contract. Each successful batch commits before any following generator call. Resume skips committed batches, completes only the pending suffix, and promotes only a complete level. Finalized levels are immutable, contiguous, and limited to eight.
- **R3 — Fencing and atomicity:** All state transitions recheck running owner token, score target, task kind/generation, content/assignment basis and newer-generation supersession under the existing lock order. Revision checks reject same-owner stale saves, resets and out-of-order commits. Failed transactions leave evidence, levels, markers and revision unchanged.
- **R4 — Exact sizing:** Every generator request is counted and sent as the same serialized envelope, with verified framing/output/context/max-input limits. Whole-level strict decrease and final fit use the shared exact classifier renderer and classifier tokenizer. Unknown/invalid limits, unsafe counts or inconsistent recounts fail closed. Nothing is truncated.
- **R5 — Original provenance:** Deterministic evidence IDs and validated immediate parent IDs preserve every input node's question/polarity lineage, including counterevidence. Original quotes/offsets are host-resolved transitively; models cannot supply them. Completion-derived coverage is unchanged by reduction, even when original completions contain no evidence.
- **R6 — Admission and failure:** Each reduction batch makes a regular `AiPort.generate` call in the automatic bucket. Typed budget/auth/configuration pauses retain progress. Invalid output, non-shrink, exhausted hierarchy or unrepresentable bounds fail visibly without destroying committed work. No automatic reducer-output repair and no exactly-once claim.
- **R7 — Compatibility and verified fixes:** Strict known v2/v3 codecs reuse validated original completions; legacy placeholder reductions are recomputed, never trusted. v3 repair markers survive. v1 requires original-evidence recomputation; unknown/malformed versions fail closed. NUL/surrogate rejection and changed-only completion writes remain covered.
- **R8 — Bounded delivery:** Fake-AI and disposable-PostgreSQL checks demonstrate the protocol without external providers, deployment, publication or production wiring. Evidence clearly distinguishes this delivery from remaining C13/V13/D2 work.

### C1 — Shared protocol and lineage

- **Shared types:** Move only the existing `ChunkEvidence` / `ChunkCompletion` type declarations to the new domain module and re-export them from the store for existing imports. Do not relocate unrelated store/planner logic.
- **New checkpoint shape:** Keep existing original-completion, coverage and evidence-digest fields; replace placeholder reduction storage with:

```ts
// Conceptual interfaces; all stored objects have exact, validated key sets.
type ReductionNode = {
  id: string;                 // host-assigned SHA-256
  questionId: string;
  polarity: 'support' | 'counter' | 'uncertain';
  text: string;
  parentIds: string[];         // immediate preceding-level IDs, not quotes
};
type BatchPlan = {
  id: string;
  start: number; end: number; // half-open indexes into ordered parent nodes
  requestDigest: string;     // SHA-256 of exact JSON.stringify(GenerationRequest)
  inputTokens: number;
};
type BatchState = BatchPlan & { output: ReductionNode[] | null };
type PendingLevel = {
  level: number;
  parentDigest: string;
  inputClassifierTokens: number;
  batches: BatchState[];      // committed prefix, null-output suffix
};
type FinalizedLevel = PendingLevel & {
  outputClassifierTokens: number;
  digest: string;             // every batch output is non-null
};
// ContextCheckpoint v4 additionally contains:
// revision: positive safe integer
// reductionBasisDigest: SHA-256 | null
// reductionLevels: FinalizedLevel[]
// pendingReduction: PendingLevel | null
// reductionFailure: { code: finite failure code; level: number;
//                     batchId: string | null } | null
```

- **Bounds:** Retain the 500,000-byte hard application checkpoint cap and separate 500,000-byte original-completion cap. Reserve 1,024 checkpoint bytes for a bounded failure marker; normal progress must fit within 498,976 bytes. Never store raw malformed model output in the checkpoint.
  - At most eight finalized levels; pending level is exactly `finalized.length + 1`, never level nine.
  - At most 4,096 nodes per parent/output level and 4,096 nonempty batches per level. A batch output has at most 32 items; each item text has at most 16,384 UTF-8 bytes. Parent ID count per item is bounded by that batch's input count.
  - Validate all text before JSONB using `isPostgresJsonText`. Validate IDs/digests as lowercase 64-hex strings; validate counts/offsets as safe integers. Reject excess data rather than shorten it.
- **Canonical identity:** Use ordered tuples with explicit protocol-domain labels for hashes, not JSONB object key order.
  - Original node ID: hash of protocol label, plan ID, original chunk ID, evidence ordinal and canonical validated evidence tuple. Preserve planner chunk order, then original evidence order.
  - Reduction basis digest: hash of protocol label, plan ID, validated original `evidenceDigest`, both models/limits, exact empty-item generator envelope, and exact empty-evidence final classifier envelope. Envelope templates, selected metadata and task question are thereby bound without adding prompt/model history to scores.
  - Parent digest: ordered full parent node representation, bound to that basis; level zero also binds the original completion digest, including empty completions.
  - Batch ID: basis, level, parent digest, batch ordinal and `[start,end)`.
  - Reduced node ID: basis, level, batch ID, canonical output ordinal and validated output tuple. Level digest binds the complete manifest, outputs and before/after classifier counts.
- **Lineage validator:** Treat original evidence as level zero; original quotes remain only in original completion records.
  1. Reject raw responses over 500,000 UTF-8 bytes before `JSON.parse`. Accept model JSON only as `{"items":[{"questionId":"0","polarity":"support","text":"...","parentIds":["..."]}]}` with exact key sets; allow the existing question-ID index contract, not arbitrary question text or IDs.
  2. Require each parent ID to belong to this batch's preceding-level nodes. Reject duplicates, unknown IDs, cross-batch references, self/future references and empty parent lists.
  3. Require every batch input ID to occur in exactly one output item's parent list. No dropped parents, duplicated parents or new evidence roots.
  4. Require each item's question and polarity to equal those of every parent it merges. Never combine support/counter/uncertain or different questions into one item.
  5. Canonicalize parent order by input order and output order by first parent position before assigning host IDs. Reject supplied IDs, quotes, refs, offsets, coverage, scores and extra keys.
- **Transitive resolution:** Resolve each current node through validated preceding levels to original evidence refs; return the canonical union, never generated offsets or quotes.
  - Deduplicate identical original `(start,end,quote)` refs across overlap; choose the earliest planner-chunk ordinal as representative. Keep distinct intervals/quotes distinct; do not merge intervals or invent quotes.
  - Keep original UTF-16 half-open offsets and validated original chunk IDs. Verify quote equality and surrogate boundaries through existing completion validation.
  - Empty original completions contribute coverage, not synthetic evidence nodes. All-empty evidence is valid and requires no reduction call if the empty-evidence final request fits.
- **Failure codes:** Use a small finite set: `invalid_output`, `non_shrinking`, `level_limit`, `unfit_request`, `checkpoint_limit`, `sizing_changed`. A persisted reduction failure is terminal for this plan/generation; retry requires a new generation, not a reset.
- **References:** R2–R7; V1–V6.

### C2 — Fenced checkpoint transitions

- **Entry points:** Update `ContextProgress`, `ContextCheckpoint`, `checkpoint`, `validateState`, `save`, `claimRepair`, and `resume`; retain `fenced`, `verifyChunks`, `validateCompletions`, `loadCompletions` and original evidence-digest validation.
- **Evidence-only save contract:** Remove reduction fields from writable `ContextProgress`; reduction is writable only through the new transition surface. Update all local callers/tests.

```ts
save(owner, input, progress, at, completions, expectedRevision: number | null)
// null: create absent state, or explicitly recompute v1 from empty progress.
// number: must equal the loaded current revision.

advanceReduction(owner, input, expectedRevision, protocol, transition, at)
// transition: bind_basis | start | commit_batch | promote | fail
```

- **Transition verification:** `protocol` is an immutable descriptor plus shared render/count functions assembled by C3/C4, not a runtime AI capability. Recompute manifests, digests and before/after classifier sizes from loaded parents through these shared pure functions; do not trust caller-supplied counts or import the execution loop into the store.
  - `resume(owner,input)` validates persisted graph structure/digests and original evidence consistency. C4 must additionally verify the current protocol basis and exact request recounts before reuse or dispatch.
- **Revision discipline:** New v4 states start at revision 1. Every actual evidence, marker or reduction mutation increments the revision in the same transaction; exact no-op saves with the current revision need not write.
  - Compare expected revision after acquiring article → task locks and validating the persisted state. A stale revision throws a bounded conflict; it never merges or resets state, including for the same execution token.
  - Existing owner/basis failure may retain the store's `null` stale result. Convert either stale condition to a visible error at the application boundary; no next AI call.
  - Reload current rows inside every transition. Caller progress is not authoritative state.
- **Original state invariants:** Completed IDs and repair markers are monotonic. Preserve existing changed-only inserts/upserts before reduction starts, including supported replacement of an existing completion with a current revision.
  - Once a reduction basis is bound, original evidence is immutable: reject changed/removed completions. Require a new generation for new evidence or another reduction basis.
  - `claimRepair` still claims only an incomplete original chunk, at most once. Construct its next checkpoint from the loaded full state so it cannot strip v4 fields. Preserve markers through every reduction transition, failure and upgrade.
- **Ordered reduction transitions:**
  1. **Bind basis:** Require complete original coverage and no terminal failure. Persist the first reduction basis even if level-zero evidence already fits; an existing basis must match exactly. Binding is immutable and does not make a generator call.
  2. **Start:** Require a matching bound basis, no terminal failure, no pending level, and a non-fitting current final request. Persist the full deterministic pending manifest and parent measurement before dispatching batch zero. Reject starting past level eight.
  3. **Commit batch:** Require matching revision, basis, level, parent digest and next uncommitted batch ID. Revalidate output and host IDs against loaded parents. Append only that batch output; never replace a committed output. Atomically write output and progress before returning.
  4. **Promote:** Require all outputs committed. Recompute the whole concatenated output request using C3 and require its classifier input token count to be strictly less than the parent's. Move the pending level into the immutable finalized list; clear pending in the same commit. Do not duplicate its stored outputs.
  5. **Fail:** Attach only the bounded failure marker; preserve original evidence, all finalized levels, the pending manifest and its committed prefix. Failure cannot clear/change earlier results. No transition may clear a v4 failure within the same plan/generation.
- **Storage bounds:** Preflight the actual candidate checkpoint before writes. If an output would exceed the normal progress bound, persist `checkpoint_limit` against the prior state using reserved headroom; do not lose prior batches or proceed to another call. Actual PostgreSQL constraint failures roll back and propagate.
  - A validated legacy state that cannot fit the v4 normal-progress bound must remain untouched and report a bounded compatibility/size failure. Do not discard original completion IDs or markers to force an upgrade.
- **Legacy policy:** Validate known legacy objects with their original exact codecs before normalizing; reject malformed coverage/evidence or extra fields.
  - **v2:** Validate original evidence/digest; normalize missing repair markers to empty because its producer had no repair dispatch.
  - **v3:** Validate and preserve repair markers, including an incomplete consumed repair.
  - **v2/v3 reductions:** Validate the old bounded string-level shape but discard it only as an explicit legacy conversion; recompute reduction from validated originals. Those levels contain no validated reduction lineage and cannot become v4 finalized levels.
  - Return normalized v4 semantics with virtual revision 0 on legacy reads; first fenced mutation with expected revision 0 writes v4 revision 1. Do not rewrite completion rows merely to upgrade a checkpoint.
  - **v1:** `resume` returns recomputation-required/no reusable completion as today. Only explicit empty-progress recomputation may replace it; delete untrusted `purpose = 'context-evidence-v2'` rows for that plan atomically, leaving other purposes, legacy chunks and scores untouched.
  - **Unknown version / malformed known object:** Fail closed on read and write. Never treat it as absent state or as v1.
- **References:** R2–R3, R6–R7; V3–V6.

### C3 — One exact classifier request contract

- **New shared helpers:** Export a score request renderer, final-evidence-state renderer, verified-model validation and exact size/fit checker. Reuse them in the direct path and C4; do not maintain an independent reducer approximation.
- **Direct renderer:** Preserve the existing property order and exact `ClassificationRequest` contract:
  - `{ model, role: 'scores', state, questions: { score: { type: 'score', instructions: task.prompt, criteria: ['0','25','50','75','100'] } } }`.
  - Direct `state` remains exactly `selectContext(task.article, task.fields)`; no added metadata or changed score mapping.
- **Evidence state:** Selected non-content fields in existing `selectContext` order, followed by `evidence`.
  - Each evidence entry has canonical order `{id,questionId,polarity,text,refs}`; refs are the host-resolved original refs from C1, ordered deterministically.
  - Do not present generated evidence as original `content`, include unselected fields, or add full article text beside evidence. Carry coverage and condensed/limited basis in the returned result/checkpoint, not as model claims.
- **Exact measurements:** Serialize the actual immutable request once with `JSON.stringify`, pass that string to the relevant `VerifiedModel.countTokens`, and retain the same request object for dispatch/return. Never parse/reserialize into a differently ordered envelope after counting.
  - Require nonnegative safe input counts, safe totals and `input + framing + output <= contextTokens`; also `input + framing <= maxInputTokens` when supplied. Retain existing positive verified output/context limit rules.
  - Fixed empty-item generator and empty-evidence classifier envelopes must fit before content probing or model calls. No catalog-limit fallback; no substring, byte clipping or dropping refs to manufacture fit.
  - **Strict decrease:** Compare classifier-token counts for the complete parent/output levels rendered identically, including all selected metadata, evidence IDs, transitive quotes, question and request framing fields. Do not use character count, reducer token count, batch-local decrease or a sum of separate requests.
  - **Final fit:** Apply that classifier's framing and output reserves and optional max-input bound. A fitting level need not be reduced further.
- **References:** R1, R4–R5; V1–V2, V7.

### C4 — Sequential persistent reducer

- **Evidence handoff:** Extract a shared evidence-plan builder from `generateScoreEvidence` without changing its extraction envelopes/chunk identities. It supplies the same `ContextInput` and generator request factory to evidence generation and reducer resume.
  - Remove hard-coded `reductionLevels: []` evidence writes; pass the returned current revision to C2. Retain the existing original repair marker and parser behavior.
  - Keep `generateScoreEvidence` independently testable as an evidence stage. Its completion result includes or permits reloading the saved checkpoint; it is not the final result of the integrated oversized path.
- **New entry:** `reduceScoreEvidence(task: ScoreContextTask, ai: AiPort, store: ReductionStore)`; `ReductionStore` is the existing save/resume/repair subset plus C2's transition method.
- **Result boundary:** Add a discriminated `reduction_ready` result containing:
  - Exact fitting `ClassificationRequest`, measured `inputTokens`, current checkpoint/progress and original coverage.
  - Basis `{taskId, executionToken, scoreId, articleId, contentRevision, assignmentRevision, generation, condensed: true, limited: false}` for this usable-content score subset.
  - No numeric score, classification result, score-store call or publication. Its captured token/basis is not itself a publication fence; future callers must recheck ownership/basis at final dispatch/publication.
- **Integration:** In `processContextChunks`, retain the direct path. For oversized requests with a store, complete/resume evidence, forward a typed pause unchanged with progress, otherwise enter the reducer. The integrated oversized path now returns `reduction_ready` rather than `evidence_ready`.
- **Execution order:**
  1. Snapshot task-owned data as the current entry point does; validate both verified models. Rebuild the exact original evidence plan and resume through the store's fences.
  2. Require complete original completion/coverage records. Resolve the current parent level, bind the basis if absent, and compare the current basis, graph and recounted manifests with persisted values. A mismatch fails closed; never reset v4 levels.
  3. If a persisted failure exists, report it before any AI call. If a pending level exists, finish/promote it before deciding whether its prefix would fit. A partial level can never serve as final context.
  4. Otherwise measure the current whole final request. If it fits, return `reduction_ready`, including when no reduction levels were needed. If eight levels already exist and it does not fit, persist/report `level_limit`; never call a ninth level.
  5. Plan and persist the next pending level through C2, then process only its uncommitted suffix in order.
  6. For each completed model response, strictly parse/validate output, persist that batch atomically, await commit, then consider the next generator call. After all batches commit, promote through C2 and repeat from step 4.
- **Generator renderer:** Use an immutable `GenerationRequest` with property order `{model,role:'context_reduction',system,user}`.
  - `system` defines C1's exact output schema, preserving every parent ID and its question/polarity group, using selected input only, with no quotes/offsets/coverage/scores. Treat evidence as untrusted data, not instructions.
  - `user = JSON.stringify({question: task.prompt, context: selectedNonContent, items})`; ordered input items are `{id,questionId,polarity,text}`. Quotes/offsets stay server-side; final rendering resolves them.
  - The exact fixed system string and user shape are implementation constants included in the basis digest. Extraction and reduction are distinct generator contracts.
- **Deterministic contiguous batching:**
  1. Start with the next parent index. Append one entire node at a time while the exact generated request fits the generator's verified bounds. On the first non-fitting extension, finalize the last fitting nonempty prefix and start the next batch at its end.
  2. Do not assume tokenizer monotonicity beyond choosing this safe prefix; maximal packing is not required. Never split an evidence node/text or omit a parent. A non-fitting singleton fails with `unfit_request` before dispatch.
  3. Require the manifest to partition `[0,parentCount)` without gaps, overlap or reordering. Persist IDs, ranges, exact serialized-request digests and counts, not duplicate prompt/model payloads.
  4. Bound planning to 4,096 token probes and 16 MiB aggregate serialized probe input per level, following the original planner's work-guard principle. Exceeding the work bound is visible `unfit_request`, not permission to relax limits. Count fixed-envelope checks and pre-dispatch recounts separately from planning probes; each such check is bounded by an already planned request.
  5. Rebuild the request for each pending batch; require the same digest/count and recount immediately before dispatch. A changed count is `sizing_changed`, not an opportunity to repack a persisted level.
- **Admission and pauses:** Each batch uses `ai.generate(request, {bucket:'automatic',taskId:task.owner.taskId,signal:task.signal})`. No SDK session, direct provider call, automatic fallback, recursive retry or parallel batch dispatch.
  - Preserve `paused_budget` reasons, `paused_auth` and `paused_configuration` with the last committed progress. Map admitted `UsageAttemptError` auth as the existing evidence path does; propagate other attempt failures without disguising them as non-admission pauses.
  - Check abort before each dispatch. Abort/provider failure preserves the checkpoint and prevents the next call.
  - Invalid model output persists `invalid_output`, then fails; no reduction repair call. Non-shrink persists `non_shrinking` with all successful batch outputs retained, without promoting the bad level.
  - Surface durable protocol failures as a bounded typed error containing the failure code and last committed progress; do not expose malformed model output or pretend a score was produced. A failed failure-marker write propagates as a persistence failure, with no following AI call.
- **Crash semantics:** No transaction spans an AI call. A committed batch is never reissued by normal resume. A response lost before durable batch commit, an ambiguous commit response, or concurrent same-owner invocations can cause an uncommitted regular batch to be dispatched more than once.
  - Reload first after an ambiguous commit; reuse any committed result. There is no provider/DB atomic transaction and no exactly-once dispatch guarantee. Revision checks allow only one state advance and never let a duplicate overwrite a committed batch.
- **References:** R1–R8; V1–V7.

### C5–C7 — Execution and evidence sequence

1. Establish the dirty-tree baseline without discarding, stashing, committing or formatting existing work. Record the actual implementation command runner/runtime and scoped diff paths.
2. Build focused protocol/renderer tests, then C1–C3 and their persistence tests. Confirm intended behavior failures are not missing-tool failures.
3. Implement C4 serially against that shared contract; add fake-AI and real-store recovery cases before claiming reduction exists.
4. Run the central verification checks and inspect changed lines relative to the captured worktree baseline. Diagnose a material failure, make an explicit bounded correction decision, and rerun affected checks; do not expand into D2/P9 or repair unrelated artifacts.
5. Append only actual results to C7, including remaining gates and any unrun checks. Do not change workflow state or claim user acceptance.

## Verification

- **Strategy:** Pure tests cover protocol/lineage/sizing boundaries; fake AI covers request ordering/admission and execution limits; disposable PostgreSQL proves durable atomicity and lock/revision behavior. No external provider calls.
- **Status:** All checks below are proposed for the future implementation. None were run for this plan. Supplied baseline evidence is recorded once in Basis.
- **Prerequisites:** Commands run from repository root under Node 24.21.0. Existing `createUsageDatabase()` in `tests/helpers/usage-database.ts` uses `/var/run/docker.sock`, a loopback-only random port and cached `postgres:18` with `--pull=never`; migrate via `migrateDatabase` and always dispose in `finally`.
  - Use the fixture and deterministic promise/`pg_stat_activity` lock barriers in the current context tests. No production URLs, credentials, live flags, image pulling or further pruning. If disposable PG cannot run, report the failed material gate; do not substitute mocks for persistence evidence.

| ID | Changes / criteria | Procedure / command | Expected signal |
| --- | --- | --- | --- |
| V1 | C1, C3, C5 / R2, R4–R5, R7 | `npm exec -- vitest run tests/unit/context-reduction.test.ts tests/unit/score-context-request.test.ts` | Deterministic codec/lineage/renderer and all boundary cases below pass. |
| V2 | C3–C5 / R1–R2, R4–R6 | `npm exec -- vitest run tests/unit/reduce-score-evidence.test.ts tests/unit/process-context-chunks.test.ts tests/unit/prepare-context.test.ts tests/unit/postgres-json-text.test.ts` | Ordered fake-AI execution, level limits and existing direct/planner/text-safety regressions pass. |
| V3 | C1–C2, C6 / R2–R3, R7 | `npm exec -- vitest run tests/integration/context-reduction.test.ts tests/integration/context-persistence.test.ts` | Real-store transition/fencing/rollback/compatibility cases below pass. |
| V4 | C2, C4, C6 / R1–R3, R5–R7 | `npm exec -- vitest run tests/integration/context-recovery.test.ts tests/integration/context-reduction.test.ts` | Real-store execution/resume and lost-response caveat cases below pass. |
| V5 | C1–C2, C5–C6 / R2–R3, R7 | Size/codec/failure/write-count cases within V1 and V3; inspect stored rows and trigger log | Bounds fail without data loss; repair claims survive; completion write counts remain linear. |
| V6 | C1–C6 / R3, R7–R8 | `npm run typecheck && npm run lint && npm run build && npm exec -- drizzle-kit check && npm run test:unit && npm run test:integration` | Static/full non-live regressions pass; any unrelated failure is reported separately, not silently fixed. |
| V7 | C3–C4, C7 / R1, R4, R8 | `git diff --check && git diff --cached --check`; inspect baseline-relative scoped diff, call sites and updated verification record | Only approved paths changed by this delivery; no migration, production import/wiring, final oversized classification/publication, or unsupported completion claims. Include untracked new files in inspection; Git diff alone omits them. |

### V1 / V2 cases — pure functions and fake AI

- **Exact requests:** Capture every tokenizer string and every fake-AI request; assert byte-for-byte `JSON.stringify(sentRequest)` equality, not only deep object equality. Include an order-sensitive tokenizer that rejects alternate property order.
  - Escaped quotes/backslashes/newlines, JSON control-character escaping where valid, non-ASCII and paired supplementary Unicode; exact-boundary fit and one-token overflow for context and max-input bounds.
  - Different classifier/generator capacities and tokenizers; preserve selected-field isolation and distinct score prompts. Reject invalid/missing limits, unsafe/noninteger/negative counts and inconsistent recounts.
- **Whole-level shrink:** Shrinking reducer input/batch texts is insufficient if the actual final classifier request is equal/larger. Equal or increased whole-level counts fail without promotion; a one-token decrease is sufficient even if another level is needed.
  - Include provenance-heavy output where shorter text still cannot fit. No trimming quotes, IDs or selected metadata to pass.
- **Hierarchy:** Zero levels when original evidence fits; multiple levels when needed; fitting eighth level succeeds. A non-fitting eighth finalized level fails before any ninth-level call. Pending eighth-level resume completes/promotes only that level.
- **Batch plan:** Contiguous deterministic partitions; fixed-envelope overflow and oversized singleton make zero generation calls; bounded non-monotonic tokenizer case; probe count/bytes exhausted visibly. Exact persisted manifest survives rebuild.
- **Lineage:** Valid many-to-one reduction across levels preserves original refs and counterevidence. Reject missing/unknown/duplicate/cross-batch parents, changed question/polarity, mixed-polarity merges, extra keys, generated quotes/offsets/IDs/coverage/score, empty outputs for nonempty parents, and excessive counts/text.
  - Overlapping identical refs deduplicate deterministically without merging distinct intervals. Refs still quote exact original UTF-16 intervals. Model ordering variations canonicalize to the same host IDs.
  - Reject NUL, lone high surrogate and lone low surrogate in model text before persistence; accept valid pairs. Keep existing original-evidence text/quote repair regressions.
- **Empty evidence / coverage:** Empty completions are valid. All-empty evidence with complete original coverage produces a fitting empty-evidence request without reducer calls; mixed empty/nonempty chunks retain full coverage. Missing any original completion prevents reducer dispatch even if existing evidence fits.
- **Execution boundary:** A pause at batch N returns committed-prefix progress. Resume sends N, not any committed earlier batch. Fake-store hooks assert batch N was committed before N+1 enters `generate`.
  - Every call carries the automatic/task/signal scope; no final oversized `classify`, session creation or score write. Zero-level success still persists its reduction basis. Direct path still performs its one classifier call and existing fractional native-index mapping.
  - Typed budget/auth/configuration outcomes, admitted auth failure, generic provider failure and abort prevent later calls. Invalid reduction output makes no automatic repair call; a persisted terminal failure makes subsequent resume call-free.
- **Existing evidence tests:** Keep original-stage repair tests focused via `generateScoreEvidence` where appropriate; separately test integrated `processContextChunks` with valid reducer responses. Do not delete old pause/repair/isolation assertions to accommodate the new result kind.

### V3 / V4 cases — disposable PostgreSQL

- **Durable batch resume:** With at least three reducer batches, pause after committing one and reacquire the task with a new token. Use a new `ContextStore` instance; compare serialized request history. Committed batch never repeats, next uncommitted batch does, and promotion happens only after all batches commit.
  - Crash after final batch commit but before promotion; restart promotes without another generation. A fitting pending prefix is never returned as a complete final level.
- **Lost response:** Fake provider observes/succeeds a batch, then inject response loss before store commit. Assert no output was committed; explicit resume may repeat precisely that uncommitted request through regular admission. State this limitation in the test name/assertions, not an exactly-once claim.
  - Inject an application-visible error after a successful DB commit; reload finds the output and makes no repeat call. This distinguishes committed output from a lost model response.
- **Stale fencing:** Old owner, wrong target/task kind, changed content/assignment revision, changed source text, generation mismatch and newer same-target generation cannot advance a level. Wait on the article lock, change ownership while blocked, then verify post-lock rejection.
- **Same-owner stale state:** Two independent sessions use one token and the same revision. Gate their commits: exactly one state advance; the loser cannot overwrite the first output, remove a pending level, reset finalized levels, clear failure/repair markers, or replace original evidence after reduction starts.
  - Repeat with stale evidence `save`, stale promotion, out-of-order batch, changed manifest/parent/basis digest and changed classifier/generator limits. Assert stored state remains unchanged on rejection. Concurrent invocations may have duplicate uncommitted dispatch; never claim otherwise.
- **Rollback:** Use trigger failures on checkpoint write and deferred commit failure, following current context tests. Inject failures for start, batch commit, promotion and evidence/repair changes. Reopen/read in an independent session; prior state/revision, completions and markers are intact, with no half-promoted level or following AI call.
- **Coverage/provenance reload:** Tamper one completion, original quote, ID, parent, digest, batch range, stored count or coverage field. Read/transition rejects inconsistent state. Empty evidence still has correct completion-derived full coverage; reduction output cannot claim a missing range complete.
- **Repair-marker preservation:** Start from a v3 repaired completion, upgrade, commit multiple reduction batches, pause, promote/fail and reacquire ownership. The original marker remains identical. An incomplete consumed repair fails before reduction, including after upgrade.

### V5 cases — storage bounds and compatibility

- Exercise just-below/at/above application byte bounds with escaping-heavy strings; exercise PostgreSQL JSONB limit rollback independently. Previously committed outputs survive an oversized next output plus durable `checkpoint_limit` marker.
- Trigger-count original `chunk_results` writes: retain the current 13 incremental completions → 13 inserts regression; a permitted pre-reduction completion replacement causes one update, identical saves cause none. Starting, committing, promoting or failing reduction causes zero completion upserts.
- Known v2/v3 fixtures validate and reuse original evidence; only legacy string reductions are discarded. Verify no completion rewrites during conversion and v3 markers survive. Reject malformed legacy fields/coverage/evidence before conversion.
- v1 completion/reduction claims never resume; explicit fenced empty recomputation removes only its untrusted context-evidence rows atomically. Unknown version, missing mandatory v4 fields, extra keys and invalid revision/level arrays fail closed on save and resume.
- Legacy/current finalized history cannot grow past eight; no skip/replacement/removal, same-level rewrite, parent mismatch or pending-prefix reset is accepted. A terminal failure cannot be cleared by same-owner save or transition.

## Readiness, decisions and remaining evidence

- **Native plan result:** `.ai/c13-reduction-plan.md`; one delivery, serial source writes, no separately dispatched packages.
- **Required decision:** Coordinator/user must explicitly approve this revised plan before any implementation. Approval includes the intentionally bounded `reduction_ready` boundary and the no-automatic-reducer-repair failure policy.
- **Other product/design questions:** None left to the executor. If either selected policy is rejected, revise this document first; do not choose a different protocol during implementation.
- **Evidence/tool gaps:** Planning session has no command runner; supplied Git/runtime/storage/test/review evidence was not independently rerun. Implementation must establish its actual baseline and execution prerequisites before source changes, then produce fresh reducer-specific V1–V7 evidence.
- **Residual risks:** Strict parent preservation is structural provenance, not proof that generated wording faithfully summarizes every claim. Exact transitive refs can dominate context size. Eight levels or the bounded checkpoint may be insufficient for an article; fail visibly with successful work retained.
- **Compatibility risk:** v4 is not readable by older binaries. No deployment/rollback execution is included; do not pair an older writer with v4 checkpoints. Retaining original evidence permits future explicit regeneration, not an automatic downgrade/reset.
- **Still incomplete after this delivery:** Final oversized classification and fenced publication, workflow-level pause/resume/scheduling, full C13/V13/D2 acceptance, P9, C21, D4 and D8. This plan grants no inference activation, production/provider calls, deployment, commit, push, merge or publish permission.
