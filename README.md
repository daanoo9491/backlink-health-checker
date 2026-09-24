# Backlink Health Checker

Upload an Excel workbook of backlinks, find out which backlink pages are still live, and download the results. Built for Marketing users, hosted entirely on Cloudflare.

> **Current status: Phase 1 — UI Foundation.** Sign-in, dashboard, new scan (upload page), scan history and settings screens. Scanning arrives in later phases. See [docs/PHASES.md](docs/PHASES.md).

## Architecture

One Cloudflare Worker serves both the React frontend (static assets) and the `/api/*` backend.

```
Browser ──► Cloudflare Worker
             ├── /api/*  → Hono API (src/worker)
             └── /*      → React SPA (src/client, served as static assets)

Later phases add:  D1 (database) · Queues (background scans) · R2 (large exports) · Cron (schedules)
```

| Layer           | Technology                          |
| --------------- | ----------------------------------- |
| Frontend        | React 19, Vite, TypeScript          |
| Backend         | Cloudflare Workers, Hono            |
| Database        | Cloudflare D1 (Phase 3)             |
| Background jobs | Cloudflare Queues (Phase 5)         |
| Tests           | Vitest                              |
| Quality         | ESLint, Prettier, strict TypeScript |
| CI/CD           | GitHub Actions + Wrangler           |

## Project structure

```
src/
  client/        React app (UI)
  worker/        Cloudflare Worker (API)
    routes/      API route modules
    middleware/  Security headers, request IDs
  shared/        Types used by both client and worker
public/          Static files (_headers, favicon)
migrations/      D1 SQL migrations (Phase 3+)
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

Database, queue and bucket setup commands are added to this section in the phase that introduces them.

## GitHub setup

1. Create an empty repo named `backlink-health-checker` on GitHub (no README).
2. Push:
   ```bash
   git remote add origin https://github.com/<you>/backlink-health-checker.git
   git push -u origin main
   git push -u origin development
   ```
3. Create a Cloudflare API token: Cloudflare dashboard → My Profile → API Tokens → **Create Token** → template **Edit Cloudflare Workers**. (Later phases also need D1 and Queues edit permissions — add them to the token then.)
4. Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Account ID is on the Workers & Pages overview page).
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

Tests cover sign-in, sessions, CSRF, status labels and upload checks. They call the Hono app directly (`createApp().request(...)`), so no Worker needs to be running.

## Troubleshooting

| Problem                                     | Fix                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `Authentication error` on deploy            | Run `npx wrangler login`, or check the API token has Workers edit permission     |
| GitHub deploy fails with 10000 / auth error | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets missing or wrong        |
| Page loads but says "Service unreachable"   | `/api/*` isn't reaching the Worker; check `run_worker_first` in `wrangler.jsonc` |
| Refreshing a page gives 404                 | `not_found_handling` must be `single-page-application`                           |
| `npm ci` fails in CI                        | Commit `package-lock.json`                                                       |
| Windows: env var errors in scripts          | Scripts use `cross-env`; run `npm install` again                                 |
