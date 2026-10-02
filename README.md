# LinkLedger SEO

_Backlink & index monitor. Formerly “Backlink Health Checker”: the repo, Worker names and web addresses keep the old name, so nothing had to move._

An internal tool for our Marketing team, with two tools behind one sign-in:

- **Link Health**: upload an Excel workbook of backlinks (or just paste links) and find out which backlink pages are still live.
- **Index Checker**: whether Google can index each page (robots.txt, noindex, canonical), with the evidence. Search Console results for your own sites follow in Phase 9.

The app runs on Cloudflare; data is stored in Supabase Postgres.

> **Current status: Phase 9 (Index Checker, part 2: Search Console).** Pages on your own sites connected to Google Search Console get Google's own answer, **Indexed** or **Not indexed** with Google's reason (e.g. “Crawled - currently not indexed”), via the URL Inspection API. Everyone else's pages keep the signal-based results. See _Search Console setup_ below.
>
> **Phase 8 (Index Checker, part 1).** Paste or upload URLs, or run it on a Link Health scan. For each page it reads robots.txt (as Googlebot), the meta robots tag, the X-Robots-Tag header and the canonical, and reports **Indexable**, **Blocked from indexing**, **Crawling blocked**, **Canonical points elsewhere**, **Page not reachable** or **Unknown**, with the evidence. It never says “Not indexed”: only Search Console can (Phase 9).
>
> **Phase 7 (page reader + soft 404).** Pages that answer “200 OK” but are really gone (a “Page not found” title or heading, a not-found message on a short page, or a removed page that now lands on a home page or an error address) are reported as **Soft 404**, with the reason. Bot-check pages count as Blocked. Each backlink page’s title is saved, shown and searchable.
>
> **Phase 6 (new name, two-tool layout).** Results can be sorted by row, backlink, status (most urgent first) or HTTP code; the summary cards and an “Issues to look at” list filter the table by issue category, each with advice on what to do.
>
> **Phase 5 (background checking).** Upload a workbook or paste links; every unique link is checked once and classified (Active, Dead, Redirected, Blocked, Rate limited, Server error, Timed out, Could not connect), with SSRF protection on every request and redirect. Checking runs in the background on Cloudflare Queues, so you can close the browser; temporary failures are retried automatically, and a scan can be paused and resumed. Data lives in Supabase Postgres, reached through Cloudflare Hyperdrive. See [docs/PHASES.md](docs/PHASES.md).

## Architecture

One Cloudflare Worker serves both the React frontend (static assets) and the `/api/*` backend.

```
Browser ──► Cloudflare Worker
             ├── /api/*  → Hono API (src/worker) ──► Hyperdrive ──► Supabase Postgres
             └── /*      → React SPA (src/client, served as static assets)

Daily Cron Trigger ──► keep-alive write (stops Supabase's free plan pausing the project)
             Queue `bhc-checks` ──► same Worker (queue consumer): one message = 8 links
             Cron every 10 min ──► restart stalled scans · keep Supabase awake
Later phases add:  R2 (large exports) · scheduled rechecks
```

| Layer           | Technology                                                |
| --------------- | --------------------------------------------------------- |
| Frontend        | React 19, Vite, TypeScript                                |
| Backend         | Cloudflare Workers, Hono                                  |
| Database        | Supabase Postgres via Cloudflare Hyperdrive (`pg` driver) |
| Background jobs | Cloudflare Queues + a 10-minute Cron safety net           |
| Tests           | Vitest                                                    |
| Quality         | ESLint, Prettier, strict TypeScript                       |
| CI/CD           | GitHub Actions + Wrangler                                 |

## Project structure

```
src/
  client/        React app (UI)
    import/      Excel reader + backlink import (runs in a Web Worker)
  worker/        Cloudflare Worker (API)
    routes/      API route modules
    middleware/  Security headers, request IDs
  shared/        Code used by both client and worker (types, statuses, URL rules)
public/          Static files (_headers, favicon)
migrations/      Postgres SQL migrations (applied by scripts/migrate.mjs)
tests/           Vitest tests and fixtures
docs/            Phase plan and notes
.github/         CI and deploy workflows
wrangler.jsonc   Cloudflare configuration
```

## Local setup

Requirements: Node.js 22 (see `.nvmrc`), npm, a Cloudflare account.

```bash
git clone https://github.com/<you>/backlink-health-checker.git
cd backlink-health-checker
npm install
cp .dev.vars.example .dev.vars   # then edit: your sign-in email, password and a session secret
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run db:migrate   # local Postgres, see below
npm run secret                   # prints a random SESSION_SECRET to paste into .dev.vars
npm run dev                      # http://localhost:5173
```

`npm run dev` runs the Worker inside Cloudflare's real runtime (workerd), so local behaviour matches production.

## Scripts

| Command                           | What it does                                         |
| --------------------------------- | ---------------------------------------------------- |
| `npm run dev`                     | Local dev server (frontend + Worker)                 |
| `npm run build`                   | Type-check and build for production                  |
| `npm run preview`                 | Build, then serve the production build locally       |
| `npm run lint`                    | ESLint                                               |
| `npm run format` / `format:check` | Prettier                                             |
| `npm run typecheck`               | TypeScript, no emit                                  |
| `npm test`                        | Vitest                                               |
| `npm run check`                   | Lint + typecheck + test + build (run before pushing) |
| `npm run deploy`                  | Build and deploy to **production**                   |
| `npm run deploy:staging`          | Build and deploy to **staging**                      |

## Environment configuration

| Where                     | What                                            | How                                                              |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| `wrangler.jsonc` → `vars` | Non-secret settings (`APP_ENV`, `APP_NAME`)     | Committed                                                        |
| `.dev.vars`               | Local Worker secrets                            | Not committed; copy from `.dev.vars.example`                     |
| Cloudflare secrets        | Production Worker secrets                       | `npx wrangler secret put NAME` (add `--env staging` for staging) |
| GitHub Actions secrets    | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Repo → Settings → Secrets and variables → Actions                |

### Sign-in secrets (required from Phase 1)

Each Worker (production **and** staging) needs three secrets. In Cloudflare: **Workers & Pages** → the Worker → **Settings** → **Variables and Secrets** → **Add** → type **Secret**.

| Name             | Value                                        |
| ---------------- | -------------------------------------------- |
| `AUTH_EMAIL`     | The email used to sign in                    |
| `AUTH_PASSWORD`  | The sign-in password (use a strong one)      |
| `SESSION_SECRET` | 32+ random characters — run `npm run secret` |

Or from the terminal: `npx wrangler secret put AUTH_EMAIL` (add `--env staging` for staging). Secrets survive deploys. Until they are set, the login page says sign-in isn't set up. Phase 3 replaces this single account with a users table.

**Never commit** `.env`, `.dev.vars`, API keys or tokens. `.gitignore` blocks them and CI fails if one is tracked.

## Cloudflare setup

1. Log in: `npx wrangler login`
2. First deploy: `npm run deploy` → creates Worker `backlink-health-checker` at `https://backlink-health-checker.<your-subdomain>.workers.dev`
3. Staging: `npm run deploy:staging` → creates `backlink-health-checker-staging`
4. Verify: open `/api/health` on the deployed URL — it should return `{"status":"ok", ...}`

### Database setup (once): Supabase + Hyperdrive

Production and staging each get their own Supabase project (the free plan allows two), so test data never touches production.

**1. Create the Supabase projects.** At supabase.com: **New project** → name `bhc-production` → choose a strong database password (save it in your password manager) → pick the region nearest your users. Repeat for `bhc-staging`.

**2. Copy each connection string.** In the project, click **Connect** → **Session pooler** → copy the URI. It looks like:

```
postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-eu-west-2.pooler.supabase.com:5432/postgres
```

Replace `[YOUR-PASSWORD]` with the database password. Use **Session pooler** (port 5432 on the `pooler.supabase.com` host): it works over IPv4, which GitHub Actions needs. (Cloudflare's docs mention the _Direct connection_; on Supabase's free plan that one is IPv6-only, so the Session pooler is the reliable choice.) Don't use the Transaction pooler (port 6543).

**3. Create the Hyperdrive configs** (Hyperdrive pools and speeds up the connection from Workers; it's included in the free plan):

```bash
npx wrangler hyperdrive create bhc-production --connection-string="<production Session pooler string>"
npx wrangler hyperdrive create bhc-staging --connection-string="<staging Session pooler string>"
```

Each prints an `id`. Paste them into `wrangler.jsonc`, replacing `PASTE-PRODUCTION-HYPERDRIVE-ID-HERE` and `PASTE-STAGING-HYPERDRIVE-ID-HERE`. Hyperdrive ids are not secrets; the password stays inside Cloudflare.

**4. Add GitHub secrets** so the deploy can create and update tables: `SUPABASE_DB_URL_PRODUCTION` and `SUPABASE_DB_URL_STAGING` (the same Session pooler strings).

**5. Cloudflare API token:** add **Account → Hyperdrive → Edit** and **Account → Queues → Edit** to the token GitHub uses (the D1 permission is no longer needed).

### Queue setup (once, Phase 5)

Checking runs in the background on Cloudflare Queues (included in the free plan: 10,000 operations a day, about 3 per batch of 8 links, so roughly 25,000 links a day). Create the two queues once:

```bash
npx wrangler queues create bhc-checks
npx wrangler queues create bhc-checks-staging
```

`wrangler.jsonc` already connects each Worker to its queue as both sender and consumer.

The deploy workflow runs `npm run db:migrate` before each deploy. Tables live in `migrations/*.sql`; applied files are recorded in `schema_migrations`. Never edit an applied migration; add a new numbered file instead.

**Security:** every table has row level security switched on with no policies, and Supabase's `anon`/`authenticated` roles have no rights. Supabase's public web API therefore can't read anything, even with the project's anon key. The app connects directly, as the database owner, through Hyperdrive.

**Copying old scans from D1 (one-off):** scans saved while the app used Cloudflare D1 can be copied into Supabase:

```powershell
$env:DATABASE_URL="<Session pooler string for the SAME environment>"
npm run import:d1 -- --from staging --dry-run   # shows what would be copied
npm run import:d1 -- --from staging             # copies
```

It reads D1 through your `npx wrangler login`, matches users by email (scans attach to the account you already use on the new database), copies each scan in one transaction and checks the counts before saving it. Running it again skips scans already copied. Unfinished uploads are left out; links that were mid-check become "waiting" so checking can continue.

**Cron (every 10 minutes):** restarts any scan whose background chain went quiet for 10 minutes (e.g. a message that failed all its retries), and writes one row to `heartbeat`. Supabase pauses free projects after about a week without activity, so this also keeps the project awake.

**Local development:** `npm run dev` connects to the `localConnectionString` in `wrangler.jsonc` (`postgres://postgres:postgres@localhost:5432/postgres`). Run a Postgres there (for example `supabase start`, or Docker `postgres:16`), then `DATABASE_URL=… npm run db:migrate`. Queues run locally inside `npm run dev` with no setup.

### Search Console setup (optional, Phase 9)

Lets the Index Checker show Google's own answer for **your** sites. Without it, index checks use signals only.

1. **Google Cloud project:** at [console.cloud.google.com](https://console.cloud.google.com), create a project (e.g. “LinkLedger SEO”).
2. **Turn on the API:** APIs & Services → Library → **Google Search Console API** → Enable.
3. **Service account:** IAM & Admin → Service Accounts → **Create service account** (name it e.g. `linkledger`); no roles are needed → Done.
4. **Key:** open the service account → Keys → Add key → Create new key → **JSON**. A `.json` file downloads. Treat it like a password.
5. **Give it access in Search Console:** for each site (e.g. `lanop.co.uk`): Search Console → Settings → Users and permissions → **Add user** → paste the service account's email (it ends in `iam.gserviceaccount.com`) → **Full** permission.
6. **Store the key as a secret** (PowerShell, in the project folder):

   ```powershell
   Get-Content "C:\path\to\key.json" -Raw | npx wrangler secret put GSC_SERVICE_ACCOUNT --env staging
   Get-Content "C:\path\to\key.json" -Raw | npx wrangler secret put GSC_SERVICE_ACCOUNT
   ```

   (first line staging, second production). Then delete the downloaded file or keep it somewhere safe; never commit it.

7. **Check:** Settings → Google Search Console lists your sites and today's usage.

Google allows 2,000 URL inspections per site per day; the app stops at 1,900 (leaving room for Search Console's own website) and falls back to signals for the rest of that day. The key is used only to sign in to Google with read-only access; the app never shows it.

If your Google Workspace blocks service-account keys (“key creation is disabled”), an admin must allow it for this project.

## GitHub setup

1. Create an empty repo named `backlink-health-checker` on GitHub (no README).
2. Push:
   ```bash
   git remote add origin https://github.com/<you>/backlink-health-checker.git
   git push -u origin main
   git push -u origin development
   ```
3. Create a Cloudflare API token: Cloudflare dashboard → My Profile → API Tokens → **Create Token** → template **Edit Cloudflare Workers**, then add **Account → Hyperdrive → Edit** and **Account → Queues → Edit**.
4. Add repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_DB_URL_PRODUCTION` and `SUPABASE_DB_URL_STAGING` (Account ID is on the Workers & Pages overview page).
5. Optional but recommended: Settings → Branches → protect `main` and require the **CI / check** status to pass.

## Branching and deployment

| Branch               | Purpose               | Deploys to        |
| -------------------- | --------------------- | ----------------- |
| `main`               | Production            | Production Worker |
| `development`        | Integration / staging | Staging Worker    |
| `feature/*`, `fix/*` | Work in progress      | — (CI runs on PR) |

Flow: `feature/x` → PR into `development` → test on staging → PR `development` into `main` → production.

## Testing

```bash
npm test          # run once
npm run test:watch
```

Worker tests run against a real Postgres (PGlite, in-process) built from the same `migrations/*.sql` as Supabase. Tests cover sign-in, throttling, sessions, CSRF, scan saving, privacy between users, status labels, upload checks, URL validation, pasted links and the Excel importer (using real workbooks in `tests/fixtures/`). They call the Hono app directly (`createApp().request(...)`), so no Worker needs to be running.

### Excel test fixtures

The workbooks in `tests/fixtures/` are generated by `scripts/make-fixtures.py` (Python + `openpyxl`). They are committed, so you only need Python if you want to change them.

## Troubleshooting

| Problem                                     | Fix                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `Authentication error` on deploy            | Run `npx wrangler login`, or check the API token has Workers edit permission     |
| GitHub deploy fails with 10000 / auth error | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets missing or wrong        |
| Page loads but says "Service unreachable"   | `/api/*` isn't reaching the Worker; check `run_worker_first` in `wrangler.jsonc` |
| Refreshing a page gives 404                 | `not_found_handling` must be `single-page-application`                           |
| `npm ci` fails in CI                        | Commit `package-lock.json`                                                       |
| Windows: env var errors in scripts          | Scripts use `cross-env`; run `npm install` again                                 |
