#!/usr/bin/env bash
# Isolated, disposable V9 smoke/regression; requires local image and postgres:18.
set -euo pipefail
image=${1:-feedrafter:local}
prefix="feedrafter-ops-$$"
network="$prefix-net"
db="$prefix-db"
app="$prefix-app"
dump=$(mktemp)
data_dump=$(mktemp)
data="$prefix-data"
restored_data="$prefix-restored-data"
cleanup() {
  docker rm -f "$app" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$data" "$restored_data" >/dev/null 2>&1 || true
  rm -f "$dump" "$data_dump"
}
trap cleanup EXIT

docker network create "$network" >/dev/null
docker volume create "$data" >/dev/null
docker volume create "$restored_data" >/dev/null
docker run -d --pull=never --name "$db" --network "$network" \
  -e POSTGRES_PASSWORD=disposable-test-only -e POSTGRES_DB=feedrafter_test postgres:18 >/dev/null
for i in {1..100}; do
  if docker exec "$db" psql -h 127.0.0.1 -U postgres -d feedrafter_test -c 'select 1' >/dev/null 2>&1; then break; fi
  sleep .2
done
docker exec "$db" psql -h 127.0.0.1 -U postgres -d feedrafter_test -c 'select 1' >/dev/null
url="postgresql://postgres:disposable-test-only@$db:5432/feedrafter_test"
origin='http://localhost:3000'
common=(--pull=never --network "$network" --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000 --mount "type=volume,src=$data,dst=/data" -e "DATABASE_URL=$url" -e "APP_ORIGIN=$origin")
start() { docker run -d --name "$app" "${common[@]}" --health-interval=2s --health-start-period=0s --health-retries=3 "$image" >/dev/null; }
request() {
  docker exec "$app" node -e 'require("node:http").get({host:"127.0.0.1",port:3000,path:process.argv[1],headers:{host:"localhost:3000"}},r=>{console.log(r.statusCode);r.setEncoding("utf8");r.on("data",x=>process.stdout.write(x));r.on("end",()=>console.log())}).on("error",()=>process.exit(1))' "$1"
}
wait_http() {
  for i in {1..100}; do if request /api/v1/health/live >/dev/null 2>&1; then return; fi; sleep .2; done
  docker logs "$app"; return 1
}
[ "$(docker image inspect "$image" --format '{{.Config.User}}')" = node ]
[ "$(docker image inspect "$image" --format '{{json .Config.ExposedPorts}}')" = '{"3000/tcp":{}}' ]
docker run --rm "${common[@]}" --entrypoint sh "$image" -c 'test "$(id -u)" = 1000 && test ! -w /app && test -w /data && test -w /tmp && ! touch /app/should-fail 2>/dev/null'
start
wait_http
response=$(request /api/v1/health/ready)
printf '%s\n' "$response" | grep '^503$' >/dev/null || { printf 'Expected unready response; got: %s\n' "$response"; exit 1; }
[ "$(docker exec "$db" psql -U postgres -d feedrafter_test -Atc "select to_regclass('public.articles') is null")" = t ]
docker run --rm "${common[@]}" "$image" migrate
for i in {1..100}; do if request /api/v1/health/ready | grep '^200$' >/dev/null; then break; fi; sleep .2; done
request /api/v1/health/ready | grep '^200$' >/dev/null
for i in {1..50}; do if [ "$(docker inspect -f '{{.State.Health.Status}}' "$app")" = healthy ]; then break; fi; sleep .2; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$app")" = healthy ]
request / | grep '^200$' >/dev/null
docker exec "$db" psql -v ON_ERROR_STOP=1 -U postgres -d feedrafter_test -c "insert into import_contexts (id,instance,account) values ('00000000-0000-4000-8000-000000000001','fixture','fixture'); insert into articles (id,context_id,freshrss_id,title,imported_at) values ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','fixture','fixture',now());" >/dev/null
docker exec "$app" sh -c 'printf fixture-data > /data/fixture'
docker exec "$app" node -e 'const q=require("node:http").request({host:"127.0.0.1",port:3000,path:"/api/v1/articles/00000000-0000-4000-8000-000000000002",method:"PATCH",headers:{host:"localhost:3000",origin:"http://localhost:3000","content-type":"application/json"}},r=>{r.resume();if(r.statusCode!==200)process.exitCode=1});q.on("error",()=>process.exitCode=1);q.end(JSON.stringify({isRead:true}))'
docker stop -t 40 "$app" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$app")" = 0 ]
docker rm "$app" >/dev/null
start
wait_http
request /api/v1/articles/00000000-0000-4000-8000-000000000002 | grep '"isRead":true' >/dev/null
docker exec "$app" sh -c 'test "$(cat /data/fixture)" = fixture-data'
docker stop -t 40 "$app" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$app")" = 0 ]
docker rm "$app" >/dev/null
# Quiescent database dump and restore into a new empty database.
docker exec "$db" pg_dump -U postgres -d feedrafter_test -Fc > "$dump"
docker run --rm "${common[@]}" --entrypoint tar "$image" -C /data -cf - . > "$data_dump"
docker run --rm -i --read-only --mount "type=volume,src=$restored_data,dst=/data" --entrypoint tar "$image" -C /data -xf - < "$data_dump"
docker exec "$db" createdb -U postgres restored
docker exec -i "$db" pg_restore --exit-on-error -U postgres -d restored < "$dump"
url="postgresql://postgres:disposable-test-only@$db:5432/restored"
common=(--pull=never --network "$network" --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000 --mount "type=volume,src=$restored_data,dst=/data" -e "DATABASE_URL=$url" -e "APP_ORIGIN=$origin")
start
wait_http
request /api/v1/health/ready | grep '^200$' >/dev/null
request /api/v1/articles/00000000-0000-4000-8000-000000000002 | grep '"isRead":true' >/dev/null
docker exec "$app" sh -c 'test "$(cat /data/fixture)" = fixture-data'
docker stop -t 40 "$app" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$app")" = 0 ]
echo 'Container lifecycle, explicit migration, health and matched DB/data restore passed.'
