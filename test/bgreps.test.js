// Node built-in test runner (CommonJS)
const test = require('node:test')
const assert = require('node:assert/strict')

// Import the library (UMD export supports CommonJS require)
const BGRepeaters = require('../public/bgreps.js')

// Polyfills for Node if needed
if (typeof globalThis.Headers === 'undefined') {
  globalThis.Headers = class Headers {
    constructor(init = {}) { this._m = new Map(Object.entries(init)) }
    has(k) { return this._m.has(k) }
    set(k, v) { this._m.set(k, String(v)) }
    get(k) { return this._m.get(k) }
    entries() { return this._m.entries() }
  }
}
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64')
}
if (typeof globalThis.TextEncoder === 'undefined' || typeof globalThis.TextDecoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('node:util')
  if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = TextEncoder
  if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = TextDecoder
}

function makeResponse({ ok = true, status = ok ? 200 : 500, statusText, headers = {}, jsonData = {} }) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]))
  if (!map.has('content-type')) map.set('content-type', 'application/json')
  return {
    ok,
    status,
    statusText: statusText || (ok ? 'OK' : 'ERR'),
    headers: { get: (k) => map.get(String(k).toLowerCase()) || null },
    json: async () => jsonData,
    text: async () => JSON.stringify(jsonData)
  }
}

function defaultResponder({ url, init }) {
  if (url.endsWith('/admin/login')) {
    return makeResponse({ jsonData: { token: 'jwt-test-token' } })
  }
  return makeResponse({ jsonData: { ok: true, url, method: init.method || 'GET' } })
}

function createFetchSpy(sequence = []) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const responder = sequence.length ? sequence.shift() : defaultResponder
    const response = await responder({ url, init })
    calls.push({ url, init })
    return response
  }
  return { fetch, calls }
}

const BASE = 'https://api.example.com/v1'

test('version is exposed (static and instance)', async () => {
  const { fetch } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  assert.equal(typeof BGRepeaters.VERSION, 'string')
  assert.equal(api.version, BGRepeaters.VERSION)
})

test('getRepeaters() without params hits /v1/', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  await api.getRepeaters()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, BASE + '/')
  assert.equal((calls[0].init.method || 'GET'), 'GET')
})

test('getRepeaters({ callsign, have_dmr }) builds proper query', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  await api.getRepeaters({ callsign: 'LZ0BOT', have_dmr: true })
  const u = new URL(calls[0].url)
  assert.equal(u.pathname, '/v1/')
  assert.equal(u.searchParams.get('callsign'), 'LZ0BOT')
  assert.equal(u.searchParams.get('have_dmr'), 'true')
})

test('getRepeater(callsign) requests /v1/{callsign}', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  await api.getRepeater('LZ0BOT')
  assert.equal(calls.length, 1)
  const u = new URL(calls[0].url)
  assert.equal(u.pathname, '/v1/LZ0BOT')
  assert.equal((calls[0].init.method || 'GET'), 'GET')
})

test('createRepeater(data) POST with JSON body and headers', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  const payload = { callsign: 'LZ0XXX', keeper: 'LZ1AA', latitude: 1, longitude: 2, place: 'X', altitude: 0, modes: { fm: true }, freq: { rx: 1, tx: 2 } }
  await api.createRepeater(payload)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(new URL(calls[0].url).pathname, '/v1/')
  const headers = calls[0].init.headers
  assert.equal(headers.get('Content-Type'), 'application/json')
  assert.equal(headers.get('Accept'), 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), payload)
})

test('updateRepeater performs login and uses Bearer token', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  api.setAuth('admin', 'secret')
  await api.updateRepeater('LZ0YYY', { place: 'New' })
  assert.equal(calls.length, 2)
  const loginHeaders = calls[0].init.headers
  assert.ok(loginHeaders.get('Authorization').startsWith('Basic '))
  const updateHeaders = calls[1].init.headers
  assert.ok(updateHeaders.get('Authorization').startsWith('Bearer '))
})

test('authorization retries once on 401 and uses refreshed token for subsequent calls', async () => {
  const responders = [
    defaultResponder, // initial login
    () => makeResponse({ ok: false, status: 401, statusText: 'Unauthorized', jsonData: { failure: true } }),
    defaultResponder, // re-login after 401
    ({ url, init }) => makeResponse({ jsonData: { ok: true, url, method: init.method || 'GET' }, headers: { 'X-New-JWT': 'jwt-after-retry' } }),
    ({ url, init }) => makeResponse({ jsonData: { ok: true, url, method: init.method || 'GET' } })
  ]
  const { fetch, calls } = createFetchSpy(responders)
  const api = new BGRepeaters({ baseURL: BASE, fetch, username: 'admin', password: 'secret' })
  await api.deleteRepeater('LZ0AAA')
  await api.deleteRepeater('LZ0BBB')
  assert.equal(calls.length, 5, 'login + failing request + re-login + retried request + follow-up request')
  const retryHeaders = calls[3].init.headers
  assert.ok(retryHeaders.get('Authorization').startsWith('Bearer '), 'retry still sends bearer')
  const followUpHeaders = calls[4].init.headers
  assert.equal(followUpHeaders.get('Authorization'), 'Bearer jwt-after-retry', 'next request uses refreshed token')
})

test('deleteRepeater DELETE method', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  await api.deleteRepeater('LZ0DEL')
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(new URL(calls[0].url).pathname, '/v1/LZ0DEL')
})

test('getDoc requests /v1/doc', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  await api.getDoc()
  assert.equal(new URL(calls[0].url).pathname, '/v1/doc')
})

test('getChangelog requests /v1/changelog and expects object with lastChanged and changes', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  const res = await api.getChangelog()
  assert.equal(new URL(calls[0].url).pathname, '/v1/changelog')
  assert.equal((calls[0].init.method || 'GET'), 'GET')
  assert.ok(typeof res === 'object' && res !== null)
})

test('static buildChirpCsv formats tone columns and filters modes', () => {
  const repeaters = [
    {
      callsign: 'LZ0AAA',
      place: 'София',
      info: ['Analog repeater'],
      freq: { rx: 145050000, tx: 145650000, tone: 88.5 },
      modes: { fm: true }
    },
    {
      callsign: 'LZ0BBB',
      place: 'Благоевград',
      info: 'Digital node',
      freq: { rx: 431550000, tx: 439150000 },
      modes: { dmr: true }
    }
  ]
  const payload = BGRepeaters.buildChirpCsv({ repeaters })
  assert.equal(payload.rowCount, 2)
  assert.ok(payload.bytes instanceof Uint8Array)
  const csv = payload.csvText.replace(/^\ufeff/, '')
  assert.ok(csv.includes('LZ0AAA'), 'first row is present')
  assert.ok(csv.includes('145.650,-,0.600,TSQL,88.5,88.5,FM'), 'tone-enabled row formatted correctly')
  assert.ok(csv.includes('LZ0BBB'), 'second row is present')
  assert.ok(csv.includes('439.150,-,7.600,,79.7,79.7,DMR'), 'tone-less row defaults tone fields')
  const dmrOnly = BGRepeaters.buildChirpCsv({ repeaters, mode: 'dmr' })
  const dmrCsv = dmrOnly.csvText.replace(/^\ufeff/, '')
  assert.equal(dmrOnly.rowCount, 1)
  assert.ok(!dmrCsv.includes('LZ0AAA'))
  assert.ok(dmrCsv.includes('LZ0BBB'))
})

test('instance buildChirpCsv fetches repeaters when array not provided', async () => {
  const responders = [
    ({ url }) => {
      if (url.endsWith('/')) {
        return makeResponse({ jsonData: [
          {
            callsign: 'LZ0DMR',
            place: 'Test',
            info: 'Auto-generated',
            freq: { rx: 439450000, tx: 431850000 },
            modes: { dmr: true }
          }
        ] })
      }
      return makeResponse({ jsonData: { ok: true } })
    }
  ]
  const { fetch, calls } = createFetchSpy(responders)
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  const payload = await api.buildChirpCsv({ mode: 'dmr' })
  assert.equal(calls.length, 1)
  assert.ok(payload.csvText.includes('LZ0DMR'))
})
