# BG Repeaters Worker – AI Guide

## Architecture
- `src/index.ts` boots a Hono app, mounts the versioned API router from `src/api.ts`, applies CORS/powered-by/etag middleware, and proxies `/public/*` through the `ASSETS` binding so Workers can ship the `public/` bundle alongside the API.
- `wrangler.jsonc` declares the D1 binding `RepsDB`, assets binding, and custom domains; Cloudflare Pages scripts in `package.json` are legacy and can be ignored unless touching the Pages deploy flow.
- All HTTP handlers live in `src/api.ts` using `OpenAPIHono`; each route is described via `@hono/zod-openapi` schemas so updating endpoints generally means editing both the schema in `src/api/*Schema.ts` and the resolver in `api.ts`.

## Data & DB access
- `src/db.ts` is the single entry point to the D1 database; every SQL statement is parameterized via `DB.prepare(...).bind(...).run()` – keep that pattern to avoid SQL injection.
- Input repeaters are sanitized via `sanitizeRepeater` (`src/sanitize.ts`) before writes; never write user-provided strings straight into SQL or JSON responses without passing through these helpers.
- Derived fields like `qth` and `freq.channel` are computed server-side (`getChannel`, Maidenhead locator) and should not be stored from client payloads; update code already strips those fields.
- When touching write paths, prefer the `*WithLog` wrappers so changelog entries stay consistent (`addChangelog` skips the `INTUSER` integration user on purpose).

## Auth & sessions
- Admin login (`POST /v1/admin/login`) still uses Basic Auth backed by SHA-256 hashes in the `users` table plus a `SUPERADMIN` user controlled via the `SUPERADMIN_PW` env var.
- After login the worker issues HMAC JWTs using helpers in `src/session.ts`; any new protected route should use the existing `adminGuard` / bearer middleware so idle refresh, UA/device pinning, and `X-New-JWT` token rolling continue to work.

## Request validation & serialization
- Queries hit `convertDotNotationToNestedObject` to map flags like `have_rx_from` into the nested shape expected by `RepeaterQueryInternalSchema`; replicate this approach when adding new dot-notated filters so the DB layer receives booleans/numbers instead of raw strings.
- All errors should return `{ failure: true, errors: {...}, code }` as modeled by `ErrorSchema`; reuse `formatZodErrors` for schema issues and wrap DB failures with `ContentfulStatusCode` values.

## Client bundle & public API
- `public/bgreps.js` is the published client; `test/bgreps.test.js` asserts its fetch contract (query building, auth retries). Update those tests whenever you change endpoints, headers, or auth flows.
- Integration tests in `test/bgreps.integration.test.js` hit a live worker at `http://localhost:8787/v1`; they seed ephemeral admin users through `wrangler d1 execute`, so keep schema changes backwards compatible or update the SQL there.

## Local dev & testing workflows
- Run `npm install` once, then `npm run dev` (wrangler dev on port 8787) for a full worker + asset environment. Assets mount from `public/`, and D1 will use your configured local binding.
- Unit tests: `npm test` (Node’s built-in runner) covers the JS client and sanitizer.
- Integration tests: `BGREPS_RUN_INTEGRATION=true npm run test:integration` while `npm run dev` (or a deployed worker) is live. Ensure `wrangler d1` is authenticated and the schema (`schema.sql`) has been applied locally before running them.

## Deployment & ops
- `npm run deploy` wraps `wrangler deploy --minify`; the CLI reads secrets/bindings from your Cloudflare account, so keep `BGREPS_JWT_*`, `SUPERADMIN_PW`, and D1 credentials up to date.
- Static docs live under `/ui` (Swagger UI via `@hono/swagger-ui`) reading `/v1/doc`; remember to align schema descriptions/examples with the actual DB columns so consumers of `bgreps.js` stay in sync.

## Gotchas
- HTTPS is enforced in production (`BGREPS_REQUIRE_HTTPS`); when testing login over HTTP you must run through localhost/10.x networks or override that env var.
- Disabled repeaters are filtered unless `include_disabled=true`; DB queries default to `disabled=0`, so new filters must respect that logic to avoid leaking offline entries unintentionally.
