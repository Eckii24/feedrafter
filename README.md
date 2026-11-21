# Feedrafter

D1 is a private, same-origin reader for durably imported FreshRSS metadata. Node serves the reader and API together; production Compose uses external PostgreSQL. No application login exists. **Never expose this service publicly:** a private VPN/network, HTTPS termination and access controls are operator prerequisites.

See [operations](docs/operations.md) for setup, migrations, security, health, backup and restore; [API reference](docs/api.md) and [server configuration](docs/server-api.md) for D1 behavior; and [verification](docs/verification.md) for actual evidence and outstanding gates. FreshRSS acknowledgement is hard-disabled; no live provider is required for normal tests.

## Local Docker Compose

Requires Docker Compose, a running Docker daemon and OpenSSL. From the repository root, create a private local configuration with a unique URL-safe database password, then build, start PostgreSQL, explicitly migrate and start the app:

```sh
if [ ! -e .env.local ]; then
  umask 077
  cp .env.local.example .env.local
  printf '\nLOCAL_DB_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env.local
  chmod 600 .env.local
fi
docker compose --env-file .env.local -f compose.local.yaml build
docker compose --env-file .env.local -f compose.local.yaml up -d --wait postgres
docker compose --env-file .env.local -f compose.local.yaml run --rm --no-deps app migrate
docker compose --env-file .env.local -f compose.local.yaml up -d --wait app
```

Open <http://127.0.0.1:3000/>; readiness is at <http://127.0.0.1:3000/api/v1/health/ready>. Set `LOCAL_APP_PORT` in `.env.local` before startup if port 3000 is occupied, and use that port in the browser. Only loopback is published; PostgreSQL has no host port. Do not proxy or expose the app publicly: it has no login. Docker administrators can read container environment variables, volumes and credentials; keep `.env.local` private and do not publish `docker compose config` output.

Stop and remove containers and the network, **without deleting data**, with:

```sh
docker compose --env-file .env.local -f compose.local.yaml down
```

The default Compose project is `feedrafter-local`, separate from the deployment Compose project. The named `db` and `data` volumes persist across shutdowns. Keep `.env.local`: changing the password there does not change an existing PostgreSQL volume's password. Back up both volumes together while all writers are stopped, and back up before upgrades; see [operations](docs/operations.md#backup-and-restore) for the matched-backup principles. Before migrating an existing installation, stop the app, take a matched backup, rebuild and run the explicit migration above; do not run concurrent migrations. `serve` never migrates. Do not use `down --volumes` unless deliberately deleting all local data.

FreshRSS is disabled by default. To supply your own configuration, create an **untracked, private** `compose.local.freshrss.yaml` override containing the following (replace no values in the YAML):

```yaml
services:
  app:
    environment:
      FRESHRSS_ENABLED: "true"
      FRESHRSS_BASE_URL: ${FRESHRSS_BASE_URL:?Set FreshRSS URL}
      FRESHRSS_EMAIL: ${FRESHRSS_EMAIL:?Set FreshRSS account}
      FRESHRSS_API_PASSWORD_FILE: /run/secrets/freshrss-password
    volumes:
      - type: bind
        source: ${FRESHRSS_PASSWORD_PATH:?Set absolute password file path}
        target: /run/secrets/freshrss-password
        read_only: true
        bind:
          create_host_path: false
```

Add `FRESHRSS_BASE_URL`, `FRESHRSS_EMAIL` and absolute `FRESHRSS_PASSWORD_PATH` values to `.env.local`; the existing password file must be readable by container UID 1000 and protected from other users. Use HTTPS for remote FreshRSS. Container `localhost` is not the host. Start with the extra override after migration:

```sh
docker compose --env-file .env.local -f compose.local.yaml -f compose.local.freshrss.yaml up -d --wait app
```

Enabling FreshRSS can immediately scan the entire unread backlog. Read acknowledgements remain disabled. To disable scheduled imports before enabling FreshRSS, run the PATCH command in [the manual-scan instructions](#optional-connect-freshrss-for-metadata-import) against the already-running local Compose app, then stop it with `docker compose --env-file .env.local -f compose.local.yaml stop app` before starting with the override. Do not use a real account for tests.

Normal serving does not enable inference. For the optional local-only activation and its safety prerequisites, see [local processing](#local-processing-opt-in). Never bake credentials into the image or commit them.

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

The database uses temporary storage; stopping it deletes its data. Normal serve registers no inference workers and activates no inference provider. A separate test-only fixture exercises synthetic preparation → category → tags → original scores through real PostgreSQL/PgBoss and fake AI, then reads persisted results in the built browser. It is not automatic import, recovery, live inference, or a production activation.

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

### Local processing opt-in

**Local experiment only, not a production safety boundary.** Use a dedicated, initially empty processing database; run exactly one app instance and no external database writers for its entire lifetime. The operator must enforce this exclusive ownership. Workers consume shared queues, not just requested IDs. Startup checks that category, tags and score queues are provisioned and contain no pending, scheduled, retrying or active jobs; missing/nonempty queues refuse startup. This is only a point-in-time preflight, **not** a lock or protection against concurrent or malicious producers. Stop and investigate pending work; do not silently delete it. A previously used database or a second app invalidates the prerequisite even if the preflight passes.

The opt-in uses TypeSafe `typesafe/jev-latest` for quality, category and scores, and Codex `openai-codex/gpt-6-luna` for tags and context reduction. The request policy deliberately uses unverified UTF-8 JSON byte size (20,000 bytes maximum; assumed 32,000 context, 4,096 output and 1,024 framing). One byte per token and the reserves are assumptions, not verified tokenization, provider framing or a guarantee against context overflow. Pi's Codex builder does **not** enforce an output-token cap. Subscription usage and cost are unknown; request caps are not cost limits. Classifier and automatic buckets each have explicit daily and concurrent request caps, further constrained by the database budgets; zero disables dispatch. Usage may be recorded as unknown, and interrupted calls may be uncertain. No real provider acceptance has been established.

For Compose, start with the empty dedicated `feedrafter-local` database, migrate and run the app disabled using the commands above. Keep it private and do not start a second app or writer. Copy your own Pi Codex OAuth `auth.json` and TypeSafe API key from private local files into the app-owned volume (never commit them or include them in shell arguments):

```sh
docker compose --env-file .env.local -f compose.local.yaml exec -T app sh -c 'umask 077; mkdir -p /data/pi-auth; chmod 700 /data/pi-auth; cat > /data/pi-auth/auth.json' < /absolute/path/to/your/pi-auth.json
docker compose --env-file .env.local -f compose.local.yaml exec -T app sh -c 'umask 077; cat > /data/pi-auth/typesafe-key' < /absolute/path/to/your/typesafe-key
```

The directory and `auth.json` must be owned by the app user, private and writable, including the parent for OAuth rotation; the key file must be owner-only. `/data` persists secrets: protect and back up the volume accordingly. Custom `models.json` and Pi credential commands are not loaded. The OAuth file must already contain valid Codex credentials; refresh may write rotated credentials. No credentials or providers are supplied by this project.

Stop the app, then set the model roles in the dedicated database and explicitly acknowledge the risks and choose caps in `.env.local` (see `.env.local.example`; remove the `#` and select your own limits):

```sh
docker compose --env-file .env.local -f compose.local.yaml stop app
docker compose --env-file .env.local -f compose.local.yaml exec -T postgres psql -v ON_ERROR_STOP=1 -U feedrafter -d feedrafter -c "update model_roles set provider='typesafe', model='jev-latest', fallback_provider=null, fallback_model=null where role in ('quality','category','scores'); update model_roles set provider='openai-codex', model='gpt-6-luna', fallback_provider=null, fallback_model=null where role in ('tags','context_reduction');"
docker compose --env-file .env.local -f compose.local.yaml up -d --force-recreate --wait app
```

No inference starts merely by enabling the app or importing metadata. Explicitly select an eligible, first-time article by replacing `ARTICLE-UUID` with its imported ID:

```sh
curl -fsS -X POST http://127.0.0.1:3000/api/v1/articles/ARTICLE-UUID/processing \
  -H 'Content-Type: application/json' -d '{}'
```

Normal disabled mode returns 503. The endpoint fetches public web content, sends it to the providers and admits category → tags → active scores. Review privacy and provider terms before use. Existing content or any prior prepare/category/tag/score task makes the article ineligible. A crash, cancellation, budget denial or admission error can leave partial work; there is no automatic retry or takeover. Inspect persisted tasks before proceeding. Score-only reevaluation is unavailable in this runtime. The public web adapter rejects private addresses but cannot establish publisher permission or content correctness.

### Repeatable synthetic product test

Requires the cached `postgres:18` image, local Docker socket access, locked dependencies and a compatible cached Chromium. The fixture creates and deletes its own uniquely named loopback PostgreSQL container; it does not accept `DATABASE_URL` or use the manual database above. It explicitly registers fake-backed workers in the test process, prepares synthetic in-memory HTML and calls the real admission adapter; there is no fake-AI API or serve switch.

```sh
mise exec node@24.21.0 -- npm run build
mise exec node@24.21.0 -- npm run test:e2e -- tests/e2e/enrichment.spec.ts
mise exec node@24.21.0 -- ./node_modules/.bin/vitest run tests/integration/explicit-article-processing.test.ts tests/integration/article-processing-api.test.ts tests/integration/freshrss-product-chain.test.ts
```

The browser test uses the real Fastify API and persistence, reloads saved category/tags/scores, and exercises score-only reevaluation including failure preservation. The import-chain test uses a locally intercepted FreshRSS protocol fixture and real import jobs, then invokes the explicit single-article HTTP endpoint with an injected processor before starting fake-AI workers. Neither test proves automatic import-to-processing or provider behavior. The fixture ends with the test; it is not a persistent interactive demo. See [verification](docs/verification.md) for tested browser path and remaining gates.

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
bash tests/container/local-compose.sh
```

Unit and integration tests do not contact a live inference provider. Integration and real-server browser tests create their own disposable PostgreSQL 18 containers on loopback; they do not use the manual `DATABASE_URL`. Unit tests do not all require PostgreSQL. Playwright requires cached compatible Chromium: install it with `mise exec node@24.21.0 -- npm exec -- playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing compatible browser. The container regression uses its own isolated Docker network and database, tests explicit migration, restart and database restore, then deletes them. Normal tests do not contact live providers.
