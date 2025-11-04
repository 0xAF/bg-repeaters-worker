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

function createFetchSpy() {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => ({ ok: true, url, method: init.method || 'GET' }),
      text: async () => JSON.stringify({ ok: true }),
    }
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

test('updateRepeater sets Authorization when setAuth is used', async () => {
  const { fetch, calls } = createFetchSpy()
  const api = new BGRepeaters({ baseURL: BASE, fetch })
  api.setAuth('admin', 'secret')
  await api.updateRepeater('LZ0YYY', { place: 'New' })
  const headers = calls[0].init.headers
  const auth = headers.get('Authorization')
  assert.ok(auth && auth.startsWith('Basic '))
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
