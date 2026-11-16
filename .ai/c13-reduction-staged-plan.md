# C13 persistent bounded reduction — Staged Execution Plan

## Overview

- **Outcome:** Implement the approved persistent reducer through an unpublished, exactly sized `reduction_ready` request, preserving R1–R8.
- **Shape:** One bounded delivery; three dependency-ordered execution slices. Slice exits prove foundations, not partial reducer acceptance.
- **Technical decision unchanged:** v4 JSONB checkpoint, immutable finalized levels, one pending level, atomic ordered batch commits, exact whole-classifier sizing and original-evidence lineage.
- **Approved boundaries retained:** No automatic reducer-output repair; no final oversized classifier dispatch or publication. Existing original-chunk repair remains distinct.
- **Excluded:** Production/provider calls, workflow/queue wiring, P9, C21, D4, D8, APIs/UI, schema/migration/dependency changes, cleanup/pruning, deployment, commit/push/merge and publication.
- **Status: approved by user for S1–S3; S1 is stopped incomplete for capacity.** Do not resume or split S1 further without a new user decision. “Continue” authorized re-scoping; explicit approval of this staged plan authorized one S1 execution, not retry chains after its capacity stop.
- **Risks:** Provenance can dominate size; reduction may not shrink or fit within eight levels/checkpoint bounds. Uncommitted provider work can repeat after response loss. Preserve work and report bounded failure; never truncate or claim exactly-once execution.

## Planned changes

- Future implementation only. This planning task creates only `.ai/c13-reduction-staged-plan.md`; it does not change the approved technical plan or source.
- IDs below belong to this document. References prefixed **technical C/V** belong to `.ai/c13-reduction-plan.md`.

| ID | Slice | File / area | Planned change and purpose |
| --- | --- | --- | --- |
| C1 | S1 | `src/server/domain/context-reduction.ts` (modify) | Extend the existing evidence types with bounded reduction protocol types, canonical identities, lineage/graph validation and pure transition invariants. |
| C2 | S1 | `src/server/application/score-context-request.ts`, `src/server/application/process-context-chunks.ts` (modify) | Extend the existing renderer with shared verified sizing and final-evidence rendering; reuse direct-path helpers without changing its behavior. Preserve exported type compatibility. |
| C3 | S1 | `src/server/application/score-reduction-protocol.ts` (new) | Pure immutable protocol factory: exact reduction envelopes, basis binding, deterministic bounded batch planning and recounting. Make the real contract available before store implementation. |
| C4 | S1 | `tests/unit/context-reduction.test.ts`, `tests/unit/score-reduction-protocol.test.ts` (new); `tests/unit/score-context-request.test.ts`, `tests/unit/process-context-chunks.test.ts` (modify) | Unit proof of lineage, canonicalization, bounds, exact ordering/sizing and unchanged direct/evidence routing. |
| C5 | S2 | `src/server/adapters/postgres/context-store.ts`, `src/server/application/generate-score-evidence.ts` (modify) | Strict v4/legacy codec and revision-fenced transitions; adapt evidence-only writes to current revisions without adding reducer dispatch. Preserve repair markers and changed-only completion writes. |
| C6 | S2 | `tests/integration/context-reduction.test.ts` (new); `tests/integration/context-persistence.test.ts`, `tests/integration/context-recovery.test.ts`, `tests/unit/process-context-chunks.test.ts` (modify) | Real PostgreSQL transition, compatibility, race, rollback and write-count tests; adapt existing evidence fixtures to v4/revisions without weakening assertions. |
| C7 | S3 | `src/server/application/reduce-score-evidence.ts` (new); `src/server/application/generate-score-evidence.ts`, `src/server/application/process-context-chunks.ts` (modify) | Sequential admitted batch execution/resume and evidence-plan sharing; integrate only the unwired oversized helper through `reduction_ready`. |
| C8 | S3 | `tests/unit/reduce-score-evidence.test.ts` (new); `tests/unit/process-context-chunks.test.ts`, `tests/integration/context-reduction.test.ts`, `tests/integration/context-recovery.test.ts` (modify) | Fake-AI sequencing plus real-store recovery, lost-response, failure and final-boundary proof. |
| C9 | S1–S3 | `docs/verification.md` (append-only modification during implementation) | Record actual slice exits, cumulative attempt history, final checks/review and remaining gates; distinguish reports from independent verification. |

No changes planned to `postgres-json-text.ts`, `prepare-context.ts`, summary implementation/tests, AI ports/adapters, production entry points, SQL/schema, settings, the source spec or `.ai/c13-reduction-plan.md`. Existing tests in those areas remain regression gates.

## Implementation details

### Basis and source precedence

- **Authoritative technical source:** [Approved reducer plan](c13-reduction-plan.md), “Acceptance criteria” R1–R8, technical C1–C4, and all verification cases.
  - Read those sections in full before implementing any slice. R1–R8 remain defined there once; this document does not replace or relax them.
  - Its single-package execution shape, approval-status text and historical file-newness/evidence are superseded only by the staging, approval gate and inspected baseline here. Technical protocol and approved failure/result boundaries remain authoritative.
- **Parent references:** `.ai/news-reader-plan.md` C13; `docs/dev-agentic-news-reader-spec.md` AC6, AC10–AC11, AC20; `docs/architecture.md` §§5–7.
- **Repository guidance:** Supplied `/home/matthias/.pi/agent/AGENTS.md`; `to-plan` skill and its example read. No repository `AGENTS.md` found by file search.
- **Verified by file inspection in this planning session:**
  - `context-reduction.ts` contains only `ChunkEvidence` / `ChunkCompletion`; the store already re-exports them. Do not repeat type extraction as new work.
  - `score-context-request.ts:renderScoreRequest` already preserves `{model,role,state,questions}`. The direct path uses it; shared model validation/sizing and evidence rendering are not yet present.
  - `processContextChunks` still returns original evidence for oversized requests with a store; without one it returns `unsupported_chunks`. Its direct score mapping is `100 * nativeIndex / 4`, including fractional indices.
  - `generateScoreEvidence` still writes `reductionLevels: []`, returns `evidence_ready`, and has the durable original-chunk repair policy. No reducer entry/dispatch exists.
  - `ContextStore` remains v3 with strict v2/v3 evidence loading and placeholder string levels, but no revision fence or reduction transition API. `save` validates previous accumulated evidence and skips unchanged completion writes with `isDeepStrictEqual`.
  - `isPostgresJsonText` rejects NUL and unpaired high/low surrogates, accepting valid pairs. Evidence text/quotes use it before JSONB persistence.
  - `selectContext` orders selected title, category, tagWeights, sourceWeight, then content. Preserve this order; evidence rendering substitutes `evidence` after the selected non-content fields.
  - `context_checkpoints.state` is JSONB with a 1,048,576-byte PostgreSQL text constraint; no schema change needed.
  - `summarizeArticle` rejects non-usable quality before generation and retains limitation metadata for usable content. Summary eligibility is a preservation gate, not new C21 work.
- **Supplied coordinator evidence — not independently executed here:**
  - HEAD `843452b4204b13696cf20d2448e696ad00e59561`; many modified/untracked files. The working tree, not HEAD alone, contains the corrections and renderer/types.
  - Node 24.21.0; approximately 109 GB free at latest check. Earlier free-space figures are historical, not current prerequisites established here.
  - Independently run correction suite: six files / 95 passed; typecheck, lint, build, Drizzle and diff checks passed; fresh scoped correction review passed.
  - New renderer/direct-order check: two files / 37 passed. Context suites after type extraction: four files / 73 passed.
  - Worker reported full unit 407 / integration 240 under Node 24; not independently rerun. `docs/verification.md` also records an earlier focused four-file / 62 result; do not substitute it for the supplied newer checks.
  - Reviewer found delivered direct renderer/type extraction safe, but full R1–R8 absent. No first-stage or reducer implementation acceptance follows from that finding.
- **Planning limits:** File reads/searches only; no independent shell, Git, runtime, disk, Docker, test or review execution. This plan reports supplied evidence as such, not as new successful checks.

### Constraints and shared contract

- **Acceptance:** R1–R8 from the technical source apply to the assembled delivery. Verification mapping is centralized below; neither S1 nor S2 satisfies complete reducer acceptance.
- **No partial activation:** S1 has no AI/DB execution; S2 adds durable capability but no reducer call site; S3 connects only the existing unwired application helper and fake-AI tests. No production import/composition/route/scheduler changes in any slice.
- **Approved output:** Oversized integration ends at `reduction_ready`, carrying the exact fitting `ClassificationRequest`, `inputTokens`, checkpoint/progress, original coverage and basis:
  `{taskId,executionToken,scoreId,articleId,contentRevision,assignmentRevision,generation,condensed:true,limited:false}`.
  - No numeric score, final oversized `classify`, score-store write or publication. Captured ownership is not a future publication fence.
- **Approved failure policy:** Reducer invalid output is durably terminal, with no repair call, fallback or recursive retry. Preserve the existing one separately admitted original-chunk repair and its consumed-marker semantics.
- **Stop rule:** Missing prerequisite, contradictory repository reality, consequential interface change or apparent need for migration → stop and report to coordinator. Do not invent a replacement design, relax a gate or expand scope.

### C1–C3 — Pure executable protocol before persistence

- **Technical source:** technical C1, C3 and the pure generator-rendering/batching parts of technical C4. This is a factoring change, not a different reducer algorithm.
- **C1 data shapes:** Implement the technical source's `ReductionNode`, `BatchPlan`/`BatchState`, `PendingLevel`, `FinalizedLevel` and v4 reduction fields exactly.
  - Persisted revision is a positive safe integer. Virtual revision 0 exists only on validated v2/v3 reads until the first fenced mutation; see C5.
  - Finalized levels are contiguous and immutable; pending level is exactly finalized count + 1. Batch outputs form a committed prefix followed by null outputs.
  - Failure codes remain `invalid_output`, `non_shrinking`, `level_limit`, `unfit_request`, `checkpoint_limit`, `sizing_changed`.
- **C1 identities/lineage:** Use protocol-labeled ordered SHA-256 tuples, not JSONB key order. Follow technical C1's exact identity inputs for originals, basis, parents, batches, reduced nodes and finalized levels.
  - Strict reducer JSON schema is `{"items":[{"questionId":"0","polarity":"support","text":"...","parentIds":["..."]}]}`; exact keys, valid planned decimal question indexes and permitted polarity only.
  - Every immediate parent appears exactly once across a batch's outputs. Reject unknown, missing, repeated, cross-batch, self/future parents and question/polarity changes; never merge counterevidence into support.
  - Canonicalize parents by input order and items by first parent before assigning host IDs. Models supply no IDs, refs, quotes, offsets, coverage or scores.
  - Resolve refs transitively to validated original UTF-16 intervals/quotes; identical `(start,end,quote)` refs deduplicate to earliest planner chunk. Do not merge distinct intervals. Empty completions contribute coverage, not nodes.
- **C1 bounds:** At most eight levels, 4,096 nodes and nonempty batches per level, 32 outputs per batch, 16,384 UTF-8 bytes per output text, parent counts no greater than batch input. Reject malformed JSON above 500,000 raw UTF-8 bytes before parsing; reject JSONB-invalid text, not valid paired Unicode.
  - Checkpoint hard cap 500,000 serialized bytes; normal progress cap 498,976, reserving 1,024 bytes for failure. Original completions retain their separate 500,000-byte cap. Never retain malformed raw output.
- **C2 entry points:** Extend existing `renderScoreRequest`; add exported verified-model validation, exact request measurement/fit and final-evidence state rendering.
  - Move `VerifiedModel`'s declaration here only if needed for shared typing; re-export it from `process-context-chunks.ts` so current summary/test imports remain valid. No unrelated type relocation.
  - Exact direct envelope remains `{model,role:'scores',state,questions:{score:{type:'score',instructions:prompt,criteria:['0','25','50','75','100']}}}`.
  - Final evidence entries are ordered `{id,questionId,polarity,text,refs}` after selected non-content fields; no unselected fields or full original content alongside evidence.
  - Count `JSON.stringify(actualRequest)` with that request's verified model. Retain the same immutable request for return/dispatch; do not normalize or reorder after counting.
  - Require safe nonnegative counts/totals, valid verified limits, `input + framing + output <= context`, and optional `input + framing <= maxInput`. Whole-level strict shrink uses complete classifier requests, including IDs/refs/metadata, never reducer counts or text length.
  - Direct-path helper reuse must retain preliminary/planner/pre-dispatch equality, one classifier call, pause handling, selected-field isolation and native score mapping. Oversized routing remains evidence-only through S2.
- **C3 new entry:** `createScoreReductionProtocol(...)` returns an immutable protocol descriptor plus pure render/count/plan/recount functions; no `AiPort`, store, sessions or provider capability.
  - Use a typed descriptor/function surface shared by C5 and C7. Declare protocol-neutral types in C1; keep score request/envelope implementation here/C2. No store import of the execution loop.
  - Accept only necessary snapshotted task prompt/selection/model data. Supply current plan ID, validated original completions/evidence digest and loaded graph when resolving/measuring state; do not close over caller-supplied progress/outputs as authoritative persisted data.
  - Descriptor binds both actual models/limits, the exact empty-item generator envelope and empty-evidence classifier envelope. Basis also binds plan ID and validated original evidence digest. Fixed system text is one constant included in that descriptor.
  - Generator order is `{model,role:'context_reduction',system,user}`; `user = JSON.stringify({question:prompt,context:selectedNonContent,items})`; input items are ordered `{id,questionId,polarity,text}`. Evidence is untrusted data, never instructions. Original extraction and reduction schemas stay distinct.
  - Verify fixed envelopes fit. Greedily append whole contiguous parent nodes until first non-fitting extension; finalize the last fitting nonempty prefix. A non-fitting singleton fails before dispatch. No splitting/omission or monotonic-tokenizer assumption.
  - Bound planning to 4,096 token probes and 16 MiB aggregate serialized probe input per level. Fixed-envelope checks and pre-dispatch recounts are separate bounded checks, not unbounded planning probes.
  - Return manifests partitioning `[0,parentCount)` with IDs/ranges/exact serialized request digests/counts, not duplicated prompt payloads. Rebuild/recount must match; drift becomes `sizing_changed`, never repacking persisted work.
- **S1 interface exit:** Protocol/types/renderers and their test vectors compile together. C5 tests use this actual factory, not a second fake sizing/protocol implementation. If S2 requires a consequential contract change, stop; do not compensate by trusting caller counts.
- **References:** R2, R4–R7; V1, V2, V6, V9.

### C5 — Fenced v4 codec and store state machine

- **Technical source:** technical C2 in full; retain its exact compatibility, transition and locking rules. Pure recomputation comes from C1–C3, already verified at S1 exit.
- **Entry symbols:** `ContextProgress`, `ContextCheckpoint`, `checkpoint`, `validateState`, `save`, `claimRepair`, `resume`; add `advanceReduction`. Preserve `fenced`, `verifyChunks`, `validateCompletions`, `loadCompletions` and evidence-digest validation.
- **Write interfaces:**

```ts
save(owner, input, progress, at, completions, expectedRevision: number | null)
// progress: evidence completion IDs and repair markers only; no writable reduction fields.
// null: absent checkpoint creation or explicit empty v1 recomputation.
// 0: first mutation of a fully validated v2/v3 checkpoint.
// positive: exact current v4 revision.

advanceReduction(owner, input, expectedRevision, protocol, transition, at)
// transition: bind_basis | start | commit_batch | promote | fail
```

- **Revision/fence mechanics:** Acquire article → task locks, recheck running token/target/kind/generation, content text/revisions, assignment and newer same-target generation, then load/validate current rows and compare expected revision.
  - Actual evidence, repair-marker or reduction mutation increments revision atomically; fresh v4 starts at 1. Exact current-revision no-op save need not write. Stale same-owner snapshots throw bounded conflict; owner/basis rejection may retain `null`. Application turns either rejection into visible failure before any next AI call.
  - Store recomputes basis, lineage, manifest digests/counts and whole-level sizes from loaded originals/parents through the real shared protocol. No trusted caller progress, counts or replacement graph.
- **Transitions:** Bind complete originals even for zero-level success; start only a non-fitting current level with no pending/failure; commit only next pending batch; promote only all-committed strictly smaller whole classifier request; fail adds terminal bounded marker without clearing prior state.
  - Starting past eight, pending-prefix fit, reset/removal/rewrite, changed bound basis/evidence and cleared terminal failure are forbidden.
  - Preflight normal-progress bytes; oversized next output commits only `checkpoint_limit` on prior state using reserved headroom. PostgreSQL write/commit failures roll back and propagate. No completion upserts on reduction transitions.
- **Original evidence/repair:** Keep monotonic completion IDs/repair markers and changed-only completion writes. Supported completion replacement is allowed only before basis binding, at current revision; originals become immutable once bound.
  - `claimRepair` retains its existing call signature/at-most-once guard, constructs next checkpoint from loaded full state, increments revision and returns the current checkpoint. It cannot strip reduction fields.
  - Adapt `generateScoreEvidence` to pass each returned revision and remove hard-coded reduction resets. Evidence-only completion still returns `evidence_ready` through S2; no reducer dispatch yet.
- **Compatibility:** Strict original exact v2/v3 codecs first; validate completions/digest/coverage/legacy bounded string levels before normalizing. Preserve v3 repair markers; normalize v2 markers to empty. Discard only validated legacy placeholder reductions, never original evidence.
  - Legacy reads expose virtual revision 0 without writing. First fenced mutation persists v4 revision 1 with no completion rewrites. If conversion exceeds the normal bound, leave legacy state untouched and report compatibility/size failure.
  - v1 cannot resume trusted completions/reductions. Only explicit fenced empty recomputation may replace it and atomically remove untrusted `context-evidence-v2` result rows for that plan. Leave other purposes, legacy chunks and scores untouched.
  - Unknown/malformed versions, extra keys or inconsistent graph/coverage/evidence fail closed on read/write. Never treat them as absence/v1.
- **Fixture adaptation:** Replace placeholder-level write tests with transition tests; retain separately seeded exact legacy fixtures. An incomplete v4 object is now malformed, not an “unknown version”; use a genuinely unknown version for that case. Update the unit memory store to return/check revisions and preserve fields rather than masking production conflicts.
- **References:** R2–R3, R6–R7; V3, V4, V6, V9.

### C7 — Reducer/resume integration

- **Technical source:** technical C4 in full. C1–C3's pure planning/rendering is reused, not reimplemented here.
- **New entry:** `reduceScoreEvidence(task: ScoreContextTask, ai: AiPort, store: ReductionStore)`; store subset adds `advanceReduction` to existing evidence save/resume/repair capabilities.
- **Evidence handoff:** Share/export the existing evidence-plan builder from `generate-score-evidence.ts`. Reuse its exact extraction envelope/system/tools, `ContextInput`, chunks and plan identity; extraction refactor must not change hashes or eligibility.
  - Keep `generateScoreEvidence` independently callable and tested as evidence-only. Its completed result includes or permits loading the current checkpoint/revision.
- **Loop order:**
  1. Snapshot caller-owned task data, validate both models, rebuild original plan and resume through store fences. Require all validated original completions/coverage, including empty ones.
  2. Resolve current parents; verify bound basis/graph/recounts or bind once. Persisted failure reports before AI; never reset v4 levels.
  3. Finish/promote an existing pending level before fit decisions. Otherwise return approved `reduction_ready` if the current whole request fits. With eight finalized non-fitting levels, persist/report `level_limit` without a ninth call.
  4. Plan/persist the full next pending manifest before dispatch. For its uncommitted suffix, recount the exact request immediately before each call, validate output, atomically commit that batch and await success before any next call.
  5. Promote a complete strictly smaller level and repeat. Non-shrink preserves all committed outputs and fails without promotion.
- **Admission/failure:** Use `ai.generate(request,{bucket:'automatic',taskId:task.owner.taskId,signal:task.signal})` for each batch, serially. Preserve budget reasons/auth/configuration pauses with last committed progress; map admitted auth errors as existing evidence execution does, without disguising other admitted failures as non-admission.
  - Check abort before dispatch; abort/provider/persistence/conflict failures forbid subsequent calls. Invalid output persists `invalid_output`, then throws a bounded typed protocol error with code/progress, not raw malformed output. Failed failure-marker write propagates persistence failure.
  - No AI call inside a transaction. After ambiguous commit, reload first; reuse committed output. Response loss before commit and concurrent same-owner invocation may repeat uncommitted work on explicit resume; no automatic retry chain/exactly-once assertion.
- **Integration entry:** `processContextChunks` retains fitting direct and no-store paths. With a store, complete/resume evidence; forward typed pauses; otherwise call reducer and return only `reduction_ready` for oversized success.
  - No fallback to evidence-ready partial success when reducer/store is incompatible. Production remains unwired; do not add activation flag or composition merely to exercise tests.
- **References:** R1–R8; V5–V9.

### C9 — Cumulative evidence, not workflow state

- Append actual commands/runtime, changed paths, test counts/cases, slice exit state and remaining checks. Do not rewrite historical entries or turn worker reports into independently rerun results.
- Carry the complete attempt ledger below into execution reports. Add actual later attempts/stops cumulatively; successful foundation exits do not reset the count.
- After S3 checks and final review, record the bounded result and remaining full C13/V13/D2, final oversized classification/publication, workflow, P9/C21/D4/D8 gates. No acceptance or workflow-state advancement inferred from test success.

## Staged execution and serial integration

These are three execution slices within one delivery, not three launches per file or separately accepted product packages. Default: one executor; execution environment chooses supported staffing. No parallel source writers.

| Slice | Coherent result | Change IDs | Hard prerequisite | Exit evidence | Safety at exit |
| --- | --- | --- | --- | --- | --- |
| S1 — Pure protocol and exact sizing | Tested executable contracts/lineage/rendering/batching | C1–C4, C9 | Explicit user approval; V0 | V1, V2, V6, V9 | Unit-only; store remains v3; oversized path still evidence-only; no reducer dispatch. |
| S2 — Durable state machine | Real-PG-tested v4 compatibility/transitions/fences | C5–C6, C9 | S1 exit; disposable PostgreSQL prerequisites | V2–V4, V6, V9 | Evidence path works with v4; transition capability is not connected to reducer execution; no `reduction_ready` claim. |
| S3 — Reducer and assembled proof | Fake-AI + real-PG reducer/resume ending at approved boundary | C7–C9 | S2 exit; actual shared interfaces carried forward | V1–V9, then V10 | Only unwired helper integrated; bounded reducer acceptance assessed only now; no production/final classification/publication. |

- **Approval scope:** User must approve this staged sequence before S1. This document alone launches nothing; prior approval of the large technical package does not authorize another handoff under it.
- **Workspace/base:** Canonical cwd `/home/matthias/feedrafter`; preserve the existing branch and dirty tree. Review base is supplied HEAD plus the actual pre-S1 tracked/staged/untracked baseline captured by V0, not HEAD alone.
  - No new branch/worktree, checkout, reset, stash, cleanup, staging, commit or merge is authorized. No isolated branch result is assumed available.
- **Serial transfer:** S1 results remain in those canonical files; S2 consumes those exact interfaces/tests; S3 consumes S2's actual store API. Shared files (`process-context-chunks.ts`, evidence helper, tests and verification record) are written only serially after predecessor exit.
  - Capture each slice's baseline-relative changed paths/content and check results in coordinator evidence; append factual exit summary to C9. Those files plus recorded evidence are the transfer, not completion text or an unmerged branch.
  - If executor changes, the successor reads both plans, cumulative ledger, current files/delta and exit evidence before writing. Preserve unfinished changes on a stop; do not restore the pre-slice tree or silently rebuild a predecessor.
- **No artifact repair handoffs:** A failed material gate needs diagnosis, explicit bounded correction disposition and affected-check rerun in the current scope. Capacity exhaustion or an unresolved design/prerequisite blocker stops the slice and returns `needs_input`; do not spawn replacement retries, reset counts or split again by artifact.
- **Review order:** Slice exits are verification/interface gates, not fresh formal reviews per file. One final scoped R1–R8 review follows all S3 integration and checks (V10). A material finding blocks completion until explicitly disposed and verified; no automatic review/repair worker chain.

### Cumulative attempt ledger — retain, never restart

| Prior event | Supplied disposition | Carry-forward meaning |
| --- | --- | --- |
| Large-package handoff 1 | Stopped for capacity; no reducer implementation; no technical infeasibility established | Remains in total history. |
| Large-package handoff 2 | Stopped for capacity; no reducer implementation; no technical infeasibility established | Second stopped handoff; no retry authorization inferred. |
| Delivered preparatory work/corrections | Renderer/type extraction safe; corrected text safety/completion writes verified; R1–R8 still absent | Existing dirty-tree baseline, not accepted S1/reducer and not a history reset. |
| Stop-point response | User said “continue”; coordinator selected re-scope, not another large-package worker retry | This planning task only; new implementation waits for explicit approval. |

No attempt IDs/timestamps beyond these supplied facts are invented. Preserve any more detailed coordinator history; reconcile before a new implementation start if its count differs. Later slice activity appends to that history rather than creating a new allowance of two retries per slice.

## Verification

- **Strategy:** Pure unit tests prove contract/lineage/exact envelopes; fake AI proves ordered admission and negative dispatch boundaries; disposable PostgreSQL proves durability, fences and atomicity. Fresh final review covers the assembled delta.
- **Status:** All V0–V10 below are future implementation checks. None executed during planning. Baseline reports are recorded only in Basis.
- **Runtime:** Repository root under Node 24.21.0, installed locked dependencies and an actual command runner. Commands below assume that Node is active; existing evidenced wrapper is `mise exec node@24.21.0 -- <command>` if needed. Do not assume a runner is present because prior workers had one.
- **PostgreSQL:** Reuse `tests/helpers/usage-database.ts:createUsageDatabase`, `/var/run/docker.sock`, cached `postgres:18`, `--pull=never`, loopback random port; migrate via `migrateDatabase`, always release fixtures with their existing `finally`/`dispose` lifecycle.
  - This fixture lifecycle is not authorization for separate environment cleanup/pruning. No production URLs/credentials, live tests, image pulls or new dependencies. Missing Docker/image/space → report failed prerequisite, not mock substitution.

| ID | Changes / criteria | Check / command | Expected signal |
| --- | --- | --- | --- |
| V0 | All / R8 | After approval: `git rev-parse HEAD`; `git status --short --untracked-files=all`; `git diff --name-only`; `git diff --cached --name-only`; `node --version`; `df -h .`; capture starting contents/diffs for all owned paths including untracked files | Actual dirty baseline preserved; runtime/storage/runner confirmed; existing changes distinguishable from this delivery. |
| V1 | C1–C4 / R2, R4–R7 | `npm exec -- vitest run tests/unit/context-reduction.test.ts tests/unit/score-context-request.test.ts tests/unit/score-reduction-protocol.test.ts` | Pure protocol/render/batch cases below pass without DB or AI calls. |
| V2 | C2, C4–C8 / R1, R4, R6–R7 | `npm exec -- vitest run tests/unit/process-context-chunks.test.ts tests/unit/prepare-context.test.ts tests/unit/postgres-json-text.test.ts tests/unit/summarize-article.test.ts` | Direct order/score mapping, evidence repair, planner guards, JSONB safety and summary eligibility unchanged. |
| V3 | C1–C3, C5–C6 / R2–R3, R7 | `npm exec -- vitest run tests/integration/context-reduction.test.ts tests/integration/context-persistence.test.ts` | Real-store transitions, codec, race, rollback, bounds and write counts below pass. |
| V4 | C5–C6, later C7–C8 / R1–R3, R6–R7 | `npm exec -- vitest run tests/integration/context-recovery.test.ts` | S2 preserves existing evidence-only recovery; S3 adds/asserts integrated recovery without dropping original-stage proof. |
| V5 | C7–C8 / R1–R6 | `npm exec -- vitest run tests/unit/reduce-score-evidence.test.ts` | Exact fake-AI history, ordered durable calls, hierarchy and failure cases below pass. |
| V6 | All source/tests / R7–R8 | `npm run typecheck && npm run lint && npm run build && npm exec -- drizzle-kit check` | Each slice compiles/static checks pass; no generated migration/schema delta. |
| V7 | C1–C8 / R1–R8 | At S3, rerun V1–V6, then `npm run test:unit && npm run test:integration` | Fresh scoped reducer proof plus all non-live unit/integration/API regressions; worker baseline counts not reused as new evidence. |
| V8 | C5, C7–C8 / R1–R3, R5–R7 | Within V3/V4 at S3, run fake-AI + real-PostgreSQL recovery cases below and inspect stored state/request history | Committed work survives restart/races/failures; no partial-level success or unsupported exactly-once claim. |
| V9 | All, C9 / R1, R4, R7–R8 | Each exit: `git diff --check && git diff --cached --check`; inspect scoped delta against V0 and directly inspect new untracked files/call sites | Approved paths/behavior only; stage safety holds; history/reporting accurate; no excluded activation, cleanup or source loss. |
| V10 | Assembled C1–C9 / R1–R8 | After S3/V7–V9: fresh final scoped review of baseline-relative changes and evidence against both plans | All R1–R8 traced to implementation and tests; findings explicitly disposed; no claim of broader C13/V13/D2 or user acceptance. |

### V1 — Pure protocol/sizing cases (S1)

- Follow `score-context-request.test.ts` and order-sensitive `process-context-chunks.test.ts` patterns; capture tokenizer strings and assert byte equality, not only object equality.
  - Quotes, backslashes, newlines/control-character escaping, non-ASCII/paired supplementary Unicode; distinct classifier/generator capacities/tokenizers; exact fit/one-token overflow for context and optional max input.
  - Invalid/missing limits; negative, fractional, unsafe and non-finite counts; overflow and inconsistent recounts fail closed. Selected metadata/prompt changes alter bound basis; unselected fields never leak.
- Test zero/current/eighth-level graph boundaries, immutable finalized/pending-prefix invariants and canonical digest/ID vectors independent of JSONB object order.
  - Equal/increased complete classifier count rejects promotion even with shorter batch text. One-token whole-request decrease is sufficient. Provenance-heavy refs remain present even when fit is impossible.
- Test canonical many-to-one lineage across levels and overlap deduplication; keep counter/uncertain evidence and distinct intervals. Permuted valid model ordering yields identical host IDs.
  - Reject every malformed-parent/schema case in C1, nonempty parents with empty output, excessive nodes/items/text/parent counts, NUL and lone high/low surrogates. Valid pairs and exact UTF-16 refs succeed.
- Test deterministic contiguous batch partition/digest/count rebuild, singleton/fixed-envelope failures, bounded non-monotonic tokenizer, probe-count and probe-byte exhaustion. No node splitting, dropped refs or payload duplication to pass bounds.
- Test all-empty and mixed-empty original completions: coverage derives only from originals, not node count; incomplete original completion sets cannot enter reduction.

### V2 — Preserved regressions (every slice)

- Keep title-only direct request, selected-field/score-prompt isolation, order-sensitive preliminary/planner/dispatch equality, fixed reserves/max-input behavior and native fractional index mapping.
- Preserve original evidence text/quote NUL and lone-surrogate repair rejection, valid pairs, exact quotes/offsets, at-most-one consumed repair and typed pauses/auth/provider failures.
- Preserve summary non-usable-quality rejection before any generation and usable limitation metadata; no summary implementation change.
- At S3, move evidence-only assertions to direct `generateScoreEvidence` calls where necessary; retain separate integrated assertions. Do not delete old repair/pause/isolation tests or blindly rename all `evidence_ready` expectations.

### V3 / V4 — Real PostgreSQL state-machine cases (S2)

- Follow `context-persistence.test.ts` seed/migration/trigger patterns and its article-lock `pg_stat_activity` barrier. Use independent sessions and deterministic barriers, not timing-only races. Use C3's real pure factory for store verification.
- Exercise bind/start/each batch/promote/fail, current-revision no-op, pending/finalized/failure immutability, bound-original immutability and out-of-order rejection. Reject incomplete promotion and a non-fitting ninth level. Tamper IDs, refs, evidence digest, coverage, basis/parent/manifest digests, ranges and token counts; reject without mutation.
- Exercise old owner, wrong score target/kind, changed content/assignment revisions/text, generation mismatch and newer same-target generation (including terminal supersession). Change ownership while blocked on article lock; reject after lock acquisition.
- Gate two same-token sessions at one revision: exactly one mutation wins; stale save/commit/promotion cannot overwrite output, remove pending/finalized data or clear repair/failure markers. Changed models/limits/renderer basis also rejects.
- Inject checkpoint write and deferred transaction-commit failures for transition/evidence/repair mutations; independently reread unchanged revision/evidence/markers/levels. Preserve current plan/chunk creation rollback tests. Check actual PostgreSQL size constraint independently of application preflight.
- Seed exact v2/v3 fixtures including repaired and incomplete-consumed-marker states; valid originals reused, only validated legacy string reductions discarded. Virtual 0 read leaves rows unchanged; first mutation yields revision 1 without completion rewrite. Malformed/extra/unknown objects fail closed.
  - Seed v1 claims and untrusted result rows; resume cannot reuse them. Fenced empty recomputation atomically removes only that plan/purpose's untrusted rows; injection failure restores prior rows/state. Oversized legacy conversion leaves originals/markers untouched.
- Test just-below/at/above serialized byte limits with escaping-heavy text, reserved failure headroom and an oversized next output. Prior outputs survive `checkpoint_limit`; no raw malformed output stored.
- Keep trigger-count regression: 13 incremental completions → 13 inserts; one permitted pre-binding replacement → one update; identical saves → zero. Bind/start/commit/promote/fail and legacy conversion → zero completion upserts.
- Through the existing evidence helper, prove v4 incremental save/repair/reacquired-token resume works while reducer dispatch remains absent at S2 exit.

### V5 / V8 — Execution and integrated recovery cases (S3)

- Follow existing `fake()`/`vi.fn<AiPort['generate']>()` patterns. Reducer outputs use parent IDs from actual requests, not fixed guessed IDs; extraction responses retain their separate quote schema.
- Capture each generated serialized request and scope; assert equality with the counted/planned request. Fake-store commit barriers prove batch N commit settles before N+1 generation. No oversized `classify`, session or score-store call; zero-level success still persists basis.
- Zero levels/all-empty evidence when final request fits; mixed empties retain coverage; missing any original completion prevents reduction even if existing nodes fit. Multi-level success; fitting eighth succeeds; non-fitting eighth fails before ninth; pending eighth resumes only its suffix.
- Pause after one of at least three batches, acquire new execution token and new `ContextStore`, resume only uncommitted suffix, then promote only when all batches committed. A fitting pending prefix never becomes success.
  - Crash after final batch commit before promotion: restart promotes without generating again.
- Inject response loss before commit: no output persisted; explicit resume may repeat exactly that uncommitted regular request. Inject application-visible error after successful DB commit: reload finds output, no repeated committed dispatch. Test names/assertions state the difference, not exactly-once behavior.
- Budget (both reasons), auth/configuration pauses, admitted auth failure, generic provider error, abort, stale ownership/revision and store write/commit failure preserve progress and forbid following calls.
- Invalid output → durable `invalid_output`, no repair generation, resumed failure is call-free. Non-shrink → durable `non_shrinking` retaining outputs, no promotion. Exhausted bounds/levels are visible terminal failures; failed failure-marker write remains persistence failure.
- Carry a v3 original repair marker through upgrade, several batches, pause, promotion/failure and owner reacquisition unchanged. Incomplete consumed original repair fails before reduction. Recheck full original coverage/provenance after reload.

## Readiness and open decisions

- **Plan artifact:** `.ai/c13-reduction-staged-plan.md`; earlier `.ai/c13-reduction-plan.md` retained as the approved technical recommendation.
- **User decision recorded:** Staged sequence approved. S1 execution stopped incomplete for capacity; no S2/S3 authorization may be inferred while S1 has not exited. No open product-policy decision: approved no-auto-repair and `reduction_ready` boundaries remain unchanged; no material evidence justifies changing them.
- **Execution prerequisites not independently established here:** Command runner, current dirty-tree baseline/branch/HEAD, Node/dependencies, disk availability, Docker socket/cached PostgreSQL image and fresh reducer-specific evidence. Verify via V0 and test prerequisites; return `needs_input` for unavailable requirements.
- **History detail gap:** Exact IDs/timestamps of the two stopped handoffs were not supplied. They are not needed to design the reducer; retain coordinator's detailed history if available, never erase/count-reset it.
- **Compatibility risk retained:** Older binaries cannot read v4; no deployment/downgrade/rollback operation is authorized. Do not run an old writer against v4 checkpoints. Regeneration requires an explicit new generation, never a checkpoint reset.
- **Residual limitation:** Structural parent preservation is not proof of semantic faithfulness. Exact refs, eight-level and checkpoint caps can prevent success; failure must retain committed work.
- **Planning completion is not execution approval, implementation acceptance, a workflow transition or permission to publish.** If a material gate fails, report diagnosis and required decision to coordinator rather than starting a retry chain.
