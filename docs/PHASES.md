# Phase plan

Each phase ends with: tests passing, docs updated, commit, push, deploy, verification. The next phase starts only after sign-off.

| Phase | Scope                                                                     | Status                                       |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------- |
| 0     | Foundation: repo, TypeScript, lint, tests, Wrangler, CI/CD, blank deploy  | ✅ Built — awaiting your deploy verification |
| 1     | UI shell: login, dashboard, sidebar, upload page, history, settings       | ⏳                                           |
| 2     | Excel upload: parsing, `Backlinks` detection, validation, dedupe, preview | ⏳                                           |
| 3     | D1 database, migrations, scan creation, auth persistence                  | ⏳                                           |
| 4     | URL checker + status classification + SSRF protection                     | ⏳                                           |
| 5     | Background scanning with Queues, throttling, retries, progress            | ⏳                                           |
| 6     | Results dashboard: cards, table, filters, search, sorting                 | ⏳                                           |
| 7     | Soft 404 detection with combined signals and reasons                      | ⏳                                           |
| 8     | Export to .xlsx / .csv preserving original columns                        | ⏳                                           |
| 9     | Backlink presence check against Target URL (HTML parsing)                 | ⏳                                           |
| 10    | Rechecking and status-change history                                      | ⏳                                           |
| 11    | Scheduled scans via Cron Triggers                                         | ⏳                                           |
| 12    | Google Sheets import                                                      | ⏳                                           |
| 13    | Production hardening                                                      | ⏳                                           |

## Decisions recorded in Phase 0

- **Single Worker** for frontend + API (Workers Static Assets). Simpler than Pages + separate Worker; one deploy, one URL, no CORS.
- **Hono** for routing: tiny, Workers-native, typed, easy to test without a runtime.
- **Vite + @cloudflare/vite-plugin**: dev server runs the real Workers runtime.
- **Staging** is a separate Worker (`env.staging`) with its own resources in later phases, so test data never touches production.
- **Free-plan awareness**: Workers Free allows 100k requests/day and limits subrequests per invocation, which is why Phase 5 splits scans into small queue batches.
