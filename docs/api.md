# D1 API reference

The generated `GET /api/v1/openapi.json` is authoritative for implemented JSON schemas, required fields, bounds and responses. Routes below reflect `src/server/http/app.ts`; [server-api.md](server-api.md) covers configuration and deployment security. D1 has no application login: use only behind the private access boundary. Supply the Host matching `APP_ORIGIN`; browser Origin, when present, must match exactly. Mutations require JSON and reject cross-site requests. Errors use `{ "error": { "code", "message", "requestId" } }`; errors are deliberately redacted.

| Method and path | D1 behavior |
| --- | --- |
| GET `/api/v1/health/live` | Process liveness. |
| GET `/api/v1/health/ready` | DB and schema readiness; 503 if unavailable or incompatible. Not a provider check. |
| GET `/api/v1/openapi.json` | Generated OpenAPI. |
| GET `/api/v1/articles` | Filter and globally sort before pagination. `read=unread|read|all`, `sort=date|title`, `direction=asc|desc`, `limit=1..100`, optional `source` UUID, `kind=article|video`, `title`, opaque `cursor`. Defaults: unread, date descending, 50. Returns `{items,nextCursor}`. |
| GET `/api/v1/articles/:id` | Article by application UUID, 404 if absent. `preparation` is `unavailable` in D1. |
| PATCH `/api/v1/articles/:id` | JSON `{ "isRead": true }` or false; returns persisted article, 404 if absent. This changes application read state, not FreshRSS. |
| POST `/api/v1/pipeline/runs` | JSON `{}` starts an import or returns the active run; 202 `{runId,state,reused}`. 503 if import is unavailable. Asynchronous: poll the run or reload after an event. |
| GET `/api/v1/pipeline/runs/:id` | Run phase/status and fetched, confirmed, pending counts; 404 if absent. Pending FreshRSS acknowledgements remain unsent in D1. |
| GET `/api/v1/settings/import` | Import enabled, interval in seconds, next scheduled time. |
| PATCH `/api/v1/settings/import` | JSON with `importEnabled` and/or integer `importIntervalSeconds` (60..2147483647). |
| GET `/api/v1/events` | SSE advisory invalidations (`article.changed`, `pipeline.changed`, `settings.changed`) and 15-second heartbeats; not a durable event log. Stream cap 100. On reconnect reload authoritative snapshots; no replay guarantee. |

Example pagination: request `/api/v1/articles?read=all&sort=date&direction=desc&limit=25`; if `nextCursor` is non-null, URL-encode it and request the same query plus `cursor=<encoded-value>`. Cursors bind the query and are not snapshots; restart at page one after changes. Never construct a cursor manually.

D1 has no mail, chat, score or enrichment endpoints; mail acknowledgements and chat reconnection examples belong to later deliveries and are not implied by this API. FreshRSS read acknowledgement is hard-disabled pending the separate compatibility gates.
