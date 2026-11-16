# C11 admission — Sequential Implementation Plan

## Overview

- **Outcome:** Replace the oversized admission/settlement/recovery/migration work unit with small, sequential, independently checked packages, then complete C11's request boundaries.
- **Status snapshot (2026-11-02):** P1–P6 admission foundation, P7 private runtime, and P8 direct classifier/generation adapters are implemented locally. P8's one-send loopback proof and scoped independent review passed; see `docs/verification.md`. P9–P11 remain incomplete. This is not C11/NR-V11 completion, product acceptance, or activation approval.
- **Approved choice:** Built-in-only Pi runtime (`modelsPath:null`); private auth persists, but custom provider/model catalogs and endpoint configuration do not. C7 defines the restricted runtime/route contract.
- **Safety boundary:** P1–P6 persist and fence reservations; P7/P8 expose tested adapters only. Existing article/import jobs and HTTP actions stay unwired to AI; no production dispatch is enabled.
  - P9–P11 (SDK sessions/compaction, setup/lifecycle composition, and cross-path accounting proof) remain outstanding. Live OAuth/provider evidence is also outstanding.
- **Key decision:** Count `reserved` ledger rows as active local slots; serialize every transition through the bucket's existing `budget_settings` row.
  - No second active-slot counter to drift; concurrency spans all dates within that bucket.
- **Key decision:** One dedicated PostgreSQL session per attempt; that session performs admission and settlement. Recovery identifies a dead database backend, not an expired wall-clock lease.
  - A dead owner becomes `uncertain`; credit stays consumed and its local slot is freed. The remote provider may still run.
- **Unchanged / excluded:** Dependency pins/npm policy; scoring/context/chat workflows; audio quota enforcement; settings UI; automatic retry scheduling; production activation; commits, merges and deployment.
- **Risk:** Releasing a dead owner's slot does not enforce a strict cap on remote requests still executing. This is the explicitly confirmed policy, not an exactly-once or remote-cancellation guarantee.

## Planned changes

Local C/V IDs below belong to this document. `NR-C11`, `NR-V11` and `NR-V15` refer to `.ai/news-reader-plan.md`.

| ID | File / area | Planned change and purpose |
| --- | --- | --- |
| C1 | `src/server/domain/usage.ts`, `src/server/ports/usage.ts` (new); `src/server/adapters/postgres/schema/enrichment.ts`, `src/server/adapters/postgres/usage-store.ts` (modify); `drizzle/0005_usage_admission.sql`, `drizzle/meta/0005_snapshot.json` (new), `drizzle/meta/_journal.json` (modify) | Define request-accounting contracts and owned reservation schema; conservatively upgrade legacy reservations; remove unfenced usage writers. |
| C1 | `src/server/http/app.ts`, `tests/integration/enrichment.test.ts` (modify); `tests/helpers/usage-database.ts`, `tests/integration/usage-migrations.test.ts` (new) | Keep schema readiness current; replace storage-only writer assertions; prove fresh and historical upgrades in disposable PostgreSQL. |
| C2 | `src/server/adapters/postgres/usage-owner.ts`, `tests/integration/usage-owner.test.ts` (new) | Isolate dedicated session identity, abort, heartbeat and connection cleanup without admitting requests. |
| C3 | `src/server/adapters/postgres/usage-admission-store.ts`, `tests/integration/usage-reservations.test.ts` (new) | Atomically consume daily credit and reserve a cross-date local slot; deny without side effects. |
| C4 | `src/server/adapters/postgres/usage-admission-store.ts` (extend); `tests/integration/usage-settlement.test.ts` (new) | Add owner-fenced, terminal-once settlement without refunds or replacement results. |
| C5 | `src/server/adapters/postgres/usage-admission-store.ts` (extend); `tests/integration/usage-recovery.test.ts` (new) | Recover only dead owners; preserve credit/history; reject late settlement. |
| C6 | `src/server/application/usage.ts`, `tests/unit/usage.test.ts`, `tests/integration/usage-gate.test.ts` (new) | Supply the single-attempt application gate, shared auth pause and cancellation/failure cleanup, using test callbacks only. |
| C7 | `src/server/ports/ai.ts`, `src/server/adapters/pi/runtime.ts`, `tests/unit/pi-runtime.test.ts` (new) | Define domain-facing AI boundary and one private shared built-in-only runtime with fixed audited routes; no persisted provider/model catalog or endpoint configuration, no dispatch implementation yet. |
| C8 | `src/server/adapters/pi/requests.ts`, `tests/helpers/fake-provider.ts`, `tests/unit/pi-requests.test.ts`, `tests/integration/pi-requests.test.ts` (new) | Bind direct generation/classification through C6 to a one-send inference transport; prove loopback 421/redirect/retry/denial/stream and wire-ledger boundaries. Incomplete. |
| C9 | `src/server/adapters/pi/sessions.ts`, `tests/integration/pi-sessions.test.ts` (new); `src/server/adapters/pi/resource-loader.ts`, `tests/unit/pi-resource-loader.test.ts` (extend only as needed) | Restrict sessions and wrap every SDK stream invocation, including explicit compaction and fixture resume. |
| C10 | `src/server/adapters/pi/setup-ai.ts`, `tests/unit/setup-ai.test.ts`, `tests/unit/ai-lifecycle.test.ts` (new); `src/server/{main,config,composition-root}.ts`, `tests/unit/config.test.ts`, `compose.yaml`, `.env.example`, `README.md`, `docs/operations.md` (modify) | Add terminal-only built-in model selection, persistent private auth and shutdown/recovery composition; no custom catalog/endpoint setup or AI job/route activation. |
| C11 | `tests/integration/budgets.test.ts`, `tests/live/pi.live.test.ts` (new); `docs/verification.md` (extend per completed package) | Close the C11 cross-path wire-accounting matrix; record partial versus full inherited gates accurately. |

## Implementation details

### Basis

- **Authority:** `.ai/news-reader-plan.md`, C1 dependency exception, C10–C11, C16, V11/V15 and delivery activation rules; `docs/dev-agentic-news-reader-spec.md`, AC19–AC21; `docs/architecture.md`, sections 5–8 and 12.
  - **Approved amendment:** The user's explicit built-in-only choice supersedes the parent NR-C11 persisted `models.json`/`catalog.json` and custom endpoint assumptions for local C7/C10. No persisted custom provider/model catalog or endpoint configuration; database role mappings remain built-in model selectors. Only this plan records the amendment; other scope and source documents are unchanged.
- **Diagnosis / supplied state:** The prior worker could not finish the combined durable admission/settlement/recovery plus migration package. Its transient TDD attempt was discarded. The request supplies **no surviving source changes**; do not recover temporary patches or treat that attempt as test evidence.
- **Verified working-tree facts:**
  - `UsageStore` exposes `record`, `updateEntry`, `incrementCounter`, budget CRUD and reads; its comment explicitly excludes admission. Source search found no production callers of those usage writers.
  - `usage_ledger` currently permits only `reserved|succeeded|failed`; it has no owner, settlement timestamp or cost/provenance fields.
  - `request_counters` has primary key `(day_utc,bucket)`. `budget_settings` already contains all four buckets and approved defaults from `drizzle/0002_budget_settings.sql`.
  - `src/shared/settings.ts` already validates nullable limits and permits zero. Reuse it; no default/validation redesign.
  - At initial planning, `src/server/adapters/pi/resource-loader.ts:createEmptyResourceLoader` and its unit test existed; `AiPort`, admission and other Pi adapters did not. This is historical inventory, not current status: `docs/verification.md` records later partial C7/C8 work; C8 below retains the uncompleted transport/evidence gate.
  - `runImport` in `src/server/adapters/postgres/import-jobs.ts` demonstrates dedicated-client error handling, heartbeat and same-session fenced writes. Do not reuse its import lock or processing ownership token for usage.
  - `migrateDatabase` uses explicit administrative migrations with an advisory lock. Normal startup must remain DDL-free.
  - Latest migration is `0004_feedback`; readiness in `src/server/http/app.ts` pins journal timestamp `1793526239814`. The parent plan's original empty-repository inventory is historical, not current reality.
- **Git / runtime evidence limits:**
  - Read `.git/HEAD` and `.git/refs/heads/master`: `master`, `6b8653391b90810f3a475e4086fb042587431119`. Review base is the current working tree on that ref, **not HEAD alone**; implementation files are present beyond the old committed plan baseline.
  - No Git status/diff or runtime command was run in this planning task. Preserve all pre-existing staged/unstaged work; supplied discarded-attempt state is not an independently verified clean-tree claim.
  - `docs/verification.md` supplies prior Node 24.21.0/PostgreSQL 18 evidence and explicitly says V11 not run. Its historical suite counts are not a current baseline measurement.
- **Pinned Pi evidence:** Repository packages are `@earendil-works/pi-{ai,coding-agent}` 1.4.0. Inspected local SDK/settings/compaction/providers/models/configuration/security/session documentation, SDK examples 09/11/12 and exported declarations.
  - `dist/core/model-runtime.d.ts` supports shared runtime injection, classifier calls and network-disabled creation.
  - `dist/core/agent-session.js:_runDefaultCompaction` passes `this.agent.streamFunction` into compaction; branch summary also uses it. `dist/core/compaction/compaction.js` uses supplied `streamFn`, otherwise a direct completion. Therefore supply the wrapper, never call the lower-level default without it.
  - `pi-ai/dist/api/classifier-shared.js:postClassifierRequest` defaults to two retries unless explicitly overridden. Pi's classifier cost is catalog-derived; direct TypeSafe catalog-zero is not evidence of free usage.
- **Mismatch gate:** Stop and report if schema sequence, source symbols, pinned APIs, permissions or supplied baseline contradict this document. Do not invent replacement architecture or relax a check.

### Confirmed policies and shared design

- **D1 — Limits:** Daily credit is per UTC day and bucket. Concurrency is per bucket over **all dates**, not globally across buckets and not per day.
  - Defaults stay automatic `50/1`, interactive `50/1`, classifier `2000/2` (daily/concurrency). `null` means unlimited; `0` denies. No new audio policy here.
- **D2 — Consumption:** One credit is consumed when the reservation transaction commits. No refund on failure, cancellation, unused committed reservation, process death or uncertain dispatch.
  - A rollback consumes nothing. An unknown commit acknowledgement never authorizes dispatch or automatic re-admission.
- **D3 — Ownership:** Each attempt owns a dedicated checked-out `pg.PoolClient`, random UUID owner token and exact `(pid, backend_start)` identity from its own backend.
  - Carry `backend_start` without JavaScript `Date` precision loss: obtain SQL text and persist/compare the full PostgreSQL timestamp. A PID by itself is insufficient.
  - All normal reservation/settlement transactions use that exact client; no reconnect/takeover using the same token.
  - Database connection loss aborts the local attempt. Recovery never transfers its reservation to a new attempt.
- **D4 — Slots:** Active local slots equal `count(usage_ledger where bucket=B and status='reserved')`, irrespective of date. All changes affecting that count take B's budget row lock first.
  - Use `READ COMMITTED` transactions. Lock order: budget row → ledger rows in ID order; read authoritative counts only after acquiring the lock. Counter creation/update occurs under that lock. Never retain a SQL transaction across a provider wait.
  - Existing `UsageStore.saveBudget` upsert takes the same row lock through PostgreSQL's update locking. It must not delete/reseed the row.
  - Lowering a cap does not cancel existing requests. Future admission denies while current usage is at/above the new value.
- **D5 — Recovery:** Only absence of the exact owning database backend proves death. A live but slow session is not expired by age.
  - Dead owner: `reserved → uncertain`; release local slot through that transition; preserve daily counters, ID, admission time, model identity, owner identity and any known usage.
  - A disconnected client may remain visible until PostgreSQL detects connection death. Keep its slot until then; no heartbeat timeout reclamation.
  - `pg_stat_activity` checks must be fresh and visible to the application role for its own sessions. Missing permissions, null identity or a failed probe are errors, not proof of death.
- **D6 — Terminal data:** `succeeded|failed|uncertain` are terminal. No terminal-to-reserved transition or late overwrite. Caller cancellation is not evidence the provider did no work.
  - Trustworthy terminal provider error → `failed`; absent/truncated terminal response or post-send abort → `uncertain`.
  - Known no-dispatch cancellation after commit → `failed` with `cancelled_before_dispatch`, still counted.
  - Missing token counts and costs stay null. Persist provenance; never manufacture zero from the SDK catalog.
- **D7 — Wiring:** No HTTP route, import/enrichment job, scheduled retry, public-web fallback or chat action may call the unfinished adapters. P1–P7 introduce no provider traffic even on startup.
  - Later fixture dispatch requires P1–P6 gates first. Production automation remains gated by inherited NR-V11/NR-V15 and its owning workflow approvals.

### Acceptance refinements

These refine AC19–AC21 for this decomposition, not replace their broader requirements.

- **A1 — Upgrade:** Fresh migration and upgrade through `0004_feedback` work; legacy ownerless reservations become uncertain without deleting/recounting history or overwriting budgets/seeds. Readiness distinguishes old/latest schema.
- **A2 — Owner:** Dedicated ownership cannot survive disconnect/reconnect or backend identity reuse; cleanup does not return a still-owning session to a pool.
- **A3 — Admission:** Under parallel connections, committed credits cannot exceed a finite daily cap; active reservations cannot exceed a finite per-bucket concurrency cap. D1/D2/D4 hold at midnight and under settings changes.
- **A4 — Settlement:** Only the originating live owner can transition its reserved row once; usage validation and terminal immutability hold; counters never decrease.
- **A5 — Recovery:** Live owners survive sweeps; dead owners become uncertain once; stale settlement cannot overwrite recovery; repeated/concurrent sweeps preserve history/counters.
- **A6 — Gate:** Preflight denial/cancellation causes zero reservation/dispatch; post-commit failure follows D2/D6. Every invoked attempt has a committed reservation; auth failure prevents repeated later calls for the affected model configuration across roles.
- **A7 — Direct Pi:** Shared built-in-only runtime and fixed audited routes per C7, explicit physical model/capability validation, no hidden retries/discovery/fallback; validated bool/choice/score and text outcomes; honest nullable usage.
- **A8 — SDK:** Exact custom tool allowlist and resource isolation on create/resume; one admission per underlying stream invocation, including multi-tool continuation and explicit compaction; all terminal/abort paths settle or recover safely.
- **A9 — Operations:** Terminal-only built-in model selection and private persistent auth; no credential logging/UI; missing auth does not block reader/import; shutdown closes owners before pools; no startup DDL or automatic model dispatch.
- **A10 — Accounting evidence:** Loopback HTTP counters prove no unadmitted request and zero extra traffic on denial. Wire attempts equal dispatched reservations, **not all committed credits**: cancellation/crash between commit and send legitimately consumes credit with no wire request.
- **A11 — Status:** Package evidence names scope and unavailable checks. Foundation success is not NR-V11, C11, D2, live/provider or production acceptance.

### C1 — Contracts, migration and unsafe-writer retirement

- **New domain contracts:**
  - `ModelUsageBucket = 'automatic'|'interactive'|'classifier'`; reuse `ModelRole`/`ModelReference` from shared settings.
  - `ReservationIntent = { bucket, role, provider, model, taskId?: string, turnId?: string }`.
  - `UsageReservation = { id: string, ownerToken: string, bucket: ModelUsageBucket, dayUtc: string }`.
  - `AdmissionResult = { admitted: true, reservation } | { admitted: false, reason: 'daily_limit'|'concurrency_limit' }`.
  - `TerminalUsage` contains status from D6, nullable `inputTokens`, `outputTokens`, `costUsd`, provenance `tokensSource`/`costSource` (`provider|unknown`), and nullable sanitized `outcomeCode`.
  - Missing budget/schema, owner loss and database failure are errors, not budget denials. No `transcription` dispatch through this model boundary.
- **New port:** `UsageAdmissionPort` provides `withOwner(signal, action)`, `reserve(owner,intent)`, `settle(owner,reservation,terminal)` and `recover()`.
  - `UsageOwner` exposes only token and owner-loss signal; adapter privately binds it to its client. No PID/client or Pi types in the application contract.
  - `settle` returns `settled|already_terminal|ownership_lost`; duplicates never change persisted data. `recover` reports the number transitioned, not reconstructed consumption.
- **Schema extension:** Add to `usage_ledger`:
  - Nullable `owner_token uuid`, `owner_pid integer`, `owner_backend_start timestamptz` (Drizzle string mode), `settled_at timestamptz`, `outcome_code text`, `task_id text`, `turn_id text`, `cost_usd double precision`.
  - Non-null `tokens_source`, `cost_source`, default `unknown`; allowed values as above. Cost must be finite/nonnegative or null. Preserve existing token/audio validation.
  - Status check adds `uncertain`; owner tuple must be wholly null or wholly present with positive PID. A `reserved` row requires the full tuple and null `settled_at`.
  - Unique non-null owner tokens enforce at most one reservation per owner. Index reserved rows by bucket/ID for slot counts and recovery; retain the existing history index.
  - Historical terminal rows may lack ownership/settlement time. Do not fabricate original completion timestamps or provenance.
- **Migration order:** Expand status/columns → update every existing ownerless `reserved` to `uncertain` with `legacy_ownerless_reservation` and migration-time `settled_at` → install ownership/state checks/indexes.
  - Preserve all pre-existing values except this explicit state transition/diagnostic. Do not rebuild counters from ledger counts: historical storage calls were independent and may not match.
  - Generate/review the SQL and snapshot together, append the journal; never edit migrations 0000–0004. `0005_usage_admission` is proposed and requires recheck at execution start.
- **Retire** `UsageStore.record`, `updateEntry`, `incrementCounter` and their exported insert alias. Keep budget CRUD, `getEntry`, `getCounter`.
  - Existing callers found only in `tests/integration/enrichment.test.ts`; replace that test's arbitrary history/counter setup with explicit fixture SQL and retain persistence/validation assertions. New owned behavior is tested through C3–C5, not these removed primitives.
- **Readiness:** Update `buildHttpApp`'s schema version to the new journal entry's actual timestamp; retain mismatch 503 behavior. No runtime migration.
- **References:** A1/A11; V1/V11.

### C2 — Dedicated session lifecycle

- **New symbol:** `openUsageOwner(pool, signal)` / owned-session helper implementing the port's owner scope; follow `runImport`'s connection/error lifecycle, not its business logic.
- Checkout once, attach error listener, obtain full backend identity and set sanitized `application_name = feedrafter-usage:<owner UUID>` for test/operational identification.
- Heartbeat at the existing import pattern's five-second interval while idle; avoid overlapping heartbeat queries. A query/connection failure permanently invalidates the handle and aborts its owner-loss signal.
- Caller abort while awaiting checkout must release any subsequently acquired client without executing a reservation. Caller abort and database-owner loss are distinct signals: healthy-session cleanup may still settle after caller abort.
- Denied/unused owners can be cleanly released. After successful terminal settlement they can be released. An unresolved reservation or uncertain connection/commit state must destroy the client, not return it for reuse.
  - P2 has no reservation operation; C3/C4 attach this lifecycle state later. Never silently reconnect or reuse an owner token for another attempt.
- Clear heartbeat/listeners and reset session metadata before healthy release; failure during cleanup destroys the client. Always run cleanup on rejected actions.
- **References:** A2; V2.

### C3 — Atomic reservation only

- **New adapter:** `PostgresUsageAdmissionStore`; receive an owner pool and injected domain `Clock` (`src/server/domain/clock.ts`). Implement owner scope plus `reserve`; settlement/recovery remain unwired until their packages land.
  - P3/P4 expose only their implemented storage surface; declare conformance to the complete `UsageAdmissionPort` after P5. No placeholder successful/no-op settlement or recovery methods.
- **Transaction on the owner's client:**
  1. Require a valid, unused owner and validated intent; begin transaction.
  2. Lock its `budget_settings` row `FOR UPDATE`; fail closed if missing. Check caller/owner cancellation before mutation.
  3. Sample `Clock.now()` **after acquiring the bucket lock**. Derive UTC `YYYY-MM-DD`; persist that admission time as `occurred_at`. Do not use a timestamp captured before a midnight lock wait.
  4. Read/create that day's counter under the same lock; count all reserved rows for the bucket, with no date filter.
  5. Compare finite caps using `used >= limit`; skip only the comparisons whose limit is null. Daily denial takes precedence if both fail. On denial leave no new counter/ledger changes.
  6. Increment/create the counter and insert one owned reserved row; commit before returning an admitted handle.
- Settings edits serialize on the budget row; never read caps outside this transaction as authority. Ledger insertion failure rolls back the increment and any new counter row.
- Do not subtract stale-looking reservations or implement recovery opportunistically here. Until P5, dead reservations conservatively block admission.
- On commit acknowledgement loss, throw an uncertain-commit error, invalidate/destroy the owner and do not auto-retry. Recovery later handles a committed row if one exists.
- No provider callback, SDK import, production wiring or executable dispatch token escapes this package.
- **References:** A2/A3; V3.

### C4 — Terminal-once settlement

- Implement `settle` on the same adapter/client; reject foreign, invalidated or reused handles before writes.
- Lock handle bucket → select ledger row by ID **and bucket** for update → match owner token, exact backend identity and `status='reserved'` → write one validated terminal result and completion time.
  - Ownership/identity mismatch: `ownership_lost`; existing terminal row: `already_terminal` without overwriting even if the repeated payload differs.
  - Preserve admission/model/day/owner/correlation fields; release slot solely by leaving `reserved`. Do not modify any day's counters.
- Validate finite nonnegative cost and nonnegative integer token counts within the existing SQL integer range; preserve actual zero, keep unavailable values null. `provider` provenance requires the corresponding reported value; SDK catalog estimates are not provider-reported costs.
- A database error rolls back all usage/state changes. Never report successful settlement if commit is unknown. Destroy the owner on uncertain commit; no provider re-execution.
- Caller abort must not prohibit a healthy owner from making the bounded terminal cleanup write; lost owner must prohibit it.
- **References:** A2/A4; V4.

### C5 — Dead-owner recovery

- Implement `recover` using an injected ordinary recovery pool, not a provider's ownership client. Process fixed bucket order, one short transaction per bounded page (100 rows), budget lock first, then reserved rows in ID order.
  - Advance an ID keyset cursor past every inspected row, including live owners; otherwise the first live page could hide dead owners forever. A later pass covers newly inserted rows behind that cursor.
- Clear cached statistics snapshots before liveness probes; compare the full `(pid, backend_start)` against `pg_stat_activity` for the current database/application role.
  - Preserve a matching live session, regardless of reservation age or day.
  - Missing exact backend: conditional `reserved → uncertain`, `outcome_code='owner_lost'`, recovery-time `settled_at`; leave known usage/provenance and counters unchanged.
  - A visible PID with a different backend start is not the owner. A probe failure or inaccessible identity stops recovery/admission readiness, rather than reclaiming on uncertainty.
- Do not resume/re-send an orphan, refund it, clear its owner metadata, or rewrite a previously terminal row. Concurrent sweeps and settlement serialize through the same bucket lock.
- Startup and subsequent admission sweeps are composed in C6/C10; no timer/worker is introduced here.
- **References:** A5; V5.

### C6 — Application attempt gate

- **New symbol:** `UsageService.executeAttempt<T>(intent, scope, invoke): Promise<AttemptResult<T>>` using `UsageAdmissionPort`, not PostgreSQL or Pi imports.
  - `scope = { bucket: ModelUsageBucket, taskId?: string, turnId?: string, signal: AbortSignal }`; reject intent/scope bucket or correlation mismatches.
  - `AttemptResult<T>` is a discriminated union: `{ kind:'completed', value:T, reservationId:string }`, `{ kind:'paused_budget', reason:'daily_limit'|'concurrency_limit' }`, or `{ kind:'paused_auth' }`.
  - `invoke(combinedSignal)` returns a typed `{ value, terminal }`; the Pi adapters own response parsing and known-versus-uncertain outcome normalization. Only successfully settled `succeeded` outcomes produce `completed`; failed/uncertain attempts throw a sanitized typed attempt error carrying reservation ID, never an apparent successful value.
- Order: validate intent and shared auth-pause latch (caller already completed model/capability/context preflight) → check abort → recover dead owners → open owner → reserve → recheck abort/owner/auth pause → invoke **at most once** → settle → release owner.
  - Budget denial returns a typed paused/denied application outcome, not an invocation or sleep/retry loop.
  - Callback throw without a trustworthy terminal result settles uncertain. Known pre-invocation cancellation uses D6. Settlement failure propagates an accounting error; do not publish a model result as successfully accounted or invoke again.
  - If the owner dies, abort locally and ignore any late provider success; recovery owns that row. A healthy cleanup uses C4; unresolved cleanup destroys the owner for C5.
- **Auth pause:** One process-wide latch shared by direct calls and every session, keyed by physical provider/model; applies across task roles. Explicit auth/permission terminal errors latch the affected configuration before another subsequent attempt.
  - Already dispatched attempts may finish; do not cancel unrelated model configurations. Budget rollover does not clear auth pause. Repair requires explicit administrative recovery/restart as in NR-C11; no per-article auth probes or hidden fallback.
- Recovery is run before each attempted admission, covering owners lost after startup without a new scheduler. No busy wait when a live owner fills concurrency; caller gets a pause outcome for its later workflow to retain/wake.
- Unit/integration callbacks are synthetic. Do not connect C12 fallback, pg-boss jobs or routes.
- **References:** A6/A11; V6.

### C7 — Shared runtime and AI port, no requests

- Construct one application-owned shared runtime with `{ authPath:'/data/pi-auth/auth.json', modelsPath:null, allowModelNetwork:false, refreshOnCreate:false }`. Pi 1.4.0 selects its in-memory model store when `modelsPath:null`; do not supply `modelsStore`, `modelsStorePath` or `catalogBaseUrl`. No persisted custom provider/model catalog or endpoint configuration is read or written by serve or setup; pre-existing `models.json`/`catalog.json` are ignored, not migrated/deleted.
- Keep the mutable runtime, providers and model objects private behind the application boundary. Accept only a fixed, code-owned audited built-in provider/API/transport/endpoint route allowlist; a catalog model/API string alone does not prove implementation identity. No caller-supplied runtime/provider injection, endpoint overrides, ambient extensions or model/provider overlays; role mappings select eligible built-in physical models without defining routes.
- Preserve private credential storage and Pi auth resolution/ordinary OAuth refresh. Login and token refresh are auth traffic **outside inference accounting**: no inference credit/ledger row or inference dispatch permit is consumed by auth traffic, and auth must not dispatch a model completion. Serve construction performs no auth/network operation; setup may perform authorized login, not custom catalog/endpoint configuration.
- Define `AiPort.classify(request,scope)`, `generate(request,scope)`, `createRestrictedSession(options,scope)` returning application-owned values/handles, never SDK instances.
  - Classification request: model reference, role, JSON object state and keyed questions. Mirror Pi's bool/choice/score question structures as application types; no SDK imports in the port. Validate answer key/type matches, choice membership and finite probabilities/confidence 0–1 before success.
  - Score questions require at least two ordered criteria. Pi returns an expected level index in `0..criteria.length-1` (pinned `docs/codemode.md`); validate that native range and preserve the scale in the domain result. Do not mislabel a raw index as an article's 0–100 score. Conversion/persistence belongs to the later scoring caller, outside C11.
  - Generation request: model reference, role, application-owned system/user text; result has text and nullable normalized usage. No arbitrary caller-supplied provider options, retry counts, tools or fallback routing.
  - Restricted handle exposes prompt, abort, explicit compact and dispose; controlled session-storage references are adapter-owned. C24 will own application chat IDs and turn persistence.
- Physical capability lookup must succeed before reserve; classifiers always select `classifier` scope. Generative automatic/interactive scope is inherited from initiating work. Reject images/transcription/virtual routing/unmapped models here rather than enabling unaccounted paths.
- Runtime construction, capability lookup and missing-auth handling cause no model request. Reader/import stays available without credentials; affected work reports paused configuration/auth.
- **References:** A7; V7.

### C8 — Direct Pi requests

- **Status:** Direct classification and generation are implemented in `src/server/adapters/pi/classifier.ts`, `generator.ts`, `single-send-transport.ts` and `runtime.ts`, using the C6 admission gate. Focused loopback/usage tests and independent scoped review passed; see `docs/verification.md` for exact counts and limits. OAuth auth failures are sanitized and pause the physical model; successful OAuth refresh remains Pi-owned. API-key requests retain the 4096 output bound, but OAuth requests omit it and have no proven hard cap. P8's direct-adapter slice is complete locally; parent V11, V15, workflow wiring and activation remain incomplete. Passing existing suites does not close this gate.
- Implement the direct methods using C7's private shared runtime/audited built-in routes, C6 and explicit provider `maxRetries:0`; never call unrelated clients with extracted OAuth tokens.
- Bind the post-commit single-use dispatch permit to an app-owned **one-send inference transport**. Prevent HTTP 421 replay, redirect following and SDK/HTTP-layer retries or second dispatch under the same reservation; `maxRetries:0` alone is insufficient. Reject routes/transports without that guarantee before reservation. No inference activation until V8's transport proof exists; C9 must retain the same boundary.
- Inspect resolved `stopReason` and error fields as well as rejected promises. Normalize terminal outcome before C4; malformed answers fail the attempt without publishing partial success. Missing usage remains unknown.
- Each explicit caller retry, fallback, chunk or reduction is a new `executeAttempt` with a new owner/reservation. No loops/implicit fallback inside a single adapter invocation; validate any explicitly selected alternate model independently.
- Add loopback fake-provider HTTP fixtures for the pinned TypeSafe System One and chosen generative HTTP/SSE protocol. Count accepted HTTP requests below Pi, with barriers to inspect the committed ledger **before** a response is released.
  - Use fixture credentials and test-only transport interception of the audited built-in routes to loopback, not persisted/custom provider/model/endpoint configuration. No real provider/network catalog traffic; the fixture seam must not expose runtime mutation or production endpoint configuration. A mock runtime alone is insufficient evidence.
  - Required negative/boundary cases and wire-ledger assertions are centralized in V7–V8 below. Count auth refresh separately under C7's auth boundary; preserving OAuth refresh is not permission for an unadmitted inference request.
- **References:** A7/A10; V8.

### C9 — Restricted SDK stream boundary

- Create/resume with shared runtime, existing empty resource loader, dedicated app-owned agent directory, in-memory settings and exact named custom tool allowlist; no pattern wildcards/additive names.
  - `cacheWarming:'off'`, `compaction.enabled:false`, agent retry disabled, provider maxRetries zero and HTTP/SSE transport where supported.
  - In-memory extraction sessions; only explicitly controlled file sessions in fixture resume/C24 integration. No personal/project discovery or default filesystem/shell/codemode/MCP tools.
  - Verify active tool names exactly after creation/resume. `tools:[]` is correct only when no custom tools are intended.
- Capture the newly created session's public `agent.streamFunction`, then replace it **before any prompt/compact** with an admitted stream bridge using C6.
  - One invocation = one reservation, not one user prompt or tool turn. Forward every underlying event and preserve the SDK stream/result contract.
  - Terminal/error/abort/consumer abandonment must settle once or invalidate the owner for recovery. Early consumer exit cannot leak a live reserved row or silently run an unobserved continuation.
  - Explicit compaction must use this same boundary. Do not call lower-level compaction without the wrapped stream. Disable automatic summaries/retries; do not expose raw session/model mutation operations that bypass validation.
  - Restore applies all controls again and rejects SDK model fallback rather than silently changing configured model.
- Scope is request fencing, not C24's durable turn/session append protocol or chat API. Those remain separate callers of this boundary.
- **References:** A8/A10; V9.

### C10 — Administrative setup and lifecycle

- Extend current `main.ts` command parser to accept `setup-ai` as an administrative terminal flow, separate from `serve` and `migrate`; do not create the reader app or start workers to log in.
- Use `runtime.login(providerId,authType,interaction)`. Show browser URL/code only in that setup terminal; support pasted redirect/code fallback according to the provider's actual methods. Do not promise a device-code flow without SDK support.
- List only built-in generative models eligible under C7's fixed audited route allowlist and require explicit validated selection; persist role mappings, not provider/model catalogs or endpoints. Preserve existing mappings/user edits and `typesafe/jev-latest`; out-of-allowlist mappings stay stored but report paused configuration, with no automatic substitution. No guessed Codex ID or default fallback. Cancelled/failed setup does not overwrite a working mapping.
- Keep config validation command-appropriate: setup must not require a running HTTP server/FreshRSS; database access is needed only to persist selected role mappings. Missing writable private paths is a setup diagnostic, not leaked credentials.
- In composition, use a separate usage-owner pool so held provider ownership clients cannot exhaust the reader/import pool. Pool backpressure is a resource constraint, not an invented budget cap when concurrency is null.
  - Run recovery before exposing the internal AI boundary; do not call any model at startup. Missing credentials leave the boundary paused, not reader readiness failed.
  - On shutdown stop new admissions, abort active attempts, perform bounded healthy-session cleanup, destroy unresolved owners, then close owner pool and existing application resources. Failed cleanup remains recoverable.
- Update compose/env/operations for private writable `/data/pi-auth/auth.json` ownership, `TYPESAFE_API_KEY`/secret handling, interactive container command, external re-login restart requirement and auth backup inclusion. Existing `/data` mount already persists auth; no personal Pi mount/new callback service, persisted catalog or custom endpoint settings. Ordinary OAuth refresh remains supported under C7's auth boundary.
- The HTTP/job graph remains AI-inactive. This package composes a capability, not automatic enrichment or an activation flag that bypasses NR gates.
- **References:** A9; V10.

### C11 — Accounting matrix and accurate evidence

- Extend package-local tests with cross-path combinations in the parent plan's proposed `tests/integration/budgets.test.ts`. Reuse the fake provider/DB helper; do not create another accounting implementation.
- Add guarded live test using the existing `tests/live/safety.ts` conventions for isolated authorization; normal suites must never contact live Pi/providers.
- Record commands, runtime versions, actual counts and unavailable checks in `docs/verification.md` after each implemented package, not as a single completion assertion at the end.
- This document does not mark inherited checks complete. See V11 and readiness below.
- **References:** A10/A11; V11.

## Verification

- **Strategy:** PostgreSQL tests prove locking, rollback, migration and backend death; application tests prove call sequencing; actual loopback provider HTTP/SSE proves Pi cannot hide attempts. No live call needed for foundation.
- **Current verification status:** The historical planning-only statement is superseded. Local checks have now run for P1–P8 slices; see `docs/verification.md` for commands, runtimes, counts, reviews and limitations. P9–P11 and parent V11/V15 remain incomplete, and no V gate or C11 acceptance is declared complete here. No live provider request or production activation was performed.
- **Prerequisites:** Node 24.21.0 with current lockfile installation; Docker daemon and locally cached `postgres:18` image for new integration suites. Follow `tests/integration/enrichment.test.ts`'s `--pull=never`, random container name, loopback ephemeral port, disposable `feedrafter_test`, bounded readiness and unconditional cleanup.
  - `tests/helpers/usage-database.ts` is a narrow shared version of that fixture for these suites; no external `DATABASE_URL` accepted, no implicit image pull and no skipped acceptance on missing Docker.
  - Exact focused commands use the Vitest executable: existing `test:integration` script already includes both test directories, so appending a file to that script is not a reliable exclusive file filter.

| ID | Changes / criteria | Procedure / command (repository root) | Expected signal |
| --- | --- | --- | --- |
| V1 | C1 / A1 | `npm exec -- vitest run tests/integration/usage-migrations.test.ts tests/integration/enrichment.test.ts` | Fresh/upgrade/second-run migration, legacy preservation and schema readiness cases below pass. |
| V2 | C2 / A2 | `npm exec -- vitest run tests/integration/usage-owner.test.ts` | Dedicated identity, disconnect and cleanup cases pass without provider calls. |
| V3 | C3 / A2–A3 | `npm exec -- vitest run tests/integration/usage-reservations.test.ts` | Contended daily/slot boundaries and rollback/unknown-commit cases pass. |
| V4 | C4 / A4 | `npm exec -- vitest run tests/integration/usage-settlement.test.ts` | One terminal transition; no stale writer/refund/partial usage write. |
| V5 | C5 / A5 | `npm exec -- vitest run tests/integration/usage-recovery.test.ts` | Only dead backend reservations become uncertain; races preserve counters/history. |
| V6 | C6 / A6 | `npm exec -- vitest run tests/unit/usage.test.ts tests/integration/usage-gate.test.ts` | Callback ordering/count and cleanup states match every boundary below. |
| V7 | C7 / A7 | `npm exec -- vitest run tests/unit/pi-runtime.test.ts` | One private shared built-in-only runtime, private auth/in-memory catalog, no overlays/endpoint configuration/discovery/network and preflight failures. |
| V8 | C8 / A7,A10 | `npm exec -- vitest run tests/unit/pi-requests.test.ts tests/integration/pi-requests.test.ts` | One-send 421/redirect/retry/denial/stream matrix and wire-ledger correlation below pass; no unadmitted or repeated inference send. |
| V9 | C9 / A8,A10 | `npm exec -- vitest run tests/unit/pi-resource-loader.test.ts tests/integration/pi-sessions.test.ts` | Exact tools/resources, admitted multi-turn/compaction/resume and stream cleanup pass. |
| V10 | C10 / A9 | `npm exec -- vitest run tests/unit/setup-ai.test.ts tests/unit/ai-lifecycle.test.ts tests/unit/config.test.ts` | Terminal isolation, no-secret logs, authless startup and shutdown/recovery composition pass. |
| V11 | All / A10–A11 | `npm exec -- vitest run tests/integration/budgets.test.ts`; then `npm run test:unit`, `npm run test:integration`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm exec -- drizzle-kit check` | Package and regression checks pass; evidence explicitly retains inherited open gates. |

### Required cases

- **V1:**
  - Empty DB → all migrations; DB explicitly migrated through 0004 → new migration; second migrator run → no further changes.
  - Old reserved/succeeded/failed rows across dates with known and null usage; deliberately nonmatching historic counters; edited budgets/model mappings/seeds. Only reserved status/diagnostic/settlement time changes; counts/IDs/history remain exact.
  - Constraints reject ownerless/partial-owner reserved rows, duplicate owner token, invalid status and nonfinite/negative amounts; historical ownerless terminal rows remain valid.
  - Readiness 503 before latest migration, 200 after, 503 on incompatible journal. Migration itself performs no dispatch/jobs.
- **V2:**
  - Distinct owners use distinct checked-out sessions/tokens, preserve exact SQL timestamp identity, clean up on thrown actions and cancellation during checkout.
  - Terminate only the fixture-owned backend via another disposable connection; owner signal aborts, operations cannot reconnect, dead client never returns to pool.
  - Heartbeats/listeners stop on all exits; denied/unused owners leave no idle leaked session. Metadata reset failure destroys instead of reuses.
- **V3:**
  - Two or more separate clients contend for one remaining credit with concurrency unlimited → exactly one admission; one slot with daily unlimited → exactly one admission. Hold owner scopes open with barriers until slot assertions finish; scope cleanup would otherwise kill owners and change the condition. Verify rows/counters, not just returned values.
  - Independent buckets can admit concurrently. Null/null permits multiple reservations, zero daily or zero concurrency denies without creating consumption; exact boundary `used == cap` denies.
  - Yesterday's live reservation blocks today's same-bucket slot; does not consume today's daily credit. Completion later does not edit today's counter.
  - Hold budget row over midnight, advance injected clock, release → admission belongs to new UTC day. Sample-after-lock behavior is asserted, including non-UTC input offsets.
  - Budget increase allows next reservation; decrease below active/used counts denies new work without cancelling/refunding old work.
  - Insert/constraint failure after attempted increment → both ledger and counter mutation roll back. Missing budget fails closed.
  - Test-only query wrapper loses acknowledgement after a real COMMIT → no admitted handle/dispatch, committed row remains counted until recovery. Loss before commit → rollback. Never expose production failure hooks.
- **V4:**
  - Success, known error, uncertain and cancelled-before-send all leave one terminal row and unchanged original-day counter; null usage remains null, actual zero remains zero.
  - Wrong token/bucket/identity, another live client, dead owner and malformed usage cannot mutate row; duplicate identical or conflicting terminal payload never overwrites first terminal data.
  - Validation/SQL failure rolls back status and usage together. UTC rollover settlement leaves admission day intact. Releasing one row frees exactly its bucket's slot.
- **V5:**
  - Old but live owner retained; fixture backend terminated after reserve → uncertain and local slot reusable, original-day counter/history intact.
  - Simulate mismatched backend-start identity at the same visible PID; prove PID alone cannot preserve/reclaim the wrong owner. No need to wait for OS PID reuse.
  - Two recoverers; recovery versus settlement; second sweep; late success after death; mixed live/dead rows in different days/buckets. Exactly one terminal winner; no negative count, refund or overwrite.
  - Failed/inaccessible liveness probe → explicit error, no reclaims. Known token values on orphan remain unchanged. Legacy ownerless data is handled by V1, not redispatched by recovery.
- **V6:**
  - Abort/preflight/auth denial before reserve → zero callback/credit. Reservation rollback/unknown commit → zero callback.
  - Abort after successful commit before invoke → zero callback, one counted terminal attempt. Provider throw/truncated outcome/after-send abort → uncertain; trustworthy error → failed.
  - Success resolves only after settlement; settlement error never invokes provider twice or publishes an accounted success. Owner death ignores late callback success and sweeps uncertain.
  - One auth failure pauses the same provider/model in other roles, with no subsequent reservations/traffic; unrelated model remains eligible. Explicit repair/restart recovery only, not day rollover.
- **V7–V8:**
  - V7: assert C7's exact runtime options and in-memory store; hostile/stale private or ambient `models.json`/catalog/extension overlays cannot change built-in model/provider/endpoint identity. No catalog/config file reads/writes or mutable runtime/provider/model handles exposed to callers; out-of-allowlist routes fail before reserve/send.
  - Wrong model kind, missing mapping/auth, invalid context/response keys, unconfigured fallback and unsupported virtual model fail before send; classifier bucket cannot be overridden to interactive/automatic.
  - TypeSafe bool/choice/score valid/invalid results, including native score endpoints/fractional midpoint/out-of-range indices for a known criteria count; gen text success/error/aborted stop reasons; resolved-error responses; missing tokens/catalog-zero cost remains unknown.
  - V8: real loopback HTTP 421, redirects (including a counted destination listener), 429/5xx, invalid JSON and response loss each produce at most one inference wire request under a reservation; zero replay/redirect-destination/hidden retry traffic. A second dispatch using the same permit is rejected without wire traffic. Later explicit fallback/retry needs a new ledger row and current cap.
  - V8: daily/concurrency/auth/preflight denial produces zero additional inference requests; held responses expose an already-committed matching reserved row before any response is released. Correlate every accepted inference request to a unique ledger row and assert terminal/counter state, not runtime-call counts; retain A10's documented counted zero-wire exceptions.
  - V8: generation HTTP/SSE success, resolved error, abort, truncated stream, `.result()` consumption and early consumer return preserve ordered events and settle once or leave a recoverable dead owner; no stream reconnect/retry/continuation under the same permit. Exercise fixture OAuth refresh separately: credentials remain private/preserved, auth traffic consumes no inference credit/permit, and every subsequent inference send still requires its own admitted permit.
- **V9:**
  - Hostile working-directory `.pi`/AGENTS/resources ignored; exact custom tools survive create/resume, default tools absent; disallowed tool calls cannot run.
  - User prompt → tool call → continuation uses two admissions and two HTTP requests; exhausted cap between them blocks the second request without losing the completed first ledger entry.
  - Explicit compaction and fixture file-session restore use the same admitted stream; assert warming/auto-retry/auto-compaction produce no background requests.
  - Error/abort/truncated stream, `.result()` consumption, early iterator return and disposed session each terminate accounting once or produce a recoverable dead owner. Forwarded events remain ordered/unmodified.
- **V10:**
  - Fake interactive login URL/pasted-code flow, unsupported device flow, cancellation and failed mapping update; no secret/code appears in normal server logs or returned HTTP data.
  - Setup lists/selects only eligible built-ins and preserves role mappings/auth without creating or consuming persisted custom provider/model catalogs or endpoint settings; rejected/out-of-allowlist selections do not overwrite mappings. Private auth persistence/restart behavior remains required; refresh follows C7, not inference accounting.
  - Missing credentials leaves reader/import boot usable with zero provider calls; recovery precedes exposing internal AI service; unhealthy recovery prevents that capability but must not silently dispatch.
  - Shutdown during provider wait aborts/settles-or-destroys owners before pool close; restart sweeps unresolved reservations. Setup starts no HTTP/import worker or startup DDL.
- **V11:**
  - Combine concurrent direct classifier/generation and SDK attempts, day rollover/in-flight old-day completion, cancellation before/after commit/send, backend death with unknown usage, auth pause/recovery, explicit fallback/chunk/reduction stand-ins, multi-tool turn, compaction and restored fixture session.
  - Assert A10 by matching observed HTTP requests to unique already-committed ledger rows; allow counted zero-wire reservations only for documented pre-send failure boundaries. Exhaustion produces zero additional traffic.
  - Search source imports/calls: no production path calls `runtime.classify`, generation/stream methods or creates sessions outside the admitted Pi adapter/setup boundary; no removed usage writer bypass remains. Setup login is auth, not a model completion.
  - Re-run API/reader regressions as part of integration suite, including `tests/integration/mail.test.ts` readiness. Run E2E after build only if lifecycle/UI-serving regressions require it; not a substitute for accounting tests.

### Inherited gates still required

- **Foundational admission:** P1–P6 + V1–V6 prove a reusable request gate with no production provider wiring. This is only part of AC20/AC21 and NR-V11.
- **C11 fixture accounting:** P7–P11 + V7–V11 prove the selected pinned direct/SDK boundaries. They do not implement C13/C14/C21/C24 callers, budget-pause persistence/fair wakeups, durable chat turn restore or the broader D2 pipeline.
- **Full NR-V11:** Requires these proofs plus the real originating workflows as they land; stand-ins do not prove actual fallback/context/summary/chat integration. Keep inherited check partial until those integration paths have wire-count evidence.
- **NR-V15:** Still requires authorized isolated built-container OAuth persistence/refresh and real JEV bool/choice/score. Proposed command: `RUN_LIVE_PI=1 npm run test:live -- tests/live/pi.live.test.ts`, with operator cost/data-disclosure authorization and isolated credentials.
  - Never run in ordinary CI. Missing credentials, exact generative model choice, container access or authorization are unavailable live evidence, not passed/skipped acceptance.
- **Production activation:** Remains separately approved and subject to the parent delivery gates. Planning/package completion grants no activation rights.

## Delivery and integration

- **Execution:** One executor at a time in `/home/matthias/feedrafter`; shared-workspace source writes are serial. No subagent/runtime selection or parallel writer requirement.
- **Transfer:** Each package's code remains in the canonical working tree; its evidence is appended under a clearly named package heading in `docs/verification.md`. A dependent checks the actual predecessor code/tests, not a completion message alone.
- **Review base:** Preserve the working-tree baseline described in Basis. Do not reset to the old commit or overwrite other pending source work. No commits/merges/pushes authorized by this plan; isolated-worktree transfer would require a separate coordinator decision and explicit patch/merge permission.
- **Integration order:** P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11. Hard prerequisites below distinguish contract/code dependencies from the requested serial rollout.
- **Package exit:** Applicable focused check plus typecheck/lint and predecessor checks stay green; record actual unavailable gates. A material failure requires diagnosis and a bounded rerun before continuing, not a new repair package per artifact.

| Package | Independently reviewable result | Changes | Criteria / checks | Hard prerequisites | Dispatch posture |
| --- | --- | --- | --- | --- | --- |
| P1 — Upgrade contract | Owned ledger shape; conservative legacy upgrade; no unsafe writer API | C1 | A1,A11 / V1 | Existing C10 schema | No dispatch code |
| P2 — Owner lifecycle | Dedicated backend identity and reliable invalidation/cleanup | C2 | A2 / V2 | P1 owner contract | No reservation/dispatch |
| P3 — Durable reserve | Atomic credit/slot decision, including midnight and rollback | C3 | A2–A3 / V3 | P1,P2 | Storage only; never invoke provider |
| P4 — Fenced settle | Immutable terminal accounting from the same owner | C4 | A4 / V4 | P3 handles/lock protocol | Storage only |
| P5 — Dead-owner recovery | Safe orphan cleanup and stale-writer exclusion | C5 | A5 / V5 | P4 terminal protocol | Storage only |
| P6 — Admission gate | Single application attempt lifecycle and auth pause | C6 | A6,A11 / V6 | P3–P5 all passed | Synthetic callbacks only; foundation milestone |
| P7 — Runtime contract | Shared restricted runtime and domain AI interface | C7 | A7 / V7 | P6 service contract | Construction/preflight only |
| P8 — Direct requests | Admitted direct classification/generation with wire proof | C8 | A7,A10 / V8 | P7 and complete P6 | Loopback fixtures only |
| P9 — SDK requests | Restricted create/resume and per-stream accounting | C9 | A8,A10 / V9 | P8 stream/usage normalization | Loopback fixtures only |
| P10 — Operational composition | Terminal setup, private paths, startup/recovery/shutdown | C10 | A9 / V10 | P7–P9 complete adapter surface | No production callers/actions enabled |
| P11 — C11 accounting proof | Cross-path matrix and honest inherited gate report | C11 | A10–A11 / V11 | P10 integrated lifecycle | No activation; live check separately authorized |

## Readiness and open decisions

- **Plan readiness:** Built-in-only material C7/C10 scope amendment approved by the user; no remaining decision on persisted catalog/custom endpoint support. P8's direct-adapter slice and its loopback proof are now implemented, but P9–P11, parent V11/V15 and workflow wiring remain open. Package/implementation acceptance and inference activation are not granted.
- **Recommended next C11 package:** P9, after confirming its session boundary can reuse the proven P8 transport; then P10 and P11 in dependency order. This recommendation does not authorize inference activation or alter the broader D2 priority.
- **Foundational policy gaps:** None identified beyond the confirmed policies recorded in D1–D6. Do not reopen them implicitly during implementation.
- **Execution evidence limits:** Git status and `git diff --check` were inspected for this plan update. Node/Docker were not rerun here; use the dated evidence in `docs/verification.md` and recheck environment-specific prerequisites before the next package. Live provider/OAuth evidence and target-host gates remain outstanding.
- **Downstream operator decisions/evidence:** Exact built-in generative model/role mappings and authorized isolated OAuth/provider proof remain outstanding for NR-V15; no guessed model/cost consent. They do not block foundation or fake-provider packages.
- **Stop/report rule:** Any material policy gap, missing prerequisite, contradictory repository state or provider request bypass returns `needs_input` to the coordinator. No interactive prompt, replacement design, policy invention or automatic workflow advance.
