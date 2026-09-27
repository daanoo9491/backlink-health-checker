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

- "Forgot password" tells the user to contact the administrator.

## Decisions recorded in Phase 2

- **Workbooks are read in the browser**, in a Web Worker. Workers on the free plan get ~10 ms CPU per request, far too little to parse a large workbook. The browser does the heavy lifting; Phase 3 sends the extracted rows to the API, which re-validates every URL with the same shared rules (`src/shared/url.ts`).
- **Own .xlsx reader** (`src/client/import/xlsx-reader.ts`, ~15 KB with `fflate`) instead of SheetJS or ExcelJS. The npm `xlsx` package is an outdated release with known vulnerabilities, and ExcelJS is ~21 MB. Our reader handles shared and inline strings, rich text, `=HYPERLINK()` formulas, inserted hyperlinks, date formats, hidden sheets and namespace prefixes, with size and row limits against zip bombs.
- **Column detection**: a cell reading `Backlinks` or `Backlink` (any case, extra spaces, trailing colon) in the first 20 rows of a sheet is the header. Optional columns recognised: Target URL, Anchor Text, Date, Status, DA.
- **Hyperlinked cells**: when a cell shows text like “View post” and links to a page, the link is used; the text is kept for export.
- **URL rules**: only http/https; `www.` links get `https://` added (and the user is told); anything else without a scheme is rejected rather than guessed. Credentials, localhost and private/link-local IPs are rejected now; Phase 4 adds DNS-level SSRF checks.
- **Duplicates** are matched after safe normalisation only (host case, default port, trailing dot, `#fragment`). Path case, query strings and http vs https stay distinct because they can serve different pages.
- **Limits**: 10 MB file, 100,000 rows, 256 columns, 200 MB uncompressed XML.

## Decisions recorded in Phase 3

- **Tables**: `users`, `scans`, `scan_rows`, `unique_urls`, `login_attempts` (`migrations/0001_initial.sql`). The spec's separate `scan_results` table is folded into `unique_urls`: each unique link is checked once and every row that points at it reads the same result. `exports` arrives with Phase 8.
- **Saving in chunks**: `POST /api/scans` (describe) → `/urls` (2,000 per request) → `/rows` (1,000 per request) → `/complete` (verify counts). This keeps every request inside the free plan's ~10 ms CPU, 50 queries per request and 100 bound parameters per query. Each chunk is ONE `INSERT … SELECT … FROM json_each(?)` statement. Chunks are retry-safe (`INSERT OR IGNORE` on natural keys); a failed save resumes the same scan.
- **Server-side checks**: the browser's counts are not trusted. `/complete` recounts in SQL and refuses (`409 UPLOAD_INCOMPLETE`) if anything is missing or a row points at a URL that doesn't exist. URLs are shape-checked on save (http/https only); full rules plus DNS-level SSRF checks run again before any request in Phase 4.
- **Privacy**: every query includes the signed-in user's id; another user's scan returns 404.
- **Sign-in**: the account now has a row in `users`; sessions carry its id (old sessions must sign in again). Throttling: 10 failures per IP or 50 per email in 15 minutes → 429.
- **Limits**: 20,000 rows and 20,000 unique links per scan (the free plan allows ~100,000 D1 row writes per day).

## Decisions recorded in Phase 4

- **Who drives checking (for now)**: the scan page calls `POST /api/scans/:id/check` in a loop; each call checks up to 8 links. Phase 5 moves the same `runCheckBatch` into a Cloudflare Queue consumer so the browser can close.
- **Free-plan subrequests**: a Worker invocation may make 50 outgoing requests, and redirect hops and DNS lookups count. A `SubrequestBudget` (45) is tracked; links that don't fit go back to waiting for the next batch instead of failing.
- **SSRF protection, on every hop**: redirects are followed manually (`redirect: 'manual'`, max 5). Before each request: http/https only, no credentials, no `localhost`/`.local`/`.internal`, no private/loopback/link-local/metadata/CGNAT/multicast IPs (IPv4 and IPv6, incl. IPv4-mapped), never the app's own hostname, and a DNS-over-HTTPS lookup (A + AAAA) that refuses names resolving to internal addresses. DNS failure fails closed. Bodies are never read in this phase.
- **Classification** (`src/worker/checker/classify.ts`): 2xx → Active; 2xx after a redirect to a _different_ page → Redirected; after a _same-page_ redirect (http→https, www, trailing slash) → Active, with the redirect recorded; 404/410 (also at the end of a redirect chain) → Dead; 401/403/451 and other 4xx → Blocked; 408 → Timed out; 429 → Rate limited; 5xx and redirect loops → Server error; no answer in 15 s → Timed out; connection/TLS problems and unknown domains → Could not connect ("the domain doesn't exist (it may have expired)" is called out).
- **Politeness**: at most 4 websites at once; requests to the same website run one at a time, 0.8 s apart. Each unique link is requested once, however many rows use it.
- **Concurrency safety**: links are reserved (`claimed_at`, migration `0002`) while being checked, so two tabs never check the same link; reservations older than 2 minutes are taken over. Scan totals are recounted from `unique_urls` after every batch.

## Added after Phase 4 (brought forward from Phase 6 on request)

- **Results filters** on the scan page: status buttons with row counts (All, Active, Dead, Redirected, Need a look, Waiting, Skipped; empty groups hidden), search across backlink and target URL, Sheet and HTTP-code dropdowns, Clear filters. Filtering runs in SQL across all rows, not just the visible page; user input is always bound as parameters and searched with `instr()` so `%` and `_` are literal. Filters live in the page address (`?status=dead&sheet=…`), so refresh and Back keep them.
- Phase 6 still adds sorting, summary cards and issue categories.
