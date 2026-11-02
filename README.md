# Feedrafter

D1 is a private, same-origin reader for durably imported FreshRSS metadata. Node serves the reader and API together; PostgreSQL is external. No application login exists. **Never expose this service publicly:** a private VPN/network, HTTPS termination and access controls are operator prerequisites.

See [operations](docs/operations.md) for setup, migrations, security, health, backup and restore; [API reference](docs/api.md) and [server configuration](docs/server-api.md) for D1 behavior; and [verification](docs/verification.md) for actual evidence and outstanding gates. FreshRSS acknowledgement is hard-disabled; no live provider is required for normal tests. AI setup and Pi sessions are not implemented in D1.

## Local development

Use Node 24.21.0 via mise. Preserve `.npmrc` policy (`min-release-age=3`, `ignore-scripts=true`).

```sh
mise exec node@24.21.0 -- npm ci
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

Playwright requires a compatible Chromium installation; use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for an existing browser or install Playwright's browser. Integration and real-server browser tests create disposable PostgreSQL 18 containers on loopback; the container regression uses its own isolated Docker network and DB, tests explicit migration, restart and DB restore, then deletes them. These tests never use `DATABASE_URL` or contact live providers. The separate `compose.test.yaml` offers a disposable loopback database for manual local experiments, not a production service.
