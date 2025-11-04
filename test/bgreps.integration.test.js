// Integration tests hitting a local dev server at http://localhost:8787/v1
// These tests will be skipped if the server is not available.

const test = require('node:test')
const assert = require('node:assert/strict')
const BGRepeaters = require('../public/bgreps.js')

const BASE = 'http://localhost:8787/v1'

async function isServerAvailable() {
  try {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined
    const to = ctrl ? setTimeout(() => ctrl.abort(), 1500) : undefined
    const resDoc = await fetch(BASE + '/doc', { method: 'GET', signal: ctrl ? ctrl.signal : undefined })
    const resList = await fetch(BASE + '/', { method: 'GET', signal: ctrl ? ctrl.signal : undefined })
    if (to) clearTimeout(to)
    return resDoc.ok && resList.ok
  } catch (_) {
    return false
  }
}

// Helper to conditionally run or skip a test based on server availability
async function conditionalTest(name, fn) {
  const up = await isServerAvailable()
  if (!up) {
    test.skip(name, () => {})
  } else {
    test(name, fn)
  }
}

conditionalTest('integration: getRepeaters() returns an array', async () => {
  const api = new BGRepeaters({ baseURL: BASE })
  const list = await api.getRepeaters()
  assert.ok(Array.isArray(list), 'Expected an array of repeaters')
})

conditionalTest('integration: getRepeater(callsign) returns an object for a callsign from the list', async () => {
  const api = new BGRepeaters({ baseURL: BASE })
  const all = await api.getRepeaters()
  assert.ok(Array.isArray(all) && all.length > 0, 'Expected non-empty list to pick a callsign from')
  const cs = all[0].callsign || all[0].callsign?.toUpperCase?.() || all[0].callsign
  assert.ok(typeof cs === 'string' && cs.length > 0, 'Expected a valid callsign')
  const one = await api.getRepeater(cs)
  assert.equal(one.callsign, cs)
})

conditionalTest('integration: getChangelog() returns { lastChanged, changes }', async () => {
  const api = new BGRepeaters({ baseURL: BASE })
  const res = await api.getChangelog()
  assert.ok(res && typeof res === 'object')
  assert.ok('lastChanged' in res)
  assert.ok('changes' in res)
  assert.ok(Array.isArray(res.changes), 'Expected changes to be an array')
  if (res.changes.length > 0) {
    const entry = res.changes[0]
    assert.equal(typeof entry.date, 'string')
    assert.equal(typeof entry.info, 'string')
    assert.equal(typeof entry.who, 'string')
  }
})
