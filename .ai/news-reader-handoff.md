# Agentic News Reader — Handoff

- Updated: 2026-06-04
- Workspace: `/home/matthias/feedrafter`, branch `master`; base revision before checkpoint: `6b8653391b90810f3a475e4086fb042587431119`. This handoff is included in the requested checkpoint commit; on resume, identify its exact revision with `git rev-parse HEAD`. Generated `.vitest/json/output.json` is excluded.

## Goal and scope

Continue implementing the documented scope in `docs/`, especially end-to-end AI/provider fallback, transcription, context processing, integrations, capacity, deployment and acceptance evidence. This is a continuation snapshot, not overall acceptance.

## Verified state

- Reader/operations foundation, C10/D2 data foundations, Pi resource isolation, mail queue, feedback, partial catalog/ranking, C12 retrieval/preparation foundations, standalone C13 planner, and C11 P1–P7 have prior scoped evidence recorded in `docs/verification.md`.
- C11 P1–P5 storage packages and P6 application gate have independent scoped pass reports. P7 shared AI port/runtime contract also received an independent scoped pass. These are partial package reviews, not C11/V11/product acceptance.
- C7 preflight now recognizes nonblank `TYPESAFE_API_KEY` as candidate presence only; credential validity is not proven. Other ambient-only/keyless provider configurations may pause conservatively.
- C8 has exploratory loopback evidence only: `tests/helpers/fake-provider.ts`, `tests/unit/fake-provider.test.ts`, `tests/integration/pi-provider-probe.test.ts`. The probe calls pinned Pi TypeSafe classifier through `UsageService.executeAttempt`, with a PostgreSQL reservation committed before the held loopback response. No direct production adapter exists.
- Latest fresh verification, Node 24.21.0: 11 focused test files, 95 tests passed; typecheck, scoped ESLint, staged/unstaged diff checks passed. Command is recorded in `docs/verification.md`. No full suite/build/E2E after the latest C7 preflight and C8 exploratory additions. Earlier full run after P7 but before those latest additions passed unit 289, integration/API 111, typecheck, lint, build, Drizzle check and diff checks.
- P6/P7 scoped independent reviews passed. C8 exploratory additions have not been independently reviewed.
- No live provider/FreshRSS/Karakeep calls, deployment, restore validation, or user acceptance evidence.

## Decisions and rationale

- Node baseline: 24.21.0. Preserve `.npmrc` and approved Pi dependency pins/overrides.
- No live/billable provider calls. Local fake loopback and disposable PostgreSQL 18 only.
- FreshRSS acknowledgement remains disabled pending V5/digest-workflow proof. Karakeep remains blocked by uncertain API and negative-lookup semantics.
- C11: per-bucket concurrency spans dates; reservation commit consumes credit; null limits unlimited; missing budget fails closed; dead owner becomes uncertain and frees only local slot; no age reclaim.
- C13 remains a planner, not context execution. Existing sizing/performance findings remain open.
- **Unresolved user decision:** Pi 1.4.0 maps a classifier response with `input_tokens:5` and missing `output_tokens` to `{input:5, output:0}`. The probe keeps both ledger counts null. Existing domain/SQL requires both counts when `tokensSource='provider'`. A choice prompt between preserving individual reported counts with provider provenance versus leaving partial reports entirely null/unknown was cancelled; do not treat Pi's synthesized zero as provider evidence or silently change the accounting contract.
- Checkpoint commit was explicitly requested by the user; this document is included. The resulting commit records a partial implementation checkpoint, not acceptance.

## Evidence

- `docs/verification.md` — package-by-package evidence and remaining gates.
- `.ai/news-reader-plan.md` — overall plan; `.ai/c11-admission-plan.md` — sequential C11 packages.
- Latest 95-test command and outcomes are in the P8 section of `docs/verification.md`; disposable database and loopback only.
- Earlier full verification and scoped review limitations are documented in the P6/P7 sections.

## Open points and blockers

- C8: decide partial usage provenance; then implement classify/generate adapters through P6 with `maxRetries:0`, exact terminal/auth/error normalization and truthful usage; prove real loopback classifier and generation HTTP/SSE, reservation-before-wire, denial-without-wire, and no hidden retries. Keep no-live boundary.
- C9 restricted admitted session streams, compaction/resume and abandonment cleanup.
- C10 setup/auth storage, shared composition, recovery-before-exposure and shutdown lifecycle; no startup dispatch.
- C11 cross-path budget/accounting matrix and V11.
- C12 article extraction/preparation is not wired to queue/API/UI; source permissions are not persisted and fallback is injectable, not sandboxed.
- C13 execution, hierarchical reduction, persistence/recovery and planner performance findings.
- Transcription, chat, video processing, score execution/reevaluation, broader D2–D5 and D7–D8 workflows remain incomplete.
- Live integrations, representative video-capacity evidence, deployment/restore validation, product acceptance, NR-V11/NR-V15 and D1 acceptance remain unverified.

## Next action

Resume with the C8 usage-provenance decision and implement the direct Pi adapter plus loopback wire-accounting proof; after integration, run fresh focused/full checks and an independent scoped review before advancing to C9. Do not enable production dispatch or claim end-to-end completion.
