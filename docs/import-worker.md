# Import worker

Node 24.21.0 and PostgreSQL are required. Provision explicitly with administrative database credentials, then run with runtime credentials:

```sh
mise exec node@24.21.0 -- npm run build:foundation
DATABASE_URL=... mise exec node@24.21.0 -- npm run import:provision
DATABASE_URL=... FRESHRSS_BASE_URL=... FRESHRSS_EMAIL=... FRESHRSS_API_PASSWORD=... mise exec node@24.21.0 -- npm run import:worker
```

`FRESHRSS_BASE_URL` ends in `/api/greader.php`; the password is the FreshRSS API password. Use environment injection or a secret manager, not literal credentials in shell history. Runtime does not run migrations or create queues. Provisioning installs the app schema and pg-boss queues. The worker schedules a wake each minute; the persisted settings control the elapsed interval (default four hours) and enablement. Startup coalesces overdue work into one import for the configured context. The worker accepts SIGTERM/SIGINT for shutdown.

Production FreshRSS mutations remain hard-disabled in `FreshRssClient`, regardless of configuration. Failed/disabled acknowledgements stay pending with run counts; no production acknowledgement may be enabled until V5 and digest compatibility are independently established. No live FreshRSS access is required by tests.

This standalone worker is scoped to its single configured context. `startImportWorkers` accepts a context-to-client factory for hosts supporting multiple contexts. Existing historical contexts are not scheduled by the standalone worker. Article preparation/processing is not implemented in this delivery; the worker stores metadata and acknowledgement intents but does not fabricate preparation tasks or results.
