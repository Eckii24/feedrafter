# Product test readiness — Implementation Plan

## Overview

- **Outcome:** Make one real, bounded processing path testable: prepared article → category → tags → the initially selected score targets → persisted reader results.
- **Priority:** Finish that chain before peripheral delivery gates, more isolated primitives, or unrelated product features.
- **Local first:** Disposable PostgreSQL 18, real PgBoss, fake AI, then the built browser against the real server. No mocked persistence or browser API responses as chain acceptance.
- **Production intent:** The user selected **Production inference**. Pursue a separately authorized activation after local acceptance; this is not permission to activate or deploy now.
- **Scope boundary:** This delivery starts with successfully prepared, usable text. Automatic import/preparation integration, bulk backfill, context reduction, recovery, videos, summaries, chat, mail, Karakeep, physical PWA and unrelated D-gates remain outside it.
  - This is a useful C14 subset, not full import-to-score coverage or C14/D2/V10 acceptance.
- **Key decision:** One article-jobs transaction owns publication, receipts, successor activation and queue writes. Reuse completed primitives/checkpoints; do not repeat them as deliveries.
- **Serialized-contract correction:** Require an immutable root-only `tagsTaskId`, including when `targetCount: 0`, to identify the exact precreated successor without relying on score rows.
- **Expert-approved additive distinction:** Existing-publisher receipts accept generation zero; newly admitted chain references and preparation receipts remain positive. Same V1 JSON shape, no migration/backfill or new scope approval; producer/reader compatibility remains gated in C1.
- **Readiness — next P1.3a only, conditional on fresh V0:** P1+P2, the approved root `tagsTaskId` and generation domains remain unchanged. P1.1/P1.2 have recorded checkpoint evidence (E5); the stopped P1.3 attempt delivered no changes (E6). P1.3 is complete only after P1.3a→P1.3b→P1.3c and aggregate V11; P1.4 cannot start earlier. Populated-target use and production remain blocked by the existing inventory/compatibility and G1–G5 gates.

## Planned changes

Local C/V/P/G IDs belong to this document. `NR-C14`, `NR-V10`, etc. mean `.ai/news-reader-plan.md` IDs.

| ID | File / area | Planned change and purpose |
| --- | --- | --- |
| C1 | `src/server/domain/article-handoff.ts` (retain corrected codec/type); `src/server/adapters/postgres/content-store.ts` (retain E1 receipt) | Preserve independent zero-capable `HandoffReceiptV1` and positive chain/preparation domains, unchanged V1 fields and immutable root-only `tagsTaskId`. Tags/scores reject root-only fields; old roots remain invalid/preserved. No migration/backfill. |
| C2 | `src/server/adapters/postgres/{catalog-store,article-jobs,score-admission}.ts` (modify); `src/server/application/{categorize,assign-tags}.ts` (modify) | Admission anchors the exact tags PK. Preserve category handoff; add standalone tag guard/receipt, then atomic linked tag publication and release of original score tasks. Harden existing `enqueueScoreTask` persisted-ID validation; never resnapshot via `ScoreAdmission`. |
| C3 | `src/server/adapters/postgres/{category-task-input-store,tag-task-input-store,score-task-input-store,score-store}.ts`; `src/server/application/process-context-chunks.ts` (modify) | Check handoffs before AI/publication against the same root tags anchor; malformed chain metadata never falls through to standalone. Separate target identity, handoff basis and dispatch configuration; preserve explicit score roots. |
| C4 | `src/server/application/{run-stored-category-task,run-stored-tag-task}.ts`, `src/server/adapters/postgres/article-worker.ts` (new); `src/server/main.ts` (modify) | Action-fenced category/tag workers and explicit static queue provisioning. Export registration for isolated callers; do not activate them in normal composition. |
| C5 | `tests/unit/{article-handoff,process-context-chunks}.test.ts`, `tests/integration/article-jobs.test.ts` (modify existing checkpoints); `tests/integration/article-worker.test.ts` (new); existing `tests/integration/{categorize,categorize-races,assign-tags,assign-tags-races,content-publication,score-admission,score-task-input,run-stored-score-task,score-worker,enrichment}.test.ts` (modify as affected) | Preserve root/generation contracts and P1.1/P1.2 evidence. Prove standalone tag receipt/closed guard, the linked-score consumer unit, then real atomic producer-to-score integration. Retain full-chain queue/race/compatibility proofs and real receipt-producing fixtures; synthetic consumer linkage is not chain evidence. |
| C6 | `src/server/http/app.ts` (modify); `tests/integration/article-processing-api.test.ts`, `tests/helpers/article-processing-fixture.ts`, `tests/e2e/enrichment.spec.ts` (new) | Read-only category/tag task status and real-server/browser acceptance. Test-only admission calls the real adapter; no public fake-AI endpoint or production model injection switch. |
| C7 | `docs/{server-api,verification,operations}.md` (modify) | Record the runnable local boundary, commands/results, dormant behavior and explicit activation gates. Do not change canonical delivery acceptance status. |

- No source removals, dependency upgrades, migration regeneration, broad refactoring or UI redesign.
- `src/server/composition-root.ts`, import paths and public score-reevaluation semantics stay unchanged; tests must enforce that boundary.

## Implementation details

### Basis

- **Authority:** `.ai/news-reader-plan.md`, especially NR-C10–C16, NR-V10–V15, its execution basis and external acceptance register.
- **Product criteria:** `docs/dev-agentic-news-reader-spec.md` AC6–AC8, AC10–AC11, AC19–AC21; architecture in `docs/architecture.md`.
  - AC6 context reduction and the wider AC19–AC21 obligations are not satisfied by this direct-only slice.
- **Latest instruction:** Refine only this artifact using the supplied expert diagnosis: split P1.3 into tag capture/standalone guard+receipt, the indivisible linked-score consumer unit, then atomic tag receipt/original-score release. No source edits, Bash, tests, provider calls or workflow advancement in this revision. Production inference remains the desired destination, not target/model/data/cost/deployment authorization.
- **Worker evidence, supplied and not independently rerun for this revision:**
  - **E0 — Earlier primitives:** Node `24.21.0`; focused C14 run: 7 files / 161 tests; typecheck, scoped lint, build and diff check passed. Independent review found no actionable findings for caller-transaction score enqueue and action-fenced claims.
  - **E1 — Original C1 checkpoint:** `article-handoff.ts` and the preparation receipt in `ContentStore.publishTask` implemented; 4 focused files / 170 tests passed. That codec predates the root/generation corrections; E5 supplies the superseding contract evidence. Preparation remains reusable. Not a running chain.
  - **E2 — Catalog transaction checkpoint:** Caller-transaction category/tag publishers and late tag rejection rollback implemented; 6 files / 213 tests passed. Exact command, scoped static/build checks and limitations are recorded in `docs/verification.md`, “P1 C2 — caller-owned catalog publication checkpoint (partial)”. At that checkpoint no category/tag handoff receipts or successors existed; E5 supersedes the category side.
  - **E3 — Stopped broad slice:** The next worker received prepared admission + atomic category→tags and returned **no code changes**, reporting transaction-owner, rollback and concurrency scope not completed. Baseline runs passed 3 files / 26 tests and 6 files / 141 tests; these are not implementation or chain evidence. Exact baseline commands were not supplied; do not invent them.
  - **E4 — Historical pre-correction P1.1 record:** The prior supplied checkpoint recorded 9 files / 271 tests (32 admission cases), typecheck, scoped lint and build under Node `24.21.0`, for the old root shape. E5 supersedes it with the corrected contract and fresh results; do not reuse it as current proof or repeat admission as a delivery.
  - **E5 — Current recorded predecessors:** `docs/verification.md`, “P1.1 — prepared admission checkpoint (partial)”, records the approved root correction and fresh V9: 4 files / 64 tests, plus 9 files / 273 tests superseding E4. “P1.2 review repair — standalone receipt generation” records the latest Node `24.21.0` / disposable PostgreSQL 18 / real PgBoss evidence: 9 files / 326 tests, P1.1 preservation 4 files / 165 tests, typecheck/scoped ESLint/build; independent re-review also reran focused checks and a 16-case standalone matrix with no actionable findings. These are recorded predecessor checkpoints, not new runs here or aggregate P1 acceptance. The record explicitly leaves tag receipts/fences/release for P1.3.
  - **E6 — Stopped P1.3 attempt / supplied diagnosis:** User reports the first P1.3 worker stopped with **no changes** because tag capture, atomic `ArticleJobs`/`CatalogStore` score release and linked loader→candidate→publication fences were coupled. Expert read-only diagnosis recommends P1.3a→P1.3b→P1.3c below. No new command/count or successful P1.3 evidence was supplied; do not invent any.
  - **Git/runtime boundary:** Supplied history describes a heavily dirty tracked/staged/untracked checkout and Node `24.21.0`; no fresh Git/runtime probe is authorized in this artifact-only revision. Preserve that baseline; execution must refresh V0 before the next package.
- **Read-only source inspection confirms:**
  - `enqueueScoreTask(tx, boss, taskId)` already sends through `fromDrizzle(tx, sql)` and validates the returned UUID. Its current update checks only that a row was returned, not that the saved `jobId` equals the actual send ID; P1.3c must close that validation gap without changing admission targets.
  - `TaskStore.claimTaskForAction` checks action and claimable state atomically; `runStoredScoreTask` uses it before resolving configuration.
  - C1's current strict codec has immutable root-only `tagsTaskId`; `ArticleJobs.admitPreparedArticle` persists its allocated tags PK even for zero targets. `HandoffReceiptV1` is independent from positive-only references/preparation receipts. Retain these implemented contracts, not the obsolete E1/E4 root shape.
  - `CatalogStore.publishCategoryCandidateInTransaction` now persists category receipts; `ArticleJobs.publishCategoryCandidate` owns exact-PK category→tags activation/enqueue. `publishTagCandidateInTransaction` still returns only assignment revision/epoch and marks tags succeeded **without a handoff receipt or a chain-namespace guard**. Its standalone wrapper uses the same transaction method. P1.3a must demonstrate that gap before changing it.
  - `ScoreAdmission.admit` and `TaskStore.createTask` also own transactions; calling them inside a chain transaction does not compose its atomicity.
  - `CategoryTaskInputStore` already implements category handoff/fingerprint checks. `TagTaskInputStore` still accepts current state after queue delay without receipt/root/source-fingerprint checks. `ScoreTaskInputStore` and `ScoreStore.publishCandidate` do not validate tag prerequisites; `processContextChunks` has no linked-handoff propagation. Their entire consumer path belongs together in P1.3b.
  - Task `result` permits a JSON object up to 16,384 bytes; task identity, prerequisite, generation and score-target columns already exist in `schema/processing.ts`.
  - Generation evidence: `schema/processing.ts` defaults task generation to `0` and constrains it to `>= 0`. Existing candidate/schema defaults permit standalone zero, including a tag's category prerequisite. The current receipt decoder accepts `0..2_147_483_647`; handoff-reference and preparation decoders still require `1..2_147_483_647`. E5 proves category integration only; tag integration/readback remains P1.3a/P1.3c.
  - `buildApplication` starts the score worker with null capabilities and an unavailable AI stub; no Pi runtime is constructed. `ArticleJobs` currently implements admission and category handoff with test-only callers, not tag publication. Category/tag stored workers remain absent and the chain is not in normal composition.
  - `ImportStore.importPageWithIdentitiesInTransaction` already returns `{ id, inserted }` using PostgreSQL 18 `old.id`; the import worker does not admit article processing. Do not rebuild this identity checkpoint.
  - Existing score browser tests mock API responses. `tests/e2e/server-reader.spec.ts` supplies the real Fastify/PostgreSQL/browser pattern to extend separately.
- **Tooling:** Existing npm scripts, installed Vitest/Playwright/ESLint/Drizzle; pg-boss `12.38.0`, Drizzle `0.45.4`. No new dependencies.
- **Contract authority:** The approved pre-release root correction is recorded in E5 and explicitly preserved by the latest request: exact root-only `tagsTaskId`, not inferred matching rows. No new root/scope approval is requested. C1's compatibility/inventory gate still applies; L1–L7, P1/P2, G1–G5 and canonical acceptance remain unchanged.
- **Generation authority:** Retain the expert-approved additive receipt domain in C1. It preserves standalone behavior without changing positive chain/preparation references, task history or JSON fields. It does not waive released-consumer/populated-target inventory or authorize rollout.
- **Planning evidence:** This revision inspected source/docs read-only and used the supplied stop/diagnosis. No source edits, Bash, Git/runtime probe, test, provider call or deployment occurred. E0–E6 distinguish historical/supplied evidence from current inspection; only this plan is owned.
- **Stop/report:** Contradictory repository reality, unclear overlapping edits or missing prerequisite → stop affected work and return `needs_input` to the coordinator. Do not invent a replacement design or weaken a gate.

### Acceptance mapping

These local exit conditions refine the cited product ACs; they do not replace them.

| ID | Product basis | Local acceptance condition |
| --- | --- | --- |
| L1 | AC6–AC8 | Real stored tasks run category → tags → scores only after their exact successful prerequisites; valid empty tags permit scoring. |
| L2 | AC10–AC11 | Active, nondeleted target IDs are selected exactly once at initial admission; later definitions are excluded, including after an initially empty selection. Targets retire independently; newer explicit score reevaluation wins. |
| L3 | AC6–AC8, AC11 | Valid versioned post-transition receipts are required for linked work. Queue-delay edits reject before AI; in-flight edits reject publication. Current request configuration is captured at dispatch, not frozen at initial admission. |
| L4 | AC6, AC21 | Result/assignment, task success, receipt, successor activation, real queue job and saved job ID commit or roll back together. Ambiguous publication errors escape without a compensating failure write. |
| L5 | AC6, AC10–AC11 | Duplicate, obsolete and wrong-action deliveries have no extra effects. Prior scores and successful siblings survive failures; null-prerequisite explicit score roots remain supported. |
| L6 | AC14, AC19–AC21 subset | The built reader displays actual persisted chain results via real API calls; task states are inspectable. Normal composition makes zero provider/runtime calls and remains fail-closed. |
| L7 | AC19–AC21 subset | Local evidence is distinguished from production acceptance. No activation occurs without all applicable G-gates and a separate bounded authorization. |

### C1 — Durable handoff contract

- **Storage decision:** Namespaced `processing_tasks.result.articleChain` metadata, `result.handoffReceipt` for category/tag success, and `result.preparationReceipt` for successful preparation. Standalone publishers can produce handoff receipts without inventing chain metadata. Merge namespaces; do not replace unrelated task metadata.
  - Constant-size metadata per task; target identity lives in precreated score task rows, not an unbounded JSON array.
  - No prompt/model-version history, article text, provider responses, secrets or execution tokens in receipts.
- **New runtime-validated shapes:**

  ```ts
  type ArticleBasis = {
    contentRevision: number;
    assignmentRevision: number;
    articleInputHash: string;
  };
  type HandoffRef = {
    taskId: string;
    generation: number; // int32, 1..2_147_483_647
    action: 'category' | 'tags';
  };
  type HandoffReceiptV1 = {
    version: 1;
    taskId: string;
    generation: number; // int32, 0..2_147_483_647; copied from publisher task
    action: 'category' | 'tags';
    articleId: string;
    prerequisiteId: string | null;
    categoryId: string;
    basis: ArticleBasis;
    catalogEpoch: number;
  };
  type ChainMetadataV1 = {
    version: 1;
    rootTaskId: string;       // category task, also the chain identity
    prepareTaskId: string;
  } & (
    | { // category root only
        requiredHandoff: null;
        requiredBasis: ArticleBasis;
        targetCount: number; // immutable, including zero
        tagsTaskId: string;  // immutable exact precreated tags UUID
      }
    | { // tags/scores; root-only fields must be absent
        requiredHandoff: HandoffRef;
        requiredBasis: ArticleBasis | null;
        targetCount?: never;
        tagsTaskId?: never;
      }
  );
  ```

- **Validation:** Exact version/action, UUID identities, bounded nonnegative int32 revisions/count, positive content revision, generation domains below, lowercase SHA-256 hex hash, correct nullable fields and action-specific field presence. Reject arrays, wrong types, unknown versions, mismatched links and malformed records; never reconstruct missing receipts from current article state.
  - In `decodeChainMetadataV1(value, action)`, category requires and returns `tagsTaskId` as a UUID distinct from both `rootTaskId` and `prepareTaskId`, using existing case-insensitive UUID identity comparison. Require it even for `targetCount: 0`; no default or optional-root interpretation.
  - Tags/scores reject any own `tagsTaskId` key, including null/undefined; retain their existing rejection of root-only `targetCount`. Use action-specific exact-key validation; do not accept then strip root fields.
- **Generation domains — expert-approved additive behavior:**
  - `HandoffReceiptV1` is modeled independently from `HandoffRef`, not as an intersection/extension. `decodeHandoffReceiptV1` validates generation directly as an integer in `0..2_147_483_647`; do not delegate its generation validation to the positive-only reference decoder.
  - A category/tag receipt copies the exact generation of the locked existing publisher task. Do not increment, normalize zero to one, tighten standalone candidate validation or invent chain metadata. Rejecting zero would break the existing schema/default and standalone publisher contract recorded in the basis.
  - Newly admitted category/tags/score chain tasks remain positive under C2's `max(all history) + 1` allocation. `decodeHandoffRef`, including `ChainMetadataV1.requiredHandoff`, still requires `1..2_147_483_647`; a valid generation-zero receipt is not a valid generation-zero chain reference. Preserve exact task/receipt generation matching at handoff checks.
  - `decodePreparationReceiptV1` remains positive (`1..2_147_483_647`); preparation publication/admission does not acquire generation-zero support. Preserve old tasks and their generations; do not rewrite history or synthesize missing receipts.
- **Compatibility / data gate:** Keep `version: 1`, the same V1 JSON fields and strict action-specific decoding. The root `tagsTaskId` amendment remains a separate pre-release breaking serialized-contract correction, justified only by the chain being unwired/not in normal composition. No V2, permissive old-root decoder, SQL/data migration or backfill.
  - Receipt generation widening is additive for the updated reader; new generation-zero receipts would be rejected by older strict readers. Pre-release producer/reader compatibility must therefore be considered together; unwired/test-only callers do not prove compatibility for released consumers.
  - Old-shaped category roots without `tagsTaskId` decode invalid and remain preserved; never infer/backfill the anchor, delete the roots or re-admit them. Invalid chains cannot publish or release successors.
  - Any released consumer or populated target remains **blocked pending inventory** of producer/reader versions and existing task/runtime shapes, followed by a separate explicit compatibility decision. This clarification authorizes no released-consumer rollout, target DB use or data repair; it is not itself another material scope approval request.
  - Distinguish namespace absence from decode failure: standalone paths require no own `articleChain` key. A present null/malformed/old-shaped namespace is invalid chain metadata, never a standalone fallback.
- **Article fingerprint:** Node standard-library SHA-256 of canonical `JSON.stringify([title, sourceId])`, retaining null distinctly. Content/assignment revisions and receipt `categoryId` cover the other article basis. Title/source changes do not reliably increment those revisions today.
  - Recompute from authoritative rows at each admission/load/publication; no raw title needs to fit in task JSON.
- **Three distinct identities:**
  - Target snapshot: original score-task identities/`scoreTargetId`s, linked to the exact root `tagsTaskId`, plus root `targetCount`. The tags anchor exists independently of score rows, including for an empty snapshot.
  - Handoff basis: required article basis and predecessor receipt, written once when a waiting successor is activated.
  - Dispatch basis: current catalog epoch, prompt/override, selected fields, models/verified limits and weights captured by the loader immediately before inference. Do not compare the current epoch with an old handoff epoch as a blanket queue-delay fence.
- **Preparation receipt:** On `ContentStore.publishTask` success, atomically store `{ version: 1, taskId, articleId, action: 'prepare', generation, contentRevision }` with the new content revision and task success; retain C1's positive preparation generation domain.
  - Failure path stays unchanged; retain previous content and receipt history on its original task.
  - Old successful prepare tasks without this receipt are not silently upgraded. Test fixtures must publish preparation through the real fenced method.
- **Publication receipts:** Persist category's resulting assignment revision even for a no-op assignment; tags persist resulting assignment revision and epoch after any new tags were created. Empty tags still create a success receipt.
- **References:** L1–L4 / V1–V3.

### C2 — One transaction owner

- **Existing publisher checkpoint (E2, retain):** `publishCategoryCandidateInTransaction(tx, candidate, at)` and `publishTagCandidateInTransaction(tx, candidate, at)` already exist on `CatalogStore`.
  - Validation/locking/write mechanics run without opening transactions; public standalone methods wrap them in one transaction. Do not reimplement this checkpoint.
  - Return the validated receipt along with the existing post-transition return values. Preserve candidate rejection versus infrastructure-error behavior.
  - A tag rejection discovered after writes must unwind the owning transaction before translating to `null`; never catch the rejection inside the transaction and commit partial tags.
- **Adapter:** Existing `ArticleJobs(db, boss)` admission/category handoff is retained; P1.3c adds tag publication:
  - `admitPreparedArticle(articleId, prepareTaskId, at)` → `{ kind: 'admitted', categoryTaskId, tagsTaskId, scoreTaskIds } | { kind: 'not_found' | 'needs_input' }`.
  - `publishCategoryCandidate(candidate, at)` and `publishTagCandidate(candidate, at)`, structurally compatible with the kernels' publisher dependencies, returning existing result fields/receipt or `null`.
  - Keep Drizzle transaction types inside PostgreSQL adapters. Narrow the kernels' publisher dependency types as needed; do not require the full `CatalogStore` to supply a chain publisher.
- **Admission mechanics:**
  1. Start read-committed transaction; lock epoch shared, active nondeleted score definitions in ID order, article, then affected tasks/prerequisites deterministically.
  2. Require current nonblank usable selected content, matching article/content revisions, and the exact same-article succeeded prepare task with a valid preparation receipt for that revision. Reject a newer prepare generation, including a failed newer task.
  3. Under the article lock, allocate category/tags generations and per-target score generations as `max(all history) + 1`. Detect int32 overflow before writes.
  4. Supersede prior unfinished category/tag work and affected older score generations; retain terminal history and saved values. A new category generation fences older linked chains even when they target a different set of scores.
  5. Allocate category/tags task UUIDs before constructing C1 metadata. Insert category as `queued`, tags as `waiting_dependency` linked to category, and one waiting score task per snapshotted target linked to tags. Persist the already-created `tagsTaskId` on the root for both zero/nonzero snapshots; it must equal the returned ID and inserted tags PK, not a later lookup or newly generated replacement. Root `requiredBasis` is the admission basis; downstream basis starts null and downstream metadata omits root-only fields.
  6. Enqueue only category and save its job ID in the same transaction. Return only after commit.
  - Each explicit test admission is a new generation, not an implicit retry or bulk backfill. Missing/unsuitable prerequisites create no partial chain or jobs. C1's old-root preservation and populated-target inventory gate apply; admission is not a repair/re-admission path for invalid stored chains.
- **Category transition:** In the owning transaction, strictly decode the persisted category root and fetch/lock `processing_tasks` by the exact PK `root.tagsTaskId`, following the lock invariant. Validate it before activation; publication, receipt and enqueue remain one atomic unit.
  - Require the same article, action `tags`, matching prerequisite/category root and prepare identity, current valid generation, `waiting_dependency` state, no prior job, and valid downstream metadata referencing the exact category task/generation with null unactivated basis. Do not discover the successor by matching prerequisite fields, score rows, count or a “first matching” query.
  - Call the transaction-aware publisher, persist its receipt, set that exact task's required basis from the receipt, activate it and enqueue it. Missing anchored row, different-UUID matching replacement, malformed/rewired metadata or failed validation → fail closed and roll back all category assignment/revision, success/receipt, task and job writes. Never rewrite the root anchor or create a replacement successor.
- **Tags transition (P1.3c):** Hold the exclusive epoch lock through publication and all successor writes. Require the publishing tags task's PK to equal the strictly decoded category root's `tagsTaskId`; validate root snapshot membership/count and every linked score prerequisite/handoff against that same anchor, persist the tags receipt, then visit the precreated score tasks in deterministic order.
  - Until P1.3c owns this entire transition, P1.3a's standalone and caller-transaction tag publishers reject every present `articleChain` namespace, including valid linked tasks. No chain-success shortcut, empty-target exception, permissive flag or alternate publisher bypass in P1.3a/P1.3b. P1.3c may introduce a chain-enabled internal path only as part of this owning transaction; the standalone guard remains closed.
  - Activate only matching waiting tasks whose target is still active/nondeleted and which have no newer score generation.
  - Retire unavailable targets as `superseded/target_unavailable`; retire older targets as `superseded/newer_generation`. Preserve already terminal or superseded tasks; never resurrect them.
  - One retired target does not block valid siblings. `targetCount: 0` requires zero original score rows and produces no score enqueue, even if definitions were added meanwhile.
  - Never call `ScoreAdmission.admit` here: it would resnapshot and start its own transaction.
- **Queue writes:** Category/tags use the existing transactional-send pattern; scores call `enqueueScoreTask`. Always `boss.send(..., { db: fromDrizzle(tx, sql), retryLimit: 0 })`, UUID-check the send ID and require exactly one returned job-ID update whose persisted `jobId` equals that actual ID case-insensitively. P1.3c adds the missing equality/cardinality check to `enqueueScoreTask`; a different valid UUID is failure, not success.
  - Missing expected successor, malformed metadata, send/update failure or deferred commit failure aborts the entire transition. No success with a missing successor job.
- **Lock invariant:** Epoch first; deterministic catalog rows (score IDs/category/tag targets); article; tasks/prerequisites in deterministic ID order; content/associations/results afterward. Existing catalog writers retain their compatible ordering.
  - For tag publication, take epoch **exclusive initially**, never upgrade shared after taking article/task locks. Resolve new tag identities while holding that lock.
  - No model/tokenizer/network work under these database locks; queue sends use only the transaction's DB connection.
- **Ambiguity:** Let publication/commit exceptions propagate through the kernel and worker. Do not subsequently set failed/superseded, retry publication, or enqueue elsewhere after a possibly committed success.
- **References:** L1–L5 / V2–V3.

### C3 — Admission, handoff and request fences

- **Before AI:** Load under existing read-committed locking discipline, using a fresh statement after acquiring the article lock to see newly committed generations.
  - Chain category checks the strict root, admission basis and preparation receipt. At category publication, enforce C2's exact-PK successor check. In P1.3, tags load/publication require their task ID to equal the fetched category root's `tagsTaskId`; linked scores require both `prerequisiteId` and required tags handoff/receipt task ID to equal that same root anchor, plus matching article/prepare/root identities, generations and target membership.
  - Fetch the persisted root by `rootTaskId` and decode it as category; do not copy root-only `tagsTaskId` into descendant metadata. Missing/malformed/old-shaped root or a different matching tags task is invalid handoff, not evidence for reconstructing an anchor.
  - Compare current content/assignment revisions, category identity and article fingerprint with the required basis. Queue-delay manual category/tag/content/title/source changes must not become the new accepted basis.
  - Waiting/unactivated work cannot run. Missing/invalid receipt → `needs_input/prerequisite_required` or `needs_input/invalid_handoff`; legitimate changed basis/newer work → `superseded/stale_basis`. No AI in either case.
- **Dispatch:** Once handoff/article checks pass, capture current eligible request configuration coherently and release locks before request measurement/AI.
  - Later prompt/model/field changes apply to that later call, per AC11; do not freeze them at admission.
  - A definition added after admission is not a target. Disabling/deleting one target must not invalidate all siblings solely because the epoch advanced before their dispatch.
  - Keep existing direct-only sizing behavior: oversized category/tags/score requests need input; do not truncate or pretend reduction exists.
- **During publication:** Retain current task/token/generation, content text/revision, assignment and dispatch-epoch checks; additionally revalidate linked prerequisite metadata, the persisted root tags anchor and article fingerprint.
  - Category candidate must fence its captured title/source basis too; tags already fence title/category but need the source fingerprint and durable link.
  - Carry linked handoff identity/fingerprint through `ScoreContextTask.owner` to `ScoreCandidate.basis` in `processContextChunks`. In-memory capture must retain the decoded root, consumer metadata, exact predecessor receipt and `articleInputHash`; use existing C1 types/JSON, not a new serialized namespace. Snapshot nested link data before awaits and propagate it unchanged through the real kernel. At publication compare with persisted task/prerequisite data; candidate omission/removal must never make a linked DB task standalone.
  - A real epoch/configuration change during inference may conservatively reject publication under the existing epoch fence. An old handoff epoch alone must not reject a later dispatch.
- **Explicit score roots:** `prerequisiteId === null` with no own `articleChain` key remains the existing score-only reevaluation path. Non-null score prerequisites require valid chain metadata/receipt; missing metadata cannot masquerade as a root. A present but undecodable namespace never qualifies as standalone.
  - Preserve root behavior, endpoint, native score mapping, selected-field isolation and successful-value preservation.
  - `ScoreAdmission`'s newer per-target generations supersede waiting/running chain targets. Tag publication skips them rather than creating replacement tasks.
- **Compatibility:** Existing standalone category/tag/score tasks remain valid only when there is no own `articleChain` key, retaining each action's other prerequisite rules. Check namespace presence separately from a null decoder result before selecting any standalone loader/publisher path; malformed chain metadata must fail closed both before AI and at publication.
  - Standalone category publication may retain its nullable-root kernel behavior. Tags still require an exact category prerequisite/receipt, including generation-zero standalone identities; never infer a receipt from `state='succeeded'` alone. A chain-bearing category prerequisite prevents standalone fallback when a tags task's namespace was removed. Old-shaped chain roots follow C1, not standalone compatibility.
- **References:** L1–L5 / V1–V3.

### C4 — Dormant stored workers

- **New entry functions:** `runStoredCategoryTask(taskId, dependencies)` and `runStoredTagTask(taskId, dependencies)`, following `runStoredScoreTask`.
  1. Fresh UUID token; `claimTaskForAction` for the expected action before resolving capabilities or loading inputs.
  2. Resolve verified capabilities; invoke the existing kernel with `ArticleJobs` publication and existing loader/task boundaries.
  3. Preserve typed pauses, validation failures, cancellation cutoff and ambiguous-success propagation.
- **Registration:** `startArticleWorkers({ db, pool, boss, ai, resolveCategoryModel, resolveTagModel })` registers static `category` and `tags` queues, batch size/concurrency one per queue, and returns `close()` draining only those registrations. Use the existing score worker for scores.
- **Provisioning:** New `provisionArticleQueues(boss)` called by explicit `main.ts migrate`, alongside score provisioning. Normal serve must not create queues/schema.
- **Safety:** No startup recovery, pause wake-up loop, automatic provider retries or fallback. Returned obsolete/paused/domain outcomes are queue success, matching score-worker behavior; infrastructure failures escape. Retry-disabled jobs are a bounded checkpoint, not the full NR task-engine retry contract.
- **Composition remains dormant:** No new runtime factory, capability resolver, credentials lookup or category/tag registration in `buildApplication`. Tests explicitly assemble fake-backed workers. Stopping/restarting after an interruption is not claimed to repair stranded tasks.
- **References:** L1, L5–L7 / V3, V6.

### C5–C6 — Actual local product exercise

- **Fixture helper:** Own a uniquely named disposable PostgreSQL 18 container, migration/provisioning, isolated PgBoss and fake AI. Inject no production credentials; never accept an arbitrary external DB URL. Cleanup only resources this fixture created.
- **Preparation:** Import a synthetic identity without enabling FreshRSS; create/claim a prepare task and call existing `prepareArticle` with in-memory public-URL HTML responses and fake quality classifier, no agent fallback. This must produce the real content/receipt used by admission.
  - This is test setup through real preparation logic, not wired automatic import or a production extraction proof.
- **Test admission:** Call `ArticleJobs.admitPreparedArticle` from test orchestration. Do not overload `/reevaluations` to recategorize/retag and do not add a test HTTP endpoint/config flag to normal serve.
- **Real HTTP:** Extend `GET /api/v1/processing-tasks/:id` with category/tags action-discriminated DTOs matching score progress fields, with null score target. Preserve Karakeep and score response shapes; return 404 for unsupported actions.
  - Extend existing task-change polling to category/tags. Do not expose internal receipts, hashes, request configuration or task JSON.
- **Browser:** Build once, serve actual Fastify/static UI on loopback as in `server-reader.spec.ts`, then run actual workers against the fixture DB. Exercise task GETs through real HTTP and reload/reopen article detail to see persisted category, tags and scores.
  - No Playwright `route.fulfill` for product API responses. It is acceptable to gate fake AI in process to observe waiting/running states.
  - Exercise the existing explicit score-reevaluation button against the real API/score worker after the chain; ensure it changes scores only.
- **No new UI feature required:** Existing article catalog, score results and reevaluation displays are sufficient for this bounded exercise; category/tag task GET is the diagnostic surface. Automatic live-refresh UI redesign is not a prerequisite.
- **References:** L1–L6 / V3–V5.

### C7 — Evidence, not acceptance inflation

- Record exact runtime, commands, test counts, cases, changed paths and failures after execution. Keep supplied checkpoint evidence separate from new results.
- Document test-only admission, selected-text/direct-only boundary and lack of automated import/recovery.
- Preserve `NR-C14`, D2 and `NR-V10` as incomplete/not accepted. Do not edit the approved scope plan to claim completion.
- Record activation intent and unresolved G-gates without credentials, personal URLs or article bodies.
- **References:** L7 / V7–V8.

## Verification

- **Strategy:** Codec tests catch receipt ambiguity; real PostgreSQL/PgBoss tests prove atomicity and races; a real-server browser proves that actual persisted outputs reach the reader. Fake AI does not prove live model quality, wire accounting or deployed compatibility.
- **Status:** E0–E6 are supplied/historical evidence, not aggregate P1 acceptance or checks run here. E5 supersedes E4's old root shape and records P1.1/P1.2 preservation; do not rerun those as new deliveries absent a V0 mismatch. V11a/V11b/V11c are proposed focused checks; **V11 is their aggregate P1.3 exit**, not any one pass. V9–V12 never replace applicable aggregate V1–V8. No checks were run for this artifact-only revision.
- **Prerequisites:** Node `24.21.0`, installed locked dependencies, Docker access to the existing test socket, cached `postgres:18` (`--pull=never`), and a usable cached Chromium for V5. Missing resources return `needs_input`; no silent download, provider request or target DB substitution.
- Commands run from repository root, under Node 24.21.0; if needed use the recorded `mise exec node@24.21.0 --` prefix. V6 build precedes V5.

| ID | Changes / criteria | Procedure / command | Expected signal |
| --- | --- | --- | --- |
| V0 | All / preservation | Read-only `git status --short --branch`, `git diff --stat`, `git diff --cached --stat`, `git ls-files --others --exclude-standard`, `node --version`; inspect overlapping files and test prerequisites. | Starting dirty/staged/untracked baseline identified and retained; expected tools/cache available. No reset, clean, stash, stage or commit. |
| V1 | C1, C3 / L1, L3 | `./node_modules/.bin/vitest run tests/unit/article-handoff.test.ts` | Strict codec/fingerprint and distinct generation-domain vectors below pass. |
| V2 | C1–C3, C5 / L1–L5 | `./node_modules/.bin/vitest run tests/integration/article-jobs.test.ts tests/integration/content-publication.test.ts tests/integration/categorize.test.ts tests/integration/categorize-races.test.ts tests/integration/assign-tags.test.ts tests/integration/assign-tags-races.test.ts tests/integration/score-admission.test.ts` | Real transaction/snapshot/publication cases, including generation-zero standalone receipt preservation, pass; existing kernel guarantees retained. |
| V3 | C3–C5 / L1–L6 | `./node_modules/.bin/vitest run tests/integration/article-worker.test.ts tests/integration/score-task-input.test.ts tests/integration/run-stored-score-task.test.ts tests/integration/score-worker.test.ts tests/integration/enrichment.test.ts` | Real deliveries complete full chain; queue-delay, linked-score and dormancy cases below pass. |
| V4 | C6 / L5–L6 | `./node_modules/.bin/vitest run tests/integration/article-processing-api.test.ts` | Real HTTP task DTOs/status and explicit reevaluation semantics below pass. |
| V5 | C6 / L1, L5–L6 | `npm run test:e2e -- tests/e2e/enrichment.spec.ts tests/e2e/score-results.spec.ts tests/e2e/score-reevaluation.spec.ts` | New real-server/browser flow passes; existing mocked UI regressions pass separately, not as persistence proof. Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` only for an existing verified executable. |
| V6 | C1–C6 / compatibility | `npm run typecheck && npm run lint && npm run build`; `npm run test:unit && npm run test:integration`; `./node_modules/.bin/drizzle-kit check`; `git diff --check` and `git diff --cached --check` | Static/build/regression/schema checks pass, or unrelated baseline failures are diagnosed and reported without modifying unrelated work. No migration drift intended. |
| V7 | C7 / L7 | Inspect docs against L1–L7, actual test results and G-register; inspect final diff against V0. | Accurate local evidence and limitations; only intended changes; no completion/activation claim. |
| V8 | C7 / L7 | Readiness review of G1–G5; **not a command to invoke providers or deploy**. | Missing inputs remain explicit; activation blocked until separate authorization and applicable proofs. |
| V9 | C1 correction, C2 admission, C5 / L2–L5 checkpoint | `./node_modules/.bin/vitest run tests/unit/article-handoff.test.ts tests/integration/article-jobs.test.ts tests/integration/content-publication.test.ts tests/integration/score-admission.test.ts` | Corrected-codec and zero/nonzero exact-anchor admission cases below pass. E5 records refreshed predecessor evidence; rerun as affected regression, not a new admission delivery. |
| V10 | C1 generation domains, C2 category, C3 category, C5 / L1, L3–L5 checkpoint | `./node_modules/.bin/vitest run tests/integration/article-jobs.test.ts tests/integration/categorize.test.ts tests/integration/categorize-races.test.ts` | Category handoff checkpoint cases below pass; tags are queued, not yet processed by stored workers. |
| V11 | C2 tags, C3 tags/scores, C5 / L1–L5 aggregate checkpoint | `./node_modules/.bin/vitest run tests/unit/article-handoff.test.ts tests/unit/process-context-chunks.test.ts tests/integration/article-jobs.test.ts tests/integration/assign-tags.test.ts tests/integration/assign-tags-races.test.ts tests/integration/score-task-input.test.ts tests/integration/run-stored-score-task.test.ts tests/integration/score-admission.test.ts tests/integration/enrichment.test.ts` | P1.3a+P1.3b+P1.3c integrated; all V11a–V11c cases pass on the assembled code. First real producer-to-score proof is P1.3c; no stored-worker acceptance inferred. |
| V11a | C2 standalone tags, C3 tag capture, C5 / L1, L3–L5 subset | Baseline procedure below, then `./node_modules/.bin/vitest run tests/unit/article-handoff.test.ts tests/integration/assign-tags.test.ts tests/integration/assign-tags-races.test.ts tests/integration/enrichment.test.ts` | Missing receipt first demonstrated, then real standalone receipts, tag fences and closed chain-publication guards pass. No linked tag success or score release. |
| V11b | C3 linked-score unit, C5 / L1, L3–L5 consumer subset | `./node_modules/.bin/vitest run tests/unit/process-context-chunks.test.ts tests/integration/score-task-input.test.ts tests/integration/run-stored-score-task.test.ts tests/integration/score-admission.test.ts tests/integration/enrichment.test.ts` | Real loader→kernel→publisher preserves/revalidates the captured link; explicit score roots pass. Seeded scheduling linkage is labeled consumer-only, not release/full-chain evidence. |
| V11c | C2 atomic tags/release/enqueue, C5 / L1–L5 producer subset | `./node_modules/.bin/vitest run tests/integration/article-jobs.test.ts tests/integration/assign-tags.test.ts tests/integration/assign-tags-races.test.ts tests/integration/score-admission.test.ts tests/integration/enrichment.test.ts` | Real producer→original-score processing and all transaction/rollback/lock/ID-equality cases below pass; then rerun aggregate V11 before P1.4. |
| V12 | C4–C5 / L1–L5, dormant L6 | `./node_modules/.bin/vitest run tests/integration/article-worker.test.ts tests/integration/enrichment.test.ts` | Real-queue local product flow and worker/provisioning cases below pass. Aggregate P1 additionally requires full V1–V3 and V6. |

### V1 cases

- **Generation-domain vectors** in `tests/unit/article-handoff.test.ts`, following its existing receipt/ref/preparation fixtures and boundary loops:
  - For otherwise valid category and tags receipts, `generation: 0`, `1` and `2_147_483_647` each decode unchanged through `decodeHandoffReceiptV1` and `readHandoffReceipt({ unrelated: true, handoffReceipt: receipt })`. Keep the existing V1 field set; no `articleChain` namespace is needed.
  - `decodeHandoffRef` and `decodePreparationReceiptV1` accept generations `1` and `2_147_483_647`, but return `null` for `0`. Otherwise valid tags/scores `ChainMetadataV1` with `requiredHandoff.generation: 0` also return `null`, whether waiting (`requiredBasis: null`) or activated. A decoded generation-zero receipt's task/action/generation must not become an accepted chain reference.
  - All three generation decoders reject `-1`, `0.5`, `2_147_483_648`, `NaN`, `Infinity`, `"0"`, null, undefined and a missing generation field. Retain positive content-revision checks independently.
- Accept category/tag no-op receipts, tags post-creation epoch, zero target count and null-title/source hash vectors. Category root decode returns the exact required `tagsTaskId` for both zero/nonzero counts.
- Root anchor vectors: reject missing field (including the old-shaped root), undefined/null/non-string/malformed UUID, and UUID aliased to root or prepare, including case-only aliases. Tags/scores reject any own root-only `tagsTaskId` field; test valid UUID and null/undefined as well as existing `targetCount` rejection.
- Reject missing namespace/receipt, wrong version/action/UUID, duplicate or mismatched identities, wrong root/prerequisite/generation, negative/fractional/overflow revisions, malformed hash and invalid action-specific nullable fields.
- Fingerprint changes on title or source changes, including null versus empty string; stable for identical input.

### V2 cases

- **Pattern:** Disposable DB setup from `score-admission.test.ts`; lock barriers from `categorize-races.test.ts`/`assign-tags-races.test.ts`; real deferred constraint trigger, not a mocked transaction promise, for commit failure.
- Admission creates one executable category job, waiting tags and only initial active/nondeleted score rows. For zero/nonzero targets assert root `tagsTaskId` equals the returned ID and persisted waiting tags PK, remains immutable, and is absent from downstream metadata; verify prerequisites, generations and saved job IDs before workers.
- Missing article, absent/malformed/obsolete prepare receipt, unusable/blank content or revision mismatch → no admitted rows/jobs; concurrent admissions serialize; generation overflow leaves history unchanged. Explicitly tamper an otherwise valid preparation receipt to `generation: 0`: admission rejects without rewriting that task/receipt or creating chain rows/jobs.
- **Standalone generation-zero regressions:** Extend `article-jobs.test.ts`'s real standalone receipt/publisher tests; exercise real loader/kernel paths in `categorize.test.ts` and `assign-tags.test.ts`, not receipt-only mocks.
  - Category task/candidate generation `0`, no own `articleChain` key, and unrelated result metadata: publish through both `CatalogStore` and `ArticleJobs`, for changed and no-op assignments. Expect success and identical returned/persisted receipts with the existing task ID and generation exactly `0`; task generation and unrelated metadata remain unchanged. The receipt round-trips through `readHandoffReceipt`; no chain metadata, successor rows or jobs are invented.
  - Tags task/candidate generation `0` with its exact successful standalone category prerequisite also at generation `0`: obtain the category receipt from the real publisher, then load/publish tags through both publisher paths. Cover empty labels, new tags and an existing-tag no-op. Expect success, correct post-transition assignment revision/catalog epoch and a generation-zero tags receipt; preserve the valid category receipt, existing task identities/generations and unrelated result metadata. Neither task gains `articleChain`; no score tasks/jobs or preparation receipts are fabricated.
  - Seed otherwise valid persisted standalone generation-zero receipts with no chain metadata: reads and compatible standalone processing retain them as valid. Preserve original task rows/history rather than deleting, backfilling, re-admitting or normalizing generations. Missing/malformed prerequisites and a present invalid chain namespace still fail closed under the existing negative cases.
- Category changes assignment revision; tags receipt uses that new revision. New tags advance epoch; score handoff uses resulting revision/epoch, not the pre-transition numbers. No-op category/tag transitions still hand off correctly.
- Before category publication, remove the anchored tags row and insert a different-UUID replacement with otherwise matching article/prerequisite/generation/metadata; particularly cover `targetCount: 0`. Reject it with no committed category publication/receipt/assignment change or tags job. Also reject a missing or malformed anchored row and an old-shaped root, preserving invalid root JSON/row with no inference, backfill, deletion or re-admission.
- Empty tags succeeds with no invented association. Zero targets stays zero even when a definition appears before tags publish. Later definitions never create downstream tasks.
- Disable/delete one original target before tags publish → only that target retires. Other original targets enqueue; terminal/superseded rows never reactivate. Explicit newer score generations win independently.
- Fail category→tag send; fail the second tag→score send after the first real enqueue; return null/malformed send ID; reject job-ID persistence; inject deferred commit failure after jobs are visible inside the transaction.
  - Assert **all** affected assignments, new tags/associations, revisions/epoch, success/receipt metadata, task states and jobs roll back together. Old successful scores remain byte-for-byte unchanged.
- Simulate lost publication response after a committed transition → exception escapes, committed success/jobs remain, no second settlement write. Keep existing cancellation-cutoff regressions.
- Deterministic independent-session barriers prove epoch/catalog/article/task lock order and exclusion through commit, including tag creation versus catalog mutation. No sleep-only race assertions.

### V3 cases

- One prepared article, real queues and fake AI → ordered category classifier, automatic-bucket tag generator, classifier call for each original score target. Inspect exact requests and final DB results, not only returned statuses.
- Native indices `0`, `1.5`, `4` retain `0`, `37.5`, `100`; score context uses post-tag assignments and only selected fields/relevant weights. No hidden multiplier or global preference leakage.
- Edit category/tags/content/title/source **after enqueue, before each relevant worker load** → no AI for stale work. Repeat edits during inference → no stale publication. Newer category/prepare generations also fence descendants.
- Change prompt/model/selected fields after handoff but before dispatch → actual request uses the new eligible values. An unrelated later definition/retired sibling does not invalidate remaining dispatches merely through old receipt epoch comparison.
- Linked score with missing/malformed/wrong-article/wrong-generation/rewired/obsolete tag receipt → no AI and no score write; repeat tampering after capture → publication rejects. In P1.3 also cover tags ID and score prerequisite/handoff/receipt ID inconsistent with root `tagsTaskId`, plus missing/malformed/old-shaped root: load rejects before AI and publication rejects after in-flight tampering.
- Standalone category/tag tasks and direct null-prerequisite score roots with no `articleChain` key retain existing behavior, including V2's valid generation-zero standalone receipts. With a present null/malformed/old-shaped namespace, none may fall through to standalone; no AI/publication/successor job.
- For linked tags and scores, change an otherwise valid stored `requiredHandoff.generation` to `0`: load rejects before AI; repeat after input capture and publication rejects with no success/receipt/successor writes. Keep the invalid stored namespace/history intact. Receipt generation-zero acceptance must not relax positive chain-reference checks or permit standalone fallback.
- Duplicate delivery/obsolete token/wrong action to each queue → no extra claim/configuration/AI/publication/successor job. Keep the existing generic claim API unchanged.
- One failing/paused article or score does not erase saved results or block successful siblings/another article. Budget/auth/configuration/oversized-input outcomes are visible; failed prerequisites never release successors.
- Worker shutdown drains only its registrations. No assertion of process-crash recovery, automatic pause resume or exactly-once external inference.
- Explicit `main.ts migrate` provisions category/tags/score queues. Normal `buildApplication`, readiness probes and score reevaluation still construct no `ModelRuntime` and make zero inference/auth/provider requests. Retain existing fetch/runtime spies; cover direct transports if the composition imports change unexpectedly.

### V4–V5 cases

- V4: Real-server GET supports category/tags, polling/SSE task-change observation and terminal/paused/error states; unknown task/action → 404. Karakeep/score DTOs remain compatible; internal receipt JSON is absent.
- V5: Synthetic preparation → real adapter admission → real workers → saved category, tags and score basis/results visible after reader reload. No product API mocking.
- V5: Execute existing explicit reevaluation from article detail; new score generations/results appear without refetch, recategorization or retagging. Preserve prior successful value when fake score inference fails; report authoritative task error, not a fabricated zero.
- On a material failure: retain sanitized trace/DB observations, diagnose, make an explicit bounded repair decision and rerun the focused check plus affected regressions once. No retry-until-green or acceptance by old counts.

### V9–V12 checkpoint coverage

- P1.3 focused acceptance lives in V11a–V11c below. Each package stops at its own check and ownership boundary; only the assembled three plus V11 satisfy P1.3.

- **V9 — Prepared admission / contract revalidation:** Preserve V1's codec/admission coverage in `article-handoff.test.ts` and `article-jobs.test.ts`, using real `ContentStore.publishTask` preparation receipts. Prove one category job plus waiting tags/original score rows, exact root anchor for immutable zero/nonzero snapshots, generation/supersession preservation and deterministic concurrent-admission exclusion.
  - E5 records this corrected checkpoint; keep old-shape decode rejection/preservation and root-only field exclusion from descendants as regressions. A successor verifies the current files/evidence after V0; stale E4 counts cannot substitute.
  - Reject every invalid admission prerequisite without rows/jobs. Fail the initial category send, null/malformed send ID, job-ID persistence and deferred commit; all admission/supersession/task/job changes roll back. Use V2's real DB failure/barrier patterns, not transaction mocks.
- **V10 — Category handoff:** Preserve E5's V2 category change/no-op, receipt, category→tags enqueue, rollback, lost-response and lock cases in `article-jobs.test.ts`, plus category-specific V3 queue-delay/in-flight fences in `categorize.test.ts` / `categorize-races.test.ts`.
  - Assert committed category success/receipt and exactly one job for root `tagsTaskId`, with saved ID/post-category basis, for zero/nonzero snapshots. Add V2's missing/malformed/exact-PK replacement and old-root rejection cases: no committed category publication or tags job, invalid root preserved. Unchanged waiting score rows remain unreleased. Keep category kernel/cancellation regressions and V3's standalone-versus-malformed namespace cases.
  - Include V2's category generation-zero regressions through both publisher paths, preserving the receipt/task generation and unrelated JSON with no chain metadata or successor jobs. Run V1's split-generation codec cases alongside V10; positive chain/preparation domains must not widen.
- **V11a — Tag capture and standalone guard/receipt:**
  - **Required first demonstration** in `tests/integration/enrichment.test.ts`, before tag loader/producer code changes:
    1. Add a real-store characterization named `standalone tag publication persists its receipt`. Obtain its category prerequisite through the real publisher. Publish currently valid standalone tags; assert publication/task success and demonstrate absent returned receipt plus `readHandoffReceipt(saved.result) === null`.
    2. Run `./node_modules/.bin/vitest run tests/integration/enrichment.test.ts -t 'standalone tag publication persists its receipt'` and record the missing-receipt observation.
    3. Change absence assertions to the required returned/persisted receipt contract; capture that specific pre-fix failure, then implement the guard/receipt. Retain the final positive-contract test, not absence as desired behavior. An unrelated fixture failure is not this evidence.
  - After implementation, cover V2's standalone tag generation-zero/positive cases through the real kernel, standalone catalog wrapper and caller-transaction method: real exact category receipts, empty/new/existing no-op tags, post-transition basis/epoch, unchanged task generation and unrelated metadata. No inferred receipts, invented chain namespace, jobs or score tasks. `ArticleJobs` tag-wrapper compatibility is deferred to V11c.
  - Cover the tag subset of V3's pre-AI/in-flight/root-anchor/fingerprint/positive-reference fences. Valid linked tags may load/capture their category handoff, but both catalog publication entry points must reject them until V11c. Present null/malformed/old-shaped namespaces and a removed child namespace with a chain-bearing category prerequisite also reject; no candidate omission or zero-target/empty-label shortcut may bypass the guard.
  - Direct guard assertions compare assignment/tags/epoch, task state/receipt and waiting scores before/after: no publication or successor writes. Keep valid category receipts/history intact. Prove standalone receipt/assignment/task rollback on late rejection and real deferred commit failure, retaining E2's rejection and cancellation/ambiguity semantics.
- **V11b — Indivisible linked-score consumer unit:**
  - In `score-task-input.test.ts`, `run-stored-score-task.test.ts` and `enrichment.test.ts`, use real category/tag receipt-producing publishers from E5/V11a with their exact persisted identities, generations and post-transition basis. Synthetic fixtures may seed only scheduling linkage/activation (root/child metadata, prerequisite links, required basis and queue linkage as needed); do not fabricate/alter success receipts or handwrite score results. Label this evidence **consumer-only; no atomic-release or full-chain proof**. The P1.3a chain-publication guard stays closed.
  - Exercise real `ScoreTaskInputStore.loadResult` → `processContextChunks` → `ScoreStore.publishCandidate`, including the stored score executor. Assert captured link/fingerprint survives into the candidate and a valid linked score publishes. Add immutable propagation and native mapping/selected-field preservation cases to `tests/unit/process-context-chunks.test.ts`; no loader-only or manually constructed candidate substitutes for integration.
  - Apply V3's linked-score before-load and after-capture tampering matrix: missing/malformed/old-shaped root or tag receipt, wrong article/generation/prepare/root, rewired prerequisite, root `tagsTaskId` disagreement, unactivated basis, generation-zero reference and stale article/newer-generation fences. Before load → zero AI/no score; after capture → publication rejected and prior successful score unchanged. Removing the optional candidate link cannot bypass persisted linked-task detection.
  - Preserve V3's direct null-prerequisite/no-namespace roots and current dispatch configuration, including unrelated epoch changes before load; malformed namespace/non-null missing-link tasks never become explicit roots. No producer release, tag-chain success, queue worker or normal composition changes.
- **V11c — Atomic tag producer and original-score release:**
  - Implement the remaining tag/score V2 transaction cases in `article-jobs.test.ts`, preserving V11a/V11b regressions. This is the first actual end-to-end **P1.3 producer-to-score** proof: real preparation receipt → real admission → real category receipt/anchored tags activation → real `assignTags` through `ArticleJobs` → released original scores through the real score loader/kernel/publisher. No synthetic linkage/activation, handwritten success/receipt, direct candidate shortcut or stored category/tag worker substitute in this proof. P1.4 still proves actual stored deliveries.
  - Cover empty/new/no-op tags and exact post-transition receipt; immutable zero-target snapshots despite later definitions; original target membership/count; independent unavailable-target retirement; newer explicit per-target generations; terminal/superseded preservation. Only original eligible tasks enqueue, each with the receipt basis/reference and its actual job ID. No `ScoreAdmission.admit` call/resnapshot during release.
  - Use V2's real second-score-send, null/malformed send ID, suppressed update and deferred-commit failures. Also install a real PostgreSQL trigger that substitutes a **different valid UUID** during score job-ID persistence: `enqueueScoreTask` must reject the returned mismatch and roll back jobs/tasks. Prove the equality check both for its existing explicit admission caller in `score-admission.test.ts` and for the new tag-release owner; a valid-looking wrong ID cannot commit.
  - Assert all new tags/associations, assignment/epoch, tag success/receipt, score activation/retirement metadata and real jobs roll back together; prior scores stay byte-for-byte unchanged. Use deterministic independent-session lock barriers through commit, and preserve lost-response/ambiguous-success propagation without compensating settlement.
  - Add V2's standalone tag generation-zero compatibility through the new `ArticleJobs` publisher as well. Only its fully validated owning chain transaction may enter chain-enabled catalog publication; standalone/direct caller-transaction entry remains closed to linked tags. Rerun aggregate V11; no single focused check accepts P1.3.
- **V12 — Stored local flow:** Add the full real-delivery flow and worker/provisioning/dormancy cases from V3 to `article-worker.test.ts` / `enrichment.test.ts`, starting with C5's synthetic real preparation setup.
  - Use actual admission, real category/tags/score queues, stored workers and fake AI. Inspect exact requests and persisted outputs; no manual task-success writes or direct-kernel substitute for the worker path. HTTP/browser acceptance stays in P2.

## Packages and dependencies

### Approval and acceptance boundary

- **Approved scope/contracts unchanged:** P1+P2 and L1–L7 remain the exact local product outcome. E5 records approval/implementation evidence for the pre-release root-only `tagsTaskId` correction and independent receipt/reference generation domains. This refinement requests no new local product/design decision; it authorizes no source execution or production/populated-target use.
- **Latest stop, not a delivery:** E6's P1.3 worker made no changes. Its tag capture/standalone publication, linked-score consumer path and atomic producer/release responsibilities become three serial boundaries. Do not redispatch the original coupled P1.3 slice or count its stop/baselines as implementation.
- **Recorded predecessors:** Retain E5's corrected P1.1/P1.2 work and evidence after fresh V0 inspection. E1–E4 alone are not the current contract proof; contradictions stop affected work rather than trigger an invented repair.
- **Checkpoint versus acceptance:** P1.3a and P1.3b deliberately cannot publish linked tags/release scores. **P1.3 acceptance/V11 is the aggregate of P1.3a+P1.3b+P1.3c**, never an individual subpackage or a seeded consumer success. P1.4 stays after V11; aggregate P1 and then P2 remain required. NR-C14/D2/NR-V10 and G1–G5 remain unchanged.

| Delivery | Independently verifiable outcome | Changes / criteria / checks | Hard prerequisite |
| --- | --- | --- | --- |
| P1 — Dormant prepared chain | Real DB/queues process prepared text through category/tags/original score targets with atomic handoffs; normal composition stays inert. Retain P1.1/P1.2; continue P1.3a→P1.3b→P1.3c→P1.4 below. | C1–C5, C7 checkpoint evidence; L1–L5 and dormancy part of L6; full V0–V3, V6 plus focused V9–V12 | E0–E2 and local runtime/DB prerequisites. |
| P2 — Reader acceptance surface | Built browser and real API expose actual P1 results and score-only reevaluation; repeatable synthetic fixture for meaningful local product testing. | C6–C7 remaining; L6–L7; V4–V8, affected V6 | Aggregate P1 accepted, including V1–V3 and V6; not merely a focused checkpoint pass. |

### Sequential implementation packages under P1

These are serial capability checkpoints within the unchanged P1 delivery. Ownership below is bounded; criteria/check references define focused acceptance, not aggregate L-criterion acceptance.

| Package | Independently meaningful boundary | Changes / focused acceptance | Hard prerequisite |
| --- | --- | --- | --- |
| P1.1 — Prepared admission correction (recorded) | Exact root tags PK for zero/nonzero snapshots; atomic prepared admission. | C1 codec, C2 admission, C5; V1, V9; E5 evidence | E1 preparation/E0 primitives and approved root correction; preserve current files under V0. |
| P1.2 — Atomic category→tags (recorded) | Category success/receipt and exact anchored tags activation/job commit together; standalone zero receipts retained. | C1 generation domains, C2/C3 category, C5; V1, V10; E5 evidence | Corrected P1.1/V9 and retained E2 publishers. |
| **P1.3a — Tag capture + standalone guard/receipt (next only)** | Capture/fence the exact category handoff; standalone tags persist receipts; every linked tag publication remains closed. | C2 standalone tags, C3 tags, C5; L1/L3–L5 subset; V11a | P1.2 contracts/evidence confirmed by **fresh V0** and local prerequisites. |
| P1.3b — Linked-score consumer unit | One loader→kernel candidate propagation→publication fence; explicit score roots preserved. Synthetic scheduling linkage is consumer evidence only. | C3 scores, C5; L1/L3–L5 consumer subset; V11b | P1.3a/V11a: real receipt producer/capture contract available; chain tag guard still closed. |
| P1.3c — Atomic tags→original scores | Tag success/receipt and only original eligible score activation/jobs commit together. First real P1.3 producer-to-score proof. | C2 tag owner/enqueue hardening, C5; L1–L5 checkpoint; V11c, then **aggregate V11** | P1.3a/V11a and indivisible P1.3b/V11b accepted in place; existing enqueue primitive retained. |
| P1.4 — Stored local product chain | Explicitly provisioned dormant workers deliver the entire prepared chain with fake AI and real DB/queues. | C4–C5; V12, then aggregate V1–V3 and V6 | All P1.3a+P1.3b+P1.3c integrated and **V11 passed**, not any focused subpackage alone. |

#### Retained predecessor boundaries

- **P1.1 owned:** `src/server/domain/article-handoff.ts`, admission in `src/server/adapters/postgres/article-jobs.ts`, `tests/unit/article-handoff.test.ts` and admission cases in `tests/integration/article-jobs.test.ts`. Retain exact root-only anchor, zero-capable receipt/positive-reference distinction, atomic snapshot/generation/supersession and V9 preservation; no new correction delivery is proposed.
- **P1.2 owned:** Category methods in `src/server/adapters/postgres/{article-jobs,catalog-store}.ts`, `category-task-input-store.ts` in the same adapter directory, `src/server/application/categorize.ts` and corresponding C5/V10 category tests. Retain exact anchored activation, category receipt, standalone generation zero and category load/publication fences. No rebuilding preparation/category primitives.
- Test queues remain explicitly provisioned by fixtures; administrative `main.ts` provisioning stays P1.4.

#### P1.3a — Tag capture and standalone publication boundary

- **Owned source:** `src/server/adapters/postgres/{tag-task-input-store,catalog-store}.ts`; `src/server/application/assign-tags.ts`.
- **Owned tests/fixtures:** `tests/unit/article-handoff.test.ts` only as needed for preserved receipt vectors; `tests/integration/{assign-tags,assign-tags-races,enrichment}.test.ts`. Update these fixtures through real receipt-producing category publishers, not seeded successful category rows without receipts. C7 evidence ownership is below.
- **Entry/interface:** Extend `TagTaskInputStore.loadResult`/`TagInputResult` and the existing `TagCandidate` capture. Fetch task/prerequisite result JSON and article source identity; distinguish namespace absence from invalid metadata. Validate the exact category receipt; for linked tags also validate decoded root `tagsTaskId`, prepare/root generations and activated basis per C3. Carry immutable root/consumer metadata, prerequisite receipt and fingerprint into the candidate; do not widen stored JSON or generation domains.
  - `assignTags` must retain that capture in publication and map invalid handoff to needs-input/no AI. Keep publisher-entry ambiguity/cancellation behavior and narrow its structural publication dependency for the later `ArticleJobs` implementation; no placeholder producer here.
- **Receipt/guard:** After V11a's required initial missing-receipt demonstration, implement standalone tag receipt in `CatalogStore.publishTagCandidate` and `publishTagCandidateInTransaction`. Return existing revision/epoch fields plus `receipt: HandoffReceiptV1`; merge the same validated receipt into task result with success and post-transition assignment/epoch in the caller's transaction. Compute standalone receipt fingerprint from the locked article, as E5's category publisher does; copy exact generation including zero.
  - Both catalog entry points reject linked tags before mutation, even a valid chain and zero targets. A removed child namespace cannot make a chain-bearing category prerequisite standalone. No `allowChain` switch, exported bypass, chain-success stub or test-only success route in this package.
- **Focused exit / stop:** V11a plus checkpoint static/evidence checks only. Valid linked tag capture is not linked publication acceptance. **No `article-jobs.ts` producer changes, linked tag success, score source/release, workers/provisioning or normal composition.** Missing prerequisite/contradictory predecessor → stop/report, not permissive fallback.

#### P1.3b — Indivisible linked-score consumer boundary

- **Owned source:** `src/server/adapters/postgres/{score-task-input-store,score-store}.ts`; `src/server/application/process-context-chunks.ts`. These three must land/verify together, never separate loader-only, propagation-only or publisher-only deliveries.
- **Owned tests/fixtures:** `tests/unit/process-context-chunks.test.ts`; `tests/integration/{score-task-input,run-stored-score-task,score-admission,enrichment}.test.ts`. Use V11b's real receipts; only synthetic scheduling linkage may be seeded and must be labeled consumer-only.
- **Entry/interface:** Extend `ScoreTaskInputStore.loadResult`, `ScoreContextTask.owner`, `ScoreCandidate.basis` and `ScoreStore.publishCandidate` as one C3 path. Capture the same root-anchor/predecessor/article identity, propagate it through the actual `processContextChunks` candidate, then revalidate persisted linkage at publication. Required data and immutable-copy semantics are in C3; absence on a linked candidate is rejection, not a root.
  - Add an invalid-handoff loader result where needed; the existing `runStoredScoreTask` maps non-stale load outcomes to needs-input. Preserve stale-basis supersession and explicit null-prerequisite/no-namespace score roots without requiring tag receipts.
- **Focused exit / stop:** V11b plus checkpoint static/evidence checks. No changes to tag producers, `ArticleJobs`, `enqueueScoreTask`, actual successor release, category/tag workers or composition. P1.3a's chain-publication guard stays closed. This package cannot claim atomic-release, end-to-end P1.3 or P1 acceptance.

#### P1.3c — Atomic producer/release boundary

- **Owned source:** `src/server/adapters/postgres/{article-jobs,catalog-store,score-admission}.ts`. Retain the P1.3a/P1.3b capture interfaces; `ScoreAdmission.admit` behavior is unchanged except shared enqueue validation.
- **Owned tests/fixtures:** `tests/integration/{article-jobs,assign-tags,assign-tags-races,score-admission,enrichment}.test.ts`; consume the existing consumer suites unchanged unless a diagnosed integration regression requires an explicit bounded repair.
- **Entry/interface:** Add `ArticleJobs.publishTagCandidate(candidate, at)` returning the P1.3a publication shape or null, plus structural delegation to existing `CatalogStore.tagKeysFit` for `assignTags`. Implement C2's tags transition with real transactions/rollback/locks; do not call a transaction-owning standalone wrapper inside it.
  1. Acquire exclusive epoch initially and the C2 lock prefix/order; validate the persisted/captured tags/root/category/prepare handoff and original score membership/count before permitting chain publication.
  2. Invoke the transaction-aware tag publisher only through this validated owning chain path; validate returned **and persisted** tags receipt/post-transition basis, merge successor activation metadata and visit the existing score rows deterministically. Standalone `CatalogStore` publication remains closed to links.
  3. Apply independent target retirement/newer-generation rules, then call **existing `enqueueScoreTask(tx, boss, taskId)`** for each eligible original row. No replacement score rows, `ScoreAdmission.admit`, target resnapshot or nested transaction.
  4. Harden that existing helper to require exactly one saved row with `jobId` equal to the actual send ID (PostgreSQL UUID/case-normalized). Any send, receipt, update, saved-ID mismatch or commit failure aborts all publication/release writes; late tag rejection exits the owner before translation to null. Ambiguous success errors escape.
- **Focused exit / stop:** V11c is the first real producer-to-score proof; then run **V11 on the assembled P1.3a+P1.3b+P1.3c**. Only that aggregate satisfies P1.3. No category/tag stored workers, administrative provisioning, HTTP/browser work or production activation; those boundaries remain P1.4/P2/G-gates.

#### Remaining delivery and evidence ownership

- **P1.4 ownership:** C4's `src/server/application/{run-stored-category-task,run-stored-tag-task}.ts`, `src/server/adapters/postgres/article-worker.ts`, explicit provisioning in `src/server/main.ts`, and C5's `tests/integration/article-worker.test.ts`/`enrichment.test.ts`. Close real stored deliveries only after V11, then full V1–V3 and V6. No P2 API/browser work early.
- **P2 ownership:** C6's exact API/test/helper/browser paths and remaining C7 docs. Hard prerequisite is aggregate P1, not V11 alone; run V4–V8 and affected V6. Exact local product outcome remains unchanged.
- **Evidence ownership for every checkpoint:** Only its exact paths, commands, counts, cases and remaining limits enter `docs/verification.md` (C7). Record V11a's initial missing-receipt/regression evidence and distinguish V11b's synthetic linkage from V11c's real producer proof. Other C7 documentation remains P2.
  - Capture fresh V0 per package; run V6's typecheck/whitespace checks and existing ESLint on exact changed source/test paths, recording them. Full V6 remains required at aggregate P1/P2 exits; focused counts never replace it.
- **Next handoff — P1.3a only after fresh V0:** Confirm E5 predecessor files/evidence and runtime/disposable-DB prerequisites, then execute only P1.3a through V11a. P1.3b→P1.3c→V11→P1.4→aggregate P1→P2 remain dependent. No new local design decision; missing evidence/tools or overlap contradictions return `needs_input`. This artifact amendment starts no implementation and advances no acceptance/workflow state.

### Integration constraints

- **Execution/integration:** Sequential writers in the shared checkout; no parallel source writing. A package successor consumes the verified predecessor before changing overlapping transaction/loader/test files. Read-only investigation may be independent; no alternate workspace/transfer mechanism is assumed.
- **Base:** Current preserved dirty root at `/home/matthias/feedrafter`, captured by V0; not an old clean commit or a reset to the approved plan's historical Git inventory.
- **Result transfer:** Changes remain in the preserved checkout; exact path/contract/check evidence enters `docs/verification.md`. Each successor confirms actual files and predecessor evidence, not counts alone. The primary executor assembles P1.3a→P1.3b→P1.3c, verifies V11, then integrates P1.4 and aggregate P1 before P2 consumes accepted contracts in place. No synthetic consumer linkage is transferred as producer/full-chain proof.
- **Permissions:** No commit/merge/worktree transfer/publication rights assumed. Do not stage, reset or disturb existing index contents.
- **Next important processing delivery, not a prerequisite for P1/P2:** Connect newly inserted import identities to real preparation jobs, snapshot targets at **import admission**, and transactionally release category after quality publication. Use existing `inserted` evidence; do not snapshot again at preparation completion or backfill old rows.
  - This requires a separate focused continuation covering prepare worker/admitted quality calls, typed pauses and preparation-to-category atomicity. Do not quietly label test fixture preparation as that integration.
  - Keep current production import and acknowledgement behavior unchanged here. Full NR-V10 also still needs this continuation and other canonical gates.

## Production activation gates — blocked / needs_input

- This register preserves the user's production-inference choice. It does not reinterpret the choice as local-only intent, nor infer consent to deployment, provider traffic or all imported articles.
- P1/P2 local acceptance must precede any activation. No default enable flag, credential wiring or production target change is part of these packages.

| Gate | Required input / evidence | Required decision / result |
| --- | --- | --- |
| G1 — Target and deployment | Exact environment/host, image/revision, database/data mounts, operator and deployment/rollback authorization. | Approve a bounded target change separately; retain matched backup and a way to stop workers before any switch. No deployment authorized by this plan. |
| G2 — Provider/model and safe wiring | Exact eligible category/scores classifier and tags generator, applicable context/output limits, credential owner, approved private auth path, applicable C11 lifecycle/direct-adapter and live compatibility evidence. | Use existing admitted built-in-only Pi boundaries and audited routes; no guessed model, personal Pi config, bypass or hidden retries. Operational composition is still unimplemented. SDK/session gates matter only if the selected workflow actually needs sessions; do not make chat completion a prerequisite for direct-only testing. |
| G3 — Data and workflow boundary | Explicit article IDs/content disclosure consent, source permissions, prepared-only versus automatic import scope, and permission for any FreshRSS mutations. | Recommend an allowlisted prepared-text canary first; no automatic backlog or whole-account processing. If full imported articles are requested, complete the next processing delivery above before that acceptance. No such canary selection is assumed approved. |
| G4 — Bounded usage | Approved request caps by bucket/total and time window, concurrency, spend ceiling or explicit unknown-cost policy, retry policy, stop owner and stop condition. | Pilot defaults (50 automatic / 50 interactive / 2,000 classifier per UTC day) are not an approved production-test budget. Count every admitted attempt; unknown cost stays unknown, not zero. |
| G5 — Authorized production acceptance | P1/P2 evidence plus separately approved wiring/run procedure, provider transport-to-ledger accounting proof for the selected direct routes, auth/refresh/container compatibility and target rollback/readiness evidence applicable to the canary. | Only then execute the authorized bounded run: correlate approved article/task IDs, category/tag/score outputs and limitations, wire sends/ledger/caps and reader state. Record model-quality observations separately from deterministic correctness. Stop on cap, disclosure, accounting, unexpected request or target mismatch. |

- **Outstanding external decisions:** G1 target/deployment authorization; G2 exact models/provider/auth; G3 data and workflow scope; G4 caps/spend/stop policy; G5 approval of the bounded live procedure. Return these to the coordinator as `needs_input`, not interactive prompts.
- **Production acceptance is not local acceptance:** Fake AI cannot establish provider compatibility, stochastic quality, actual spend, auth refresh, transport accounting or deployed behavior. Even a successful canary does not accept NR-C14/D2/NR-V10, import automation, crash recovery or the wider product.
- **No activation instructions implied:** Missing material gate → remain dormant and report. Inputs supplied later require incorporation into an approved bounded activation continuation before code wiring/deployment/provider calls; no executor-selected substitutes.
