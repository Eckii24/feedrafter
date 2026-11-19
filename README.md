# Feedrafter

D1 is a private, same-origin reader for durably imported FreshRSS metadata. Node serves the reader and API together; PostgreSQL is external. No application login exists. **Never expose this service publicly:** a private VPN/network, HTTPS termination and access controls are operator prerequisites.

See [operations](docs/operations.md) for setup, migrations, security, health, backup and restore; [API reference](docs/api.md) and [server configuration](docs/server-api.md) for D1 behavior; and [verification](docs/verification.md) for actual evidence and outstanding gates. FreshRSS acknowledgement is hard-disabled; no live provider is required for normal tests.

## Local development

Use Node 24.21.0 via mise. Preserve `.npmrc` policy (`min-release-age=3`, `ignore-scripts=true`).

### Run the local server

Requires Docker Compose and a running Docker daemon. The database below is disposable and only for local experiments; do not use real data. From the repository root:

```sh
mise exec node@24.21.0 -- npm ci
docker compose -f compose.test.yaml up -d --wait
export DATABASE_URL=postgresql://postgres:disposable-test-only@127.0.0.1:55432/feedrafter_test
export APP_ORIGIN=http://127.0.0.1:3000
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- npm run db:migrate
mise exec node@24.21.0 -- npm start
```

Open <http://127.0.0.1:3000/>. Health endpoints: <http://127.0.0.1:3000/api/v1/health/live> and <http://127.0.0.1:3000/api/v1/health/ready>. The server defaults to loopback port 3000. Stop it with Ctrl+C, then stop and remove the disposable database:

```sh
docker compose -f compose.test.yaml down
```

The database uses temporary storage; stopping it deletes its data. Normal serve does not register category/tag workers; its score worker remains fail-closed and no inference provider is activated. A separate test-only fixture exercises synthetic preparation → category → tags → original scores through real PostgreSQL/PgBoss and fake AI, then reads persisted results in the built browser. It is not automatic import, recovery, live inference, or a production activation.

### Optional: connect FreshRSS for metadata import

This connects the existing reader/importer only, **not** Pi or automatic article preparation. Use a private FreshRSS instance with its Google Reader API enabled and an API password. The importer scans unread entries and can process an entire unread backlog; there is no per-run item limit. FreshRSS read acknowledgements are disabled. Use HTTPS for a remote instance; HTTP credentials are sent in clear text. Do not point a disposable test database at real data unless you accept importing that metadata and scanning the backlog.

Import scheduling defaults to enabled and enabling FreshRSS can start a scan immediately. To request a manual scan instead, start the server without FreshRSS as above, then run in another terminal:

```sh
curl -fsS -X PATCH http://127.0.0.1:3000/api/v1/settings/import \
  -H 'Content-Type: application/json' -d '{"importEnabled":false}'
```

Stop the server. In the same terminal used to start it, configure your own URL and account and point to an existing absolute-path file containing only the API password (restrict it to your user, e.g. `chmod 600 /absolute/path/to/freshrss-api-password`). Do not commit the file. Environment variables are not automatically loaded from `.env` by the Node server.

```sh
export FRESHRSS_ENABLED=true
export FRESHRSS_BASE_URL='https://YOUR-FRESHRSS/api/greader.php'
export FRESHRSS_EMAIL='YOUR-ACCOUNT'
export FRESHRSS_API_PASSWORD_FILE='/absolute/path/to/freshrss-api-password'
mise exec node@24.21.0 -- npm start
```

With the server running, request one scan and poll the returned `runId`:

```sh
curl -fsS -X POST http://127.0.0.1:3000/api/v1/pipeline/runs \
  -H 'Content-Type: application/json' -d '{}'
curl -fsS http://127.0.0.1:3000/api/v1/pipeline/runs/YOUR-RUN-ID
```

Imported metadata appears in the reader. The disabled scheduling setting persists in the database; manual runs still work. Do not use these example credentials or URLs literally. The local test database is deleted when stopped.

### Pi and processing status

There is currently **no supported serve configuration or CLI** that connects Pi to the article workers, and FreshRSS import does not start preparation or article admission. Setting Pi/provider credentials or model roles alone does not enable inference. The existing Pi adapters have narrowly supported provider routes and usage admission, but production composition still needs verified model/token sizing and framing, safe budgets, preparation scheduling and recovery before it can be activated safely. No live model calls or live FreshRSS acceptance were performed here.

The unwired `createArticleQualityClassifier` seam maps preparation quality checks to an admitted classifier call associated with the preparation task. It requires caller-supplied verified model sizing and framing; its fixture token counter is not suitable for real use. The pinned Pi catalog lists `openai-codex/gpt-6-luna`, but not `openai-codex/gpt-6.1-terra`. The existing generator does not support the Codex route, and Pi's Codex request builder does not apply its `maxTokens` option. Pi auth is currently fixed to `/data/pi-auth/auth.json`; custom Pi `models.json` and its credential commands are not loaded. Do not treat credentials or model configuration as activation.

A private code-level seam, `processExplicitArticles` in `src/server/adapters/postgres/explicit-article-processing.ts`, accepts 1–20 distinct explicit article IDs and injected web/quality-classifier dependencies. It prepares eligible first-time articles sequentially and uses the existing transactional admission to queue the category → tags → scores chain. It does not provision queues, register workers, scan a backlog, retry or recover. The caller must provision queues, supply safe dependencies, explicitly manage existing workers and their shutdown, and inspect results. Existing workers consume their shared queues, not just these IDs; do not start them against an uncontrolled backlog. Existing content or any prior preparation/category/tag/score task makes an article ineligible for this first-time seam. A crash, cancellation, or admission error can leave a running or completed preparation without a chain; no automatic takeover or retry is provided. An exception stops the batch and can leave earlier articles processed; inspect persisted tasks before any further action. This is an integration seam, not a supported live activation.

### Repeatable synthetic product test

Requires the cached `postgres:18` image, local Docker socket access, locked dependencies and a compatible cached Chromium. The fixture creates and deletes its own uniquely named loopback PostgreSQL container; it does not accept `DATABASE_URL` or use the manual database above. It explicitly registers fake-backed workers in the test process, prepares synthetic in-memory HTML and calls the real admission adapter; there is no fake-AI API or serve switch.

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- npm run test:e2e -- tests/e2e/enrichment.spec.ts
mise exec node@24.21.0 -- ./node_modules/.bin/vitest run tests/integration/explicit-article-processing.test.ts tests/integration/article-processing-api.test.ts tests/integration/freshrss-product-chain.test.ts
```

The browser test uses the real Fastify API and persistence, reloads saved category/tags/scores, and exercises score-only reevaluation including failure preservation. The import-chain test uses a locally intercepted FreshRSS protocol fixture and real import jobs, then invokes the explicit processing seam before starting fake-AI workers. Neither test proves automatic import-to-processing or provider behavior. The fixture ends with the test; it is not a persistent interactive demo. See [verification](docs/verification.md) for tested browser path and remaining gates.

### Local checks and tests

```sh
mise exec node@24.21.0 -- npm run lint
mise exec node@24.21.0 -- npm run typecheck
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- npm run test:unit
docker pull postgres:18
mise exec node@24.21.0 -- npm run test:integration
mise exec node@24.21.0 -- npm run test:e2e
docker build -t feedrafter:local .
bash tests/container/operations.sh feedrafter:local
```

Unit and integration tests do not contact a live inference provider. Integration and real-server browser tests create their own disposable PostgreSQL 18 containers on loopback; they do not use the manual `DATABASE_URL`. Unit tests do not all require PostgreSQL. Playwright requires cached compatible Chromium: install it with `mise exec node@24.21.0 -- npm exec -- playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing compatible browser. The container regression uses its own isolated Docker network and database, tests explicit migration, restart and database restore, then deletes them. Normal tests do not contact live providers.
