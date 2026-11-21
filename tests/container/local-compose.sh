#!/usr/bin/env bash
# Isolated synthetic local Compose lifecycle; removes only this test's resources.
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp=$(mktemp -d)
project="feedrafter-local-test-$(basename "$tmp" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
export LOCAL_DB_PASSWORD=disposabletestonly LOCAL_APP_PORT="$port" LOCAL_PROCESSING_ENABLED=false
printf 'LOCAL_DB_PASSWORD=%s\nLOCAL_APP_PORT=%s\n' "$LOCAL_DB_PASSWORD" "$port" > "$tmp/env"
# Hold the temporary, socket-only bootstrap server open until its healthcheck runs.
cat > "$tmp/bootstrap.sh" <<'EOF'
touch /tmp/bootstrap-started
while [ ! -f /tmp/bootstrap-release ]; do sleep 1; done
EOF
export BOOTSTRAP_INIT="$tmp/bootstrap.sh"
cat > "$tmp/bootstrap.yaml" <<'EOF'
services:
  postgres:
    volumes:
      - ${BOOTSTRAP_INIT}:/docker-entrypoint-initdb.d/hold-bootstrap.sh:ro
EOF
compose=(docker compose --env-file "$tmp/env" -p "$project" -f compose.local.yaml -f "$tmp/bootstrap.yaml")
# Refuse to touch an existing project's resources, including a tagged image.
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")$(docker volume ls -q --filter "label=com.docker.compose.project=$project")$(docker network ls -q --filter "label=com.docker.compose.project=$project")$(docker image ls -q "$project-app")" ]; then
  rm -rf "$tmp"
  echo 'Test project collision; refusing cleanup.' >&2
  exit 1
fi
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$project-app" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
"${compose[@]}" config -q
"${compose[@]}" up -d postgres
for ((i=0; i<120; i++)); do
  if "${compose[@]}" exec -T postgres test -f /tmp/bootstrap-started 2>/dev/null; then break; fi
  sleep 1
done
"${compose[@]}" exec -T postgres test -f /tmp/bootstrap-started
"${compose[@]}" exec -T postgres pg_isready -U feedrafter -d feedrafter >/dev/null
if "${compose[@]}" exec -T postgres pg_isready -h 127.0.0.1 -U feedrafter -d feedrafter >/dev/null; then
  echo 'Bootstrap server unexpectedly accepts TCP connections.' >&2
  exit 1
fi
container=$("${compose[@]}" ps -q postgres)
initial_failures=$(docker inspect --format '{{.State.Health.FailingStreak}}' "$container")
for ((i=0; i<30; i++)); do
  read -r status failures < <(docker inspect --format '{{.State.Health.Status}} {{.State.Health.FailingStreak}}' "$container")
  if [ "$status" = healthy ]; then
    echo 'Postgres reported healthy during socket-only bootstrap.' >&2
    exit 1
  fi
  if (( failures >= initial_failures + 2 )); then break; fi
  sleep 1
done
if (( failures < initial_failures + 2 )); then
  echo 'Timed out waiting for bootstrap healthchecks.' >&2
  exit 1
fi
"${compose[@]}" exec -T postgres touch /tmp/bootstrap-release
"${compose[@]}" up -d --wait postgres
"${compose[@]}" build app
"${compose[@]}" run --rm --no-deps app migrate
"${compose[@]}" up -d --wait app
curl -fsS "http://127.0.0.1:$port/api/v1/health/ready" >/dev/null
curl -fsS "http://127.0.0.1:$port/" >/dev/null
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U feedrafter -d feedrafter -c "insert into import_contexts (id,instance,account) values ('00000000-0000-4000-8000-000000000001','fixture','fixture')" >/dev/null
"${compose[@]}" exec -T app sh -c 'printf fixture > /data/fixture'
"${compose[@]}" down
"${compose[@]}" up -d --wait app
curl -fsS "http://127.0.0.1:$port/api/v1/health/ready" >/dev/null
[ "$("${compose[@]}" exec -T postgres psql -U feedrafter -d feedrafter -Atc "select count(*) from import_contexts where instance='fixture'")" = 1 ]
# Expansion belongs to the shell inside the app container.
# shellcheck disable=SC2016
"${compose[@]}" exec -T app sh -c 'test "$(cat /data/fixture)" = fixture'
# Opt-in startup only: synthetic files, no article requests or provider traffic.
"${compose[@]}" exec -T app sh -c 'umask 077; mkdir -p /data/pi-auth; chmod 700 /data/pi-auth; printf "{}" > /data/pi-auth/auth.json; printf "synthetic-key" > /data/pi-auth/typesafe-key'
"${compose[@]}" stop app
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U feedrafter -d feedrafter -c "update model_roles set provider='openai-codex', model='gpt-6-luna' where role in ('tags','context_reduction')" >/dev/null
export LOCAL_PROCESSING_ENABLED=true LOCAL_EXCLUSIVE_DB_ACK=true LOCAL_UNVERIFIED_SIZING_ACK=true LOCAL_CODEX_COST_ACK=true
export LOCAL_CLASSIFIER_DAILY=1 LOCAL_CLASSIFIER_CONCURRENCY=1 LOCAL_AUTOMATIC_DAILY=1 LOCAL_AUTOMATIC_CONCURRENCY=1
"${compose[@]}" up -d --force-recreate --wait app
curl -fsS "http://127.0.0.1:$port/api/v1/health/ready" >/dev/null
echo 'Local Compose migration, persistence and synthetic opt-in startup passed.'
