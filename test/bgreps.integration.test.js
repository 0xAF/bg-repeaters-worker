// Integration tests hitting a local dev server at http://localhost:8787/v1
// These tests will be skipped if the server is not available.

const test = require('node:test')
const assert = require('node:assert/strict')
const BGRepeaters = require('../public/bgreps.js')

const BASE = 'http://localhost:8787/v1'
const RUN_INTEGRATION = process.env.BGREPS_RUN_INTEGRATION === 'true'

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
  if (!RUN_INTEGRATION) {
    test.skip(name, () => {})
    return
  }
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

// ====== AUTH & CRUD TESTS (Dynamic Test User) ======
// We create a transient test user directly in the local D1 database via Wrangler CLI, then remove it after tests.
// This avoids relying on the seeded SUPERADMIN password guesswork and keeps auth tests deterministic.
const { execSync } = require('node:child_process')
const TEST_USER = 'INTUSER'
const TEST_PASS = 'int_test_pw_123'
function encodeBasic(u, p) { return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') }

async function loginForToken(username, password) {
  const headers = {
    Authorization: encodeBasic(username, password),
    'Content-Type': 'application/json',
    'X-Device-Id': 'integration-tests'
  }
  const res = await fetch(BASE + '/admin/login', { method: 'POST', headers, body: JSON.stringify({ deviceId: 'integration-tests' }) })
  if (!res.ok) {
    const err = new Error('Login failed')
    err.status = res.status
    throw err
  }
  const data = await res.json()
  if (!data?.token) throw new Error('Login did not return token')
  return data.token
}

function sha256Hex(str) {
  return require('node:crypto').createHash('sha256').update(str).digest('hex')
}

async function ensureTestUser() {
  // Insert user (if exists, delete then re-insert for a clean state)
  try {
    execSync(`npx wrangler d1 execute RepsDB --local --command \"DELETE FROM users WHERE username='${TEST_USER}'\"`, { stdio: 'ignore' })
  } catch (_) {}
  const hash = sha256Hex(TEST_PASS)
  execSync(`npx wrangler d1 execute RepsDB --local --command \"INSERT INTO users (username,password,enabled,created,updated) VALUES ('${TEST_USER}','${hash}',1,datetime('now'),datetime('now'))\"`, { stdio: 'inherit' })
}

async function removeTestUser() {
  try {
    execSync(`npx wrangler d1 execute RepsDB --local --command \"DELETE FROM users WHERE username='${TEST_USER}'\"`, { stdio: 'inherit' })
  } catch (e) {
    console.warn('Cleanup: could not delete test user', e.message)
  }
}

// Prepare test user if server is up
conditionalTest('integration: setup test user', async () => {
  await ensureTestUser()
  // Verify it appears in /admin/users with auth
  const token = await loginForToken(TEST_USER, TEST_PASS)
  const res = await fetch(BASE + '/admin/users', { headers: { Authorization: `Bearer ${token}` } })
  assert.ok(res.ok, 'Expected test user auth to succeed for /admin/users listing')
  const arr = await res.json()
  assert.ok(Array.isArray(arr), 'Expected array of users')
  assert.ok(arr.find(u => u.username === TEST_USER), 'Test user not listed')
})

// Unauthenticated users must not be able to create, update, or delete
conditionalTest('integration: unauthenticated users cannot create/update/delete', async () => {
  const api = new BGRepeaters({ baseURL: BASE })
  const callsign = 'LZ0ZZZ'
  const payload = {
    callsign, keeper: 'LZ2SLL', latitude: 42.7, longitude: 24.9,
    place: 'Тест', altitude: 1000,
    modes: { fm: { enabled: true } },
    freq: { rx: 430700000, tx: 438300000 }
  }
  // Create should fail with 401
  let createErr; try { await api.createRepeater(payload) } catch (e) { createErr = e }
  assert.ok(createErr && createErr.status === 401, 'Expected 401 for unauthenticated create')
  // Update should fail with 401
  let updateErr; try { await api.updateRepeater(callsign, { place: 'Nope' }) } catch (e) { updateErr = e }
  assert.ok(updateErr && updateErr.status === 401, 'Expected 401 for unauthenticated update')
  // Delete should fail with 401
  let deleteErr; try { await api.deleteRepeater(callsign) } catch (e) { deleteErr = e }
  assert.ok(deleteErr && deleteErr.status === 401, 'Expected 401 for unauthenticated delete')
})

conditionalTest('integration: create/update/delete repeater with auth (test user)', async () => {
  // Ensure test user exists (idempotent)
  await ensureTestUser()
  const api = new BGRepeaters({ baseURL: BASE, username: TEST_USER, password: TEST_PASS })

  // Ensure clean start: attempt delete if it already exists
  try { await api.deleteRepeater('LZ0ZZZ') } catch (_) {}

  // Create
  const createPayload = {
    callsign: 'LZ0ZZZ', keeper: 'LZ2SLL', latitude: 42.71, longitude: 24.91,
    place: 'Тест Създаване', altitude: 900,
    modes: {
      fm: { enabled: true },
      dmr: { enabled: true, network: 'DMR+', color_code: '1', callid: '284040', reflector: 'XLX023 B', ts1_groups: '9,284', ts2_groups: '284', info: 'Test DMR' }
    },
    freq: { rx: 430700000, tx: 438300000 }
  }
  const created = await api.createRepeater(createPayload)
  assert.equal(created.callsign, 'LZ0ZZZ')
  assert.ok(created.modes.dmr.callid === '284040')

  // Update
  const updated = await api.updateRepeater('LZ0ZZZ', { place: 'Тест Обновяване', modes: { dmr: { enabled: true, network: 'DMR+', color_code: '1', callid: '284040', reflector: 'XLX023 C' } } })
  assert.equal(updated.place, 'Тест Обновяване')
  assert.ok(updated.modes.dmr.reflector?.includes('C'))

  // Delete
  const deleted = await api.deleteRepeater('LZ0ZZZ')
  assert.equal(deleted.callsign, 'LZ0ZZZ')

  // Confirm gone
  let notFound = false
  try { await api.getRepeater('LZ0ZZZ') } catch (e) { notFound = e.status === 404 }
  assert.ok(notFound, 'Expected repeater to be gone after delete')
})

conditionalTest('integration: auth failure wrong password (test user)', async () => {
  const api = new BGRepeaters({ baseURL: BASE, username: TEST_USER, password: 'wrongpassword' })
  let errorCaught = false
  try {
    await api.createRepeater({ callsign: 'LZ0ZZZ', keeper: 'LZ2SLL', latitude: 42.7, longitude: 24.9, place: 'BadAuth', altitude: 100, modes: { fm: { enabled: true } }, freq: { rx: 430700000, tx: 438300000 } })
  } catch (e) {
    errorCaught = true
    assert.equal(e.status, 401)
  }
  assert.ok(errorCaught, 'Expected 401 for wrong password')
})

conditionalTest('integration: teardown test user', async () => {
  await removeTestUser()
  // Confirm login fails now
  let failed = false
  try {
    await loginForToken(TEST_USER, TEST_PASS)
  } catch (_) {
    failed = true
  }
  assert.ok(failed, 'Expected login to fail for removed test user')
})
