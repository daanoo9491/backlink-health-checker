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

## Changed after Phase 4: database moved to Supabase; paste links

- **Database: Cloudflare D1 → Supabase Postgres, via Cloudflare Hyperdrive** (on request). Hyperdrive pools connections near the Worker, and its queries count against Cloudflare's 1,000 internal-service limit, not the free plan's 50 external subrequests per invocation, so link checking keeps its full request budget. Free plan: 100,000 Hyperdrive queries per day.
- Driver: `pg` (node-postgres ≥ 8.16.3, as Cloudflare requires), one lazily opened connection per request, closed after the response. Everything goes through a small `Db` interface (`src/worker/db/db.ts`); tests use PGlite (real Postgres in-process) behind the same interface.
- Schema `migrations/001_initial.sql`: same tables as before, Postgres-native (`uuid`, `timestamptz`, `jsonb`, `boolean`; an identity column keeps workbook order). Bulk inserts use `jsonb_array_elements_text`/`jsonb_to_recordset`; link reservations use `FOR UPDATE SKIP LOCKED`. Migrations run with `scripts/migrate.mjs` (tracked in `schema_migrations`), from CI before each deploy.
- **Supabase web API closed**: RLS on every table with no policies, and all rights revoked from `anon`/`authenticated`.
- **Keep-alive**: daily Cron Trigger writes a heartbeat so the free project is never paused; it also clears expired sign-in counters.
- Scan ids that aren't valid UUIDs return 404 before reaching the database; NUL characters (which Postgres can't store) are stripped from uploaded cells.
- Old D1 scans are not migrated (staging test data only; production had not received Phase 3). The D1 databases can be deleted.
- **Paste links**: paste links into the box on New scan (or anywhere on the page), or drag links onto the upload area or the Dashboard; the text becomes a one-sheet import ("Pasted links") validated and de-duplicated exactly like Excel, saved, and checking starts straight away. Typing or editing, then **Check N links**, also works.
- **Start scan now starts checking** straight away (no second click). A refresh does not restart it.

## Fix: runaway database usage while checking (found via D1's daily limit)

A day of testing read 23.9 million D1 rows (free limit: 5 million/day). Cause: the scan page's checking loop asked again **immediately** when a batch had nothing to check (links reserved by a second tab, or by a batch that was interrupted, for up to 2 minutes). That loop could run several times a second, and every call recounted the scan and reloaded the whole results table with its filter counts. The same bug would have used up Hyperdrive's 100,000 queries/day just as quickly, so moving databases alone would not have fixed it.

- The loop now waits whenever a batch checks nothing: the server returns `retryAfterMs` (5 s); otherwise 2 s, 4 s, 8 s … up to 15 s (`src/client/lib/check-loop.ts`, unit-tested).
- An idle batch does one small count and no recount (≤ 3 queries). A normal batch returns the updated scan from its single recount query (≤ 5 queries, was 6+).
- While checking, the results table reloads at most every 5 s and once at the end, not after every batch.
- The Sheet filter list comes from the scan record instead of reading every row.
- `tests/worker/query-budget.test.ts` holds each endpoint to a query budget, so this can't creep back.
- Measured: one scan checked in two tabs at once (40 links): 10 check requests, 98 database transactions in total. Two tabs left open on a finished scan make no requests.

## One-off: copy old D1 scans into Supabase

`scripts/import-from-d1.mjs` (`npm run import:d1 -- --from staging`). Reads D1 with `wrangler d1 execute --json` through a temporary config (no API token needed beyond `wrangler login`), keyset-paged 500 rows at a time to keep D1 reads low, and writes each scan in a single Postgres transaction with a count check before commit. Users are matched by email; scan ids, results, timestamps, row order and original cells are kept. Idempotent (existing scans skipped). Tested against a local D1 built from the old migrations: a 404-row and a 1,200-row scan (paging), duplicates, invalid rows, Unicode cells, an interrupted check, an unfinished upload (skipped), and an account that already existed on the new database.

## Decisions recorded in Phase 5 (background checking)

Checking moved from the browser to the server, on Cloudflare Queues. Closing the tab, the laptop going to sleep or losing Wi-Fi no longer stops a scan.

- **One message = one batch of 8 links.** After each batch the consumer sends the next message for the same scan, so each scan runs as one chain: politeness to websites is unchanged (4 sites at once, 0.8 s between requests to the same site) and each invocation stays inside the free plan's 50-request limit.
- **Chain token.** Start mints a new `chain_id`; messages carrying an older one are dropped. A double click, two tabs, or Pause → Resume can never run two chains for one scan. Start does nothing while a chain has reported in during the last 3 minutes.
- **Pause / Resume.** Pause clears the chain (the queued message is dropped on arrival); a batch already running finishes and keeps the scan paused. Resume starts a new chain from where it stopped.
- **Automatic retries.** Timeouts, 429, 5xx, dropped connections and failed DNS look-ups (not "domain doesn't exist") are retried up to 3 attempts in total: after 1 minute, then 4 (or the site's `Retry-After`, capped at 15 minutes). Until the last attempt the link keeps its latest result, shows "Trying again automatically soon", and counts as still to do. While only retries are waiting the chain sleeps (delayed message, 5 s – 5 min) instead of polling.
- **Request budget.** If no link in a batch could finish within the request budget (e.g. long redirect chains checked side by side), the next batch takes one link at a time, so a scan can't get stuck.
- **Safety net.** A Cron Trigger every 10 minutes restarts scans that are queued/running but haven't reported in for 10 minutes (heartbeat), up to 20 per run. Paused and finished scans are left alone. A message that throws is retried by the queue (30 s, up to 3 times) before the safety net steps in.
- **Scan page** polls the scan every 4 s while it is checking (not when the tab is hidden) and reloads the table at most every 12 s. It shows a Pause / Resume button and, if a scan hasn't moved for 3 minutes, a "Restart now" button.
- **Usage per batch:** ≤ 5 database queries and 1 message (~3 queue operations). An idle wake-up: ≤ 3 queries. Enforced by `tests/worker/query-budget.test.ts`.
- **Endpoints:** `POST /api/scans/:id/start` and `POST /api/scans/:id/pause` replace `POST /api/scans/:id/check`. New scan statuses: `paused`; migration `002_background.sql` adds `chain_id`, `heartbeat_at`, `app_host` to scans and `retry_at` to links.
- **App host.** The queue consumer has no incoming request, so Start records the app's hostname on the scan; the checker still refuses to request the app itself.

## Known limits after Phase 5

- Free Queues plan: about 25,000 links a day across all scans. Messages are kept 24 hours; anything older is picked up by the Cron safety net.
- A link that keeps failing temporarily is shown with its last error after 3 attempts; "Check again" for single links comes with rechecks (Phase 14).

## Decisions recorded in Phase 6 (new name, two-tool layout)

- **Name: LinkLedger SEO**, tagline “Backlink & index monitor” (recommended in the product plan; it's an internal team tool, so no trademark search was needed). Only the display name changed, kept in one place (`src/shared/brand.ts`, plus `APP_NAME` in `wrangler.jsonc` for `/api/health`). The repo, Worker names, queue names and every web address are unchanged, so old links and bookmarks still open. The checker's User-Agent now says `LinkLedgerSEO/1.0`.
- **Two tools in the menu:** a **Link Health** section (New scan, Scan history) and an **Index Checker** section. Index Checker is a “coming next” page explaining the two routes (Search Console for your own sites; signals for everyone else's) and the rule that someone else's page is never labelled “Not indexed”. The Dashboard is split the same way.
- **Sorting:** column headers sort by Row (workbook order, default), Backlink (A–Z), Status (most urgent first: gone → can't be reached → site errors → refused → redirected → active → waiting; skipped rows always last) and HTTP code (no response last). Press again to reverse. Ties keep workbook order. Sort lives in the address (`?sort=status&dir=desc`), so refresh and Back keep it. Only fixed, whitelisted ORDER BY strings reach SQL.
- **Issue categories** (`src/shared/issues.ts`): every non-active result falls in exactly one: Page gone (404/410, soft 404), Can't be reached (DNS/connection/certificate), Site errors (5xx, timeout), Site refused our check (403, 429), Redirected. Each has one or two sentences of advice. They are filter groups too (`?status=refused` etc.).
- **Summary cards are buttons** that filter the table; the “Issues to look at” list has a Show rows button per category. Card numbers count unique links and come from the same query as the table, so they always agree with the filters.
- **No double counting:** a link waiting for its automatic retry counts as Waiting only, not also as Need a look (Phase 5 showed it in both).
- **No extra database work:** the per-result counts replaced the old “which HTTP codes exist” query (one grouped pass gives both), so the results endpoint is still ≤ 5 queries.
- **Phone layout fix:** wide tables now scroll inside their box instead of widening the whole page (it happened on Scan history and the scan page).
