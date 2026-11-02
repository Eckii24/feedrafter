# Agentic News Reader — Implementation Plan

## Overview

- **Outcome:** Deliver the documented first release as eight independently verifiable increments in one shared plan.
- **Scope approved:** D1–D8 below; no implementation, deployment, commit, or publication authorized by this planning task.
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

## Planned changes

- Every path below is **proposed**, except the existing `docs/` source documents. No application symbols currently exist.
- Brace notation lists concrete related files. Migration patterns identify newly generated SQL plus Drizzle journal/snapshots; review generated SQL before use.
- Shared files are extended incrementally by their owning delivery; do not install later dependencies or expose unfinished actions early.

| ID | File / area | Planned change and purpose |
| --- | --- | --- |
| C1 | `package.json`, `package-lock.json`, `.node-version`, `.npmrc`, `tsconfig{,.server,.web}.json`, `eslint.config.js`, `vite.config.ts`, `vitest.{unit,integration,live}.config.ts`, `playwright.config.ts`, `.gitignore` (new) | Establish pinned build/test tooling, strict server/browser boundaries, reproducible scripts, and C11-enabling Pi pins/root overrides under C1's user-approved exception; preserve npm policy. |
| C2 | `src/server/{main,composition-root,config,cli}.ts`, `src/server/domain/{article,processing,errors,clock}.ts`, `src/shared/{common,article,processing}.ts` (new) | Define bootstrap, pure foundational types, clock/error contracts, and runtime-validated public DTOs. |
| C3 | `src/server/adapters/postgres/{client,migrate,import-store,reader-store,task-store}.ts`, `src/server/adapters/postgres/schema/{index,import,processing}.ts`, `drizzle.config.ts`, `drizzle/*_import.sql` (new) | Persist import identity, read state, acknowledgements, settings, runs/tasks, and initial constraints/indexes. |
| C4 | `src/server/application/{start-import,run-import,recover-processing}.ts`, `src/server/ports/{unit-of-work,import-store,task-queue,freshrss}.ts`, `src/server/adapters/jobs/{runner,queues,freshrss-coordinator}.ts` (new) | Coordinate one import, transactional enqueue, scheduling, bounded retry, fencing, and restart recovery. |
| C5 | `src/server/adapters/freshrss/{client,schemas}.ts` (new) | Implement authenticated Google Reader API pagination, exact-ID acknowledgement, and ambiguous-result reconciliation. |
| C6 | `src/server/application/{list-articles,get-article,update-article}.ts`, `src/server/http/{app,security,errors,events}.ts`, `src/server/http/routes/{articles,pipeline,settings,health}.ts` (new) | Add schema-derived OpenAPI, global SQL pagination, personal read actions, progress, health, and SSE. |
| C7 | `index.html`, `src/web/{main,App}.tsx`, `src/web/api.ts`, `src/web/styles.css`, `src/web/components/{ArticleList,ArticleDetail,ProcessingStatus,OfflineNotice}.tsx`, `src/web/components/ui/{button,dialog,checkbox,select,input,badge}.tsx`, `src/web/pwa.ts`, `public/{manifest.webmanifest,icons/}` (new) | Build the responsive installable reader and shell-only cache; keep mutations online-only. |
| C8 | `Dockerfile`, `.dockerignore`, `compose.yaml`, `compose.test.yaml`, `.env.example`, `.github/workflows/ci.yml`, `README.md`, `docs/operations.md` (new) | Deliver one non-root app image, external-DB deployment example, isolated test DB, explicit migrations, setup/restore procedures, and CI. |
| C9 | `tests/helpers/{database,fixtures,fake-freshrss,fake-clock}.ts`, `tests/unit/{config,processing}.test.ts`, `tests/integration/{migrations,queue-transaction,import,reader}.test.ts`, `tests/api/{security,reader,pipeline,sse}.test.ts`, `tests/e2e/reader.spec.ts`, `tests/live/freshrss.live.test.ts` (new) | Establish test patterns and prove the first safe import/reader increment. |
| C10 | `src/shared/{settings,taxonomy,scores}.ts`, `src/server/domain/{settings,taxonomy,scores}.ts`, `src/server/adapters/postgres/schema/enrichment.ts`, `src/server/adapters/postgres/{settings-store,taxonomy-store,content-store,score-store,usage-store}.ts`, `drizzle/*_enrichment.sql` (new) | Add validated model settings, catalogs, content/chunks, score definitions/results, usage reservations, and seeds. |
| C11 | `src/server/ports/ai.ts`, `src/server/application/usage.ts`, `src/server/adapters/pi/{runtime,requests,sessions,resource-loader,setup-ai}.ts` (new); C1/C2/C8 (extend) | Share Pi authentication, implement terminal setup and restricted sessions, and gate each direct/SDK request. |
| C12 | `src/server/ports/public-web.ts`, `src/server/adapters/web/{public-url,request,readability-worker,extract}.ts`, `src/server/application/prepare-article.ts` (new) | Safely fetch and extract original content off the event loop; assess quality and run restricted source-approved fallback. |
| C13 | `src/server/application/{prepare-context,process-context-chunks}.ts`, `src/server/domain/context.ts` (new) | Implement task-specific complete-coverage chunking, hierarchical reduction, checkpoints, and provenance. |
| C14 | `src/server/application/{categorize,assign-tags,evaluate-scores,reevaluate-article}.ts`, `src/server/adapters/jobs/article-jobs.ts` (new); C3/C4/C6 (extend) | Chain preparation/category/tags/scores, protect manual edits, and add SQL score ordering without automatic historical reevaluation. |
| C15 | `src/server/http/routes/{taxonomy,scores,processing-tasks}.ts`, `src/web/components/{ScoreValues,ArticleActions}.tsx`, `src/web/pages/{Settings,TaxonomySettings,ScoreSettings,Processing}.tsx` (new); C6/C7 (extend) | Expose catalog/model/prompt/context/limit settings, content retry, all-active-score reevaluation, and processing diagnostics. |
| C16 | `tests/helpers/fake-ai.ts`, `tests/unit/{taxonomy,scores,context}.test.ts`, `tests/integration/{budgets,enrichment,context-recovery}.test.ts`, `tests/api/enrichment.test.ts`, `tests/e2e/enrichment.spec.ts`, `tests/live/pi.live.test.ts` (new) | Verify enrichment semantics, request-level accounting, restricted tools, OAuth/JEV gates, and context coverage. |
| C17 | `src/shared/preferences.ts`, `src/server/domain/preferences.ts`, `src/server/application/{vote,merge-tags,manage-preferences}.ts`, `src/server/adapters/postgres/{preference-store.ts,schema/preferences.ts}`, `src/server/http/routes/preferences.ts`, `src/web/components/FeedbackPicker.tsx`, `src/web/pages/PreferenceSettings.tsx`, `drizzle/*_preferences.sql` (new); C10/C14/C15 (extend) | Implement targeted feedback, decay/offsets, searchable preference management, and atomic multi-tag merge. |
| C18 | `tests/unit/preferences.test.ts`, `tests/integration/{preferences,tag-merge}.test.ts`, `tests/api/preferences.test.ts`, `tests/e2e/preferences.spec.ts` (new) | Cover controlled-time weights, preserved detached votes, merge collisions, races, and rollback. |
| C19 | `src/server/ports/media.ts`, `src/server/adapters/media/{download,egress-proxy,ffmpeg,whisper,workspace}.ts`, `src/server/application/prepare-video.ts`, `src/server/adapters/postgres/schema/media.ts`, `src/web/components/VideoProgress.tsx`, `drizzle/*_media.sql` (new); C4/C8/C14/C15 (extend) | Add subtitle-first video processing, bounded local transcription/checkpoints, storage protection, and deadline/backlog visibility. |
| C20 | `tests/unit/media.test.ts`, `tests/integration/{media,media-egress,video-recovery}.test.ts`, `tests/e2e/video.spec.ts`, `tests/bench/media.ts`, `tests/fixtures/media/manifest.example.json`, `tests/live/video-capacity.live.test.ts`, `docs/media-benchmark.md` (new) | Test subprocess/security/recovery behavior and measure quality, resources, and full four-hour capacity. |
| C21 | `src/shared/summaries.ts`, `src/server/application/summarize-article.ts`, `src/server/adapters/postgres/{summary-store.ts,schema/summaries.ts}`, `src/server/http/routes/summaries.ts`, `src/web/components/Summary.tsx`, `drizzle/*_summaries.sql`, `tests/integration/summaries.test.ts`, `tests/e2e/summaries.spec.ts` (new) | Add explicit persisted summaries with interactive limits and successful-replacement semantics. |
| C22 | `src/shared/mail.ts`, `src/server/domain/mail.ts`, `src/server/application/{select-mail,list-mail-queue,acknowledge-mail}.ts`, `src/server/adapters/postgres/{mail-store.ts,schema/mail.ts}`, `src/server/http/routes/mail.ts`, `src/web/components/MailSelection.tsx`, `drizzle/*_mail.sql`, `tests/integration/mail.test.ts`, `tests/api/mail.test.ts`, `tests/e2e/mail.spec.ts` (new) | Add mail selection/consumer contracts without sending mail or changing read status. |
| C23 | `src/server/ports/karakeep.ts`, `src/server/adapters/karakeep/{client,schemas}.ts`, `src/server/application/bookmark-article.ts`, `src/server/http/routes/karakeep.ts`, `src/web/components/KarakeepAction.tsx`, `tests/integration/karakeep.test.ts`, `tests/e2e/karakeep.spec.ts`, `tests/live/karakeep.live.test.ts` (new); C6/C7 (extend) | Add explicit original-URL bookmarking with bounded duplicate reconciliation and visible uncertain outcomes. |
| C24 | `src/shared/chat.ts`, `src/server/application/{chat-sessions,chat-turn}.ts`, `src/server/adapters/pi/chat-tools.ts`, `src/server/adapters/web/search.ts`, `src/server/adapters/postgres/{chat-store.ts,schema/chat.ts}`, `src/server/http/routes/chat.ts`, `src/web/pages/Chat.tsx`, `drizzle/*_chat.sql`, `tests/unit/search.test.ts`, `tests/integration/{chat,search}.test.ts`, `tests/e2e/chat.spec.ts`, `tests/live/{search,session-restore}.live.test.ts` (new); C6/C7/C11 (extend) | Add controlled persisted chat, no-key search/read tools, references, streaming, and interrupted-turn handling. |
| C25 | `docs/{api,verification}.md`, `tests/integration/restore.test.ts`, `tests/e2e/pwa.spec.ts` (new); C8 documentation/CI (extend per delivery) | Keep API/acceptance coverage, integration evidence, installation, resource configuration, backup/restore, and mobile/proxy verification accurate. |

## Implementation details

### Basis

- **Authoritative behavior:** `docs/dev-agentic-news-reader-spec.md`, AC1–AC21. Reuse these IDs; this plan does not replace their definitions.
- **Architecture authority:** `docs/architecture.md`; confirmed F1–F4 in `docs/technical-design.md`.
- **Proposal status:** Other technical-sketch details become implementation choices only where explicitly selected below. Historical `docs/dev-agentic-news-reader.md` does not override newer decisions.
- **Repository inspected:** `master`, commit `82d72823e937161287c8728066fabe08e93a899e`; four tracked documents, empty `src/`, no existing scripts/tests/dependencies.
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
- **Scripts to create:** `dev`, `build`, `start`, `typecheck`, `lint`, `test:unit`, `test:integration`, `test:e2e`, `test:live`, `db:generate`, `db:migrate`, `benchmark:media`.
  - `build` compiles server/CLI and UI; `start` runs the built CLI's `serve` command.
  - `test:integration` includes `tests/integration` and `tests/api`; `test:live` includes only `tests/live` and is excluded from normal CI.
  - Use React Testing Library for interaction tests if needed; Playwright covers full UI flows. No existing test pattern is available to extend.
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

- **New bootstrap:** `buildApplication(config, dependencies)` creates the composition root; handlers and jobs call ordinary application functions. Domain/application modules import no Fastify, Drizzle, or Pi types.
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
- **Read/update:** `GET /articles/:id`; `PATCH /articles/:id` initially `{ isRead }`, later optional `{ categoryId, expectedAssignmentRevision }`. Reading never updates FreshRSS or mail state.
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

- **New interfaces:** `AiPort.classify(request, scope)`, `AiPort.generate(request, scope)`, `AiPort.createRestrictedSession(options, scope)`; domain-facing results contain validated answers/text/usage, not SDK objects.
  - `scope = { taskId? , turnId?, bucket: automatic|interactive|classifier, signal }`; classifiers always use their dedicated bucket.
- **Runtime:** One `ModelRuntime.create({ authPath: '/data/pi-auth/auth.json', modelsPath: '/data/pi-auth/models.json', modelsStorePath: '/data/pi-auth/catalog.json', allowModelNetwork: false })` instance shared by direct requests and all sessions.
  - Use Pi auth resolution/refresh, not extracted OAuth tokens passed to unrelated clients. Only administrator-owned configuration files are read.
  - `setup-ai` calls `runtime.login(providerId, authType, interaction)` using terminal notifications/prompts; show auth URL/device code only in the interactive setup terminal, never normal application logs.
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
- **Approved defaults:** 50 automatic, 50 interactive, 2,000 classifier attempts per UTC day; concurrency 1, 1, 2 respectively. No default local audio-minute quota; audio usage is separate.
  - Source-approved extraction and automatic context work use automatic bucket. Requested summaries/chat/compaction use interactive bucket. Retrying automatic preparation retains automatic classification/generation buckets.
  - Pause at step boundaries on exhausted budgets; daily reset/settings increases wake existing paused work fairly, without blocking imports or other eligible articles.
  - Auth/permission errors pause the affected model configuration globally until repaired; do not spend one identical failed request per article.
  - Hard euro/token caps apply only when conservatively reservable; pilot guarantees are request caps, not undisclosed-cost guarantees.
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
- **References:** AC6, AC10–AC11, AC20 / V13.

### C14–C15 — Taxonomy, scoring, and settings

- **Pipeline:** content/transcript + quality → category → tags → applicable scores; successful prerequisite/result transition and enqueue are atomic.
  - At import, snapshot the IDs of active automatic score targets into waiting task records, not their prompt/model versions. Adding a definition later does not backfill old articles accidentally.
  - D1 articles remain unscored after D2 installation. Explicit per-article preparation/reevaluation may opt them into current active targets; do not add an automatic bulk backfill.
  - Valid empty tags satisfy the prerequisite; failed tags do not. One failed article/score does not block unrelated work or erase successful sibling scores.
- **Category:** Classifier choice over active category IDs plus fallback; unknown/invalid answer is an error, uncertain choice selects fallback. Manual category correction increments assignment revision; no automatic reevaluation.
- **Tags:** Regular LLM returns validated `{ tags: string[] }`, maximum ten unique normalized names; prefer a bounded relevant catalog shortlist rather than unlimited global catalog context.
  - Transactionally resolve concurrent insert collisions on normalized key, then create associations. A manually changed assignment revision fences stale automatic associations.
  - Preserve votes independently of associations in D3. No semantic merge or deletion as a side effect of model normalization.
- **Scores:** One classifier question/request per score initially, allowing independently selected context and prompt override without cross-score context leakage.
  - Current prompt/model values are read for the actual call; category override else global prompt. Weights are context only, never a post-classifier multiplier.
  - Missing selected content/prerequisites produces visible unavailable/needs-input state, not invented zero values. Validate finite 0–100 output before committing.
  - `reevaluateArticle(id)` targets all currently active definitions with current stored category/tags/content. It does not recategorize, retag, or refetch automatically.
  - Assignment/content change while a task runs makes that task superseded; no automatic new evaluation merely because a user edited metadata or voted.
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
- **Score integration:** Compute only relevant article tag/source weights at call time and only for enabled context fields; D2 before any votes uses zero weights/offsets.
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
- **Search:** New repository-owned adapter with `search(query, maxResults=5, signal): { provider, results:[{title,url,snippet}] }`.
  - Trim nonempty query, max 500 characters; result count 1–10. GET DuckDuckGo HTML, parse inspected selectors/redirects; then Bing RSS on unavailable HTTP response or detected challenge/parser failure.
  - One 250-ms retry per provider for transient `202`, `429`, `5xx`, honoring bounded `Retry-After`; max four network attempts for one search call. No captcha bypass, headless browser or authenticated scraping.
  - Successful valid empty results remain empty; a challenge or malformed page is not reported as a successful zero-result search. Both providers failing yields visible `SEARCH_UNAVAILABLE`.
  - No API key or shipped local index/service. Queries still leave the host to DuckDuckGo/Bing; document this disclosure and lack of availability/SLA guarantee. Do not log raw queries.
  - Use C12's pinned public request path, 2 MiB search response limit, 20-second total tool deadline, cancellation, XML without external entities, normalized/deduplicated safe result URLs.
  - `web_fetch` returns bounded readable pages with `requestedUrl`, canonical `finalUrl`, content, truncation and continuation offsets. Search snippets/page text use an explicit untrusted-data envelope; no instructions from them become permissions.
- **Turn limits:** Interactive request bucket; max 10 model requests, 20 tool calls, 120 seconds initially. Count all continuations/compaction separately; abort at next safe boundary and persist a visible limit/error state.
  - Auto compaction remains disabled. Before context exhaustion explicitly compact via the admitted SDK stream, preserving references; if there is no budget, stop visibly with session intact.
  - Dispose idle sessions and re-open on demand; use bounded active-session memory. No pg-boss replay of a chat turn.
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
- **Status:** All V checks below remain required; this amendment marks none complete. No checks or probes were rerun during this plan-only amendment.
- **C1 isolated compatibility evidence (supplied evaluation results; not independently rerun here):**
  - Disposable installation passed under Node `24.21.0` and npm `11.19.0` with a byte-identical copy of the unchanged npm policy. The exact C1 Pi pins and root-override versions resolved.
  - `npm audit --omit=dev`: 0 findings. Full dev-inclusive audit still had 8 findings: 4 low and 4 moderate.
  - Temporary project checks passed: 44 unit tests, 24 integration tests, 5 E2E tests, typecheck, lint, and build.
  - Focused static checks and a Pi SDK fake-provider stream plus `maxRetries: 0` single-wire-request probe passed.
  - No real provider or FreshRSS traffic occurred.
  - **Limits:** Compatibility evidence only, not exhaustive proof, C11 completion, or a claim that all dependencies are globally secure. C11 implementation requirements, all V11 cases, V15, and production approval gates remain unchanged.
- **Execution prerequisites:** Node baseline, lockfile installation, Docker daemon/disposable DB, browser test dependencies; C1 creates all named scripts.
  - For local DB tests: `docker compose -f compose.test.yaml up -d --wait`, then use its disposable `TEST_DATABASE_URL`. Harness refuses non-test database names.
  - Live suites require their matching `RUN_LIVE_*` flag, explicit isolated endpoints/accounts, and `ALLOW_INTEGRATION_WRITES=isolated-fixtures` for mutations. Pi calls also require operator cost/data-disclosure authorization.
  - Missing prerequisites are reported as unavailable, not counted as passed/skipped acceptance evidence. Never run live suites against production by default.

| ID | Changes / criteria | Procedure / command | Expected signal |
| --- | --- | --- | --- |
| V1 | C1–C2, C7–C8 / AC21 | `npm ci && npm run typecheck && npm run lint && npm run build` | Locked compatible install; server/browser compile; no server/secret imports in UI bundle. |
| V2 | C3–C4, C9 / AC3, AC21 | `npm run test:integration -- tests/integration/migrations.test.ts tests/integration/queue-transaction.test.ts` | Empty/upgrade migrations pass; app row and pg-boss job commit/rollback together; runtime does no DDL. |
| V3 | C3–C5, C9 / AC1–AC2 | `npm run test:integration -- tests/integration/import.test.ts` | Exact-ID deduplication, whole-scan-before-ack, durable pending ack and injected-failure cases below pass. |
| V4 | C4, C9 / AC3, AC6, AC20 | `npm run test:unit -- tests/unit/processing.test.ts` and integration import/recovery cases | One import; coalesced starts; fenced/restartable work; later import proceeds despite older paused article jobs. |
| V5 | C5, C9 / AC1–AC3 | `RUN_LIVE_FRESHRSS=1 npm run test:live -- tests/live/freshrss.live.test.ts` in an authorized disposable installation matching deployed version | Recorded pagination/ID/read/token/hidden-feed/favorites compatibility; only fixture IDs change. |
| V6 | C6, C9, C14–C16 / AC11, AC14 | `npm run test:integration -- tests/integration/reader.test.ts tests/api/reader.test.ts` | Global filter/order/null/tie/cursor semantics work across multiple pages and score removal. |
| V7 | C6–C9 / AC3, AC14, AC21 | `npm run test:integration -- tests/api/security.test.ts tests/api/pipeline.test.ts tests/api/sse.test.ts` | Schema errors/redaction/host-origin rules; bounded SSE; reconnect snapshot and action coalescing. |
| V8 | C7–C9, C25 / AC14 | `npm run test:e2e -- tests/e2e/reader.spec.ts tests/e2e/pwa.spec.ts`; authorized phone/Nginx Proxy Manager check | Mobile/desktop reader and install work; shell-only cache; offline writes impossible; SSE not buffered. |
| V9 | C8, C25 / AC3, AC21 | Build/run app image with test DB; exercise `migrate`, health, SIGTERM/restart and `tests/integration/restore.test.ts` | Non-root single app service, persistent read/results, no startup migration, matched DB restore. |
| V10 | C10, C14–C16 / AC6–AC8, AC10–AC11 | `npm run test:unit -- tests/unit/taxonomy.test.ts tests/unit/scores.test.ts`; `npm run test:integration -- tests/integration/enrichment.test.ts tests/api/enrichment.test.ts` | Category/tag/config/score/reevaluation and preservation cases below pass. |
| V11 | C10–C11, C16, C24 / AC19–AC20 | `npm run test:integration -- tests/integration/budgets.test.ts` with fake provider wire counters | Every actual direct/SDK attempt admitted; concurrency/day races cannot overspend; no hidden retries/warming. |
| V12 | C12, C16 / AC4, AC6 | Enrichment tests plus `npm run test:unit -- tests/unit/context.test.ts` extraction fixtures | Article/paywall/error/unusable/limited paths distinguished; fallback source permissions enforced. |
| V13 | C13, C16 / AC6, AC10–AC11, AC20 | `npm run test:integration -- tests/integration/context-recovery.test.ts` | Full coverage, isolated contexts, generation checkpoints, reduction bounds, pause/resume and truthful provenance. |
| V14 | C6, C11–C12, C19, C24 / AC18–AC21 | Security/API tests plus `tests/integration/search.test.ts` and restricted tool/egress cases | SSRF/DNS/redirect/HTML/prompt-injection/tool/path boundaries hold without exposing integrations/secrets. |
| V15 | C11, C16 / AC19–AC21 | `RUN_LIVE_PI=1 npm run test:live -- tests/live/pi.live.test.ts` from built container | Headless OAuth/persistence/refresh and JEV bool/choice/score work; exact model IDs/limits and attempts recorded. |
| V16 | C17–C18 / AC8–AC13 | `npm run test:unit -- tests/unit/preferences.test.ts`; `npm run test:integration -- tests/integration/preferences.test.ts tests/integration/tag-merge.test.ts tests/api/preferences.test.ts`; preferences E2E | Decay/timestamps/detached votes/offsets and atomic order-independent merge satisfy cases below. |
| V17 | C19–C20 / AC5–AC6, AC20–AC21 | `npm run test:unit -- tests/unit/media.test.ts`; `npm run test:integration -- tests/integration/media.test.ts tests/integration/video-recovery.test.ts` | Subtitle-first processing, limits/cleanup/checkpoints/fencing and no silent API fallback. |
| V18 | C12, C19–C20 / AC21 | `npm run test:integration -- tests/integration/media-egress.test.ts` with instrumented proxy/downloader fixtures | Every supported media connection obeys public-network policy; forbidden direct paths/redirects fail closed. |
| V19 | C19–C20 / AC5, AC20–AC21 | `npm run benchmark:media -- --manifest <local-manifest> --output <sanitized-result>`; `RUN_LIVE_VIDEO=1 npm run test:live -- tests/live/video-capacity.live.test.ts` on target host | Measured usable DE/EN transcripts and full representative workload within four hours, or explicit failed capacity gate. |
| V20 | C21 / AC15, AC19–AC20 | `npm run test:integration -- tests/integration/summaries.test.ts`; summaries E2E | Interactive admission, coalescing, missing/limited content and successful-only replacement. |
| V21 | C22 / AC17 | `npm run test:integration -- tests/integration/mail.test.ts tests/api/mail.test.ts`; mail E2E | Selection and per-ID idempotent ack correct under races; read state unchanged; app sends no mail. |
| V22 | C23 / AC16 | `npm run test:integration -- tests/integration/karakeep.test.ts`; Karakeep E2E; authorized `RUN_LIVE_KARAKEEP=1 npm run test:live -- tests/live/karakeep.live.test.ts` | Original-URL-only create, existing/ambiguous outcomes and supported lookup verified without altering old bookmarks. |
| V23 | C8, C11, C24–C25 / AC18–AC21 | Restore integration test; `RUN_LIVE_RESTORE=1 npm run test:live -- tests/live/session-restore.live.test.ts` in empty isolated deployment | DB/read/results/jobs plus matching Pi sessions/credentials restore; session resumes safely after restart. |
| V24 | C24 / AC18–AC20 | `npm run test:unit -- tests/unit/search.test.ts`; `npm run test:integration -- tests/integration/chat.test.ts tests/integration/search.test.ts`; chat E2E; optional `RUN_LIVE_SEARCH=1 npm run test:live -- tests/live/search.live.test.ts` | No-key search parsing/failure bounds; safe session/reference/turn/reconnect behavior below. |
| V25 | All / AC1–AC21 | `npm run test:unit && npm run test:integration && npm run test:e2e && npm run typecheck && npm run lint && npm run build`; reconcile `docs/verification.md` with this table | All implemented deliveries green; no acceptance claim based only on skipped live checks or suite exit. |

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
  - Fallback/manual/archived category, idempotent seeds, tag normalization/concurrent creation/max ten/valid zero tags, stale automatic assignment and independent failed article.
  - Editable prompt/category override, each context checkbox, relevant-only preferences, no arithmetic multiplier, score boundaries 0/100, NaN/infinite/out-of-range rejection.
  - New definition leaves old articles unassessed; prompt/model change causes no jobs; manual reevaluation targets all and only active definitions without retagging; failed refresh retains old value/time/basis.
- **V11:** Concurrent requests with one remaining slot, UTC rollover using fake clock, in-flight previous-day completion, auth-wide pause/recovery, cancellation before/after dispatch, process death with unknown usage, fallback and context-reduction requests, SDK multi-tool turn, explicit compaction and restored session. Wire count equals admitted attempted requests; an exhausted bucket causes zero additional provider traffic. TypeSafe catalog-zero price is displayed unknown unless independently configured/reported.
- **V12–V14:**
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
- **V20–V22:** Double-click coalescing, successful repeat, terminal/transient/auth/budget failure, old result preservation, invalid IDs, concurrent transitions, changed revisions. Mail covers mixed known/sent/not-selected/unknown IDs and repeated acknowledgement; Karakeep covers create committed but response lost, reliable lookup found/absent/unavailable, no mutation of existing bookmarks.
- **V23:** Kill after DB intent before/after session append; restore matching database/session files/credentials into empty volumes; verify article state, pending jobs, interrupted turn, session message IDs and continuation without duplicate append. Missing/mismatched files produce diagnostic failure, not a fresh replacement conversation.
- **V24:** DDG `uddg` links/duplicates/unsafe schemes, Bing XML/markup, empty valid search, HTTP200 challenge, both providers down, max four search attempts and cancellation. Chat covers multi-article draft references without auto-send, forbidden article IDs/path traversal/symlink, one active turn, stable message deduplication, budget mid-turn, tool/time cap, abort, SSE reconnect, context compaction and no built-in tools after resume.
- **V25:** Document every AC's owning delivery and checks; record unavailable/failed live gates with exact reason. Fix regressions with bounded rerun after diagnosis, not unrelated refactors.

## Delivery and integration

- **Approved split:** The packages below are separately deliverable increments, not workers or tracker tickets. They share the contracts and verification above.
- **Review/integration base:** Repository `master` at the Basis commit. Before execution, inspect current diff; preserve unrelated user work and record the actual starting commit if it changed.
- **Result transfer:** Default one executor, serial source writes in `/home/matthias/feedrafter`; accepted predecessor code remains in this checkout. Record sanitized verification in `docs/verification.md` and temporary ignored `artifacts/<delivery>/`.
  - No patch transfer, commits, merge, push, or deployment permission is implied. If an execution environment uses isolated branches/worktrees, it must obtain publication/merge authorization and define an explicit transfer before depending on their code.
- **Prerequisites below are capability dependencies only:** Other deliveries need not be completed merely because their number is lower. Database migration ordering/shared source edits still remain serial in one checkout.

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

- **Recommended execution:** D1 first, then D2; choose later ready packages by value while preserving hard prerequisites. Finish each package's tests/documentation before proceeding.
- **Scope gates:**
  - D1 production acknowledgement remains disabled until V5 and existing digest compatibility are established in isolation/read-only inspection.
  - D2 real AI automation remains disabled until V11 and V15 prove admission/auth; importing/reading may continue without credentials.
  - D4 local transcription is not declared production-capable until V18 and V19 pass with configured host resources. Failed capacity requires explicit user decision, not relaxed acceptance.
  - D7 live bookmarking requires deployed API compatibility proof; uncertain results remain actionable, not silently retried.
  - D8 session correctness and restore require V23; no personal Pi directory or default tool discovery as a shortcut.
- **Full first-release completion:** All AC1–AC21 covered, all relevant deterministic checks green, and material live/physical/capacity gates evidenced or explicitly accepted as unresolved by the user. Completion of a package does not transfer code or grant release rights.

## Readiness and authorization boundary

- **Planning scope and material product choices:** Resolved as recorded in Basis. Future provider/model credentials, exact available Codex ID, measured resource profile and real integration evidence are explicit setup/verification prerequisites, not facts already established.
- **Ready for:** Authorized implementation of the selected delivery's code and deterministic tests, subject to package compatibility/proof gates.
- **C1 → C11 readiness:** Dependency adoption is resolved by C1's specific user-approved exception; C11 continuation is enabled, not declared done. This amendment is plan-only and does not authorize touching externally staged source work or changing Git state.
- **Not authorized by this plan:** Live-state changes, billable/provider calls, model/media downloads, production import acknowledgements, deployment, tracker creation, commit, merge, or push.
- **At any missing prerequisite or material failed gate:** Stop the affected work, report evidence and the smallest decision needed, then obtain an explicit decision before a bounded rerun. Do not substitute another design automatically.
