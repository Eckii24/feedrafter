# D1 server/API

The server needs Node 24.21.0, a private PostgreSQL database, and an external private-access boundary. No public login is provided. `APP_ORIGIN` is the exact browser origin, including a non-default port; the proxy must preserve its Host header. Direct non-browser clients may omit Origin but must still use that Host. JSON mutations reject cross-site browser requests. No wildcard CORS is enabled.

Build and provision explicitly (runtime never runs migrations):

```sh
mise exec node@24.21.0 -- npm run build
# Set DATABASE_URL and APP_ORIGIN in the environment, not the command history.
mise exec node@24.21.0 -- npm run db:migrate
mise exec node@24.21.0 -- npm start
```

`HOST` defaults to `127.0.0.1`, `PORT` to `3000`. `TRUSTED_PROXIES`, if set, is a comma-separated list of IP addresses or CIDRs. Supply only trusted reverse proxies. No forwarded header is trusted by default. HTTPS and network access control belong to the deployment. Readiness checks database connectivity and required schema objects; it does not test an external provider. OpenAPI is at `/api/v1/openapi.json`; `/api/v1/events` emits advisory invalidations, not a replayable log. Reconnect clients must reload snapshots.

FreshRSS is opt-in: set `FRESHRSS_ENABLED=true`, `FRESHRSS_BASE_URL` (ending in `/api/greader.php`), `FRESHRSS_EMAIL`, and either `FRESHRSS_API_PASSWORD` or `FRESHRSS_API_PASSWORD_FILE` (absolute file path). Otherwise the reader works without credentials and import start returns 503. Import writes article metadata and acknowledgement intents only; D1 does not create per-article processing tasks. Production FreshRSS read acknowledgements are hard-disabled in the client, including when configured. Pending acknowledgements remain visible in run counts. Do not remove this gate until isolated V5 and digest-compatibility evidence exists; fixture tests are not that evidence. No real FreshRSS service is used by normal tests.

## External mail queue

This application does not send email. An external consumer reads `GET /api/v1/mail-queue?limit=50&cursor=...` (limit 1–100, default 50), sends mail, then posts `{ "articleIds": ["UUID", ...] }` to `/api/v1/mail-queue/acknowledgements` (1–100 IDs; duplicates are collapsed). Responses separate `confirmed`, `alreadyConfirmed`, and `rejected` entries (`NOT_FOUND` or `NOT_SELECTED`). Acknowledgement marks selected articles sent; retries are idempotent. A sent article cannot be selected or reset: `PUT /api/v1/articles/:id/mail-selection` with `{ "selected": true|false }` returns `409 MAIL_ALREADY_SENT`. Selection is independent of read state and FreshRSS acknowledgements. All writes require the existing same-origin/JSON protections and an online connection.

Queue items are selected-unsent, ordered by selection timestamp and UUID ascending. `nextCursor` is opaque; pagination is neither a snapshot nor a lease. Consumers must coordinate sends and retries themselves. In particular, a successful external send followed by a lost acknowledgement can result in duplicate email: this API cannot guarantee exactly-once delivery.

Items include original metadata and the stored article content where available. `content.status` is `missing`, `limited`, or `available`; quality, limitation, failure code and capture metadata are exposed without waiting for processing. Transcript and summary have `missing` status and null text because these capabilities do not yet store results. No content is invented or fetched by queue reads.

## Targeted feedback

`GET /api/v1/articles/:id/feedback` lists the article's current tags and source plus previously voted detached tags, with each target's vote and timestamp. `POST /api/v1/articles/:id/feedback` accepts `{ "value": -1|0|1, "targets": [{ "type": "tag"|"source", "id": "UUID" }] }`. Targets must be distinct and nonempty; an invalid target rejects the whole request. A tag must be currently attached or have a retained vote; a source must be the article's current source. Each explicit action refreshes its vote timestamp, including repeated values and zero. `DELETE /api/v1/articles/:id/feedback/tags/:tagId` and `/sources/:sourceId` remove votes idempotently; send a JSON body such as `{}` under the mutation policy. Detached votes remain editable until removed. Feedback does not modify scores or enqueue tasks. Preference administration, tag merge, and score-context integration remain unimplemented.

## Catalog administration (local slice)

`GET /api/v1/categories` and `/api/v1/tags` return `{ "items": [...] }`, including archived records. `POST` to either collection accepts `{ "label": "..." }`; `PATCH /api/v1/categories/:id` or `/api/v1/tags/:id` accepts exactly one of `{ "label": "..." }` or `{ "archived": true }`. Responses are the created or updated record (201 or 200); an unknown ID returns 404. Labels must be nonblank and at most 200 Unicode code points after trimming or tag normalization. Category collisions compare trimmed labels case-insensitively; tag labels use NFKC/whitespace normalization and PostgreSQL Unicode casefold identity. Archived names remain reserved. Collisions return 409; invalid input and attempts to archive the fallback category return 400. Archiving is idempotent, retains existing assignments, and archived tags cannot be newly attached. The fallback category can be renamed but not archived. These routes use the same JSON/origin security policy as other mutations.

## Score-definition administration

`GET /api/v1/scores` returns `{ "items": [...] }`, including deleted definitions. `POST /api/v1/scores` requires exactly `name`, `description`, `prompt`, `active`, `includeTitle`, `includeContent`, `includeCategory`, `includeTagWeights`, and `includeSourceWeight`. `PATCH /api/v1/scores/:id` accepts a nonempty subset of those fields. Text must be nonblank, contain no NUL, and be at most 200, 2,000, and 10,000 UTF-16 code units respectively; flags must be JSON booleans. Unknown fields are rejected. The shared HTTP body limit is 16 KiB, including JSON encoding. Existing records may have empty descriptions from older writes. Responses return the definition including `id` and `deletedAt`; creation returns 201. Invalid input returns 400, unknown IDs 404, and editing a deleted definition 409 `DELETED`.

`DELETE /api/v1/scores/:id` requires JSON (e.g. `{}`), sets `active` false and persists `deletedAt`; repeating it returns the original deletion timestamp. Historical article scores are retained. Deleted definitions cannot be edited or reactivated. The 0–100 range applies to results, not definitions.

`GET /api/v1/scores/:id/category-prompts` returns `{ "items": [{ "scoreId": "UUID", "categoryId": "UUID", "prompt": "..." }] }`, including stored overrides for subsequently archived categories. `PUT /api/v1/scores/:id/category-prompts/:categoryId` accepts exactly `{ "prompt": "..." }` and returns the override. Prompt text must be nonblank, NUL-free and at most 10,000 UTF-16 code units. `DELETE` on the same path requires exactly `{}` and returns `{ "removed": true }`, including when the override did not exist. Both IDs must be valid UUIDs. Unknown scores/categories return 404, deleted scores 409, and archived or fallback categories 400 on mutations; fallback always uses the global prompt. Invalid requests leave stored overrides unchanged. Disabled but nondeleted scores are allowed.

These routes use the existing origin/Host/JSON policy and require a private access boundary. Score model execution and reevaluation remain absent; these changes neither enqueue work nor recalculate scores.

## Manual article catalog assignment

`GET /api/v1/articles/:id/catalog` returns `{ "category": { ... }, "tags": [ ... ], "assignmentRevision": 0 }`, including archived current assignments. `PATCH /api/v1/articles/:id/category` accepts exactly `{ "categoryId": "UUID" }`. `PUT` and `DELETE /api/v1/articles/:id/tags/:tagId` attach or detach a tag; send JSON, for example `{}`, under the mutation policy. Successful writes return `{ "ok": true }`. Invalid UUIDs or bodies return 400; unknown article or catalog IDs return 404; assigning an archived category or attaching an archived tag returns 409 `ARCHIVED`. Only active categories and tags are assignable; the protected fallback is an active category. Archived tags remain visible and detachable. Repeated writes are idempotent: each actual category or association change increments `assignmentRevision` once; no-op writes do not. Writes serialize against other assignment writes and catalog archive, and do not remove retained tag votes, change read/mail/score state, enqueue tasks or trigger reevaluation. The reader editor requires an online connection; changes are not queued offline.

## Reader

List filtering and date/title/score sorting happen before pagination. Date descending remains the default. For `sort=score`, provide an explicit active, non-deleted `scoreId` UUID; missing, unknown, inactive, or deleted IDs return 400. `scoreId` is not accepted for other sorts. Values sort in the selected direction with nulls last, then coalesced publication/import date descending and UUID descending. Each list item has `scoreValue`, null when no value exists or no score is selected; detail and mutation responses return null. No scores are calculated by reader requests. Cursor contents are opaque to clients and bind the filter/sort query. They are not snapshots: reload from page one after mutations. Manual category/tag assignment is available; score calculation and article-enrichment remain unavailable, and the reader returns preparation as unavailable rather than fabricating a result. The build includes the same-origin reader UI at `/`. The API exposes source IDs, not a source catalog; the reader's source filter accepts a source UUID. The service worker precaches only the versioned shell and build assets; API and event requests remain network-only. Offline changes are not queued.
