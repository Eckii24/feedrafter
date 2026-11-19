# Product test readiness — Handoff

> Historical handoff, superseded: P1.3b is implemented; the P1.3c score-identity concern is resolved by the clarified snapshot authority. See `.ai/product-test-readiness-plan.md` and `docs/verification.md` for current status. P1.3c atomic release remains incomplete.
- Updated: 2026-11-10
- Workspace: `/home/matthias/feedrafter`, branch `master`, HEAD `ac7588b095e805d8e7b4c43b3ed236ffabdcfa8c`; committed earlier as `ac7588b` plus docs `a285fe0`. Current P1.3a and status/docs updates are uncommitted. Pre-existing `.vitest/json/output.json` remains untracked and untouched.

## Goal and scope
Finish the approved local prepared-article → category → tags → original snapshotted scores flow using disposable PostgreSQL/PgBoss and fake AI, then stored workers and real-server/browser acceptance. Production inference/deployment remains separately gated. Canonical plan: `.ai/product-test-readiness-plan.md`.

## Verified state
- P1.1 and P1.2 are recorded predecessor checkpoints only; do not claim aggregate P1.
- P1.3a code implemented in `src/server/adapters/postgres/{tag-task-input-store,catalog-store}.ts` and `src/server/application/assign-tags.ts`. V11a passed 4 files / 199 tests; typecheck, scoped ESLint and whitespace checks passed. Evidence in `docs/verification.md` under “P1.3a — tag capture and standalone publication checkpoint”. Standalone tags persist receipts; linked tag publication remains closed.
- P1.3b has **no implementation**. Baseline V11b was 5 files / 200 tests; V11a preservation rerun passed 4 / 199. Those are baselines, not P1.3b acceptance.
- P1.3c, aggregate V11, workers/P1.4 and P2 API/browser acceptance are not implemented. No full local product-chain test exists.
- README says local reader/catalog/score UI can run but chain is not end-to-end testable. Current edits update that status and plan/docs record the stop.

## Decisions and rationale
- User requested all missing parts, then selected “use sensible defaults” for expert-identified P1.3b clarification.
- Defaults recorded in `.ai/product-test-readiness-plan.md` E8/P1.3b: persisted metadata classifies root vs linked; validate ancestry using actual task generations/receipts/root `tagsTaskId`/source fingerprint/activated tag basis; P1.3b checks this task's linkage only while P1.3c owns total snapshot membership/count; don't compare old receipt epoch with current dispatch epoch; use real preparation/category/tag receipts then add only synthetic scheduling metadata without editing receipts.
- Expert found P1.3b technically valid, with no architectural contradiction. Cause of worker stops remains unknown.
- Two repair handoffs for the same P1.3b slice returned no source changes even after clarification. Current orchestration retry limit is reached. Do not retry P1.3b or start dependent P1.3c/P1.4/P2 in this continuation. Require a new authorized execution decision/approach; do not weaken acceptance or split the production consumer guard.

## Evidence
- `mise exec node@24.21.0 -- ./node_modules/.bin/vitest run tests/unit/article-handoff.test.ts tests/integration/assign-tags.test.ts tests/integration/assign-tags-races.test.ts tests/integration/enrichment.test.ts` → V11a 4 files / 199 tests (worker report; disposable PostgreSQL 18/PgBoss/fake AI).
- Focused typecheck, ESLint and whitespace checks passed for P1.3a (worker report).
- P1.3b V11b baseline command/results and stop history are documented in `docs/verification.md` and E8/E9 in the plan. Last failed implementation handoff ran only whitespace checks; no V11b implementation test.
- `git diff --check` and `git diff --cached --check` passed after current doc/status edits.

## Open points and blockers
- The current writer-handoff limit prevents another attempt at P1.3b. Expert diagnosis did not establish why two writers could not complete it; no tool denial or test failure was observed.
- `docs/verification.md` correctly marks P1.3b incomplete. No aggregate P1.3/C14/D2/V10 or production acceptance.

## Next action
Present the P1.3b execution stop to the user. Await a separately authorized continuation approach; preserve the E8 decisions and current two-handoff history. Do not implement P1.3c until P1.3b is actually complete and verified.
