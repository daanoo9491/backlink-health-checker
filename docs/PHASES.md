# Phase plan

Each phase ends with: tests passing, docs updated, commit, push, deploy, verification. The next phase starts only after sign-off.

| Phase | Scope                                                                     | Status                       |
| ----- | ------------------------------------------------------------------------- | ---------------------------- |
| 0     | Foundation: repo, TypeScript, lint, tests, Wrangler, CI/CD, blank deploy  | ✅ Done — live on Cloudflare |
| 1     | UI shell: login, dashboard, sidebar, upload page, history, settings       | ⏳                           |
| 2     | Excel upload: parsing, `Backlinks` detection, validation, dedupe, preview | ⏳                           |
| 3     | D1 database, migrations, scan creation, auth persistence                  | ⏳                           |
| 4     | URL checker + status classification + SSRF protection                     | ⏳                           |
| 5     | Background scanning with Queues, throttling, retries, progress            | ⏳                           |
| 6     | Results dashboard: cards, table, filters, search, sorting                 | ⏳                           |
| 7     | Soft 404 detection with combined signals and reasons                      | ⏳                           |
| 8     | Export to .xlsx / .csv preserving original columns                        | ⏳                           |
| 9     | Backlink presence check against Target URL (HTML parsing)                 | ⏳                           |
| 10    | Rechecking and status-change history                                      | ⏳                           |
| 11    | Scheduled scans via Cron Triggers                                         | ⏳                           |
| 12    | Google Sheets import                                                      | ⏳                           |
| 13    | Production hardening                                                      | ⏳                           |

## Decisions recorded in Phase 0

- **Single Worker** for frontend + API (Workers Static Assets). Simpler than Pages + separate Worker; one deploy, one URL, no CORS.
- **Hono** for routing: tiny, Workers-native, typed, easy to test without a runtime.
- **Vite + @cloudflare/vite-plugin**: dev server runs the real Workers runtime.
- **Staging** is a separate Worker (`env.staging`) with its own resources in later phases, so test data never touches production.
- **Free-plan awareness**: Workers Free allows 100k requests/day and limits subrequests per invocation, which is why Phase 5 splits scans into small queue batches.

## Decisions recorded in Phase 1

- **Sign-in is real, not a mock.** One account set by Cloudflare secrets (`AUTH_EMAIL`, `AUTH_PASSWORD`), HMAC-signed `__Host-` session cookie (HttpOnly, Secure, SameSite=Lax, 12 h). Phase 3 moves users into D1 with hashed passwords; the session and CSRF code stay.
- **CSRF**: every non-GET API request must carry an `Origin` matching the app.
- **Status model** lives in `src/shared/status.ts`: machine values (`DEAD`) separate from labels ("Dead"). Temporary problems are never styled as dead.
- **Badges** use colour + icon shape + text, so they work without colour vision.
- **Font**: Atkinson Hyperlegible Next, self-hosted (no third-party requests), designed for readability.
- **Upload page** accepts and validates the file (.xlsx, ≤ 10 MB). Reading it is Phase 2.

## Known limits after Phase 1

- No login attempt limiting yet (Phase 3, backed by D1).
- "Forgot password" tells the user to contact the administrator.
