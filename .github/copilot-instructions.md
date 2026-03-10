# BG Repeaters Worker – AI Guide

## Architecture Overview

- **Runtime**: Cloudflare Workers (Wrangler + Hono framework)
- **Database**: Cloudflare D1 (SQLite backend)
- **Validation**: Zod + `@hono/zod-openapi` for runtime validation and OpenAPI schema generation
- **Authentication**: Basic Auth (SHA-256) for login + HMAC JWT for sessions

### App Structure

- `src/index.ts` boots a Hono app, mounts the versioned API router from `src/api.ts`, applies middleware (CORS/powered-by/etag), and proxies `/public/*` through the `ASSETS` binding (serves `public/bgreps.js` client library).
- `wrangler.jsonc` declares the D1 binding `RepsDB`, assets binding, and custom domains; legacy Cloudflare Pages scripts in `package.json` can be ignored.
- All HTTP handlers live in `src/api.ts` using `OpenAPIHono`; each route is described via `@hono/zod-openapi` schemas, so updating endpoints requires editing both the Zod schema in `src/api/*Schema.ts` and the handler resolver in `api.ts`.
- Static OpenAPI (Swagger) documentation auto-generated at `/v1/doc` and served via Swagger UI at `/ui`.

## Data & DB Access

- `src/db.ts` is the single entry point to the D1 database; every SQL statement is parameterized via `DB.prepare(...).bind(...).run()` – **keep that pattern to avoid SQL injection**.
- Input repeaters are sanitized via `sanitizeRepeater` (`src/sanitize.ts`) before writes; never write user-provided strings straight into SQL or JSON responses without passing through these helpers.
- Derived fields like `qth` (Maidenhead locator) and `freq.channel` are computed server-side (via `getChannel`, `locator` library) and **should NOT be stored from client payloads**; repeater update code already strips those fields.
- When touching write paths, prefer the `*WithLog` wrappers (e.g., `addRepeaterWithLog`, `updateRepeaterWithLog`, `deleteRepeaterWithLog`) so changelog entries stay consistent; `addChangelog` skips the `INTUSER` integration user on purpose.

### Database Query Patterns

**Parameterized queries (safe from SQL injection)**:
```typescript
const result = await DB.prepare(
  'SELECT * FROM repeaters WHERE callsign = ?'
).bind(callsign).run();
```

**Changelog entry creation** (use `*WithLog` wrappers):
```typescript
// Instead of:
await addRepeater(db, repeaterData);

// Use:
await addRepeaterWithLog(db, username, repeaterData);
// This automatically logs { date, who: username, info } to changelog
```

**Rate limiting queries** (guest requests):
```typescript
const counts = await countRequestRateLimitHits(db, { contactHash, ip }, windowMinutes);
// Returns { byContact, byIp } to enforce per-contact and per-IP limits
```

## Request Validation & Serialization

- Queries hit `convertDotNotationToNestedObject` to map flat dot-notation filters (e.g., `have_rx_from` → `{ have: { rx: { from } } }`) into the nested shape expected by `RepeaterQueryInternalSchema`; replicate this approach when adding new flat filter parameters.
- All errors must return `{ failure: true, errors: {...}, code }` as modeled by `ErrorSchema`; reuse `formatZodErrors` for schema issues and wrap DB failures with `ContentfulStatusCode` values.
- Repeater callsigns are validated as `/^(LZ0)\w{3}$/` (6 alphanumeric chars starting LZ0).
- Keeper callsigns are validated as `/^LZ[1-9]\w{2,3}$/` (4–5 chars starting LZ# where # is 1-9).
- Latitude bounds: ±90, Longitude bounds: ±180; validated at Zod schema layer before DB access.

## Auth & Sessions

### Login Flow

1. **Frontend** sends `POST /v1/admin/login` with `Authorization: Basic base64(username:password)` header
2. **Backend** (in `authenticateUser` via `db.ts`) decodes Base64, verifies credentials against SHA-256 hashes in `users` table (fallback: `SUPERADMIN_PW` env var)
3. **On success**, backend issues **HMAC JWT** using helpers in `src/session.ts`:
   ```typescript
   const token = await createSessionToken(env, {
     username,           // Logged-in username
     tokenVersion,       // From users.token_version (used for revocation)
     uaHash,             // SHA256 of User-Agent (optional UA pinning)
     deviceId,           // From X-Device-Id header (optional device pinning)
   });
   // Returns JWT with claims: { username, token_version, issued_at, exp, idle_expires, ua, device }
   ```
4. **Response** includes `{ token: "eyJ..." }` in body; frontend stores in `localStorage`
5. **Front-to-back**: bearer token sent as `Authorization: Bearer <jwt>` on all protected requests

### Session Token Structure

**JWT claims** (from `src/session.ts`):
- `username` – User who logged in
- `token_version` – Incremented on logout (forces re-login if bumped server-side)
- `issued_at` – Token creation timestamp (ms)
- `exp` – Absolute expiry (default 24h from issue, configurable via `BGREPS_JWT_ABSOLUTE_EXPIRES_MS`)
- `idle_expires` – Idle timeout expiry (default 2h, configurable via `BGREPS_JWT_IDLE_EXPIRES_MS`)
- `ua` – SHA256 hash of User-Agent (if pinning enabled; optional)
- `device` – Device ID from `X-Device-Id` header (if pinning enabled; optional)

**Per-request verification** (via `ensureBearerAuth`):
- Decode JWT and verify HMAC signature against `BGREPS_JWT_SECRET` env var
- Check `exp` and `idle_expires` against current time
- Compare user's current `token_version` in DB; if mismatch → force logout (session revoked)
- If UA/device pinning enabled, verify headers match token claims
- On success, optionally issue new token via `x-new-jwt` response header (sliding window)

### Token Rolling & Idle Refresh

- After verifying a valid token, backend calculates idle refresh window: if remaining time until `idle_expires` <= window (default 30 min), issue new JWT in `x-new-jwt` response header
- Frontend's custom API wrapper intercepts `x-new-jwt`, updates `localStorage`, and continues without re-login
- This keeps idle sessions alive as long as user is actively using the app

### Protected Routes & Middleware

**Auth guard middleware** (applied to routes):
- `adminGuard` — Checks Bearer token on `/admin/users` and `/admin/requests` routes; rejects unauthenticated requests
- Non-GET operations (POST, PUT, PATCH, DELETE) on repeaters require bearer token, except `POST /requests` (guest submissions use Turnstile instead)

**Logout** (`POST /v1/admin/logout`):
- Increments user's `token_version` in DB
- All existing tokens with old version are invalidated client-side (next request fails with 401)
- Frontend clears `localStorage` token

## API Routes Reference

All routes are under `/v1` base path. Key routes:

### Public Routes

| Method | Path | Description | Query Params |
|--------|------|-------------|--------------|
| GET | `/` or empty | Query repeaters (all by default) | `callsign`, `disabled`, `include_disabled`, `freq_min`, `freq_max`, `have_rx_from`, `have_tx_to`, `qth`, `modes`, etc. |
| GET | `/{callsign}` | Fetch single repeater by callsign | — |
| GET | `/doc` | OpenAPI schema (JSON) | — |
| POST | `/requests` | Submit guest repeater request (Turnstile required) | — |

### Protected Routes (Bearer Token Required)

| Method | Path | Description | Auth | Body |
|--------|------|-------------|------|------|
| POST | `/admin/login` | Issue JWT session token (Basic Auth) | Basic Auth | `{ deviceId?: string }` |
| POST | `/admin/logout` | Revoke current session | Bearer | — |
| POST | `/` | Create new repeater | Bearer | Full `Repeater` object |
| PUT | `/{callsign}` | Update repeater | Bearer | Partial `Repeater` fields |
| DELETE | `/{callsign}` | Soft-delete repeater | Bearer | — |
| GET | `/admin/users` | List all admin users | Bearer | — |
| POST | `/admin/users` | Create admin user | Bearer | `{ username, password, enabled? }` |
| PUT | `/admin/users/{username}` | Update user password/status | Bearer | `{ password?, enabled? }` |
| DELETE | `/admin/users/{username}` | Delete user account | Bearer | — |
| GET | `/admin/requests` | List guest submissions | Bearer | `status?`, `limit?`, `cursor?` |
| GET | `/admin/requests/{id}` | Fetch single guest request | Bearer | — |
| PATCH | `/admin/requests/{id}` | Update request status/notes | Bearer | `{ status?, adminNotes? }` |

### Special Endpoints

| Method | Path | Description | Notes |
|--------|------|-------------|-------|
| GET | `/changelog` | Changelog audit log (public) | Shows who/what/when for all changes |

## Schema Validation Patterns

### Repeater Format

**Callsign validation**:
- Format: `/^(LZ0)\w{3}$/` — exactly 6 chars, must start with `LZ0`
- Examples: `LZ0ABC`, `LZ0XYZ` ✓ | `LZ1ABC`, `LZ0AB` ✗

**Keeper validation**:
- Format: `/^LZ[1-9]\w{2,3}$/` — 4–5 chars, must start with `LZ#` where # is 1-9
- Examples: `LZ1AAA`, `LZ9CALL` ✓ | `LZ0AAA`, `LZAAAA` ✗

**Location validation**:
- `latitude`: number, range ±90
- `longitude`: number, range ±180
- `altitude`: number (optional, in meters)
- `qth`: auto-calculated Maidenhead grid square (read-only, computed server-side via `locator` library)

**Frequency validation**:
- `freq.rx`: receive frequency (MHz, dependent on mode)
- `freq.tx`: transmit frequency (MHz, dependent on mode)
- `freq.channel`: auto-calculated channel number (read-only, via `getChannel()`)
- `freq.tone`: optional CTCSS tone (e.g., "67Hz")

**Modes**:
- Each mode (fm, am, usb, lsb, dmr, dstar, fusion, nxdn, parrot, beacon) has:
  - `enabled: boolean` — is this mode active
  - Mode-specific fields: `freq`, `tone`, `info` (array of strings)

**Internet metadata**:
- Optional object with arbitrary keys: `rdac`, `repeaterbook`, `dns`, etc.

### Error Response Shape

All errors follow uniform format:
```typescript
{
  failure: true,
  errors: {
    FIELD_NAME: "Human-readable error message",
    // Multiple fields can have errors
  },
  code: 422 // HTTP status code (400, 401, 403, 404, 409, 422, 429, 500)
}
```

**Common error codes**:
- 400 — Malformed request
- 401 — Unauthorized (invalid/expired token, missing Bearer)
- 403 — Forbidden (user disabled, HTTPS required)
- 404 — Not found (repeater callsign does not exist)
- 409 — Conflict (e.g., cannot approve non-pending request)
- 422 — Unprocessable entity (validation error)
- 429 — Rate limit exceeded (guest request limit)
- 500 — Server error (Turnstile misconfiguration, DB error)

## Frontend Integration Points

### HTTP Headers

**Requests sent by frontend** (via `src/services/api.ts`):
- `Authorization: Basic base64(username:password)` — Login only
- `Authorization: Bearer <jwt>` — All protected requests
- `X-Device-Id: <uuid>` — Device fingerprint (localhost.repsadmin.device from localStorage)
- `Content-Type: application/json` — JSON body requests

**Responses from backend**:
- `x-new-jwt: <new-token>` — Sliding token refresh (frontend intercepts and stores)
- `Access-Control-Allow-Credentials: true` — CORS header (allows credentialed fetch)
- `ETag: <digest>` — Response caching hint

### Error Contract

Frontend expects:
```typescript
interface ErrorResponse {
  failure: true;
  errors: Record<string, string>;
  code: number;
}
```

Example error handling in frontend:
```typescript
try {
  const rep = await getRepeater('LZ0ABC');
} catch (err) {
  if (err.failure && err.code === 404) {
    // Repeater not found → show "not found" message
  } else if (err.code === 401) {
    // Token expired → redirect to login
  } else {
    // Other error → show generic message with err.errors details
  }
}
```

## Common Modification Patterns

### Adding a New API Endpoint

1. **Define schema** in `src/api/NewSchema.ts` using Zod (`z.object`, `z.string`, etc.)
2. **Import schema** in `src/api.ts`
3. **Create route handler** in `src/api.ts`:
   ```typescript
   api.openapi(
     createRoute({
       method: 'get',           // Method
       path: '/new/endpoint',   // Path under /v1
       request: {               // Optional: params, query, body
         params: NewParamSchema,
         query: NewQuerySchema,
         body: { content: { 'application/json': { schema: NewBodySchema } } }
       },
       responses: {
         200: { content: { 'application/json': { schema: ResponseSchema } }, description: '...' },
         '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error' }
       }
     }),
     async (c) => {
       // Handler logic
       const params = c.req.valid('param');
       const query = c.req.valid('query');
       const body = await c.req.valid('json');
       return c.json(result, 200);
     }
   );
   ```
4. **Apply auth middleware** if needed (add to `adminGuard` use block or inline check)
5. **Return error shape** — always wrap errors as `{ failure: true, errors: {...}, code }`

### Changing Validation Rules

1. Edit the Zod schema in `src/api/*Schema.ts`
   - Example: `callsign: z.string().regex(/^(LZ0)\w{3}$/)`
2. Update handler logic if needed (some validators require DB lookups)
3. Re-run tests: `npm test` (unit) and `BGREPS_RUN_INTEGRATION=true npm run test:integration` (integration)

### Adding a Changelog Entry

Use `*WithLog` wrappers in write operations:
```typescript
// Bad: skips changelog
await db.addRepeater(db, repeater);

// Good: includes changelog entry
await db.addRepeaterWithLog(db, username, repeater);
// This logs: { date: NOW, who: username, info: JSON.stringify(repeater) }
```

Use `addChangelog()` directly for custom changelog entries:
```typescript
await db.addChangelog(db, {
  date: new Date().toISOString(),
  who: adminUsername,
  info: JSON.stringify({ action: 'custom_action', data: {...} })
});
```

## Security Checklist

When adding or modifying endpoints:

- [ ] **Parameterized queries** — All SQL uses `DB.prepare(...).bind(...)` (no string interpolation)
- [ ] **Input sanitization** — User-provided strings pass through `sanitizeRepeater()` before DB/response
- [ ] **Auth on protected routes** — Verify `adminGuard` or bearer token check is applied
- [ ] **Rate limiting on guest routes** — Guest submissions check `countRequestRateLimitHits()` and enforce limit
- [ ] **Error handling** — Never expose DB/stack traces in error responses; use `{ failure: true, errors: {...}, code }` format
- [ ] **Validation** — All inputs validated at Zod schema layer before business logic
- [ ] **Device pinning** — Optional but recommended for admin sessions (backend enforces match if token claims include device)
- [ ] **HTTPS enforcement** — Login enforces HTTPS in production (check `shouldEnforceHttps()` and `isSecureRequest()`)

## Telegram Notifications

The worker can send Telegram notifications to configured admins when guest requests are submitted or resolved (approved/rejected).

### Configuration

**Environment Variables** (configure via `wrangler secret put`):
- `BGREPS_TELEGRAM_BOT_TOKEN` — Bot token from @BotFather (required)
- `BGREPS_TELEGRAM_CHAT_IDS` — Comma-separated list of chat IDs (required, e.g., "123456,789012,-1001234567890")
- `BGREPS_TELEGRAM_NOTIFY_REJECTIONS` — Enable rejection notifications (optional, default: "true")

**Setting up a Telegram bot**:
1. Message @BotFather on Telegram → `/newbot` → follow prompts → receive bot token
2. Get chat IDs:
  - **Individual user**: Message @userinfobot → receive your user ID (positive number)
  - **Group**: Add bot to group, send message, check `https://api.telegram.org/bot<TOKEN>/getUpdates` (negative group ID)
  - **Channel**: Similar to group (negative ID starting with `-100`)
3. Configure via Wrangler:
  ```bash
  wrangler secret put BGREPS_TELEGRAM_BOT_TOKEN
  # Enter: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   
  wrangler secret put BGREPS_TELEGRAM_CHAT_IDS
  # Enter: 123456,789012,-1001234567890
  ```

### Integration Points

**Notification triggers** (in `src/api.ts`):
1. **New guest request** (`POST /requests` handler) — After `insertGuestRequest()` succeeds
  - Calls `notifyNewGuestRequest()` with request ID, submitter name, message preview, country
  - Sent to all configured chat IDs in parallel
2. **Request resolved** (`PATCH /admin/requests/{id}` handler) — After `updateGuestRequest()` succeeds
  - Calls `notifyGuestRequestResolved()` when status changes to approved/rejected
  - Includes action (created/updated), repeater callsign, admin who resolved, notes

**Implementation** (`src/telegram.ts`):
- `parseChatIds()` — Parse comma-separated chat IDs, validate numeric format
- `sendTelegramMessage()` — Send to all chats in parallel via `Promise.allSettled()`
- `formatNewRequestNotification()` — Template for new submissions (emoji, name, message preview, link)
- `formatResolvedRequestNotification()` — Template for approved/rejected (status emoji, repeater callsign, admin notes)
- `escapeTelegramMarkdown()` — Escape special chars for MarkdownV2 format

### Error Handling

- **Non-blocking**: Telegram failures logged but don't break request flow (wrapped in `.catch()`)
- **Graceful degradation**: If bot token or chat IDs not configured → silently skip notifications
- **Partial failures**: If one chat ID fails → other chats still receive notifications
- **Invalid chat IDs**: Filtered out during parsing; valid IDs still receive notifications

### Privacy & Security

- **Contact privacy**: Never include full contact (email/phone) in notifications — only submitter name
- **Message truncation**: Admin notes and messages truncated to 200 chars in notifications
- **Rate limiting**: Telegram allows ~30 messages/second per bot; parallel delivery won't hit limits under normal traffic

### Testing Telegram Integration

```bash
# Configure locally
wrangler secret put BGREPS_TELEGRAM_BOT_TOKEN --env dev
wrangler secret put BGREPS_TELEGRAM_CHAT_IDS --env dev

# Start dev server
npm run dev

# Test new request notification
curl -X POST http://localhost:8787/v1/requests \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","contact":"test@example.com","message":"Test notification","turnstileToken":"..."}'

# Check Telegram chat for notification with request ID, name, message preview

# Test approval notification (requires auth token)
curl -X PATCH http://localhost:8787/v1/admin/requests/1 \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"approved"}'

# Check Telegram chat for approval notification with repeater callsign, action (created/updated)
```

**Debugging**:
- Check worker logs for `[Telegram]` prefixed messages
- Failed deliveries logged with chat ID and error reason
- Successful deliveries logged with chat ID
- If notifications not received: verify bot token, chat IDs, bot added to groups/channels

## Client Bundle & Public API

- `public/bgreps.js` is the published client; `test/bgreps.test.js` asserts its fetch contract (query building, auth retries). Update those tests whenever you change endpoints, headers, or auth flows.
- Integration tests in `test/bgreps.integration.test.js` hit a live worker at `http://localhost:8787/v1`; they seed ephemeral admin users through `wrangler d1 execute`, so keep schema changes backwards compatible or update the SQL there.
- Frontend loads `bgreps.js` at runtime (see `src/boot/bgreps-loader.ts` in repsadmin) using `API_BASE_URL` env var; library is served unminified from `/public/bgreps.js` path on same origin as API.

## Local dev & testing workflows
- Run `npm install` once, then `npm run dev` (wrangler dev on port 8787) for a full worker + asset environment. Assets mount from `public/`, and D1 will use your configured local binding.
- Unit tests: `npm test` (Node’s built-in runner) covers the JS client and sanitizer.
- Integration tests: `BGREPS_RUN_INTEGRATION=true npm run test:integration` while `npm run dev` (or a deployed worker) is live. Ensure `wrangler d1` is authenticated and the schema (`schema.sql`) has been applied locally before running them.

## Deployment & Ops

- `npm run deploy` wraps `wrangler deploy --minify`; the CLI reads secrets/bindings from your Cloudflare account, so keep `BGREPS_JWT_*`, `BGREPS_TURNSTILE_SECRET`, `SUPERADMIN_PW`, and D1 credentials up to date.
- Static docs live under `/ui` (Swagger UI via `@hono/swagger-ui`) reading `/v1/doc`; remember to align schema descriptions/examples with the actual DB columns so consumers of `bgreps.js` stay in sync.
- Rate limiting environment variables (guest requests): `BGREPS_REQUEST_LIMIT`, `BGREPS_REQUEST_WINDOW_MINUTES`
- JWT configuration: `BGREPS_JWT_SECRET`, `BGREPS_JWT_ABSOLUTE_EXPIRES_MS`, `BGREPS_JWT_IDLE_EXPIRES_MS`, `BGREPS_JWT_REFRESH_WINDOW_MS`
- HTTPS enforcement: `BGREPS_REQUIRE_HTTPS` (can be overridden for localhost development)

## Gotchas & Tips

- **HTTPS is enforced in production** (`BGREPS_REQUIRE_HTTPS`); when testing login over HTTP you must run through localhost/10.x networks or override that env var.
- **Disabled repeaters are filtered** unless `include_disabled=true`; DB queries default to `disabled=0`, so new filters must respect that logic to avoid leaking offline entries unintentionally.
- **Token version revocation**: Incrementing a user's `token_version` in the DB invalidates all their existing tokens; this is used for logout and account disablement. Check the token version on every bearer auth request.
- **Device ID pinning**: If a token was issued with a device ID, subsequent requests must include the same `X-Device-Id` header (case-sensitive). This helps prevent token theft in shared device scenarios.
- **Turnstile verification**: Guest request rate limiting relies on Turnstile for bot protection; if the secret is missing or validation fails, reject with 403/500. Always verify before incrementing rate limit counters.
- **Rate limit sliding window**: Use `pruneRequestRateLimitHits()` to clean old records before counting; the window is configurable via `BGREPS_REQUEST_WINDOW_MINUTES` (default 24h).
- **Guest request approval flow**: A pending request can only be approved once; approval attempts to apply the repeater suggestion and updates the request status. Catch errors in `applyRepeaterSuggestionFromRequest()` and return them to the admin.
- **Mailhead locator (`qth`)**: Computed from lat/long via the `locator` library; never store it directly from client input. Recalculate on every write.
- **Derived channel numbers**: `freq.channel` is auto-calculated via `getChannel()` based on `freq.rx`, `freq.tx`, and mode. Don't trust client values; recompute on the server.
- **Guest request merging**: When approving a suggestion for an existing repeater, merge mode-by-mode and field-by-field (not wholesale replacement) to preserve data. Use `mergeRepeaterRecords()` helper.
