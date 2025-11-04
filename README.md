
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

---

## Client Library: bgreps.js

`bgreps.js` is a tiny, dependency-free client for the v1 API at `https://api.varna.radio/v1`.

It supports all endpoints:

- GET    `/v1/`               → `getRepeaters(query?)`
- GET    `/v1/{callsign}`     → `getRepeater(callsign)`
- POST   `/v1/`               → `createRepeater(data)` (Basic Auth)
- PUT    `/v1/{callsign}`     → `updateRepeater(callsign, data)` (Basic Auth)
- DELETE `/v1/{callsign}`     → `deleteRepeater(callsign)` (Basic Auth)
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
</script>
```

### Usage (Node)

```js
const BGRepeaters = require('./bgreps')
const api = new BGRepeaters({ baseURL: 'https://api.varna.radio/v1' })

const one = await api.getRepeater('LZ0BOT')
const list = await api.getRepeaters({ callsign: 'LZ0BOT' })
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
console.log(BGRepeaters.VERSION) // e.g. '1.0.0'
console.log(api.version)         // e.g. '1.0.0'

// Read:
await api.getRepeaters({ callsign: 'LZ0BOT' })
await api.getRepeaters({ have_dmr: true, have_rx_from: 430000000, have_rx_to: 440000000 })
await api.getRepeater('LZ0BOT')

// Write (Basic Auth):
api.setAuth('admin', 'password')
await api.createRepeater(data)
await api.updateRepeater('LZ0BOT', patch)
await api.deleteRepeater('LZ0BOT')

// OpenAPI:
await api.getDoc()
```

Notes:

- `getRepeaters(query)`: You can call without params to fetch all repeaters, or provide filters like `{ callsign: 'LZ0BOT' }` or `{ have_dmr: true }`.
- Query parameters align with the API (e.g., `have_dmr`, `have_rx_from`, `have_rx_to`, `callsign`, etc.). Booleans serialize to `true`/`false`. Arrays repeat the key.
