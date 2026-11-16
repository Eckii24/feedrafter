# Agentic News Reader — Implementation Plan

## Overview

- **Outcome:** Deliver the documented first release as eight independently verifiable increments in one shared plan.
- **Scope approved:** The user now authorizes implementation of D1–D8 end to end against the existing AC1–AC21 and V1–V25 gates. This task updates the plan only; it implements no source.
- **Authorization boundary:** No deployment, commit, merge, push, publication or tracker creation. External mutations/provider calls and media/model downloads still need the isolated consent and prerequisites below; implementation authorization is not production activation.
- **Architecture:** One TypeScript/Node application process and image; React/Vite UI, Fastify API, PostgreSQL, Drizzle, pg-boss, and Pi. No additional queue, reverse proxy, search service, or agent runtime.
- **Key decisions:**
  - Start with safe import and a minimal reader; add ranking without coupling import completion to model work.
  - Admit every model request through PostgreSQL budgets; disable hidden provider retries and cache warming.
  - Use no-key DuckDuckGo HTML search with Bing RSS fallback, following the inspected personal extension without loading it.
  - Preserve successful results during retries; expose missing, stale, partial, paused, and failed work explicitly.
  - Adopt C1's explicitly user-approved Pi dependency/root-override exception after isolated compatibility evaluation; this enables C11 continuation, not completion or production approval.
- **Unchanged / excluded:** Existing FreshRSS favorites/digest workflow; no mail sender, public login, semantic/URL deduplication, score-based hiding, offline article storage, browser-based extraction, or generic plugin framework.
- **Material risks:** Real FreshRSS/Karakeep behavior, container OAuth, SDK request accounting, media egress, and target-host video capacity require isolated proofs.
  - Failed gates stop the affected delivery; no silent fallback, weaker security boundary, paid transcription, or relaxed four-hour target.

## Current status snapshot — 2026-11-02

Based on the current dirty working tree and `docs/verification.md`, not a fresh full-plan rerun. This is implementation tracking, not user acceptance. Local package reviews and fixture tests do not mark a D delivery or V gate accepted.

| Change IDs | Status | Completed locally | Still missing / open |
| --- | --- | --- | --- |
| C1–C9 | Implemented foundation; D1 partial/locally usable | Toolchain, reader/import foundation, local UI/API, migrations, container operations test, mail/Karakeep/preference UI additions. | D1 acceptance: live FreshRSS/digest/ack compatibility (V5), physical PWA/proxy check (V8), and current-tree restore/target-host gate (V9) remain. Do not treat older container test as post-latest-migration proof. |
| C10 | Data/config foundation, not full D2 | Enrichment schema/seeds, catalogs, model-role/score settings foundations, content/score storage. | Automated quality→category→tags→scores pipeline and full-chain reevaluation absent; V10 not met. |
| C11 | Partial, direct path only | Admission ledger/owner/reservation/settlement/recovery/gate; shared private built-in-only Pi runtime; direct TypeSafe classifier/OpenAI generation with single-send transport, auth handling, token provenance, terminal/EOF checks. Offline restricted session construction exists but prompt/compact remain fail-closed. | Admitted SDK sessions/compaction (P9), setup/lifecycle (P10), cross-path accounting matrix (P11/V11), live OAuth/JEV V15, and workflow wiring remain absent. No inference activation. OAuth generation has no hard output-token cap; 4096 applies only when Pi sends the field. |
| C12 | Partial | SSRF-conscious preparation and fenced publication; persisted exact-host/source permissions, API and management UI; preparation candidate enforces per-article-source permission when its adapter is supplied. | Production restricted fallback, queue/workflow wiring, AI, typed pause/recovery and complete V12/V14 remain; C12/D2 are not accepted. |
| C13 | Planner, storage, direct scores and chunk evidence subset | Direct/chunk planner; plan-scoped atomic evidence/checkpoints; direct score candidate, oversized score evidence and one fail-closed pre-dispatch repair marker. | Hierarchical reduction, final classification, workflow pause/resume and fenced publication remain; V13 not met. |
| C14 | Partial storage/admin plus explicit direct-score reevaluation workflow | Manual taxonomy assignment, score sorting/display, score definition/override foundations, and atomic candidate publishers for category, tags and direct scores, fenced by task ownership/prerequisite/generation/target, content/assignment revisions, active definition and catalog epoch. Explicit reevaluation API atomically admits fresh generations/jobs for active definitions; article detail exposes this action and authoritative task status, and a pg-boss worker executes stored inputs through the direct-only score runner. Normal composition registers this worker with no model capabilities and a fail-closed AI stub; migration explicitly provisions its queue. A read-only article score-results API and detail display show saved results, basis freshness, limitations and latest task separately from reevaluation. | Category/tag workflow and successor enqueue, full import→prepare→category→tags→scores chain, automatic admission/backfill, startup recovery, C13 reduction, and complete V10 remain absent. This direct-score slice does not accept C14/D2. |
| C15 | Partial administration | Catalog, score/category-prompt, manual assignment and preference UI/API slices; saved score results and explicit reevaluation with per-task status in article detail. | Full AI/limits/content/summary settings, retry/processing diagnostics, production score execution and complete enrichment UI remain. |
| C16 | Partial tests | Fake/local unit, PostgreSQL, loopback and E2E coverage for delivered slices. | Full V10–V15 matrix, live Pi proof and all context/recovery/egress cases remain. |
| C17–C18 | Partial D3 implementation | Targeted voting, preference search/sort/offset/half-life administration and atomic tag merge are implemented with scoped tests/reviews. | D2 score-context integration, full V16 and broader stale asynchronous classifier/assignment publication fencing remain; D3 is not accepted. |
| C19–C20 | Partial C19 domain helpers | Pure DE/EN subtitle-track selection, strict-subset WebVTT parsing and timestamped cue normalization with tests; unwired. | Subtitle acquisition, media/transcription pipeline, egress enforcement, recovery, persistence, benchmark and capacity evidence. |
| C21 | Partial saved-summary and unwired count-only slices | Direct-only summary candidate, fenced last-success persistence, C22 queue projection, read-only API and reader display; separately admitted API-key-only Responses input-token counter. No summary generation or counter dispatch is wired into the app. | Count is not a fit decision or generation usage; provider acceptance and generation-usage parity are unverified. Explicit generation/regeneration task/API and UI, verified sizing/output cap, settings, C13 integration and V20 remain. See `docs/verification.md`. |
| C22 | Local feature implemented | Mail queue selection/ack contract, API/UI and local tests, including mixed outcomes, lock-ordered races, sent UI, and C21 saved-summary projection; app sends no mail. | D4 transcript projection and tests, external consumer compatibility and V21/full acceptance remain open. |
| C23 | Local feature implemented | Explicit original-URL Karakeep task/client/UI with bounded uncertainty handling; scoped tests/review passed. | Deployed API/schema compatibility and authorized live V22 remain open. |
| C24 | Partial search adapter only | Unwired no-key DDG HTML/Bing RSS adapter through pinned public web, with offline fixtures. | Controlled persisted chat/session/tool/restore workflow, tool wiring and acceptance gates remain. |
| C25 | Partial | Verification evidence and API/operations docs updated incrementally. | Full API/restore/PWA/acceptance documentation and V25 remain. |

| Delivery | Current status | Main outstanding gates |
| --- | --- | --- |
| D1 Safe reader | Local implementation substantially present; **not accepted** | V5 FreshRSS/digest, physical/proxy V8, deployed/target-host and operator restore V9; current-tree local container restore passed. |
| D2 Ranked text reader | **Incomplete** | C12/C13 and the remaining C14 quality/category/tag/import chain, safe startup recovery, V10–V15, V25. Direct-score reevaluation API/worker and saved-result/status UI are implemented but dormant and not production inference activation. |
| D3 Personal preferences | **Partial** | D2 integration, remaining asynchronous publication fencing and full V16. |
| D4 Automatic videos | **Partial foundation only** | Wired media/transcription pipeline, C20, V17–V19 and measured target capacity. |
| D5 Summaries | **Partial** | Explicit generation/regeneration workflow, verified direct-request sizing, settings, C13 integration, V20 and D2/C11 prerequisites. |
| D6 Mail queue | Local contract and saved-summary projection implemented; **not full acceptance** | D4 transcript projection and V21 external consumer compatibility evidence. |
| D7 Karakeep action | Local implementation; **not full acceptance** | Live/deployed compatibility V22. |
| D8 Pi chat | **Partial search adapter only; not accepted** | Chat/session/tools and restore, C24, P9–P11, V11/V14/V23/V24. |

**Historical verification checkpoint (before the latest score workflow/UI changes):** Local Node 24.21.0 full unit (638 tests), integration/API (342), and E2E (38) suites passed, along with typecheck, lint, build, Drizzle check and whitespace checks. Later slices have focused verification recorded in `docs/verification.md`; this is not a claim that those full suites were rerun on the current tree. Deterministic local results do not establish live provider/FreshRSS/Karakeep/mail compatibility, physical device/proxy behavior, target-host deployment/restore, or media capacity. V1–V25 remain acceptance gates; none is declared fully satisfied here.

## Execution basis for the authorized continuation

- **Coordinator Git evidence:** `master` at `843452b`; about 30 modified tracked files plus many untracked files, including C11/C17/C23 work. Supplied evidence, not a fresh Git inspection by this planner.
- **Inspection evidence:** Current `package.json`, source/test inventory, composition, task/import/content/score/catalog/mail stores, Pi port/runtime/resource loader, and the cited verification sections were read. No commands, tests, service calls or runtime probes were run for this plan update.
- **Preserve the starting tree:** Before implementation, perform V0. Treat tracked, staged and untracked work as the baseline, including unfinished slices; do not reset, clean, stash, checkout old files, regenerate existing migrations, or overwrite it with the original scaffolding design.
  - Extend existing behavior in place. An overlapping user edit with unclear intent is a `needs_input` boundary, not permission to discard it.
  - Serialize writers in this checkout. No worktree/branch transfer or commit permission is assumed.
- **Current path authority:** The table below supersedes original proposed scaffolding paths. HTTP currently lives in `src/server/http/app.ts`; UI in `src/web/*.tsx`; queue adapters in `src/server/adapters/postgres`. Do not reorganize the repository merely to match historical names.
- **Readiness:** Local implementation and deterministic tests can proceed for all D1–D8 in dependency order. Full acceptance remains blocked by external evidence in the final gate register. A predecessor's working capability is a code prerequisite; its unavailable live/physical gate is not a blanket stop on downstream fixture-backed implementation.
- **Source authority:** Historical “Keine Implementierungsfreigabe” / “no implementation authorized” statements in source docs describe planning time. The current user instruction supersedes only that authorization status, not product behavior or acceptance.
- **ID namespaces:** C/V/D in this document are canonical. P9–P11 and their local C/V IDs refer only to `.ai/c11-admission-plan.md`; its NR-V11/NR-V15 mean this document's V11/V15.

## Planned changes

- Existing paths are modified, not recreated. Explicitly new paths below are proposals verified absent during inspection.
- Brace notation lists related files. New schema changes require new ordered SQL plus Drizzle journal/snapshot entries after existing `0006_tag_merge`; inspect the actual journal before numbering.
- No source removals or general layout refactor planned. Shared files extend incrementally; unproven external capabilities remain disabled.

| ID | File / area | Planned change and purpose |
| --- | --- | --- |
| C1 | `package{,-lock}.json`, `.node-version`, `.npmrc`, `tsconfig{,.build,.web}.json`, `eslint.config.js`, `vite.config.ts`, `vitest.live.config.ts`, `playwright.config.ts` (existing) | Preserve approved pins/policy and working builds; complete only required missing scripts/dependencies as later features land. |
| C2 | `src/server/{main,composition-root,config}.ts`, `src/server/domain/clock.ts` (modify); feature-owned application/port/shared DTO modules (new in C11–C24) | Extend command-aware bootstrap, injected application boundaries and validated feature contracts without framework/SDK leakage. |
| C3 | `src/server/adapters/postgres/{client,migrate,import-store,reader-store,task-store}.ts`, `src/server/adapters/postgres/schema/{index,import,processing}.ts`, `drizzle.config.ts` (modify); new ordered migrations | Preserve identity/read/ack data; add task prerequisite, generation, target and publication state needed by delivered features. |
| C4 | `src/server/application/scan-unread.ts`, `src/server/ports/{unit-of-work,task-queue,freshrss}.ts`, `src/server/adapters/postgres/{import-jobs,import-runner}.ts` (modify) | Extend existing coordinator with atomic per-new-article enqueue, durable recovery and independent processing queues. |
| C5 | `src/server/adapters/freshrss/{client,schemas,acknowledgement-protocol}.ts`, `tests/live/{freshrss.live.test,safety}.ts` (modify) | Complete isolated exact-ID mutation/reconciliation proof; keep operational acknowledgement disabled until V5/digest approval. |
| C6 | `src/server/http/app.ts`, `src/server/adapters/postgres/{reader-query,reader-store}.ts` (modify) | Extend current schemas/routes, full-content detail, category/status filters, Signal default, generalized task progress/retry, security and SSE. |
| C7 | `src/web/{App,main,ArticleCatalog,FeedbackPicker,CatalogSettings,ScoreSettings,PreferenceSettings}.tsx`, `src/web/{api.ts,style.css}`, `index.html`, `vite.config.ts` (generated PWA manifest/service worker), `public/{icon-192.png,icon-512.png,icon.svg}` (existing); minimal feature UI additions in C15/C19/C21/C24 | Preserve reader/catalog/preferences flows; add feature actions and diagnostics with responsive, accessible, online-only behavior. |
| C8 | `Dockerfile`, `.dockerignore`, `compose{,.test}.yaml`, `.env.example`, `.github/workflows/ci.yml`, `README.md`, `docs/operations.md` (modify) | Extend one non-root image, explicit migrations/setup, private Pi paths, bounded media resources and matched restore instructions; no deployment. |
| C9 | `tests/unit/{config,freshrss,scan-unread}.test.ts`, `tests/integration/{postgres,import-jobs}.test.ts`, `tests/api/security.test.ts`, `tests/e2e/{reader,server-reader}.spec.ts`, `tests/container/operations.sh` (modify); `tests/e2e/pwa.spec.ts` (new) | Revalidate foundation and latest migrations; fill transactional/recovery/security/PWA cases using current fixture patterns. |
| C10 | `src/shared/{settings,taxonomy,scores}.ts`, `src/server/adapters/postgres/schema/enrichment.ts`, `{catalog-store,content-store,score-store,usage-store}.ts` in that adapter (modify); `settings-store.ts`, `context-store.ts` and ordered migrations (new) | Complete validated settings, source permissions, private preparation candidates, collision-safe context checkpoints and fenced publication; retain seeds/user edits. |
| C11 | `src/server/{ports/ai,application/usage}.ts`, `src/server/adapters/pi/{runtime,classifier,generator,single-send-transport,resource-loader}.ts` (modify); `src/server/adapters/pi/{sessions,setup-ai}.ts` (new); C2/C8 (extend) | Finish restricted SDK create/resume/compaction, terminal setup, shared lifecycle and cross-path admission; reuse completed P1–P8 rather than replace them. |
| C12 | `src/server/ports/public-web.ts`, `src/server/adapters/web/{public-url,request,readability-worker,extract}.ts`, `src/server/application/prepare-article.ts` (modify); `src/server/adapters/pi/extraction.ts` (new) | Connect admitted quality/context processing and source-approved restricted fallback; preserve safe fetch/access checks and pause-safe candidate checkpoints. |
| C13 | `src/server/application/prepare-context.ts` (modify); `src/server/application/process-context-chunks.ts` (new); C10 persistence (extend) | Execute task-specific chunk evidence/reduction, exact-envelope sizing, full coverage, durable pause/resume and publication fences. |
| C14 | `src/server/application/{categorize,assign-tags,evaluate-scores,reevaluate-article}.ts`, `src/server/adapters/postgres/article-jobs.ts` (new); C3/C4/C6/C10 (extend) | Complete atomic quality→category→tags→per-score chain, captured active targets, manual-edit/catalog fencing and explicit reevaluation. |
| C15 | `src/server/http/app.ts`, `src/web/{App,ScoreSettings}.tsx`, `src/web/api.ts` (modify); `src/web/{AiSettings,Processing,ArticleActions,ScoreValues}.tsx` (new) | Expose AI/limits/content/summary settings, usage, source permission, retry/reevaluation, full results and meaningful processing states. |
| C16 | `tests/helpers/{fake-provider,usage-database}.ts`, existing Pi/usage/public-web/enrichment/publication tests (extend); `tests/helpers/fake-ai.ts`, `tests/integration/{pi-sessions,budgets,context-recovery,article-jobs}.test.ts`, `tests/unit/{setup-ai,ai-lifecycle}.test.ts`, `tests/api/enrichment.test.ts`, `tests/e2e/enrichment.spec.ts`, `tests/live/pi.live.test.ts` (new) | Close V10–V15 on real originating workflows; retain transport-level wire counters and guarded live separation. |
| C17 | `src/server/domain/preferences.ts`, `src/server/adapters/postgres/{preference-store,preference-admin-store,tag-merge-store,catalog-store}.ts`, `src/server/adapters/postgres/schema/preferences.ts`, `src/server/http/app.ts`, `src/web/{FeedbackPicker,PreferenceSettings}.tsx` (modify as needed); C14 (extend) | Preserve local preference/merge implementation; integrate relevant-only current weights and asynchronous assignment/catalog publication fencing. |
| C18 | `tests/unit/preferences.test.ts`, `tests/integration/{preferences,preference-admin,tag-merge,assignments}.test.ts`, `tests/api/preferences.test.ts`, `tests/e2e/preferences.spec.ts` (extend) | Complete real-PostgreSQL merge-vs-publisher races and score-context integration; retain detached-vote and UI evidence. |
| C19 | `src/server/ports/media.ts`, `src/server/adapters/media/{download,egress-proxy,ffmpeg,whisper,workspace}.ts`, `src/server/application/prepare-video.ts`, `src/server/adapters/postgres/schema/media.ts`, `src/web/VideoProgress.tsx`, ordered migration (new); C4/C8/C14/C15 (extend) | Add subtitle-first video pipeline, controlled audio transcription, resource/checkpoint/egress enforcement and four-hour backlog diagnostics. |
| C20 | `tests/unit/media.test.ts`, `tests/integration/{media,media-egress,video-recovery}.test.ts`, `tests/e2e/video.spec.ts`, `tests/bench/media.ts`, `tests/fixtures/media/manifest.example.json`, `tests/live/video-capacity.live.test.ts`, `docs/media-benchmark.md` (new); `package.json` (extend) | Prove media behavior/security; add benchmark script and sanitized measurement format; retain target-host capacity gate. |
| C21 | `src/shared/summaries.ts`, `src/server/application/summarize-article.ts`, `src/server/adapters/postgres/{summary-store.ts,schema/summaries.ts}`, `src/server/ports/input-token-counter.ts`, `src/server/adapters/pi/runtime.ts`, `src/web/Summary.tsx`, ordered migration, `tests/integration/{summaries,pi-generator}.test.ts`, `tests/e2e/summaries.spec.ts` (planned); C6/C7/C15 (extend) | Implement explicit saved summaries, interactive admission, safe regeneration and last-success preservation; the count-only capability is not wired to this workflow. |
| C22 | `src/server/adapters/postgres/mail-store.ts`, `src/server/http/app.ts`, `src/web/{App.tsx,api.ts}`, `tests/integration/mail.test.ts`, `tests/api/mail.test.ts`, `tests/e2e/reader.spec.ts` (modify) | Retain local selection/ack contract; replace missing transcript/summary projections as D4/D5 land and verify enriched queue payloads without building a sender. |
| C23 | `src/server/ports/karakeep.ts`, `src/server/adapters/karakeep/{client,schemas}.ts`, `src/server/adapters/postgres/karakeep-jobs.ts`, `src/server/http/app.ts`, `src/web/{App.tsx,useKarakeep.ts}`, existing Karakeep tests (modify); `tests/live/karakeep.live.test.ts` (new) | Preserve local action/uncertainty/auth behavior; encode only version-evidenced lookup/normalization semantics and separately prove V22. |
| C24 | `src/shared/chat.ts`, `src/server/application/{chat-sessions,chat-turn}.ts`, `src/server/adapters/pi/chat-tools.ts`, `src/server/adapters/web/search.ts`, `src/server/adapters/postgres/{chat-store.ts,schema/chat.ts}`, `src/web/Chat.tsx`, ordered migration, `tests/unit/search.test.ts`, `tests/integration/{chat,search}.test.ts`, `tests/e2e/chat.spec.ts`, `tests/live/{search,session-restore}.live.test.ts` (new); C6/C7/C11 (extend) | Add no-key search and restricted persisted chat with turn deduplication, SSE/reconnect, reference controls and matched session restore. |
| C25 | `docs/{api,server-api,verification,operations,import-worker,karakeep-client}.md`, `README.md`, `tests/container/operations.sh`, CI (modify); `tests/integration/restore.test.ts`, `tests/e2e/pwa.spec.ts` (new, shared with C9) | Keep feature/API/acceptance and operational evidence accurate, including current-tree restore and final gate report; correct stale “D1 has no…” claims as features arrive. |

## Implementation details

### Basis

- **Authoritative behavior:** `docs/dev-agentic-news-reader-spec.md`, AC1–AC21. Reuse these IDs; this plan does not replace their definitions.
- **Architecture authority:** `docs/architecture.md`; confirmed F1–F4 in `docs/technical-design.md`.
- **Proposal status:** Other technical-sketch details become implementation choices only where explicitly selected below. Historical `docs/dev-agentic-news-reader.md` does not override newer decisions.
- **Continuation authority:** Current user request authorizes implementation of all D1–D8, not deployment or publication. Execution basis above records the supplied current Git state; do not use the historical inventory as a checkout/review base.
- **Historical planning-time inventory:** At the original planning baseline, `master` was `82d72823e937161287c8728066fabe08e93a899e`, with four tracked documents and no source/scripts/tests/dependencies. This is not the current repository state.
- **Environment inspected on 2026-10-31:** Local Node `26.12.0`, npm `11.20.0`, Docker executable available. Docker daemon/target-host access and PostgreSQL were not tested.
- **User decisions from planning:**
  - Full first release split into D1–D8, not just D1.
  - On 2026-10-31, approved revising the Node baseline from 24.22.2 to the locally available 24.21.0 LTS, subject to compatibility validation.
  - On 2026-10-31, approved version drift as needed to complete implementation while preserving the configured npm release-age policy. Changed the ESLint pin to eligible, peer-compatible 10.13.0 based on registry metadata.
  - Approved daily UTC request limits: automatic generative 50; interactive generative 50; classifier 2,000.
  - Search must need no API key; an existing local Pi extension may inform the implementation.
- **Inspected integration evidence:**
  - Installed Pi `1.4.0`: `docs/sdk.md`, `docs/providers.md`, `docs/models.md`, `docs/settings.md`, `docs/security.md`, `docs/custom-provider.md`, `docs/extensions.md`, SDK examples 09/12, and exported declarations under the installed coding-agent package.
  - Public executor references: [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [full-control example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts). Use the pinned package declarations over moving documentation.
  - Pi `ModelRuntime` exposes `create`, `getModel`, `getModelOfType`, `login`, `streamSimple`, `complete`, and `classify`; `createAgentSession` accepts the same runtime.
  - `AgentSession.agent.streamFunction` is public and writable in the installed declarations. Wrap this boundary for request admission; do not infer admission from observational extension events.
  - Pi's System One adapter performs one `postClassifierRequest` per invocation; its retry helper defaults to two retries unless `maxRetries: 0` is supplied.
  - [pg-boss 12.38.0 transaction adapters](https://github.com/timgit/pg-boss/blob/12.38.0/docs/api/adapters.md): import `fromDrizzle` from `pg-boss`, `sql` from `drizzle-orm`; pass `{ db: fromDrizzle(tx, sql) }` to `boss.send` inside the application transaction.
  - [pg-boss CLI](https://github.com/timgit/pg-boss/blob/12.38.0/docs/cli.md) supports controlled `migrate`, `version`, and `doctor`; normal startup uses `migrate: false`.
  - [FreshRSS 1.28.1 source](https://github.com/FreshRSS/FreshRSS/blob/1.28.1/p/api/greader.php) confirms Google Reader endpoints. This is not evidence of the running version or complete hidden-feed coverage.
  - [Karakeep create](https://github.com/karakeep-app/karakeep/blob/main/docs/docs/api/create-bookmark.api.mdx) documents link creation returning existing bookmarks; [check-url](https://github.com/karakeep-app/karakeep/blob/main/docs/docs/api/check-bookmark-url.api.mdx) documents URL lookup. Moving docs are not a deployed-version guarantee.
- **Personal extension inspected:** `/home/matthias/.pi/agent/extensions/web-research/{README.md,search.ts,search.test.ts,ssrf.ts,fetch.ts,types.ts}`.
  - Search GETs `https://html.duckduckgo.com/html/?q=...`; parses `a.result__a`, `.result__snippet`, and `uddg` redirect parameters.
  - On unavailable/transient search responses it tries `https://www.bing.com/search?format=rss&q=...`; each provider gets at most one short transient retry.
  - Normalize whitespace, remove fragments, deduplicate result URLs, and reject non-HTTP(S) destinations. Snippets are untrusted discovery data, not verified article content.
  - Required facts are recorded here; executor must not depend on those personal files being present. Do not copy the extension's resource loader, personal configuration, or credentials.
- **Routine assumptions:** German UI/default summaries; original content language retained; one operator, one FreshRSS context, one app replica. Desktop and mobile share the same API.
- **Stop condition:** If sources, exported APIs, package compatibility, or prerequisites contradict this plan, stop and report. Do not invent replacement architecture or weaken acceptance criteria.

### C1 — Toolchain and boundaries

- **Selected baseline:** Node `24.21.0` LTS and PostgreSQL 18 for isolated tests; support an operator-provided PostgreSQL 17 or 18 only after its integration suite passes. User approved this plan revision on 2026-10-31 because Node 24.21.0 is installed while 24.22.2 is unavailable; validate pinned package/tool compatibility before proceeding.
- **Package pins verified through npm metadata:**
  - Fastify `5.12.7`; `@fastify/static` `10.1.8`; `@fastify/swagger` `9.9.2`; `@fastify/type-provider-typebox` `6.3.0`; `typebox` `1.3.27`.
  - Drizzle ORM `0.45.4`, Drizzle Kit `0.31.11`, `pg` `8.23.1`, pg-boss `12.38.0`.
  - React/React DOM `19.3.1`, Vite `8.3.5`, React Vite plugin `6.1.2`, Tailwind and its Vite plugin `4.3.3`, PWA plugin `2.0.0`.
  - Mozilla Readability `0.6.0`, linkedom `0.18.14`, `ipaddr.js` `2.5.0`, `react-markdown` `10.1.0`.
  - TypeScript `6.0.3`, Vitest `5.0.5`, Playwright `1.64.1`, ESLint `10.13.0`, typescript-eslint `8.72.1`. ESLint 10.13.0 was published 2026-10-16 and its Node engine admits 24.21.0; typescript-eslint 8.72.1 accepts ESLint `^10.0.0` and TypeScript `>=4.8.4 <6.1.0` (npm registry metadata, checked 2026-10-31). The 10.14.0 pin was too recent for the configured 72-hour npm age gate.
  - TypeScript 7 was available but exceeds the inspected linter peer range `<6.1.0`; do not select it incidentally.
- **Remaining small build/type utilities:** Resolve compatible exact versions during scaffolding, use `save-exact=true`, and commit the complete lockfile as part of implementation only if separately authorized. No forced/legacy peer installation.
- **Validation:** New Fastify TypeBox provider uses `typebox`, not `@sinclair/typebox`; its required `ajv-formats` peer must be pinned. Use runtime schemas for external/API/model data, not types alone.
- **Layout:** ESM; strict NodeNext server build to `dist/server`, Vite browser build to `dist/web`; server-only imports rejected from browser modules. Share only DTO schemas/types under `src/shared`.
- **Scripts:** Keep existing `build`, `start`, `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e`, `test:live`, `db:migrate`, and foundation/import scripts. Add `dev` and `db:generate` using the installed tooling; C20 adds `benchmark:media`. Do not replace working scripts wholesale.
  - `build` compiles server/CLI and UI; `start` runs the built CLI's `serve` command.
  - `test:integration` includes `tests/integration` and `tests/api`; `test:live` includes only `tests/live` and is excluded from normal CI.
  - Use React Testing Library for interaction tests if needed; Playwright covers full UI flows. Follow existing `tests/unit`, `tests/integration`, `tests/api`, `tests/e2e` and `tests/helpers/usage-database.ts` conventions; proposed paths are additions, not evidence that those tests already exist.
- **User-approved C1 dependency exception enabling C11 — adopt/continue:** User explicitly chose adoption/continue after the isolated compatibility evaluation recorded in Verification.
  - Merge this fragment into root `package.json`, preserving unrelated entries; record matching exact resolutions in `package-lock.json`. Do not mix Pi generations or depend on globally installed Pi.

  ```json
  {
    "dependencies": {
      "@earendil-works/pi-ai": "1.4.0",
      "@earendil-works/pi-coding-agent": "1.4.0"
    },
    "overrides": {
      "undici": "8.12.3",
      "glob": "14.0.2",
      "minimatch": "11.0.1"
    }
  }
  ```

  - **Rationale:** Official advisory evidence from the evaluation identifies fixed versions as `undici >=8.12.2` for both examined findings, `glob 14.0.2`, and `minimatch 11.0.1`. The selected overrides meet those fixed-version thresholds.
  - **Explicit exception:** These root overrides supersede at least some declared dependency ranges. User approval accepts this specific compatibility risk; do not treat it as implicit range compatibility or blanket approval for other overrides.
  - **Policy unchanged:** Preserve `.npmrc` byte-for-byte: `save-exact=true`, `min-release-age=3`, `ignore-scripts=true`. No `--force`, `--legacy-peer-deps`, or other policy changes/bypasses.
- **References:** AC21 / V1, V2.

### C2–C3 — Foundational contracts and persistence

- **Bootstrap:** Extend existing `buildApplication(config)` in the composition root; add injected dependencies only where required for feature/test seams. Handlers/jobs call application functions. New application boundaries expose application-owned ports, not Fastify/Drizzle/Pi types; do not reorganize working foundation code.
- **Configuration:** Validate DB connection, `APP_ORIGIN`, listen address/port, explicit trusted proxy addresses/CIDRs, FreshRSS context/base URL, secret-file references, and `/data` paths.
  - Missing AI/Karakeep credentials disable only affected actions/jobs, not the reader.
  - Do not allow an empty/invalid explicitly supplied value to silently use a default.
  - Secrets from environment or deployment secret files; never settings JSON returned to browsers. Do not support executable `!command` secret configuration.
- **Schema:** UUID primary keys; external FreshRSS IDs stored as exact strings; `timestamptz` everywhere; injected `Clock.now()` for business-time decisions.
  - `import_contexts`: stable instance/account identity, no credentials; changing identity creates a new context rather than reinterpreting old IDs.
  - `sources`: unique `(context_id, external_feed_id)`; missing feed identity may remain absent on an article rather than inventing a feed.
  - `articles`: unique `(context_id, freshrss_id)`, original URL and optional metadata, import time, kind, personal read flag, assignment/content revisions.
  - Missing publication time stays null; a separate sort expression uses `coalesce(published_at, imported_at)`.
  - No unique URL constraint, automatic age cap, retention deletion, or reset-on-upsert.
  - `processing_runs`: import status, fetch/ack phase, counters, start/end/error and execution owner.
  - `freshrss_acknowledgements`: unique article/context-entry, pending/confirmed status, scan eligibility, attempts and reconciliation diagnostics.
  - `processing_tasks`: article/action/optional score target, generation, execution token, state, prerequisite link, attempt count, timestamps, error code, bounded result metadata, and pg-boss job reference.
  - Initial `app_settings`: validated schedule and deployment-independent settings; typed JSON is acceptable, unvalidated arbitrary settings are not.
- **Constraints:** Foreign keys and checks for states; unique active import per context and active article action per generation. Catalog/result additions arrive through later reviewed migrations.
- **Migration entry:** CLI `migrate` runs app SQL and controlled pg-boss migrations under an exclusive migration lock, creates/updates the delivery's static queue definitions, then verifies versions.
  - Pass migration credentials through environment/secret files, not process arguments or logs; pin the dependency CLI/library to C1's release.
  - Runtime startup neither pushes Drizzle schema, creates queue tables, nor migrates pg-boss. Incompatible schema keeps readiness false and workers stopped.
  - Save SQL, journal, and snapshots; test empty install and predecessor upgrade. Avoid speculative down-migrations that delete user data.
- **References:** AC1–AC3, AC21 / V2–V5.

### C4–C5 — Import, queue, and recovery

- **Ports:** Define application-owned `FreshRssPort` with `listUnreadPage(continuation?, signal)`, `markRead(ids, signal)`, and `getReadState(ids, signal)`; `TaskQueue.enqueue(unitOfWork, taskId)` must participate in the store transaction.
  - Define an opaque application `UnitOfWork` in its port; store transaction callbacks pass this handle to cooperating adapters. Only PostgreSQL adapters unwrap it to a Drizzle transaction; application signatures never expose Drizzle types.
- **FreshRSS wire contract, relative to configured `/api/greader.php`:**
  - POST `/accounts/ClientLogin`, form `Email`, `Passwd` using the API password; parse text `Auth=...` and send `Authorization: GoogleLogin auth=...`.
  - GET `/reader/api/0/token`; include returned token as `T` in mutation forms.
  - GET `/reader/api/0/stream/contents/user/-/state/com.google/reading-list` with `xt=user/-/state/com.google/read`, bounded `n`, and optional `c`.
  - Consume `items` and optional `continuation` until absent. Reject malformed/repeated continuation tokens instead of looping or declaring success.
  - POST `/reader/api/0/edit-tag`, form `a=user/-/state/com.google/read`, `T`, and repeated `i` fields. Never use `mark-all-as-read`, favorite mutations, or feed-wide operations.
  - Reconcile exact IDs through `/reader/api/0/stream/items/contents` with repeated `i` and validated read categories; if unavailable, use the release-supported read-ID listing. V5 must establish the actual deployed contract before enabling acknowledgement.
  - Treat numeric-looking IDs as strings; do not coerce through JavaScript numbers. Adapt alternate source/ID forms only after the fixture contract is explicit.
- **Ordered import:**
  1. `startImport(contextId)` transaction returns an existing active run or creates exactly one run and pg-boss job.
  2. A dedicated coordinator connection holds a PostgreSQL session advisory lock for the context across fetch and acknowledgement; all acknowledgement retries use this same coordinator.
  3. Fetch pages sequentially. In each transaction insert new identities, preserve existing article/personal/result fields, and persist ack intent. For each delivery, create and enqueue processing work only for capabilities delivered there: D1 creates no article-processing task; starting in D2, create eligible per-article tasks and enqueue their first executable job atomically with page persistence using `fromDrizzle`. Do not create placeholder/no-op tasks or backfill D1 entries automatically when D2 arrives.
  4. During the entire fetch phase perform **no** read acknowledgement, including old retries. Any page/commit failure ends the scan as incomplete; no acknowledgements from that incomplete scan.
  5. Only after complete pagination, durably record completion and make saved IDs eligible. Reconcile/retry pending acknowledgements, including IDs absent from the current unread response; acknowledge only known-durable IDs.
  6. Bound acknowledgement attempts, retain remaining intents, and finish the import run with explicit pending/error counts. Do not hold the import open forever waiting for unavailable FreshRSS.
- **Crash semantics:** Restart incomplete pagination from the beginning; deduplicate by context/ID. Resume a completed scan's ack phase from its durable checkpoint, or complete a fresh scan before enabling its acknowledgements.
  - An unknown acknowledgement result stays pending until reconciled or a safe exact-ID repeat succeeds. Do not infer failure from absence in the unread feed alone.
  - On coordinator DB connection loss abort its HTTP requests and stop that worker; a stale execution token cannot commit progress. One deployed app replica is a supported invariant, not a promise of distributed exactly-once effects.
  - FreshRSS pagination is not a snapshot; other clients may move entries. Record observed API coverage and rescan from the beginning on later runs.
- **Scheduling:** Default interval four elapsed hours; store `next_import_at`, allow disable/edit, and use a pg-boss scheduled wake-up to atomically start/coalesce due work. Startup performs at most one overdue catch-up, not a backlog of missed schedules.
- **Task engine:** pg-boss drives execution; app task rows represent business progress, not a second polling queue.
  - States: `waiting_dependency`, `queued`, `running`, `retry_wait`, `paused_budget`, `paused_auth`, `needs_input`, `failed`, `succeeded`, `superseded`.
  - Claim with a fresh execution token; result commit checks token plus relevant generation/revisions. Next-task creation/enqueue and result commit are one transaction.
  - Transient errors: three attempts total, delays approximately 30/60 seconds with jitter; honor longer `Retry-After`. Terminal validation/paywall/unsupported-input errors do not retry automatically.
  - Keep pg-boss retry ownership explicit: two retries after the initial attempt; do not add another three-attempt loop inside a handler. Budget/auth pauses finish the execution without a retry storm; reset/config-change/manual wake-up enqueues existing paused work transactionally.
  - General heartbeat 30 seconds; explicit per-queue expiry exceeds controlled operation timeout. Expiry/retry can overlap old code, so fencing remains necessary.
  - Recovery reconciles unfinished task/job references, releases stale running ownership, and re-enqueues genuinely stranded work without recreating successful results.
- **References:** AC1–AC3, AC6, AC20–AC21 / V2–V5, V11.

### C6 — HTTP and global reader query contract

- **General:** `/api/v1`; JSON request/response schemas drive OpenAPI at `/api/v1/openapi.json`.
  - Error: `{ error: { code, message, requestId, details? } }`; bounded field-level details only, never raw provider responses or secrets.
  - Statuses: `400` invalid shape/cursor; `403` origin/host policy; `404` unknown ID; `409` state/revision conflict; `422` known but unsuitable content/action; `503` unavailable integration. Asynchronous budget/auth pauses are returned as task state, not discarded requests.
  - Async action: `202 { taskId, state, reused }` or import `202 { runId, state, reused }`; same active action returns its existing reference. Finished explicit actions may create a new generation.
  - PATCH requests accept only listed fields; reject unknown keys rather than passing arbitrary objects to persistence.
- **Article DTO:** UUID, exact FreshRSS ID/context, nullable original metadata, read state, kind, category/fallback when available, processing summary, and later feature data.
  - List excludes full text/chunks; detail includes full available text/transcript, last successful results, timestamps, basis/provenance, and per-step status.
  - D1 lists imported metadata with preparation unavailable; no fake zero scores or fake completed content.
- **`GET /articles`:** `read=unread|read|all` (default unread), optional category/source/kind/status/title query, `sort=date|title|score`, optional active `scoreId`, `direction=asc|desc`, `limit` default 50/max 100, `cursor`.
  - D1 default date descending; D2 default Signal descending while that definition is active, otherwise date descending. Signal uses a stable seeded ID, not its editable name.
  - Apply all predicates and ordering in SQL before limit. Title search is literal case-insensitive substring; escape `%`/`_` and parameterize SQL.
  - Score ordering: numeric value in selected direction, `NULLS LAST`, then sort date descending and UUID descending. Date/title order likewise ends in deterministic date/UUID tie-breakers.
  - Opaque versioned base64url cursor binds the query fingerprint, sort position including null placement, date and UUID. It may reference a stored title by UUID and hash rather than embed an unbounded title; reject a changed or missing anchor. Validate structure/types/filter match; never interpolate it as SQL. Reject inactive/deleted explicit score sorts.
  - No snapshot guarantee while data changes; query invalidation reloads from the first page after relevant changes.
- **Read/update:** Preserve `GET /articles/:id` and `PATCH /articles/:id` with `{ isRead }`; keep existing catalog actions at `/articles/:id/catalog`, `/articles/:id/category` and `/articles/:id/tags/:tagId` rather than add duplicate assignment routes. Catalog snapshots report assignment revision; asynchronous publishers capture/check it. Reading never updates FreshRSS or mail state.
- **Progress:** POST `/pipeline/runs`; GET `/pipeline/runs/:id`; GET `/processing-tasks/:id`; POST `/processing-tasks/:id/retry`.
  - Retry rechecks limits/auth/prerequisites, rejects successful or currently running tasks, and cannot bypass generation fencing.
- **Settings:** GET/PATCH `/settings/import` for enabled/interval; validate positive interval and cap wake frequency operationally without changing the four-hour default.
- **SSE:** GET `/events`; events `{ type, entityId, revision?, data? }` for invalidation/progress and later chat deltas.
  - Heartbeat every 15 seconds; `text/event-stream`, no caching/compression/buffering, bounded per-client buffers, drop slow streams rather than unbounded RAM.
  - No durable event history or replay promise. Reconnect reloads DB/session snapshots; deltas are advisory. Do not enqueue work or cancel tasks merely because a stream disconnects.
- **References:** AC3, AC14, AC21 / V6, V7, V8.

### C7–C8 — Reader shell, container, and operations

- **UI:** Compact list/detail layout; source/date/kind, optional scores, processing state, and explicit actions. Desktop split view; mobile list/detail navigation with reachable controls and visible pending/errors.
  - Read/unread, filters, title search, stable pagination, manual import and run progress work in D1. Do not render inactive future feature buttons.
  - Server is authoritative; invalidate/refetch after mutations. On offline/timeout do not claim success or queue a write. Keep previously displayed data only in volatile page state.
  - Seed only the shadcn/ui components actually used; own their source, accessible labels/focus, touch targets, and contrast. No mandatory visual redesign during later slices.
- **PWA:** Precache versioned JS/CSS/icons and shell only. Network-only `/api`, `/events`, article/chat data, and integration responses; no IndexedDB/localStorage article persistence or mutation queue.
  - Do not cache article DOM, external images, credentials, or API payloads. Disable remote images/iframes in rendered content; safe links use HTTP(S), `noopener`, and explicit navigation.
  - `react-markdown` without raw HTML; extracted main content may initially render as plain text. No `dangerouslySetInnerHTML` on source/model text.
  - Installation manifest/icons and online/offline notices; service-worker update does not replay actions.
- **Image:** Multi-stage build, pinned Node image digest, non-root app UID, read-only application filesystem, writable bounded data/temp mounts, internal HTTP. Node serves UI and API; no nginx, Docker socket, or full personal Pi directory.
- **Compose:** Production example defines only `app` and external DB configuration. `compose.test.yaml` provides disposable PostgreSQL for development/tests, never production infrastructure.
- **CLI:** `serve`, `migrate`, `setup-ai`; administrative commands do not start HTTP or job workers. Entry point forwards container arguments so `docker compose run --rm -it app setup-ai` is valid.
- **HTTP boundary:** Only configured Host/Origin; trust forwarded headers only from configured proxy IPs. No wildcard CORS. JSON mutation requests require JSON content type and validate Origin/Sec-Fetch-Site when present; reject browser cross-site writes.
  - Non-browser VPN API clients may omit Origin; access still requires private deployment. Do not silently add a public API account/token system.
  - CSP restricts scripts/connect to self, objects/frames none, referrer policy no-referrer, bounded body sizes. HTTPS is external Nginx Proxy Manager's responsibility.
- **Health/logs/shutdown:** `/health/live` process only; `/health/ready` DB/schema/required filesystem, never paid calls or mandatory AI auth.
  - Structured IDs/error codes; redact Authorization, secret fields, query strings and raw external payloads; no article/chat bodies in ordinary logs.
  - SIGTERM stops new HTTP actions/claims, aborts cancellable work, drains for a bounded grace period, terminates child process groups, then exits; durable progress supports restart.
- **Backup:** Operator-controlled quiescent cut: stop app writes/workers, `pg_dump` database including app and pg-boss schemas, archive `/data/pi-auth` and `/data/pi-sessions`, then resume.
  - Encrypt/protect credential backups; exclude temp/model cache. Restore database and matching Pi files together into an empty isolated deployment, migrate only after backup, and verify continuation before switching traffic.
  - Retention/RPO are operator policy, not guessed defaults or an extra backup service. Schema-changing rollback restores a matched backup/image, not a destructive automatic downgrade.
- **References:** AC14, AC19, AC21 / V1, V7–V9, V23.

### C9 — Establish test conventions

- Vitest `describe`/`it.each`; injected clocks/transports/AI/subprocess launchers; fresh fixtures per test. No process-wide clock/env mutation shared between parallel tests.
- PostgreSQL tests use a disposable database/schema per test worker against the actual engine; include pg-boss objects. Never substitute SQLite or mock constraints/locks.
- API tests use Fastify injection; SSE/proxy tests use a real ephemeral listener. Playwright starts the built app against isolated fixtures and fake integrations.
- Fixture server supports multiple pages, exact IDs beyond safe integer range, malformed/repeated cursors, hidden-feed fixtures, controllable delays, and response loss before/after mutation.
- Tests must fail loudly if accidentally configured with production integration URLs. Live suites require explicit environment consent and seeded disposable accounts/data.
- Detailed cases and commands are centralized in V1–V9.

### C10 — Enrichment data and configuration

- **Add:** `categories`, `tags`, `article_tags`, `article_contents`, `content_chunks`, `chunk_results`, `score_definitions`, `score_category_prompts`, `article_scores`, `usage_ledger`, and budget-period counters.
  - One protected fallback category; every article points to exactly one category once D2 migration completes. Archive normal categories, preserving old assignments; never archive fallback.
  - Tag technical identity: Unicode NFKC, trimmed/collapsed whitespace, case-insensitive key; preserve a human-readable label. Do not stem, translate, or semantically merge.
  - Archive ordinary tags rather than hard-delete referenced feedback; merged-away tags are hard-deleted only by C17's transaction. Archived tags stay visible on historical associations but are not newly suggested.
  - Content keeps full available extracted text/transcript, revision, source URL, quality/limitation status, and failure code. Failed refresh does not destroy previous successful content.
  - Score check: finite numeric 0–100, unique article/definition; nullable absence is not zero. Record calculated time, content/assignment basis and condensed/limited flags, not prompt/model-configuration version or score history.
  - Preserve previous successful individual score values until their replacements succeed; use task states to distinguish old result and failed new attempt.
- **Seeds:** Exact eight start categories and four scores/prompts from the product spec; fallback uses global defaults. Initial proposals become editable starter prompts, not claims of calibrated quality.
  - Seed stable IDs idempotently; never overwrite user edits during migration/startup.
  - Only personal relevance includes tag/source weights by default. Other starter contexts include title/content/category; per-score checkboxes control each field.
- **Model roles:** quality, category, tags, scores, extraction agent, context reduction, summary, chat, transcription service. Persist provider/model IDs and optional explicit fallback, never secrets.
  - Classifier default `typesafe/jev-latest` resolved as provider `typesafe`, model `jev-latest`.
  - No guessed Codex model ID: `setup-ai` lists available generative models and requires an explicit validated selection for role defaults. Until mapped/authenticated, affected work pauses visibly.
  - Fallback is absent by default; selecting one is explicit configuration, capability-checked and budget-accounted.
- **References:** AC7–AC11, AC19–AC20 / V10–V13.

### C11 — Shared Pi runtime and request budgets

- **Approved material scope amendment:** User selected built-in-only after receiving details, as recorded in `.ai/c11-admission-plan.md` C7/C10. Approval changes plan scope only; it is not implementation acceptance or inference activation approval.
- **New interfaces:** `AiPort.classify(request, scope)`, `AiPort.generate(request, scope)`, `AiPort.createRestrictedSession(options, scope)`; domain-facing results contain validated answers/text/usage, not SDK objects.
  - `scope = { taskId? , turnId?, bucket: automatic|interactive|classifier, signal }`; classifiers always use their dedicated bucket.
- **Runtime:** One `ModelRuntime.create({ authPath: '/data/pi-auth/auth.json', modelsPath: null, allowModelNetwork: false, refreshOnCreate: false })` instance shared by direct requests and all sessions.
  - Pi 1.4.0 selects its in-memory built-in catalog; omit `modelsStore`, `modelsStorePath` and `catalogBaseUrl`. Serve/setup read or write no persisted custom provider/model catalogs or endpoint configuration; pre-existing `models.json`/`catalog.json` are ignored, not migrated/deleted.
  - Keep runtime/provider/model objects private; permit only fixed, code-owned audited built-in provider/API/transport/endpoint routes under an explicit allowlist. No caller-supplied runtime/provider injection, endpoint overrides or ambient overlays; role mappings select eligible built-ins, not routes.
  - Use Pi auth resolution/refresh and private persisted credentials, not extracted OAuth tokens passed to unrelated clients. Login and ordinary OAuth refresh stay outside inference accounting: no inference credit, ledger reservation or dispatch permit; auth must not trigger inference. Serve construction performs no auth/network operation.
  - `setup-ai` calls `runtime.login(providerId, authType, interaction)` using terminal notifications/prompts; show auth URL/device code only in the interactive setup terminal, never normal application logs.
  - `setup-ai` lists only built-in generative models eligible under the route allowlist; require explicit validated selection and persist role mappings, never catalogs/endpoints.
  - Preserve existing mappings/user edits, including `typesafe/jev-latest` where eligible. Out-of-allowlist mappings remain stored but report paused configuration, with no automatic substitution; cancelled/failed setup does not overwrite a working mapping.
  - Browser callback or pasted redirect/code fallback; device-code only if actually supported. Persistent credential directory is writable by app UID and excluded from UI/API.
  - External re-login initially requires app restart; ordinary refresh stays with Pi.
- **No-discovery sessions:** Adapt the full-control example's `ResourceLoader` to return empty extensions/skills/prompts/context files and an application-owned prompt. Use dedicated agent directory and `SettingsManager.inMemory`.
  - Disable cache warming and agent automatic retries; set provider `maxRetries: 0`; force provider SSE/HTTP where supported to simplify accounting. Disable automatic hidden compaction; explicit compaction, when needed, uses the same admitted stream wrapper.
  - Set `tools` to the **exact custom names** required for that session; `customTools` registers their implementations. `tools: []` disables custom tools too and is not the correct enabled-custom-tool configuration.
  - No default read/write/bash/codemode/MCP/extensions; verify active tool names after create/resume. Extraction sessions are in-memory; chat persists through C24.
- **Admission:**
  1. Validate model/capability/context and shared auth-pause state.
  2. In one transaction lock the UTC-day bucket row, check request cap and global concurrency, increment used/reserved requests, and create a durable ledger reservation.
  3. Dispatch one provider attempt. Every retry/fallback/chunk/agent continuation is separately admitted; no nested undisclosed provider retry.
  4. Finalize usage from the terminal response/stream event. Keep missing tokens/costs null with provenance, not Pi's catalog-zero cost. Release concurrency, not already-consumed uncertain call credit.
  5. On process death retain uncertain reservations as counted attempts; use fenced execution ownership for recovery and concurrency-slot cleanup.
- **SDK boundary:** Capture the newly created session's public `agent.streamFunction` and wrap it before prompting. Reserve before delegating; forward all stream events and settle usage on terminal/error/abort.
  - Both normal turns and explicit session compaction must use this wrapper; disable cache warming because it can bypass this request path.
  - Direct `runtime.classify`/generation calls go through the same application admission service with `maxRetries: 0`. Inspect `stopReason`/error values even when promises resolve.
  - V11 must count actual fake-provider HTTP requests, including multi-tool turns and errors. If any chosen provider bypasses these controls, block that provider; do not replace this gate with estimates.
  - **Current status (2026-11-02):** Direct classifier and generation adapters now use the private shared built-in-only runtime, one-send transport and admitted permits. Their scoped loopback suite and independent review passed; see `docs/verification.md`. They remain unwired. SDK session/compaction boundaries, operational setup, cross-path V11 and live V15 remain incomplete; no inference activation is authorized. `maxRetries: 0` alone is insufficient; every direct call, SDK turn and compaction must retain the same boundary.
- **Approved defaults:** 50 automatic, 50 interactive, 2,000 classifier attempts per UTC day; concurrency 1, 1, 2 respectively. No default local audio-minute quota; audio usage is separate.
  - Source-approved extraction and automatic context work use automatic bucket. Requested summaries/chat/compaction use interactive bucket. Retrying automatic preparation retains automatic classification/generation buckets.
  - Pause at step boundaries on exhausted budgets; daily reset/settings increases wake existing paused work fairly, without blocking imports or other eligible articles.
  - Auth/permission errors pause the affected model configuration globally until repaired; do not spend one identical failed request per article.
  - Hard euro/token caps apply only when conservatively reservable; pilot guarantees are request caps, not undisclosed-cost guarantees.
- **Continuation:** Execute P9 → P10 → P11 from `.ai/c11-admission-plan.md`, reusing the actual direct-adapter files in this change table. P10 may compose the private capability without activating real workflows; C14/C21/C24 may wire fixture-tested callers while real inference stays disabled pending the gates.
- **Port extension:** Extend the application-owned `RestrictedSession` only for controlled tool registration, bounded event subscription and adapter-owned create/open references needed by extraction/chat. Do not expose SDK sessions, mutable runtime/model objects or arbitrary client paths.
- **References:** AC19–AC21 / V11, V15.

### C12 — Public retrieval, quality, and restricted extraction

- **Public-web boundary:** Only HTTP(S), no URL credentials, no local/single-label hostnames, only ports 80/443. Block IP-literal targets as a conservative rule.
  - Resolve all A/AAAA results; fail if any is non-global/private/reserved, including IPv4-mapped IPv6, loopback, link-local, multicast, metadata and transition addresses that can reach non-public targets.
  - Use `ipaddr.js` parsing/range classification with explicit tests, not a copied incomplete handwritten range list. Pin the approved IP in the connection's lookup while retaining correct Host and TLS SNI/certificate validation.
  - Validate each redirect independently; do not reuse trust for a different host. No cookies/auth forwarding; disallow HTTPS downgrade. Integration clients use separate exact configured authorities, never this allowance through article URLs.
  - Limits: 30-second total fetch deadline, five redirects, ten MiB **decompressed** body, two concurrent fetches. Limit both compressed and decompressed streams; oversize is a visible error, not truncated full text.
- **Extraction:** `prepareArticle(articleId, generation)` fetches original URL, sends bounded HTML to one worker-thread DOM/Readability extractor, and persists plain text plus provenance.
  - linkedom must not execute scripts or load subresources. Feed body may be diagnostic data but is never accepted as validated full content.
  - Quality classifier uses a bounded score/bool schema; translate to usable/uncertain/unusable with explicit heuristic labeling. Set a documented pilot decision threshold (0.7 probability for usable, 0.3–0.7 uncertain); do not call the threshold a completeness proof.
  - Paywall/access-error evidence overrides apparent long text. Unusable/missing content stops dependent scoring; usable but limited content may proceed only with visible limited basis.
  - For uncertain/unusable extraction, auto-agent fallback only if source permission allows it; YouTube permission seeded true, others false. Source settings may explicitly enable another feed/domain.
- **Fallback tools:** D2 enables only `web_fetch`, including bounded link discovery/fetching; C24 later adds `web_search` through the shared tool factory. Both use the same safe boundary and bounded results; no shell, filesystem, cookies, credentials, or article-write tools.
  - Agent output is a candidate, validated for shape/provenance and reclassified for quality; do not accept its self-declaration of completeness.
  - Limit per extraction session to 10 model requests, 20 tool calls and 120 seconds, configurable downward/upward through validated safety settings. Exhaustion remains a visible failed/needs-input task.
- **Integration gap:** `prepareArticle` enforces the injected persisted per-article-source permission before fallback and exact-host permission for different linked or redirect hosts, but still converts thrown failures to terminal failure; its injectable quality/fallback ports are not production AI adapters. Settings alone do not activate fallback processing; no queue/workflow or typed pause/recovery exists.
  - Preserve typed `paused_budget` / `paused_auth` / unavailable configuration outcomes through preparation, context processing and task state; never flatten them to content failure. Use `needs_input` plus a bounded configuration reason where the task-state enum has no configuration pause.
  - Persist bounded extracted candidate text/provenance in a private preparation-candidate checkpoint keyed by task/generation/basis before quality requests; keep it separate from published `article_contents`. Give the candidate its own task/generation/text identity; do not advance the public content revision before validated publication. Resume that candidate after a budget/auth pause; no repeated network extraction solely because a limit was reached. Successful publication/failure cleanup is fenced; failed refresh retains last successful public content.
  - Adapt Pi bool probability `p` to `{ usable: p >= 0.7, probability: p }` for the current assessment contract, after full C13 coverage. Preserve access-evidence rejection before any model declaration of quality.
- **Source permission default:** Persist optional per-feed override and exact canonical-host rules; feed override wins, otherwise host rule, otherwise false. Seed true only for `youtube.com`, `www.youtube.com`, `m.youtube.com`, `youtu.be`; no suffix matching or automatic permission for linked hosts. Preserve explicit user overrides. Permission authorizes bounded public fetch, never credentials/paywall bypass.
- **References:** AC4, AC6, AC19, AC21 / V12, V14.

### C13 — Context preparation and complete coverage

- **Input:** Task kind, selected context fields, immutable content revision, processing generation, model context/output limits, and task-specific prompt/questions.
- **Mechanics:**
  1. Build only the selected fields. Estimate request size including JSON, prompt/questions, tool schemas, and output reserve; use provider tokenizer where available, otherwise conservative UTF-8 byte-based token upper estimate.
  2. Direct-call when it fits; never chunk a title-only score simply because the article is long.
  3. Split oversize selected content at paragraphs/time boundaries; split a single oversized paragraph further. Store stable chunk IDs, exact character/time intervals and any overlap against that revision.
  4. Generate task-specific evidence per chunk through the regular LLM role. Retain references and counterevidence relevant to each score's prompt; do not feed every score a generic lossy summary.
  5. Hierarchically reduce evidence until the final request fits, deduplicating overlap references. Preserve source coverage metadata throughout.
  6. Run final category/quality/score classifier, or final generative task, on the resulting context. Never average arbitrary chunk scores or silently omit content.
- **Progress/failure:** Require strictly smaller context after a reduction level; cap hierarchy at eight levels and invalid-output repair at one separately admitted request per chunk. Otherwise fail visibly, preserving successful previous results.
  - Record total/completed chunk counts, coverage intervals, missing ranges and condensed/limited basis. A partly processed revision cannot be published as complete.
  - Resume completed chunks only within the same content revision, task kind and generation. Explicit reevaluation/regeneration creates a new generation, not recycled old calculations.
  - Do not store prompt/model configuration versions per score. Generations/revisions prevent stale writes; they are not a prompt-history feature.
  - Budget pause checkpoints outstanding work; another article may proceed. Excluded preference/category/content fields must not leak into chunk prompts indirectly.
- **Persistence slice implemented:** Migration 0007 retains legacy article/revision/ordinal rows and adds plan-scoped ordinal and planner-hash identities, with a separate bounded versioned checkpoint for coverage/reduction state. An operational request fingerprint identifies the exact planned envelopes and limits, task and assignment basis; no prompt/model versions are stored on scores. The context store maps planner hashes to chunk UUIDs and requires the running task token, current content/assignment basis and generation; a newer generation supersedes older work.
  - `ContextStore` atomically stores bounded, validated task-specific chunk evidence in existing `chunk_results` and advances a v3 checkpoint. Question IDs are zero-based decimal indexes into planned questions; each evidence reference quotes an exact original planner chunk interval in absolute UTF-16 offsets. Empty evidence is valid; coverage follows completion records only. Reload verifies evidence/checkpoint consistency; v1 completion and reduction state requires recomputation. No new migration or prompt/model history.
  - Direct-score subset: `process-context-chunks.ts` checks the exact single-question classifier request against caller-supplied verified limits, uses the planner for direct coverage and returns an unpublished candidate. Direct candidates are not publication-fenced: C14 must recheck the owner token, target and basis atomically. The caller must supply a tokenizer and framing/output reserves verified for actual Pi/provider expansion; no catalog limit assumption is made.
  - Oversized scores with a supplied context store use the actual generator envelope and limits to plan selected content, then directly generate and validate per-chunk evidence. The store atomically checkpoints each success and checks the score target as well as the existing fences. Resume reuses only an identical plan under reacquired ownership. Pauses return checkpoint progress; no score or publication results. Without a store the existing `unsupported_chunks` result remains.
  - Invalid evidence gets at most one separate regular-generator repair call. A v3 JSONB checkpoint atomically claims the chunk before dispatch under article/task locks; an incomplete claimed chunk fails closed after restart, even if dispatch was never admitted. Original v2 checkpoints have no repair dispatch and are validated before upgrade; v1 still requires recomputation. Hierarchical reduction, final classification, workflow pause/resume and publication remain open. Future reduction execution must preserve original references and coverage through publication.
  - Keep the planner's fixed-envelope and probe-work guards. Count the exact sent envelope plus real provider/system/tool framing; do not size one JSON shape then send another. Refuse a provider/model with unknown usable context limits rather than assuming the catalog's nominal limit.
- **References:** AC6, AC10–AC11, AC20 / V13.

### C14–C15 — Taxonomy, scoring, and settings

- **Pipeline:** content/transcript + quality → category → tags → applicable scores; successful prerequisite/result transition and enqueue are atomic.
  - At import, snapshot the IDs of active automatic score targets into waiting task records, not their prompt/model versions. Adding a definition later does not backfill old articles accidentally.
  - D1 articles remain unscored after D2 installation. Explicit per-article preparation/reevaluation may opt them into current active targets; do not add an automatic bulk backfill.
  - Valid empty tags satisfy the prerequisite; failed tags do not. One failed article/score does not block unrelated work or erase successful sibling scores.
- **Category:** Classifier choice over active category IDs plus fallback; unknown/invalid answer is an error. Pilot acceptance requires both chosen probability and confidence >=0.7; otherwise select fallback. This is a heuristic, not calibrated accuracy. Manual category correction increments assignment revision; no automatic reevaluation.
  - Partial unwired kernel: an already-owned category task requires usable current content and, when declared, the exact same-article successful prepare prerequisite; nullable roots remain supported only by this isolated kernel. Publisher rechecks the captured dependency and content under locks. Cancellation before publisher entry settles failed without publishing; later cancellation does not undo success. It measures one direct request against caller-verified limits. Fake-AI tests only; no admission, queue, successor, recovery, production model wiring or C13 reduction. The full automatic chain must supply the prerequisite. This does not accept C14, V10 or D2.
- **Tags:** Regular LLM returns validated `{ tags: string[] }`, maximum ten unique normalized names; prefer a bounded relevant catalog shortlist rather than unlimited global catalog context.
  - Partial unwired direct-only kernel for an already-owned task: exact successful same-article category prerequisite and its declared prepare basis, current usable content, and no newer tags or category generation are required. Capture and publication are fenced; cancellation before publisher entry fails without publication. One request is measured against caller-verified model bounds; oversized input needs input, with no reduction. Output uses the automatic usage bucket and exact PostgreSQL-normalized key size is capped at 1,000 bytes before publication. Fake-AI and local Pi/TLS tests only. No global tag shortlist is sent: relevant ranking is not implemented. No admission, queue, successor, recovery, import/backfill or composition wiring; this is not full C14 or D2 and does not activate production inference.
  - Transactionally resolve concurrent insert collisions on normalized key, then create associations. A manually changed assignment revision fences stale automatic associations.
  - Preserve votes independently of associations in D3. No semantic merge or deletion as a side effect of model normalization.
- **Scores:** One classifier question/request per score initially, allowing independently selected context and prompt override without cross-score context leakage.
  - Preserve Pi's native expected-level index in C11. The scoring caller uses five ordered anchors (0, 25, 50, 75, 100, interpreted by the selected prompt) and stores `100 * nativeIndex / (criteria.length - 1)`, without rounding/clamping or preference multiplication. Validate native range first; test fractional indices as well as endpoints.
  - Current prompt/model values are read for the actual call; category override else global prompt. Weights are context only, never a post-classifier multiplier.
  - Missing selected content/prerequisites produces visible unavailable/needs-input state, not invented zero values. Validate finite 0–100 output before committing.
  - `reevaluateArticle(id)` targets all currently active definitions with current stored category/tags/content. It does not recategorize, retag, or refetch automatically.
  - Assignment/content change while a task runs makes that task superseded; no automatic new evaluation merely because a user edited metadata or voted.
- **Assignment progress:** A successful automatic category/tag transition increments assignment revision only for actual changes; its successor captures the resulting content/assignment/catalog basis. Never reuse the pre-transition revision as the next step's expected basis.
- **Transactional integration:** Extend `ImportStore.importPageInTransaction` to distinguish newly inserted identities from existing upserts; only new identities get automatic target snapshots/tasks. Use the page transaction for first enqueue; no scan/backfill of existing D1 rows.
  - Add a transaction-aware task/publication surface rather than calling current `TaskStore.createTask` (which opens its own transaction) from another transaction. Result, task success, successor creation and `boss.send(...,{db:fromDrizzle(tx,sql)})` must commit or roll back together.
  - Partial checkpoint: standalone score admission now uses a reusable caller-transaction score enqueue/job-ID primitive, verified with real PostgreSQL 18 and PgBoss rollback. It does not create or activate the category → tags → scores chain; transaction-aware publication, handoff receipts, workers and chain regressions remain. No import integration, recovery or production model activation; C14, D2 and V10 are not accepted.
  - `ScoreStore.saveSuccessful` currently fences only content/assignment revisions. Job publication must additionally lock/validate task token, generation, selected score target and catalog epoch before calling its transaction-aware equivalent. Category/tag publishers need the same captured-basis discipline; old success cannot overwrite a new failure/generation or resurrect a merged tag.
  - Add static queues only through `main.ts`'s explicit migration/provision path. Start pg-boss for processing even when FreshRSS/Karakeep are disabled; do not nest processing inside an import worker or require provider credentials for reader startup.
  - Generalize `GET /processing-tasks/:id`, currently Karakeep-only, with action-discriminated DTOs while preserving its existing bookmark fields for Karakeep callers.
- **Routes:**
  - GET/POST `/categories`; PATCH `/categories/:id` including archive; protected fallback cannot be archived.
  - GET/POST `/tags`; PATCH `/tags/:id` including archive; PUT/DELETE `/articles/:id/tags/:tagId` changes only associations. Adding permits active existing IDs; catalog POST creates a new technical name.
  - GET/POST `/scores`; PATCH `/scores/:id`; DELETE `/scores/:id` is soft deletion. Category overrides and selected context fields are validated parts of a score definition.
  - POST `/articles/:id/reevaluations`; POST `/articles/:id/content-retries`; GET/PATCH `/settings/ai`, `/settings/limits`, `/settings/content`, and `/settings/summary` as the feature appears.
  - GET `/usage` reports day/bucket counts, pauses, known/reported/estimated/unknown usage separately. No secret values or complete global preference table in article AI context.
- **Settings UI:** Editable catalog/score/prompt/model/limit/schedule forms with validation and explicit saving; show provider/data-disclosure labels and unavailable capabilities.
  - Disabled definitions remain historical but are not automatic targets or selectable active sorts; deleting Signal switches the default sort to date.
  - Article view distinguishes unassessed, previous successful/old, condensed, limited, failed new attempt, and budget/auth pause. No automatic low-score filter.
- **References:** AC6–AC8, AC10–AC11, AC14, AC19–AC20 / V6, V10–V15.

### C16 — Enrichment verification additions

- Fake Pi endpoints and injected AI port cover deterministic behavior; real provider calls are only V15.
- Capture exact outbound classifier state per score to detect disabled-field/global-preference leakage and hidden post-multiplication.
- Instrument HTTP attempts below Pi, not just application adapter invocations, for V11. Include SDK compaction, cancellation, invalid responses, and resumed sessions.
- Detailed cases are centralized in V10–V15.

### C17–C18 — Targeted preference feedback and merge

- **Domain:** `weight(offset, votes, asOf, halfLifeDays)` implements AC13 exactly using elapsed milliseconds/86,400,000; use one `asOf` instant for a calculation batch.
  - Half-life finite and positive, default 90. Offset finite, neutral vote zero; never clamp raw weights. Future vote timestamps are invalid rather than amplifying weights.
  - Counts are raw positive/negative vote counts, not rounded decayed counts; render weights with readable precision while sorting by raw values.
- **Persistence:** Separate `tag_votes` and `source_votes`, real FKs, unique article/target, value check `-1,0,1`; no FK from votes to mutable `article_tags`.
  - Each explicit vote action updates its timestamp, even same value. Deletion removes vote; neutralization keeps zero with refreshed timestamp.
  - Allow editing/removing a historical detached vote, but do not permit a new arbitrary tag target never associated/voted on that article. Source must match the article's source.
- **Routes:** POST `/articles/:id/feedback` with `{ value: -1|0|1, targets: [{ type:'tag'|'source', id }] }`; nonempty distinct targets, all-or-nothing validation/transaction.
  - DELETE `/articles/:id/feedback/tags/:tagId` and `/sources/:sourceId`; repeated deletion is harmless.
  - GET `/preferences/tags`, `/preferences/sources` with query/sort/cursor; PATCH `/tags/:id/preference`, `/sources/:id/preference` with finite `manualOffset`; PATCH `/settings/preferences` with half-life.
  - POST `/tags/merge` with `{ targetId, sourceIds: UUID[] }`; at least one distinct source, target excluded, all active/existing.
- **Merge transaction:**
  1. Serialize catalog mutation and affected article writes; lock tag IDs and affected articles in deterministic order. Votes/association edits use the same lock order to prevent a missed concurrent vote.
  2. Read **all** participating votes, including target and detached votes, grouped per article. Compute sign of the original total once; preserve latest participating timestamp. Articles with no vote receive none.
  3. Add offsets; union associations; replace votes with one target vote; increment relevant assignment/catalog revisions to fence in-flight jobs.
  4. Remove old associations/votes/override references and hard-delete source tags only after constraints are satisfied. Commit once; errors expose no partial merge.
  - Never merge pairwise with intermediate sign truncation. No timestamp refresh to merge time and no automatic score recomputation.
- **UI:** Thumb opens multi-target picker, never an article vote. Show previously voted detached targets separately. Preference settings support name search/raw-value sorting and explicit offset edits.
- **Score integration:** Compute only relevant article tag/source weights at call time and only for enabled context fields; reuse actual votes/offsets in this dirty tree, not a zero-weight D2 stub.
  - Read half-life and relevant weights at one `asOf` instant per request. Excluded fields must be absent from the final request and every chunk/reduction prompt.
  - Automatic tag publication must acquire the same catalog-epoch → sorted catalog targets → article → task order as merge-compatible writes. Capture epoch before inference; compare under lock at publication. A merge during inference supersedes the stale result even if the article had no participating association when the merge began.
  - Extend existing assignment/score fences rather than assuming the local merge tests cover future publishers. Votes/offset edits affect later explicit calls; they enqueue no automatic reevaluation.
- **References:** AC8–AC13 / V16.

### C19 — Video pipeline and controlled media

- **Entry:** `prepareVideo(articleId, generation)` supplies the same content/quality port as article preparation; downstream taxonomy/scores are reused.
- **Mechanics:**
  1. Resolve supported video metadata and usable human/automatic subtitles with yt-dlp; normalize timestamped cues, remove duplicated overlapping cues, keep language/provenance.
  2. If no usable subtitles, reserve temporary storage and download audio only; no arbitrary default video duration/daily audio cap.
  3. ffmpeg consumes local input only and emits mono PCM segments, initially 10 minutes with two-second overlap. One global local transcription process; initial two CPU threads.
  4. Benchmark candidate: pinned whisper.cpp multilingual `small`, initially Q5 quantization if supported by that build. Version/model hash and download source are recorded before installation; never select `.en`.
  5. Persist segment transcript/timestamps and checkpoint after each success. Merge using time-aligned overlap, preserve uncovered ranges; do not guess missing speech.
  6. Publish full transcript only after required segments complete; then run existing quality/category/tags/score jobs. Partial transcripts/errors remain visible and are not a completed video success.
- **Media data:** Store language, duration, subtitle/transcription method, completed intervals, generation, audio minutes, queue/start/complete times and resource diagnostics. Full transcript lives in PostgreSQL, not only temp files.
- **Subprocess safety:** Spawn argument arrays with shell disabled; executable paths and flags application-owned; no user-provided flags, cookies, browser extraction, plugin directories or inherited secrets.
  - Use yt-dlp ignoring personal config/plugins, no playlists/external downloaders, and route every HTTP(S) connection through a loopback-only application-owned egress proxy.
  - Proxy validates DNS/IP/ports for each HTTP target and CONNECT, pins the approved address, and refuses non-public/unsupported destinations; CONNECT cannot connect to an unvalidated numeric target. Never expose this proxy as a general LAN service.
  - ffmpeg/whisper have no remote input URL; protocol allowlist only local files/pipes as required. Do not let yt-dlp invoke unrestricted network-capable ffmpeg postprocessing.
  - V18 must prove redirects/manifests/CDN fetches cannot reach blocked targets; proxy configuration alone is not proof. Unsupported downloader paths fail closed, not direct-network fallback.
- **Resource guards:** Separate ephemeral workspace with configurable byte budget/minimum free space; reserve before download and enforce during streaming, not only via Content-Length.
  - Before video processing is enabled, operator supplies a measured temp-storage budget and container resource profile. Missing profile pauses video work, not import/reader.
  - Storage exhaustion pauses as needs-input with reason `temporary_storage`; never fills disk or discards the article. Cleanup final files at success/terminal failure and scan orphan workspaces at startup/on schedule; retain DB checkpoints.
  - Derive each segment timeout from measured throughput with reserve and set pg-boss expiry above it; heartbeat while active. Kill process group on timeout/SIGTERM and verify no orphan children.
  - Local audio minutes are recorded by actual processed segments, retries included. Optional audio quota configurable, disabled by default. Explicit remote transcription requires endpoint/auth/configuration and data-disclosure consent; no automatic paid fallback.
- **Capacity visibility:** Queue age, oldest item, observed throughput and estimated completion when measurable; unknown estimates stay unknown.
  - Track pending/paused/failed/completed and overdue-four-hour videos separately. Completion requires transcript, quality, category, tags, and applicable active score targets; never count failed/paused work as success.
  - New score definitions do not retroactively change old automatic targets; use C14's import targets and explicit reevaluation semantics.
- **References:** AC5–AC6, AC19–AC21 / V17–V19.

### C20 — Media evidence and capacity gate

- Manifest references operator-supplied legally usable local DE/EN recordings, videos/subtitle fixtures, durations, transcript references, and expected facts; no unreviewed media/model downloads during planning.
- `benchmark:media` emits JSON with CPU/architecture, pinned executable/model hashes, thread count, duration, real-time factor, peak RSS, temp peak, errors, and concurrent reader latency.
- Initial profile is a benchmark candidate only. Failure requires a decision on more resources, alternate measured local model, or explicitly configured API transcription; executor cannot declare the candidate suitable by default.
- V19 tests a real four-hour arrival window plus all queued/downstream work and reports the initial backlog separately without excluding it silently.

### C21 — Requested summaries

- **Entry:** `summarizeArticle(articleId)`; POST `/articles/:id/summaries`, optional `{ regenerate: true }` for explicit replacement. Return saved current result on ordinary repeat if no new generation requested; active generation is coalesced.
- Requires usable stored article/transcript; missing basis returns a visible prerequisite/422, not automatic fabricated summary or unrequested refetch.
- Use current configurable German summary prompt through regular Pi generation and C13, charged interactive; quality limitations included in the prompt/result metadata.
- `article_summaries` holds last successful result/time/basis. Store candidate only after successful validation and revision/token checks; failed regeneration leaves previous summary and visible failed attempt.
- UI displays existing summary immediately, progress/error separately, and offers an explicit regenerate action.
- **References:** AC15, AC19–AC20 / V20.

### C22 — Mail queue contract

- **States:** `not_selected`, `selected`, `sent`; initialize existing rows to not selected through migration. No coupling to read status, votes, Karakeep or FreshRSS.
- PUT `/articles/:id/mail-selection` with `{ selected: boolean }` changes only the first two states; attempting to reset sent returns `409 MAIL_ALREADY_SENT`.
- GET `/mail-queue?limit&cursor` returns `{ items, nextCursor }`, selected/unsent only, ordered selection time/UUID ascending.
  - Item includes stable internal ID, original URL/title/source/author/dates/kind, available text/transcript/summary, and explicit missing/limited processing states. Never wait indefinitely or invent content for incomplete items.
  - Pagination is not a mail lease or snapshot. Consumer owns send/retry coordination.
- POST `/mail-queue/acknowledgements` with `{ articleIds: UUID[] }`, nonempty/max 100/deduplicated; response `{ confirmed: UUID[], alreadyConfirmed: UUID[], rejected: [{ id, code }] }`.
  - In a transaction, lock addressed articles; selected → sent, sent → already confirmed, unknown/not selected → rejected. Mixed input has per-ID outcomes, not unintended state changes or whole-feed mutation.
  - Concurrent unselect/ack serializes: whichever locks first determines the valid transition. Repeated confirmation is idempotent.
- UI displays sent without a reset toggle. Document that successful mail send plus lost API acknowledgement can still produce duplicate delivery in the external consumer.
- **Remaining integration:** `MailStore.list` currently hardcodes missing transcript/summary. Project real persisted D4 transcript and C21 summary when available, with truthful limited/missing states, using the existing queue item schema extended compatibly. Do not couple queue visibility/ack to processing completion or implement a mail sender/consumer service.
- **References:** AC17 / V21.

### C23 — Karakeep

- POST `/articles/:id/karakeep` creates/coalesces a task; GET task/detail exposes outcome without creating a new article status/tag.
- Dedicated integration uses configured base authority and deployment-only bearer token; never uses article network allowance for its private endpoint.
- Send only `{ type: 'link', url: article.originalUrl }` to `/api/v1/bookmarks`; do not mutate existing bookmarks, favorites, tags, or notes.
  - Treat documented `201` created and `200` existing as success after validating returned bookmark ID/type/URL semantics.
  - Before retrying ambiguous timeout, GET `/api/v1/bookmarks/check-url?url=...`; reconcile documented fragment/trailing-slash normalization without changing stored original article URL.
  - If deployed API lacks reliable lookup/duplicate behavior, mark uncertain/needs-input and require explicit retry; do not blindly post repeatedly or claim exactly-once.
  - Auth/config error pauses only this integration. Bounded transient retry follows C4 and never retries a terminal validation error.
- Persist last successful/uncertain operation data in processing task result metadata; no bookmark-history subsystem or global deduplication feature.
- **References:** AC16, AC21 / V22.

### C24 — Persistent restricted chat and no-key search

- **Storage:** `chat_session_refs` maps internal UUID to controlled Pi session path/ID and operational metadata. Pi JSONL is authoritative conversation storage; DB stores no duplicate transcript.
  - `SessionManager.create/open` uses `/data/pi-sessions` and an application-owned cwd. Resolve/canonicalize real paths under that directory, reject symlink/path traversal, and never accept a client file path.
  - Restore/resume with C11's exact allowlist/resource loader/admitted stream; no fallback model selected by SDK without explicit application configuration.
- **Routes:** GET/POST `/chat/sessions`; GET `/chat/sessions/:id`; POST `/chat/sessions/:id/messages` with `{ text, articleIds: UUID[], clientMessageId: UUID }`; POST `/chat/sessions/:id/abort`.
  - POST returns `202 { turnId, state, reused }`; stable client message ID avoids double append on response loss. One active turn per session; another message gets `409 CHAT_BUSY`.
  - Persist turn intent before appending. Append a session marker carrying `clientMessageId`; recovery checks authoritative session entries before any re-append to resolve crash between DB and session-file writes.
  - On crash mark interrupted, reload saved session, and let user explicitly continue; never blindly repeat the last message/provider call as a job retry. Client disconnect alone does not abort the turn.
  - Subscribe before prompting; forward `message_update` text deltas, authoritative `message_end`, and `agent_settled` to SSE with session/turn IDs. After reconnect fetch session snapshot; missed deltas are not data loss.
- **Tools, exact allowlist:** `article_metadata`, `article_content`, `article_chunks`, `web_search`, `web_fetch`.
  - Article tools accept internal IDs and bounded ranges. Access restricted to explicitly referenced/session-attached articles; no global data export, state mutation, arbitrary files, secrets, or shell.
  - Content returns revision, offsets/time ranges and continuation; default 8,000/max 15,000 characters. No automatic injection of unlimited full articles into chat history.
  - Extraction agent may share only `web_search`/`web_fetch`; no article write capability is introduced.
- **Search:** Repository-owned adapter implemented as an unwired slice; offline evidence and limits in `docs/verification.md`. Contract: `search(query, maxResults=5, signal): { provider, results:[{title,url,snippet}] }`.
  - Trim nonempty query, max 500 characters; result count 1–10. GET DuckDuckGo HTML, parse inspected selectors/redirects; then Bing RSS on unavailable HTTP response or detected challenge/parser failure.
  - One 250-ms retry per provider for transient `202`, `429`, `5xx`, honoring bounded `Retry-After`; max four network attempts for one search call. No captcha bypass, headless browser or authenticated scraping.
  - Successful valid empty results remain empty; a challenge or malformed page is not reported as a successful zero-result search. Both providers failing yields visible `SEARCH_UNAVAILABLE`.
  - No API key or shipped local index/service. Queries still leave the host to DuckDuckGo/Bing; document this disclosure and lack of availability/SLA guarantee. Do not log raw queries.
  - Use C12's pinned public request path, 2 MiB search response limit, 20-second total deadline, cancellation, normalized/deduplicated safe result URLs. Search parsing uses bounded terminable workers and a conservative XML 1.0 subset validator without DTD or external entities; this is not a standards-complete XML parser. Only recognized result or explicit supported empty shapes count as success.
  - `web_fetch` returns bounded readable pages with `requestedUrl`, canonical `finalUrl`, content, truncation and continuation offsets. Search snippets/page text use an explicit untrusted-data envelope; no instructions from them become permissions.
- **Turn limits:** Interactive request bucket; max 10 model requests, 20 tool calls, 120 seconds initially. Count all continuations/compaction separately; abort at next safe boundary and persist a visible limit/error state.
  - Auto compaction remains disabled. Before context exhaustion explicitly compact via the admitted SDK stream, preserving references; if there is no budget, stop visibly with session intact.
  - Dispose idle sessions and re-open on demand; use bounded active-session memory. No pg-boss replay of a chat turn.
- **Shared search:** C12 remains fetch-only until C24 adds `web_search`; then extraction may share only those two read-only web tools. Search is not a separate delivery or service.
- **UI:** Copy-to-chat adds references to draft input without sending; multi-select supported. New/list/resume chat, per-turn progress/errors, abort, reconnect and offline state; sanitized Markdown only.
- **References:** AC18–AC21 / V11, V14, V23–V24.

### C25 — Documentation and evidence

- `docs/api.md` explains generated contract discovery and semantic examples for pagination, asynchronous actions, mail acknowledgements and chat reconnection; generated schemas remain authoritative for shapes.
- `docs/verification.md` records AC/V coverage and actual results/environment, distinguishing fixtures, isolated integrations, benchmarks and operator live checks. Do not rewrite source-spec status to imply implementation approval.
- Extend operations after each delivery: new secret references/model roles, limits, pending work recovery, PWA/network disclosure, media profile, and matched DB/Pi backup/restore.
- No credentials, complete personal URLs, copyrighted full media, or sensitive conversation bodies in evidence artifacts. Retain compact sanitized fixtures/results.

## Verification

- **Strategy:**
  - Unit/API tests cover business semantics and validation with deterministic clocks/transports.
  - Real PostgreSQL integration tests cover uniqueness, transactions, lock races, queue coupling and migration/restart.
  - Fake provider/subprocess tests expose hidden attempts, unsafe egress and stale writes without model cost.
  - Playwright covers desktop/mobile flows and online-only behavior; physical phone/proxy/restore checks cover deployment realities.
  - Isolated live proofs and target-host measurements gate claims that fixtures cannot establish.
- **Status:** V1–V25 remain acceptance gates. Some component checks have passed locally, but no V gate or D delivery is marked fully accepted by this status update. Check evidence and limitations are summarized below and maintained in `docs/verification.md`; package-level pass/review is not product acceptance.
- **C1 isolated compatibility evidence (supplied evaluation results; not independently rerun here):**
  - Disposable installation passed under Node `24.21.0` and npm `11.19.0` with a byte-identical copy of the unchanged npm policy. The exact C1 Pi pins and root-override versions resolved.
  - `npm audit --omit=dev`: 0 findings. Full dev-inclusive audit still had 8 findings: 4 low and 4 moderate.
  - Temporary project checks passed: 44 unit tests, 24 integration tests, 5 E2E tests, typecheck, lint, and build.
  - Focused static checks and a Pi SDK fake-provider stream plus `maxRetries: 0` single-wire-request probe passed.
  - No real provider or FreshRSS traffic occurred.
  - **Limits:** Compatibility evidence only, not exhaustive proof, C11 completion, or a claim that all dependencies are globally secure. C11 implementation requirements, all V11 cases, V15, and production approval gates remain unchanged.
- **Execution prerequisites:** Use `mise exec node@24.21.0 -- <npm command>` from the root, or verify that exact Node is already active. This planner has file tools only; the executor needs command execution, mise/Node/npm, Docker socket access, cached `postgres:18`, and Chromium.
  - Existing integration/API and real-server E2E suites create their own disposable PostgreSQL 18 containers (`--pull=never`, loopback, no external DB URL); extend that pattern. `compose.test.yaml` is optional for manual experiments, not a suite prerequisite or a `TEST_DATABASE_URL` contract.
  - Use the documented cached Chromium 1243 through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` only after checking its path exists; otherwise report the missing compatible browser. No silent browser/model/media download.
  - Build before Playwright; never overlap build with E2E. Use `npm exec -- vitest run <files>` for focused checks: appending paths to the existing broad npm test scripts does not narrow their original directory arguments.
  - Files named below but absent from the change table's current inventory are planned tests; create them in the owning change before invoking their gate. Missing tests or zero matched tests are not a pass.
  - Live suites require their matching `RUN_LIVE_*` flag, explicit isolated endpoints/accounts, and `ALLOW_INTEGRATION_WRITES=isolated-fixtures` for mutations. Pi calls also require operator cost/data-disclosure authorization.
  - Missing prerequisites are reported as unavailable, not counted as passed/skipped acceptance evidence. Never run live suites against production by default.

| ID | Changes / criteria | Procedure / command | Expected signal |
| --- | --- | --- | --- |
| V0 | All / preservation constraint | Before writes: `git branch --show-current`, `git rev-parse --short HEAD`, `git status --short --untracked-files=all`, `git diff --stat`, `git diff --cached --stat`; inspect affected diffs. At exit compare against that inventory and run staged/unstaged `git diff --check`; inspect newly created files too. | Starting user work identified and retained; only scoped additive/targeted changes; no Git-state mutation. |
| V1 | C1–C2, C7–C8 / AC21 | `npm ci && npm run typecheck && npm run lint && npm run build` | Locked compatible install; server/browser compile; no server/secret imports in UI bundle. |
| V2 | C3–C4, C9 / AC3, AC21 | `npm exec -- vitest run tests/integration/postgres.test.ts tests/integration/import-jobs.test.ts tests/integration/usage-migrations.test.ts tests/integration/article-jobs.test.ts` | Empty/upgrade migrations pass; app row and pg-boss job commit/rollback together; runtime does no DDL. |
| V3 | C3–C5, C9 / AC1–AC2 | `npm exec -- vitest run tests/unit/scan-unread.test.ts tests/unit/freshrss.test.ts tests/integration/import-jobs.test.ts tests/integration/postgres.test.ts` | Exact-ID deduplication, whole-scan-before-ack, durable pending ack and injected-failure cases below pass. |
| V4 | C4, C9 / AC3, AC6, AC20 | `npm exec -- vitest run tests/integration/import-jobs.test.ts tests/integration/article-jobs.test.ts tests/integration/context-recovery.test.ts` | One import; coalesced starts; fenced/restartable work; later import proceeds despite older paused article jobs. |
| V5 | C5, C9 / AC1–AC3 | `RUN_LIVE_FRESHRSS=1 npm run test:live -- tests/live/freshrss.live.test.ts` in an authorized disposable installation matching deployed version | Recorded pagination/ID/read/token/hidden-feed/favorites compatibility; only fixture IDs change. |
| V6 | C6, C9, C14–C16 / AC11, AC14 | `npm exec -- vitest run tests/integration/postgres.test.ts tests/integration/scores-api.test.ts tests/api/enrichment.test.ts`; `npm run test:e2e -- tests/e2e/scores.spec.ts tests/e2e/server-reader.spec.ts` | Global filter/order/null/tie/cursor semantics work across multiple pages and score removal. |
| V7 | C6–C9 / AC3, AC14, AC21 | `npm exec -- vitest run tests/api/security.test.ts tests/integration/import-jobs.test.ts tests/api/enrichment.test.ts`; extend these with listener-based SSE/reconnect cases | Schema errors/redaction/host-origin rules; bounded SSE; reconnect snapshot and action coalescing. |
| V8 | C7–C9, C25 / AC14 | `npm run test:e2e -- tests/e2e/reader.spec.ts tests/e2e/pwa.spec.ts`; authorized phone/Nginx Proxy Manager check | Mobile/desktop reader and install work; shell-only cache; offline writes impossible; SSE not buffered. |
| V9 | C8, C25 / AC3, AC21 | `docker build --pull=false -t feedrafter:verification . && bash tests/container/operations.sh feedrafter:verification`; `npm exec -- vitest run tests/integration/restore.test.ts` | Non-root single app service, persistent read/results, no startup migration, matched DB restore. |
| V10 | C10, C14–C16 / AC6–AC8, AC10–AC11 | `npm exec -- vitest run tests/unit/enrichment.test.ts tests/integration/enrichment.test.ts tests/integration/assignments.test.ts tests/integration/content-publication.test.ts tests/integration/article-jobs.test.ts tests/api/enrichment.test.ts`; `npm run test:e2e -- tests/e2e/enrichment.spec.ts` | Category/tag/config/score/reevaluation and preservation cases below pass. |
| V11 | C10–C11, C16, C24 / AC19–AC20 | `npm exec -- vitest run tests/integration/budgets.test.ts tests/integration/pi-sessions.test.ts tests/unit/setup-ai.test.ts tests/unit/ai-lifecycle.test.ts` using actual workflow callers and fake-provider wire counters | Every actual direct/SDK attempt admitted; concurrency/day races cannot overspend; no hidden retries/warming. |
| V12 | C12, C16 / AC4, AC6 | `npm exec -- vitest run tests/unit/prepare-article.test.ts tests/unit/public-web.test.ts tests/integration/public-web.test.ts tests/api/enrichment.test.ts` | Article/paywall/error/unusable/limited paths distinguished; fallback source permissions enforced. |
| V13 | C13, C16 / AC6, AC10–AC11, AC20 | `npm exec -- vitest run tests/unit/prepare-context.test.ts tests/integration/context-recovery.test.ts` | Full coverage, isolated contexts, generation checkpoints, reduction bounds, pause/resume and truthful provenance. |
| V14 | C6, C11–C12, C19, C24 / AC18–AC21 | `npm exec -- vitest run tests/unit/public-address.test.ts tests/unit/pi-resource-loader.test.ts tests/api/security.test.ts tests/integration/public-web.test.ts tests/integration/pi-sessions.test.ts tests/integration/search.test.ts tests/integration/chat.test.ts`; media-specific proof in V18 | SSRF/DNS/redirect/HTML/prompt-injection/tool/path boundaries hold without exposing integrations/secrets. |
| V15 | C11, C16 / AC19–AC21 | `RUN_LIVE_PI=1 npm run test:live -- tests/live/pi.live.test.ts` from built container | Headless OAuth/persistence/refresh and JEV bool/choice/score work; exact model IDs/limits and attempts recorded. |
| V16 | C17–C18 / AC8–AC13 | `npm exec -- vitest run tests/unit/preferences.test.ts tests/integration/preferences.test.ts tests/integration/preference-admin.test.ts tests/integration/tag-merge.test.ts tests/integration/assignments.test.ts tests/integration/article-jobs.test.ts tests/api/preferences.test.ts`; `npm run test:e2e -- tests/e2e/preferences.spec.ts` | Decay/timestamps/detached votes/offsets and atomic order-independent merge satisfy cases below. |
| V17 | C19–C20 / AC5–AC6, AC20–AC21 | `npm exec -- vitest run tests/unit/media.test.ts tests/integration/media.test.ts tests/integration/video-recovery.test.ts`; `npm run test:e2e -- tests/e2e/video.spec.ts` | Subtitle-first processing, limits/cleanup/checkpoints/fencing and no silent API fallback. |
| V18 | C12, C19–C20 / AC21 | `npm exec -- vitest run tests/integration/media-egress.test.ts` with instrumented proxy/downloader fixtures | Every supported media connection obeys public-network policy; forbidden direct paths/redirects fail closed. |
| V19 | C19–C20 / AC5, AC20–AC21 | `npm run benchmark:media -- --manifest <local-manifest> --output <sanitized-result>`; `RUN_LIVE_VIDEO=1 npm run test:live -- tests/live/video-capacity.live.test.ts` on target host | Measured usable DE/EN transcripts and full representative workload within four hours, or explicit failed capacity gate. |
| V20 | C21 / AC15, AC19–AC20 | `npm exec -- vitest run tests/integration/summaries.test.ts`; `npm run test:e2e -- tests/e2e/summaries.spec.ts` | Interactive admission, coalescing, missing/limited content and successful-only replacement. |
| V21 | C22 / AC17 | `npm exec -- vitest run tests/integration/mail.test.ts tests/api/mail.test.ts`; `npm run test:e2e -- tests/e2e/reader.spec.ts`; isolated consumer contract exercise described below | Selection and per-ID idempotent ack correct under races; read state unchanged; app sends no mail. |
| V22 | C23 / AC16 | `npm exec -- vitest run tests/unit/karakeep.test.ts tests/integration/karakeep.test.ts`; `npm run test:e2e -- tests/e2e/karakeep.spec.ts tests/e2e/karakeep-extra.spec.ts`; separately authorized `RUN_LIVE_KARAKEEP=1 npm run test:live -- tests/live/karakeep.live.test.ts` | Original-URL-only create, existing/ambiguous outcomes and supported lookup verified without altering old bookmarks. |
| V23 | C8, C11, C24–C25 / AC18–AC21 | `npm exec -- vitest run tests/integration/restore.test.ts`; separately authorized `RUN_LIVE_RESTORE=1 npm run test:live -- tests/live/session-restore.live.test.ts` in an empty isolated environment | DB/read/results/jobs plus matching Pi sessions/credentials restore; session resumes safely after restart. |
| V24 | C24 / AC18–AC20 | `npm exec -- vitest run tests/unit/search.test.ts tests/integration/chat.test.ts tests/integration/search.test.ts`; `npm run test:e2e -- tests/e2e/chat.spec.ts`; optional authorized `RUN_LIVE_SEARCH=1 npm run test:live -- tests/live/search.live.test.ts` | No-key search parsing/failure bounds; safe session/reference/turn/reconnect behavior below. |
| V25 | All / AC1–AC21 | `npm run typecheck && npm run lint && npm run build && npm exec -- drizzle-kit check && npm run test:unit && npm run test:integration && npm run test:e2e`; reconcile AC/V/D evidence and V0 final diff | All implemented deliveries green; no acceptance claim based only on skipped live checks or suite exit. |

### Required cases by check

- **V2:** Force exception after app insert/before enqueue, after enqueue/before commit, and after successful commit/before worker start. A rollback leaves neither entity; a commit leaves recoverable work. Check FK/state/identity constraints, migration lock and incompatible-schema readiness.
- **V3–V5:**
  - At least three unread pages; first import includes old entries and distinct IDs sharing one URL. IDs larger than `Number.MAX_SAFE_INTEGER` remain exact.
  - No edit-tag request before the last page's commit; acknowledgement retry cannot overlap pagination. Mid-page HTTP/DB failure means no acknowledgements for that scan.
  - Restart after page commit and after full-scan checkpoint; lost read response; already-read/absent pending IDs; auth expiry; repeated/malformed cursor; partial response; permanent errors.
  - Reimport retains read status, manual category/tags, feedback, mail selection and prior content/scores once later deliveries add them.
  - Concurrent manual/scheduled starts return one run; paused transcription/model tasks do not stop the next import. Hidden-feed/external-client caveats are recorded, not assumed away.
  - Live fixture favorites unchanged; inspect existing digest contract read-only before enabling production acknowledgements. No production-state proof by mutation.
- **V6:** More than 100 articles; equal scores/dates/titles, missing scores, zero scores, null publication times, every filter combination used by UI, ascending/descending across page boundaries, literal `%`/`_`, cursor/filter mismatch, bad cursor and concurrent edits. Deleted Signal defaults to date; an explicitly deleted sort ID is rejected.
- **V7–V9:** Malformed JSON/unknown fields, foreign Origin/Host, spoofed forwarding, unauthenticated private-network client assumptions, redacted failures, XSS in title/content/model output, slow SSE client, reconnect while task completes, worker restart. Inspect Cache Storage/localStorage/IndexedDB for article/chat payload absence; physically install on a phone and confirm VPN-off behavior.
- **V10:**
  - Extend `enrichment.test.ts`, `assignments.test.ts`, `content-publication.test.ts`, new `article-jobs.test.ts`/API/E2E files using the existing disposable DB and Fastify-injection patterns. Include newly inserted vs reimported identities, import target snapshot/rollback, one task failure independent of siblings, all-active-only explicit reevaluation, and generalized task DTO compatibility with Karakeep.
  - Fallback/manual/archived category, idempotent seeds, tag normalization/concurrent creation/max ten/valid zero tags, stale automatic assignment and independent failed article.
  - Editable prompt/category override, each context checkbox, relevant-only preferences, no arithmetic multiplier, score boundaries 0/100, native indices 0/1.5/4 → 0/37.5/100, NaN/infinite/out-of-range rejection; category threshold just below/at 0.7.
  - New definition leaves old articles unassessed; prompt/model change causes no jobs; manual reevaluation targets all and only active definitions without retagging; failed refresh retains old value/time/basis.
- **V11:** Concurrent requests with one remaining slot, UTC rollover using fake clock, in-flight previous-day completion, auth-wide pause/recovery, cancellation before/after dispatch, process death with unknown usage, fallback and context-reduction requests, SDK multi-tool turn, explicit compaction and restored session. Correlate every inference wire send to one prior committed, un-reused permit/reservation; each admitted callback produces at most one send. Counted pre-dispatch cancellation/auth failure may have zero sends, never an extra send or refund. An exhausted bucket causes zero additional inference traffic. Auth login/refresh is separately observed, not inference. TypeSafe catalog-zero price is displayed unknown unless independently configured/reported.
- **V12–V14:**
  - In `prepare-article.test.ts` and `context-recovery.test.ts`, verify typed budget/auth/configuration pauses, durable candidate reuse without refetch, successful-only content publication, source permission precedence/YouTube defaults, plan-scoped chunk keys across scores/generations, old checkpoint migration and stale token/basis rejection. Keep existing UTF-16 coverage and deterministic planner-work regressions.
  - Readability success, short but valid text, navigation-only page, paywall, malformed HTML, redirect loop, decompression bomb, source-disallowed agent fallback, worker crash and safe retry.
  - Full chunk interval coverage including oversized paragraph, overlaps not counted twice, task-specific evidence, excluded-field nonleakage, multi-level reduction/no-progress failure, budget pause, invalid output, generation/content revision changes, explicit fresh evaluation and direct-call fast path.
  - IPv4/IPv6 mapped/private/metadata/reserved addresses, mixed public/private DNS answers, rebinding, malicious redirect, TLS SNI, unsupported scheme/ports/userinfo; fake integration secrets/endpoints never become available to public fetch tools.
  - Malicious article asks agent to run bash/read credentials/write mail: tools are absent and state unchanged. No HTML script/event handler executes in reader/chat.
- **V15:** Use only expressly authorized test content. Verify JEV answer structures and context/size errors; selected Codex model supports required generation/tool behavior; setup via browser/headless fallback, writable persisted auth, container restart and token refresh. No credential bytes in logs/API/browser bundle.
- **V16:**
  - Votes at ages 0/90/180 days contribute 1/0.5/0.25; fractional days, non-UTC timezones, neutral/delete/same-value revote, finite offsets and configurable half-life. Manual offset never decays.
  - Tag removal preserves/editable vote; new arbitrary target rejected; invalid multi-target feedback writes nothing. UI picker never creates an article-level vote.
  - Merge `(+1,+1,-1) → +1` under every source order, `(+1,-1) → 0`, include target's vote/offset, latest old timestamp, detached vote, duplicate association, no-vote article, concurrent vote, rollback at each write phase and stale model result.
  - Controlled real examples check that enabling preference context can influence personal relevance without altering Hype/Facts/Signal by arithmetic; record model variability rather than asserting a universal direction from one stochastic response.
- **V17–V19:**
  - Subtitles avoid audio/transcription; absent/bad subtitles trigger audio; unsupported/private video remains visible; DE/EN/long audio, overlap merge, process timeout, no secrets in child env, storage unknown/full/oversize/chunk checkpoint/orphan cleanup and restart.
  - Instrument yt-dlp metadata/subtitle/audio/CDN/manifests and redirections; ffmpeg cannot open HTTP input; blocked schemes/private CONNECT/IP targets cannot escape proxy.
  - Benchmark transcript quality: no missing full segments, preserved named entities/numbers/key facts against supplied references, timed sample comparison by operator; report inaccuracies, not a manufactured precision guarantee.
  - Compare reader p95 latency under transcription to idle baseline; pilot guard is <=1 second and <=2x baseline on representative list/detail requests. Do not increase thread/RAM use silently to pass.
  - Four-hour test measures from `imported_at` to all required automatic outputs, including queue/model budgets; classify every overdue/failed/paused input. Measure incoming video hours, subtitle coverage, CPU model/throughput/temp/RSS and background-service impact. Unobserved representative load means gate unavailable, not passed.
- **V20–V22:** Extend named integration/API and browser files; new summary tests follow existing content-publication and online-only reader patterns. Double-click coalescing, successful repeat, terminal/transient/auth/budget failure, old result preservation, invalid IDs, concurrent transitions, changed revisions. Mail covers mixed known/sent/not-selected/unknown IDs and repeated acknowledgement; Karakeep covers create committed but response lost, reliable lookup found/absent/unavailable, no mutation of existing bookmarks.
- **V21 consumer procedure:** Seed disposable selected article/video fixtures with available, missing and limited content plus a saved summary; fetch all queue pages from the intended consumer/test client, acknowledge only the explicit fixture IDs (no mail send), repeat the acknowledgement, and confirm read state unchanged and acknowledged IDs absent from the next queue read. Consumer ownership/version and compatibility evidence remain external; no new consumer implementation is part of D6.
- **V22 compatibility procedure:** Establish a versioned fixture/schema before recognizing lookup found/absent or URL normalization. Lost create response + lookup found → success; reliably absent → only an explicitly requested safe retry; unavailable/unrecognized lookup → `needs_input`, no new POST. Retain existing task coalescing and auth pause/restart semantics.
- **V23:** Kill after DB intent before/after session append; restore matching database/session files/credentials into empty volumes; verify article state, pending jobs, interrupted turn, session message IDs and continuation without duplicate append. Missing/mismatched files produce diagnostic failure, not a fresh replacement conversation.
- **V24:** DDG `uddg` links/duplicates/unsafe schemes, Bing XML/markup, empty valid search, HTTP200 challenge, both providers down, max four search attempts and cancellation. Chat covers multi-article draft references without auto-send, forbidden article IDs/path traversal/symlink, one active turn, stable message deduplication, budget mid-turn, tool/time cap, abort, SSE reconnect, context compaction and no built-in tools after resume.
- **V25:** Document every AC's owning delivery and checks; record unavailable/failed live gates with exact reason. Keep per-package command, environment, count and coverage evidence separate from final acceptance. The catalog POST/PATCH Playwright timeout recorded in `docs/verification.md` remains undiagnosed: on recurrence retain traces, diagnose the waiting request/server/fixture race, decide a bounded scoped fix, then rerun the focused case and whole E2E once. Retry-until-green or old passing counts cannot close V25.

## Delivery and integration

- **Approved split:** The packages below are separately deliverable increments, not workers or tracker tickets. They share the contracts and verification above.
- **Review/integration base:** Supplied `master` at `843452b` **plus the entire initial dirty/untracked tree**, not the historical planning commit. V0 records the actual baseline before writes; all predecessor work remains part of it.
- **Result transfer:** Default one executor, serial source writes in `/home/matthias/feedrafter`; locally verified predecessor code remains in this checkout. Record sanitized verification under named D/change headings in `docs/verification.md`; temporary ignored evidence may use `artifacts/<delivery>/` only after verifying it is ignored. Dependents inspect actual code/evidence, not a completion message.
  - No patch transfer, commits, merge, push, or deployment permission is implied. If an execution environment uses isolated branches/worktrees, it must obtain publication/merge authorization and define an explicit transfer before depending on their code.
- **Prerequisites below are capability dependencies only:** D1's local reader/import substrate enables D2/D6/D7 without waiting for V5/V8/target-host V9. D2's locally proven admitted processing/content interfaces enable D3/D4/D5/D8 without claiming V15 accepted. Other deliveries need not be accepted merely because their number is lower. Migration ordering/shared writes remain serial.

| Package | Independently usable result | Change IDs | Criteria / checks | Hard prerequisites |
| --- | --- | --- | --- | --- |
| D1 — Safe imported reader | Browse all durably imported entries, control personal read state, inspect import/ack/restart errors; date sorting until ranking exists. | C1–C9; D1 parts of C25 | AC1–AC3, baseline AC14/AC21; V1–V9 | None |
| D2 — Ranked text reader | Prepare original articles and rank by configurable Pi scores, with taxonomy, context coverage, safe tools and visible limits. | C10–C16; extend C1–C8/C25 | AC4, AC6–AC8, AC10–AC11, AC19–AC20, extended AC14/AC21; V1–V15, V25 | D1 |
| D3 — Personal preferences | Give targeted feedback, inspect decayed weights/offsets, merge tags transactionally, use weights in chosen scores. | C17–C18; extend C10/C14/C15/C25 | AC9, AC12–AC13, extended AC8/AC10; V10, V16, V25 | D2 |
| D4 — Automatic videos | Subtitle/transcribe and enrich videos with restartable limits and measured capacity diagnostics. | C19–C20; extend C4/C8/C14/C15/C25 | AC5, extended AC6/AC19–AC21; V11–V14, V17–V19, V25 | D2 |
| D5 — Summaries | Request and retain an article/transcript summary with safe regeneration. | C21; extend C7/C11/C15/C25 | AC15, extended AC19–AC20; V13, V20, V25 | D2 |
| D6 — Mail queue | Select entries and consume/acknowledge them externally without a sender. | C22; extend C3/C6/C7/C25 | AC17; V21, V25 | D1 |
| D7 — Karakeep action | Explicitly bookmark original URLs and reconcile uncertain duplicate outcomes. | C23; extend C6/C7/C25 | AC16; V22, V25 | D1 |
| D8 — Pi chat | Start/resume conversations about selected stored content and public web sources using no-key search. | C24; extend C6/C7/C11/C25 | AC18, extended AC19–AC21; V11, V14, V23–V25 | D2 |

### Remaining execution sequence

1. **Baseline and D1 local closure — C1–C9/C25.**
   - Perform V0; inspect scripts, journal and existing code. Run V1 and currently available D1 portions of V2–V9; baseline existing D3/D6/D7 suites. Missing future tests are not failures of already implemented D1.
   - Complete deterministic import/ack, security/SSE and shell-only PWA cases; rerun current image/restore after the latest migration. Keep operational FreshRSS mutation disabled.
   - Exit: reproducible foundation, attributed regressions and explicit external blockers. Reuse existing slices; do not reimplement them.
2. **D2 ranked text reader — C10–C16, ordered internal slices.**
   - **D2.a / shared AI boundary:** C11 P9 → P10 → P11, preserving P1–P8; focused checks and available V11 matrix. Exit: SDK create/resume/compaction, offline construction, terminal setup and lifecycle under wire-counted fakes, no real inference activation.
   - **D2.b / usable content/context:** C10/C12/C13 candidates/checkpoints/settings and restricted fallback. Exit: applicable V12–V14 extraction/context/tool cases, pause/resume and old-result retention pass.
   - **D2.c / automatic workflow:** C14 atomic import→prepare→category→tags→per-score chain, then C15 API/UI/usage/retry/Signal default. Connect actual preferences, not a zero-weight stub. Exit: V2/V4/V6/V7/V10/V11/V13/V14 on real originating workflows plus enrichment E2E.
   - These are slices of D2, not additional products. Shared AI/task/checkpoint interfaces and writes stay serial. Missing external V15 does not stop fake-backed implementation.
3. **D3 closure — C17–C18.**
   - Preserve voting/admin/merge; finish stale category/tag/score publication races and selected-field weight propagation. Exit: V10/V16 deterministic cases pass; model-effect evidence remains pending with V15 when unavailable.
4. **D5 summaries — C21.**
   - Reuse D2 context/admission/publication; add saved result/settings/explicit action. Exit: V20 and applicable V11/V13 pass for articles and synthetic transcripts. Actual transcription is not a prerequisite.
5. **D4 videos — C19–C20.**
   - Add subtitle/audio path, restricted subprocess/egress/workspace, checkpoints and common downstream chain; extend image/tool packaging and benchmark manifest/output. Pass V17/V18 controlled fixtures before any external media fetch.
   - Exit: deterministic recovery/security/UI checks pass. Missing approved artifacts/profile block corresponding real packaging/processing/benchmark, not fixture work. V19 stays unavailable until measured. Rerun D5 using persisted transcript fixtures.
6. **D6 then D7 closure — C22/C23; shared writes serial.**
   - D6: retain selection/ack; finish enriched content/transcript/summary projection and V21 local cases. External contract proof uses V21's bounded procedure, not a new sender.
   - D7: retain coalescing/auth/uncertainty; rerun V22 local cases. Encode version-specific found/absent/normalization only after its evidence arrives; otherwise preserve uncertainty and report `needs_input`.
7. **D8 chat — C24.**
   - Reuse C11 restricted sessions; add search, controlled paths, turn intent/marker reconciliation, references/tools, SSE/UI. Exit: V11/V14/V23/V24 deterministic cases, compaction/resume and matched session restore pass. Never auto-replay interrupted turns.
8. **Integrate D1–D8 — C25/V25.**
   - Run applicable feature checks, then V25 and current image/restore. Confirm imports continue during processing pauses; mail/read/preferences/bookmark/chat states remain independent; every mutation stays online-only.
   - Record exact AC/V/D passed/failed/unavailable evidence, environment and missing inputs. Return code/evidence in the dirty checkout; no commit/deployment/publication or acceptance claim for blocked deliveries.

- **Package exit discipline:** Record focused evidence plus V1 regression checks for each source slice; migrations require V2 and current readiness/restore coverage. Build before browser tests. Material failure stops affected dependents for diagnosis/decision/bounded rerun; independent local packages may continue.
- **Scope gates:**
  - D1 production acknowledgement remains disabled until V5 and existing digest compatibility are established in isolation/read-only inspection.
  - D2 real AI automation remains disabled until V11 and V15 prove admission/auth; importing/reading may continue without credentials.
  - D4 local transcription is not declared production-capable until V18 and V19 pass with configured host resources. Failed capacity requires explicit user decision, not relaxed acceptance.
  - D7 live bookmarking requires deployed API compatibility proof; uncertain results remain actionable, not silently retried.
  - D8 session correctness and restore require V23; no personal Pi directory or default tool discovery as a shortcut.
- **Full first-release acceptance:** All AC1–AC21 covered and required deterministic/live/physical/capacity gates evidenced. Missing gates remain unaccepted. A later explicit user waiver is a separate scope decision, never a passing V result; none is supplied here. Package completion grants no release rights.

## External acceptance gate register

- **Status:** `needs_input` for full acceptance; no new local-test results claimed. Inputs below are not permission to deploy/contact services. The coordinator arranges authorized isolated proofs/operator evidence; this request alone does not supply them.
- **No bypass:** Keep affected operational capabilities disabled/paused. Credentials, personal URLs, article/chat bodies and OAuth codes never enter plan/evidence/logs.

| Gate / checks | Missing input or evidence | Work allowed while blocked |
| --- | --- | --- |
| G1 / V5 | Running FreshRSS version; read-only favorites/digest contract; matching disposable host/account/IDs, mutation consent and safety configuration. Current live test is read-only, not ack proof. | Guarded fixture mutation/reconciliation tests and local workflows; no production acknowledgement. |
| G2 / V8 | Physical phone/browser, VPN and authorized existing Nginx Proxy Manager environment: install, VPN-off, SSE/heartbeat/buffering and sensitive-cache checks. | Playwright/PWA/security fixtures; no target deployment/proxy change. |
| G3 / V9, V23 | Current-tree disposable image/restore rerun, then operator target-environment matched DB/auth/session backup/restore proof; matching private files and empty isolated target. | Disposable container tests and synthetic session crash/restore; no production restore/switch. |
| G4 / V11, V15, V16 model-effect cases | Exact eligible built-in generative/Codex model choice and usable context limits; isolated Pi/TypeSafe credentials, cost/content-disclosure consent, container OAuth/refresh/JEV proof. SDK routes must meet one-send admission; no silent substitute. | P9–P11, workflow wiring, fake-provider counts and preference-context tests; no live login/inference or production activation. |
| G5 / V17–V19 | Approved pinned yt-dlp/ffmpeg/whisper.cpp/model artifacts, hashes/licenses/download consent; measured temp quota/container CPU/RAM profile on shared target; legal DE/EN fixtures/references and representative arrival/backlog window. | Subprocess/egress/checkpoint fixtures, benchmark harness/diagnostics; no downloads or claimed four-hour capacity. |
| G6 / V21 | Intended external consumer owner/version and isolated fetch/ack contract evidence. Actual mail send/sender correctness remain outside this app. | API tests/bounded disposable consumer procedure; no consumer service or mail delivery. |
| G7 / V22 | Deployed Karakeep version; authoritative versioned create/check-url/normalization schemas or sanitized fixtures; isolated account/token/URLs and write consent. Current lookup cannot establish absence. | Conservative client/task/UI regressions; no guessed successful lookup, duplicate create or live bookmark. |

- **Optional search probe:** V24 live DDG/Bing availability needs separate external-network consent. Deterministic parsing/limits remain required; one live pass is no SLA.
- **Failed gate:** Preserve sanitized evidence, identify failed contract, return smallest explicit decision needed; only bounded authorized rerun. No extra service, paid fallback, weaker egress, arbitrary quota or relaxed four-hour target.

## Readiness and authorization boundary

- **Local execution:** Ready for user-authorized D1–D8 implementation in the sequence above after V0 confirms tree/runtime prerequisites. No product-scope selection remains.
- **Full acceptance:** Blocked on G1–G7 where applicable and any deterministic failures. Exact model selection/media profile/artifacts belong to setup gates, not guessed defaults.
- **C11 authority:** Dependency exception and built-in-only amendment remain approved; extend existing work. Subplan “no activation” still applies to external/production inference, not implementation of remaining code/fake-backed callers.
- **Preservation:** Carefully extend in-scope files, including unfinished slices; never discard user edits, disturb staging, reset baseline or treat untracked work as disposable.
- **Not authorized:** Deployment/target installation, publication, commit/merge/push, tracker creation, production mutations or unconsented external/provider/media operations. Disposable local verification containers are tests, not deployment permission.
- **Stop/report:** Contradictory repository/API reality, unclear overlapping edits or missing prerequisite → stop affected work and return normal `needs_input` to coordinator with path/evidence/needed input. No interactive prompt, replacement architecture or silent waiver. Only unaffected local work with satisfied prerequisites may continue.
