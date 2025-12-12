
# BG Repeaters Worker

This repository hosts the Cloudflare Worker that serves the BG Repeaters API (OpenAPI) and related assets.

## Develop

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run deploy
```

## Configuration & Environment

| Variable | Required | Description |
| --- | --- | --- |
| `SUPERADMIN_PW` | yes | Plain-text password used by the legacy SUPERADMIN Basic auth flow. Must be kept in a secret and never committed. |
| `BGREPS_JWT_SECRET` | yes | HMAC secret for issuing/verifying admin JWTs. Rotate with `wrangler secret put BGREPS_JWT_SECRET`. |
| `BGREPS_JWT_TTL_MS` | no | Absolute lifetime for issued JWTs (defaults to 24h). |
| `BGREPS_JWT_IDLE_MS` | no | Sliding idle timeout before a session is considered stale (defaults to 2h). |
| `BGREPS_REQUIRE_HTTPS` | no | When unset/`true`, login endpoints reject non-HTTPS origins except localhost. Override with `false` for local testing. |
| `BGREPS_TURNSTILE_SECRET` | yes | Cloudflare Turnstile secret key used to verify guest submissions. Obtain it from the Turnstile dashboard and store it via `wrangler secret put BGREPS_TURNSTILE_SECRET`. |
| `BGREPS_REQUEST_LIMIT` | no | Maximum guest submissions allowed per window for a single contact/IP (defaults to 5). |
| `BGREPS_REQUEST_WINDOW_MINUTES` | no | Rolling window (in minutes) for the limiter and pruning logic (defaults to 1440 = 24h). |

Required bindings declared in `wrangler.jsonc`:

- `RepsDB` – D1 database with the schema from `schema.sql`.
- `ASSETS` – Static asset binding used to serve `public/`.

## Guest Request Workflow

Anonymous operators can file requests via `POST /v1/requests`. The payload must include `name`, `contact`, an optional `message`, and a Turnstile token:

```json
{
  "name": "Ivan LZ1ABC",
  "contact": "ivan@example.com",
  "message": "Please update the keeper info for LZ0BOT",
  "repeater": { "callsign": "LZ0BOT" },
  "turnstileToken": "<token from client-side widget>"
}
```

Responses look like:

```json
{
  "id": 42,
  "status": "pending",
  "rateLimit": {
    "limit": 5,
    "remaining": 4,
    "windowMinutes": 1440
  }
}
```

### Rate limiting & cleanup

- Every submission is recorded in the `request_rate_limits` table using a hash of the contact info and the caller IP.
- Limits are controlled via `BGREPS_REQUEST_LIMIT` and `BGREPS_REQUEST_WINDOW_MINUTES`.
- The Worker now exports a scheduled handler and Wrangler is configured with an hourly cron (`0 * * * *`). Each run prunes stale rows that fall outside the active window so the table stays small.

Run the scheduled handler locally via `wrangler dev --test-scheduled` to confirm the prune logs fire when expected.

---

## Client Library: bgreps.js

`bgreps.js` is a tiny, dependency-free client for the v1 API at `https://api.varna.radio/v1`.

Current version: **2.0.0**

It supports all endpoints:

- GET    `/v1/`               → `getRepeaters(query?)`
- GET    `/v1/{callsign}`     → `getRepeater(callsign)`
- POST   `/v1/`               → `createRepeater(data)` (Basic Auth)
- PUT    `/v1/{callsign}`     → `updateRepeater(callsign, data)` (Basic Auth)
- DELETE `/v1/{callsign}`     → `deleteRepeater(callsign)` (Basic Auth)
- GET    `/v1/changelog`      → `getChangelog()`
- GET    `/v1/doc`            → `getDoc()`

### Install / Include

- Browser: include the script file directly (UMD export as `BGRepeaters`).
- Node: `require('./bgreps')` and ensure `fetch` is available or pass a custom fetch in options.

### Usage (Browser)

```html
<script src="/bgreps.js"></script>
<script>
  const api = new BGRepeaters({ baseURL: 'https://api.varna.radio/v1' })
  api.getRepeater('LZ0BOT').then(console.log)
  api.getRepeaters({ have_dmr: true, have_rx_from: 430000000, have_rx_to: 440000000 }).then(console.log)
  // Include disabled repeaters together with enabled ones
  api.getRepeaters({ include_disabled: true }).then(console.log)
</script>
```

### Usage (Node)

```js
const BGRepeaters = require('./bgreps')
const api = new BGRepeaters({ baseURL: 'https://api.varna.radio/v1' })

const one = await api.getRepeater('LZ0BOT')
const list = await api.getRepeaters({ callsign: 'LZ0BOT' })
// All repeaters including disabled
const all = await api.getRepeaters({ include_disabled: true })
// Only disabled repeaters
const disabledOnly = await api.getRepeaters({ disabled: true })
```

### Write Operations (Basic Auth required)

```js
api.setAuth('admin', 'password')

// Create
await api.createRepeater({
  callsign: 'LZ0XXX',
  keeper: 'LZ1AA',
  latitude: 42.1,
  longitude: 24.7,
  place: 'София',
  altitude: 0,
  modes: { fm: true },
  freq: { rx: 430000000, tx: 438000000, tone: 79.7 },
  digital: {
    dmr: {
      network: 'DMR+',
      color_code: '1',
      callid: '284040',
      reflector: 'XLX023 ipsc2',
      ts1_groups: '284,91',
      ts2_groups: '2840',
      info: 'Static 284 on TS1'
    }
  }
})

// Update
await api.updateRepeater('LZ0XXX', { place: 'Пловдив', modes: { fm: true, dmr: true } })

// Delete
await api.deleteRepeater('LZ0XXX')
```

### Method Reference

```js
const api = new BGRepeaters({
  baseURL: 'https://api.varna.radio/v1',
  username: undefined, // optional for write ops
  password: undefined, // optional for write ops
  timeout: 10000,      // request timeout in ms
  debug: false,        // log requests/errors
  // fetch: customFetch, // override fetch if needed (Node)
})

// Version
console.log(BGRepeaters.VERSION) // e.g. '1.4.1'
console.log(api.version)         // e.g. '1.4.1'

// Read:
await api.getRepeaters({ callsign: 'LZ0BOT' })
await api.getRepeaters({ have_dmr: true, have_rx_from: 430000000, have_rx_to: 440000000 })
// Include disabled repeaters together with enabled ones
await api.getRepeaters({ include_disabled: true })
// Only disabled repeaters
await api.getRepeaters({ disabled: true })
await api.getRepeater('LZ0BOT')

// Write (Basic Auth):
api.setAuth('admin', 'password')
await api.createRepeater(data)
await api.updateRepeater('LZ0BOT', patch)
await api.deleteRepeater('LZ0BOT')

// OpenAPI:
await api.getDoc()

// Changelog:
const { lastChanged, changes } = await api.getChangelog()
console.log(lastChanged, changes.length)

// Build a CHIRP CSV (Node/browser)
const payload = await api.buildChirpCsv({ mode: 'dmr' })
require('node:fs').writeFileSync(payload.filename, payload.bytes)

// Browser-only: fetch + trigger download in one call
await api.downloadChirpCsv({ mode: 'analog' })
```

### CHIRP CSV Export Helper

`buildChirpCsv` produces a CHIRP-compatible CSV from the latest repeater list. It returns an object with:

- `filename` – Suggested file name (`CHIRP_repeaters_<mode>.csv`).
- `mimeType` – Always `text/csv`.
- `mode` – The applied repeater filter (`all`, `analog`, `dmr`, `dstar`, `fusion`, `nxdn`, `parrot`).
- `rowCount` – Number of exported entries.
- `bytes` – `Uint8Array` with a UTF-8 BOM; write directly to disk or stream.
- `csvText` – Convenience string copy of the payload.

Usage patterns:

```js
// Instance – automatically fetches repeaters unless you provide opts.repeaters
const payload = await api.buildChirpCsv({ mode: 'all', includeDisabled: true })

// Static – supply repeaters manually (useful in tests or offline transforms)
const payload = BGRepeaters.buildChirpCsv({ repeaters, mode: 'dmr' })

// Browser-only convenience: fetch + generate + trigger download
await api.downloadChirpCsv({ mode: 'analog' })
```

Optional options:

- `mode` (default `all`) – Matches the filter buttons in the public map (`all`, `analog`, `dmr`, `dstar`, `fusion`, `nxdn`, `parrot`).
- `repeaters` – Pre-fetched API payload (skips the internal `getRepeaters()` call). Required for the static helper.
- `includeDisabled` – Pass `true` to include disabled entries when the helper performs the fetch.
- `query` – Extra filters forwarded to `getRepeaters()` (e.g., `{ have_dmr: true }`).

Node users should persist `payload.bytes`. Browser users can call `downloadChirpCsv` (instance or static) to emit a `<a download>` click that saves the file locally.

### Modes as Objects

API responses now return `modes` with children as objects:

```json
{
  "modes": {
    "fm": { "enabled": true },
    "dmr": { "enabled": true, "network": "DMR+", "color_code": "1", "callid": "284040", "reflector": "XLX023 ipsc2" },
    "dstar": { "enabled": true, "reflector": "XLX359 B" }
  }
}
```

Digital details live directly inside their respective mode objects (no separate `digital` root key).

> **Note:** v2.0.0 removed the legacy `flatten()` helper. Consumers should read values directly from `modes`, `freq`, and `internet` instead of relying on synthesized `mode_*` or `freq_*` fields.

### Disabled Repeaters & Query Flags

Repeaters can be temporarily disabled (e.g. maintenance, hardware failure). They remain retrievable by exact callsign but are excluded from normal listings unless explicitly requested.

Flags:

- `disabled=true` — return only disabled repeaters.
- `disabled=false` — return only enabled repeaters (same as omitted when `include_disabled` not set).
- `include_disabled=true` — return both enabled and disabled repeaters in one response.

Accepted truthy values for these flags: `true`, `1` (string or number). Falsy: `false`, `0`.

Examples:

```js
// All enabled only (default behavior)
await api.getRepeaters()

// Only disabled
await api.getRepeaters({ disabled: true })

// Combined list
await api.getRepeaters({ include_disabled: true })

// Filtering while including disabled
await api.getRepeaters({ include_disabled: true, have_dmr: true })

// Specific callsign always returns even if disabled
await api.getRepeater('LZ0ARD') // returns object with disabled: true
```

Edge cases:

- If both `disabled=true` and `include_disabled=true` are supplied, `include_disabled` wins (combined list).
- If an invalid value is passed (e.g. `disabled=abc`), it falls back to enabled-only.

Return shape for a disabled repeater includes `"disabled": true` at top level.
Notes:

- `getRepeaters(query)`: You can call without params to fetch all repeaters, or provide filters like `{ callsign: 'LZ0BOT' }` or `{ have_dmr: true }`.
- Query parameters align with the API (e.g., `have_dmr`, `have_rx_from`, `have_rx_to`, `callsign`, etc.). Booleans serialize to `true`/`false`. Arrays repeat the key.
- Digital DMR fields now include `callid` and `reflector` in addition to `network`, `color_code`, `ts1_groups`, `ts2_groups`, and `info`.
