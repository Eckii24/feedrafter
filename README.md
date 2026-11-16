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

The database uses temporary storage; stopping it deletes its data. The local reader, catalog and score UI can run, but the prepared article → category → tags → snapshotted scores chain is **not complete or testable end-to-end**. P1.3a onward, workers and API/browser acceptance remain open. The score worker stays fail-closed; no inference provider is activated.

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
