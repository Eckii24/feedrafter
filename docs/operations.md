# D1 operations

## Boundary and contents

The image contains one Node app serving UI and API on the same origin. Production Compose has only the app; PostgreSQL and HTTPS termination are external. **No built-in login:** allow access only via a private VPN/network and external access controls; never publish directly to the Internet. The example binds to host loopback; an existing trusted HTTPS proxy may connect there. Preserve the original Host header and WebSocket/SSE-compatible streaming behavior. Set `APP_ORIGIN` to the exact external HTTPS browser origin (including port); requests with another Host or Origin are rejected. Do not set `TRUSTED_PROXIES` unless needed; if used, pass only the actual trusted IPs/CIDRs in an operator-maintained Compose override. No proxy, database, Docker socket or full personal Pi directory is included.

App code and dependencies are root-owned; process UID/GID is 1000. Compose enforces a read-only root filesystem, drops capabilities and mounts a 64 MiB `/tmp` tmpfs. An existing private host directory is mounted at `/data`; assign UID/GID 1000 and restrict host permissions. Set an operator-enforced filesystem quota on it; the bind mount itself is not size-limited. `/tmp` is ephemeral. The current D1 app does not yet use `/data` for Pi credentials/sessions; `setup-ai` and Pi authentication are future work, not commands available now.

## Setup and migration

Do not run these commands against production during testing. For an intended private installation, prepare an external PostgreSQL database and its credentials, private VPN and TLS proxy. Review and restrict the Docker host and DB network access. Copy `.env.example` to `.env`, set its values and `chmod 600 .env`; create the specified absolute `APP_DATA_DIR` beforehand with restricted permissions and ownership 1000:1000. The database URL must be reachable **from the container**; localhost refers to the container. Protect credentials in backups and operator environments. Compose environment variables are visible to Docker administrators; never commit `.env`, expose Docker access to untrusted users, or publish `docker compose config` output containing secrets.

```sh
docker compose build
# Explicit, one-off administrative action; never automatic on serve.
docker compose run --rm --no-deps app migrate
docker compose up -d app
```

The migrate command requires both `DATABASE_URL` and `APP_ORIGIN`; it applies Drizzle migrations and provisions pg-boss objects/queues. Use database privileges sufficient for those operations; arrange runtime privileges separately as appropriate. Back up first before upgrading an existing database. `serve` never migrates or provisions schema/queues. Do not start competing migration/restore operations. `docker compose stop app` gives the app 40 seconds for graceful shutdown. Check image version and DB compatibility before upgrades; no automatic schema downgrade exists.

FreshRSS is disabled by default. If explicitly enabled in an operator-maintained override, pass `FRESHRSS_ENABLED=true`, `FRESHRSS_BASE_URL`, `FRESHRSS_EMAIL`, and a protected read-only mounted secret file via `FRESHRSS_API_PASSWORD_FILE`; see [server/API](server-api.md). Protect Docker configuration and secret files. D1 **never sends FreshRSS read acknowledgements**, even when configured; pending intents remain visible. No provider credentials belong in the image, build context, documentation or logs.

## Health and troubleshooting

`/api/v1/health/live` checks the process; `/api/v1/health/ready` checks DB connectivity and required schema/version, not provider availability or writable data mounts. The image healthcheck checks write access to `/data` and `/tmp`, then probes readiness locally with the configured Host. A 503 means DB/schema is unavailable or mismatched: verify configuration and migrate explicitly; no provider calls are made by the probe. When testing from the host or monitoring agent, send Host matching `APP_ORIGIN` (and route through the private boundary). Inspect health with `docker compose ps` and logs with `docker compose logs app`; restrict access to operational output. The application suppresses detailed startup and queue errors to avoid leaking credentials; inspect database-side diagnostics securely.

## Backup and restore

Operator defines frequency, retention, encryption, RPO and access policy. An image alone is not a backup. Take a **matched, quiescent** cut: stop all app instances and any standalone workers/writers, wait for shutdown, then back up the full DB (including `public`, `drizzle` and `pgboss` schemas) and the matching persistent `/data` directory. Back up any Pi authentication and session files that later versions store there. Do not include ephemeral `/tmp` or model caches. Protect and encrypt archives and transport; they can contain articles and credentials. Record the image digest and config version alongside the pair without embedding secrets.

Example: run PostgreSQL client tools from an authorized operator environment, configured through protected `PGSERVICEFILE`/`PGPASSFILE` or another secure mechanism, with `PGSERVICE` selecting the **intended** database. Verify host/database before every destructive operation. Paths below are placeholders on protected storage, not shell variables from `.env`.

```sh
docker compose stop app
umask 077
pg_dump -Fc --file=/secure/backup/feedrafter.dump
tar -C /absolute/path/to/private/feedrafter-data -czf /secure/backup/feedrafter-data.tar.gz .
# Resume only after both captures succeeded and are secured.
docker compose up -d app
```

Test restore into an isolated empty database and empty private data directory, with no production URLs, no external provider configuration, and no inbound traffic. Use the matching image and database version first. Restore the DB and matching data archive together; preserve ownership and permissions. The DB target must already exist and have suitable roles/permissions; `--no-owner --no-privileges` assigns ownership to the restore user. Example with client environment deliberately pointed to the isolated empty target:

```sh
pg_restore --exit-on-error --no-owner --no-privileges --dbname=feedrafter_restore /secure/backup/feedrafter.dump
tar -C /absolute/path/to/empty/restore-data -xzf /secure/backup/feedrafter-data.tar.gz
```

Point an isolated app instance at that restored pair. Run the explicit migration only if upgrading the restored image/schema, after retaining the original matched backup. Verify readiness and persisted read state before any operator-controlled switch. For schema-changing rollback, restore the prior matched DB/data backup with its matching image; never rely on automatic downgrade. `tests/container/operations.sh` demonstrates matched DB/data backup and restore, including read-state continuity and a data-volume fixture; Pi session restore cannot be demonstrated until Pi exists. See [verification](verification.md#restore-evidence-and-limits) for the actual local command, result and unverified operator/deployment gates.
