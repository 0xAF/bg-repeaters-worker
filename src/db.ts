import { RepeaterSchema, RepeaterQueryInternalSchema } from './api/RepeaterSchema'
import { sanitizeRepeater } from './sanitize'
import { ErrorSchema } from './api/ErrorSchema'
import { z } from '@hono/zod-openapi'
// import { util } from 'zod';
import Maidenhead from '@amrato/maidenhead-ts';
// Local type for changelog entries to avoid cross-file module resolution issues in some editors
type ChangelogEntry = { date: string; who: string; info: string }

type Repeater = z.infer<typeof RepeaterSchema>;
type RepeaterQueryInternal = z.infer<typeof RepeaterQueryInternalSchema>;
type ErrorJSON = z.infer<typeof ErrorSchema>;
// --- User management helpers (hash + auth) ---
// Passwords stored as SHA-256 hex strings; we accept Basic auth and compare.
// We keep these lightweight to avoid external crypto dependencies; Web Crypto API is available in Workers.

const SUPERADMIN_USERNAME_VALUE = 'SUPERADMIN'
const superadminEncoder = new TextEncoder()
let superadminTokenVersion = 1

export const SUPERADMIN_USERNAME = SUPERADMIN_USERNAME_VALUE

export const isSuperadminUsername = (username?: string | null): boolean => {
  return typeof username === 'string' && username.trim().toUpperCase() === SUPERADMIN_USERNAME_VALUE
}

const getSuperadminRecord = (): UserRecord => ({
  username: SUPERADMIN_USERNAME_VALUE,
  enabled: 1,
  token_version: superadminTokenVersion,
})

const timingSafeEqualStrings = (a: string, b: string): boolean => {
  const aBytes = superadminEncoder.encode(a)
  const bBytes = superadminEncoder.encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i]
  return diff === 0
}

type BasicAuthOptions = { superadminPassword?: string }

export const sha256Hex = async (input: string): Promise<string> => {
  // Workers runtime provides crypto.subtle
  const enc = new TextEncoder().encode(input)
  const hashBuf = await crypto.subtle.digest('SHA-256', enc)
  return [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const listUsers = async (DB: D1Database): Promise<UserRecord[] | ErrorJSON> => {
  try {
    const q = `SELECT username, enabled, created, updated FROM users ORDER BY username ASC`
    const { results } = await DB.prepare(q).all() || { results: [] }
    return results as UserRecord[]
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

export const createUser = async (DB: D1Database, username: string, password: string, enabled: boolean): Promise<UserRecord | ErrorJSON> => {
  try {
    if (isSuperadminUsername(username)) {
      return { failure: true, errors: { SUPERADMIN: 'The SUPERADMIN account is managed via environment variables.' }, code: 400 }
    }
    const existing = await getUser(DB, username)
    if ((existing as any).username) return { failure: true, errors: { EXISTS: 'User already exists.' }, code: 406 }
    const hash = await sha256Hex(password)
    const q = `INSERT INTO users (username, password, enabled, token_version, last_login, last_login_device, last_login_ua, created, updated)
      VALUES (UPPER(?), ?, ?, 1, NULL, NULL, NULL, datetime('now'), datetime('now'))`
    await DB.prepare(q).bind(username.toUpperCase(), hash, enabled ? 1 : 0).run()
    return await getUser(DB, username) as UserRecord
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

export const updateUser = async (DB: D1Database, username: string, data: { password?: string; enabled?: boolean }): Promise<UserRecord | ErrorJSON> => {
  try {
    if (isSuperadminUsername(username)) {
      return { failure: true, errors: { SUPERADMIN: 'The SUPERADMIN account cannot be modified via the API.' }, code: 400 }
    }
    const user = await getUser(DB, username)
    if (!(user as any).username) return { failure: true, errors: { NOTFOUND: 'User not found.' }, code: 404 }
    const parts: string[] = []
    const values: any[] = []
    if (data.password) { parts.push('password = ?'); values.push(await sha256Hex(data.password)) }
    if (data.enabled !== undefined) { parts.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }
    if (!parts.length) return user as UserRecord // nothing to update
    parts.push(`updated = datetime('now')`)
    const q = `UPDATE users SET ${parts.join(', ')} WHERE username = UPPER(?)`
    values.push(username)
    await DB.prepare(q).bind(...values).run()
    return await getUser(DB, username) as UserRecord
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

export const deleteUser = async (DB: D1Database, username: string): Promise<UserRecord | ErrorJSON> => {
  try {
    if (isSuperadminUsername(username)) {
      return { failure: true, errors: { SUPERADMIN: 'The SUPERADMIN account cannot be deleted.' }, code: 400 }
    }
    const user = await getUser(DB, username)
    if (!(user as any).username) return { failure: true, errors: { NOTFOUND: 'User not found.' }, code: 404 }
    const q = `DELETE FROM users WHERE username = UPPER(?)`
    await DB.prepare(q).bind(username).run()
    return user as UserRecord
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

export const getUser = async (DB: D1Database, username: string): Promise<UserRecord | ErrorJSON> => {
  try {
    if (isSuperadminUsername(username)) {
      return getSuperadminRecord()
    }
    const q = `SELECT username, password, enabled, token_version, last_login, last_login_device, last_login_ua, created, updated
      FROM users WHERE username = UPPER(?)`
    const { results } = await DB.prepare(q).bind(username).all() || { results: [] }
    if (!results?.length) return {} as UserRecord
    return results[0] as UserRecord
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

export const verifyUserBasicAuth = async (DB: D1Database, authHeader: string | null, opts?: BasicAuthOptions): Promise<boolean> => {
  if (!authHeader || !/^Basic\s+/i.test(authHeader)) return false
  try {
    const b64 = authHeader.replace(/^Basic\s+/i, '')
    const decoded = atob(b64)
    const [user, pass] = decoded.split(':')
    if (!user || !pass) return false
    if (isSuperadminUsername(user)) {
      const expected = (opts?.superadminPassword ?? '').trim()
      if (!expected.length) {
        console.warn('SUPERADMIN_PW is not configured; rejecting SUPERADMIN login attempt.')
        return false
      }
      const ok = timingSafeEqualStrings(pass, expected)
      if (!ok) {
        console.warn('Password mismatch for SUPERADMIN login attempt')
      }
      return ok
    }
    const rec = await getUser(DB, user)
    if (!(rec as any).username || (rec as any).enabled === 0) {
      console.warn('User record missing or disabled during login', { providedUser: user, recordFound: !!(rec as any).username, enabled: (rec as any).enabled })
      return false
    }
    const hash = await sha256Hex(pass)
    const stored = rec as UserRecord
    const ok = (stored.password as string | undefined) === hash
    if (!ok) {
      console.warn('Password mismatch for user', { username: stored.username, providedHash: hash })
    }
    return ok
  } catch {
    return false
  }
}

export const authenticateUser = async (DB: D1Database, authHeader: string | null, opts?: BasicAuthOptions): Promise<string | null> => {
  const ok = await verifyUserBasicAuth(DB, authHeader, opts)
  if (!ok) return null
  const b64 = (authHeader as string).replace(/^Basic\s+/i, '')
  const decoded = atob(b64)
  const [user] = decoded.split(':')
  return user ? user.toUpperCase() : null
}

export const recordUserLogin = async (DB: D1Database, username: string, deviceId?: string | null, uaHash?: string | null): Promise<void | ErrorJSON> => {
  try {
    if (isSuperadminUsername(username)) return
    const q = `UPDATE users SET last_login = datetime('now'), last_login_device = ?, last_login_ua = ?, updated = datetime('now')
      WHERE username = UPPER(?)`
    await DB.prepare(q).bind(deviceId ?? null, uaHash ?? null, username).run()
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

export const bumpTokenVersion = async (DB: D1Database, username: string): Promise<UserRecord | ErrorJSON> => {
  try {
    if (isSuperadminUsername(username)) {
      superadminTokenVersion += 1
      return getSuperadminRecord()
    }
    const q = `UPDATE users SET token_version = COALESCE(token_version, 1) + 1, updated = datetime('now') WHERE username = UPPER(?)`
    const result = await DB.prepare(q).bind(username).run()
    if (!result?.success) return { failure: true, errors: { SQL: 'Failed to bump token version.' }, code: 422 }
    const rec = await getUser(DB, username)
    if (!(rec as UserRecord).username) return { failure: true, errors: { NOTFOUND: 'User not found.' }, code: 404 }
    return rec as UserRecord
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

// --- User management helpers ---
type UserRecord = {
  username: string;
  password?: string;
  enabled: number;
  token_version?: number;
  last_login?: string | null;
  last_login_device?: string | null;
  last_login_ua?: string | null;
  created?: string;
  updated?: string;
}

const toHex = (buffer: ArrayBuffer): string => {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const getRepeaters = async (DB: D1Database, r: Repeater | RepeaterQueryInternal): Promise<Repeater[] | ErrorJSON> => {
  try {
    let q = `SELECT * FROM repeaters WHERE 1=1`
    const values: any[] = []
    // Disabled filter: default to enabled-only unless include_disabled is true or disabled is explicitly specified
    const rrTop = r as any
    // Be tolerant about the type of include_disabled (boolean, numeric, or string)
    // so that any truthy variant like 'true', '1', 1 will activate the combined listing.
    const includeAll = rrTop.include_disabled === true ||
      rrTop.include_disabled === 'true' || rrTop.include_disabled === '1' ||
      rrTop.include_disabled === 1
    if (!includeAll) {
      // Accept boolean true/false, numeric 1/0, and string 'true'/'false'/'1'/'0'
      const rawDisabled = rrTop.disabled
      const hasDisabledParam = rawDisabled !== undefined
      const disabledVal = (rawDisabled === true || rawDisabled === 1 || rawDisabled === '1' || rawDisabled === 'true') ? 1
        : (rawDisabled === false || rawDisabled === 0 || rawDisabled === '0' || rawDisabled === 'false') ? 0
        : null
      if (hasDisabledParam && disabledVal !== null) {
        q += ' AND disabled = ?'; values.push(disabledVal)
      } else if (!hasDisabledParam) {
        // default: only enabled
        q += ' AND disabled = 0'
      } else {
        // malformed value: still default to enabled-only
        q += ' AND disabled = 0'
      }
    }
  if (r.callsign) { q += ' AND UPPER(callsign) = UPPER(?)'; values.push(r.callsign) }
    if (r.keeper) { q += ' AND UPPER(keeper) = UPPER(?)'; values.push(r.keeper) }
    if (r.place) { q += ' AND UPPER(place) LIKE UPPER(?)'; values.push('%' + r.place + '%') }
    if (r.location) { q += ' AND UPPER(location) LIKE UPPER(?)'; values.push('%' + r.location + '%') }
    if (r.info) { q += ' AND UPPER(info) LIKE UPPER(?)'; values.push('%' + r.info.join('\r\n') + '%') }

    if ((r as Repeater).modes || (r as Repeater).freq || (r as Repeater).internet) {
      const rr = r as Repeater
      if (rr.modes?.fm) { q += ' AND mode_fm = ?'; values.push(rr.modes.fm ? 1 : 0) }
      if (rr.modes?.am) { q += ' AND mode_am = ?'; values.push(rr.modes.am ? 1 : 0) }
      if (rr.modes?.usb) { q += ' AND mode_usb = ?'; values.push(rr.modes.usb ? 1 : 0) }
      if (rr.modes?.lsb) { q += ' AND mode_lsb = ?'; values.push(rr.modes.lsb ? 1 : 0) }
      if (rr.modes?.dmr) { q += ' AND mode_dmr = ?'; values.push(rr.modes.dmr ? 1 : 0) }
      if (rr.modes?.dstar) { q += ' AND mode_dstar = ?'; values.push(rr.modes.dstar ? 1 : 0) }
      if (rr.modes?.fusion) { q += ' AND mode_fusion = ?'; values.push(rr.modes.fusion ? 1 : 0) }
      if (rr.modes?.nxdn) { q += ' AND mode_nxdn = ?'; values.push(rr.modes.nxdn ? 1 : 0) }
      if (rr.modes?.parrot) { q += ' AND mode_parrot = ?'; values.push(rr.modes.parrot ? 1 : 0) }
      if (rr.modes?.beacon) { q += ' AND mode_beacon = ?'; values.push(rr.modes.beacon ? 1 : 0) }
      if (rr.freq?.rx) { q += ' AND freq_rx = ?'; values.push(rr.freq.rx) }
      if (rr.freq?.tx) { q += ' AND freq_tx = ?'; values.push(rr.freq.tx) }
      if (rr.freq?.tone) { q += ' AND tone = ?'; values.push(rr.freq.tone) }
      if (rr.internet?.echolink) {
        if (rr.internet.echolink == 1) q += ' AND net_echolink > 0'; else { q += ' AND net_echolink = ?'; values.push(rr.internet.echolink) }
      }
      if (rr.internet?.allstarlink) {
        if (rr.internet.allstarlink == 1) q += ' AND net_allstarlink > 0'; else { q += ' AND net_allstarlink = ?'; values.push(rr.internet.allstarlink) }
      }
      if (rr.internet?.zello) q += ' AND net_zello IS NOT NULL'
      if (rr.internet?.other) q += ' AND net_other IS NOT NULL'
    }

    if ((r as RepeaterQueryInternal).have) {
      const rr = r as RepeaterQueryInternal
      if (rr.have?.rx?.from) { q += ' AND freq_rx >= ?'; values.push(rr.have.rx.from) }
      if (rr.have?.rx?.to) { q += ' AND freq_rx <= ?'; values.push(rr.have.rx.to) }
      if (rr.have?.tx?.from) { q += ' AND freq_tx >= ?'; values.push(rr.have.tx.from) }
      if (rr.have?.tx?.to) { q += ' AND freq_tx <= ?'; values.push(rr.have.tx.to) }
      if (rr.have?.tone) q += ' AND tone > 0'
      if (rr.have?.fm) q += ' AND mode_fm > 0'
      if (rr.have?.am) q += ' AND mode_am > 0'
      if (rr.have?.usb) q += ' AND mode_usb > 0'
      if (rr.have?.lsb) q += ' AND mode_lsb > 0'
      if (rr.have?.dmr) q += ' AND mode_dmr > 0'
      if (rr.have?.dstar) q += ' AND mode_dstar > 0'
      if (rr.have?.fusion) q += ' AND mode_fusion > 0'
      if (rr.have?.nxdn) q += ' AND mode_nxdn > 0'
      if (rr.have?.parrot) q += ' AND mode_parrot > 0'
      if (rr.have?.beacon) q += ' AND mode_beacon > 0'
      if (rr.have?.echolink) q += ' AND net_echolink > 0'
      if (rr.have?.allstarlink) q += ' AND net_allstarlink > 0'
      if (rr.have?.zello) q += ' AND net_zello IS NOT NULL'
      if (rr.have?.other) q += ' AND net_other IS NOT NULL'
    }

    const { results } = await DB.prepare(q).bind(...values).all() || { results: [] }
    const mapped: Repeater[] = (results as any[]).map(row => {
      const channel = getChannel(parseInt(String(row.freq_tx), 10))
      const infoLines = typeof row.info === 'string' ? row.info.split(/\r?\n/).filter((l: string) => l.length) : (Array.isArray(row.info) ? row.info : undefined)
      const dstar = {
        enabled: !!row.mode_dstar,
        reflector: row.dstar_reflector || undefined,
        info: row.dstar_info || undefined,
        module: row.dstar_module || undefined,
        gateway: row.dstar_gateway || undefined,
      }
      const fusion = {
        enabled: !!row.mode_fusion,
        reflector: row.fusion_reflector || undefined,
        tg: row.fusion_tg || undefined,
        info: row.fusion_info || undefined,
        room: row.fusion_room || undefined,
        dgid: row.fusion_dgid || undefined,
        wiresx_node: row.fusion_wiresx_node || undefined,
      }
      const dmr = {
        enabled: !!row.mode_dmr,
        network: row.dmr_network || undefined,
        ts1_groups: row.dmr_ts1_groups || undefined,
        ts2_groups: row.dmr_ts2_groups || undefined,
        info: row.dmr_info || undefined,
        color_code: row.dmr_color_code || undefined,
        callid: row.dmr_callid || undefined,
        reflector: row.dmr_reflector || undefined,
      }
      const nxdn = {
        enabled: !!row.mode_nxdn,
        network: row.nxdn_network || undefined,
        ran: row.nxdn_ran || undefined,
      }
      const qth = (row.latitude && row.longitude) ? Maidenhead.fromCoordinates(row.latitude as number, row.longitude as number, 3).locator : undefined
      return {
        callsign: row.callsign,
        disabled: !!row.disabled,
        keeper: row.keeper,
        latitude: row.latitude,
        longitude: row.longitude,
        place: row.place,
        location: row.location || undefined,
        qth,
        info: infoLines,
        altitude: row.altitude,
        power: row.power || 0,
        modes: {
          fm: { enabled: !!row.mode_fm },
          am: { enabled: !!row.mode_am },
          usb: { enabled: !!row.mode_usb },
          lsb: { enabled: !!row.mode_lsb },
          dmr,
          dstar,
          fusion,
          nxdn,
          parrot: { enabled: !!row.mode_parrot },
          beacon: { enabled: !!row.mode_beacon },
        },
        freq: { rx: row.freq_rx, tx: row.freq_tx, tone: row.tone, channel },
        internet: (row.net_echolink || row.net_allstarlink || row.net_zello || row.net_other) ? {
          echolink: row.net_echolink || undefined,
          allstarlink: row.net_allstarlink || undefined,
          zello: row.net_zello || undefined,
          other: row.net_other || undefined,
        } : undefined,
        coverage_map_json: row.coverage_map_json || undefined,
        added: row.created ? new Date(row.created) : undefined,
        updated: row.updated ? new Date(row.updated) : undefined,
      } as Repeater
    })
    return mapped

  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

// Fetch single repeater by callsign
// Fetch single repeater by callsign (including disabled ones).
// We intentionally do NOT filter by disabled here so that:
//  - createRepeater can detect existing (even disabled) records
//  - update/delete operations can act on disabled repeaters
// Public listing/search (getRepeaters) still hides disabled items.
export const getRepeater = async (DB: D1Database, callsign: string): Promise<Repeater | ErrorJSON> => {
  try {
    if (!callsign) return { failure: true, errors: { PARAMS: 'Provide callsign parameter.' }, code: 411 }
    // Use getRepeaters with explicit disabled: true and false fetch attempts to cover both states.
    let list = await getRepeaters(DB, { callsign } as any) as any
    if (list.failure && list.code) return list as ErrorJSON
    let arr = Array.isArray(list) ? list : []
    if (!arr.length) {
      // try disabled=true explicitly
      list = await getRepeaters(DB, { callsign, disabled: true } as any) as any
      if (list.failure && list.code) return list as ErrorJSON
      arr = Array.isArray(list) ? list : []
    }
    if (!arr.length) return { failure: true, errors: { NOTFOUND: 'Repeater not found in database.' }, code: 404 }
    return arr[0]
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
}

// Insert new repeater
export const addRepeater = async (DB: D1Database, p: Repeater): Promise<Repeater | ErrorJSON> => {
  try {
    const check = await getRepeater(DB, p.callsign)
    if ((check as ErrorJSON).failure && (check as ErrorJSON).code != 404) return check as ErrorJSON
    if ((check as Repeater).callsign) return { failure: true, errors: { EXISTS: 'Repeater with this callsign already exists in database.' }, code: 406 }
    // Ignore user-supplied qth or channel (always computed server-side)
    if ((p as any).qth) delete (p as any).qth
    if ((p as any).freq && (p as any).freq.channel) delete (p as any).freq.channel
    p = sanitizeRepeater(p) as Repeater
    const q = `INSERT INTO repeaters (
      callsign, disabled, keeper, latitude, longitude, place, location, info, altitude, power,
      mode_fm, mode_am, mode_usb, mode_lsb, mode_dmr, mode_dstar, mode_fusion, mode_nxdn, mode_parrot, mode_beacon,
      freq_rx, freq_tx, tone,
      net_echolink, net_allstarlink, net_zello, net_other,
      coverage_map_json,
      dstar_reflector, dstar_info,
      fusion_reflector, fusion_tg, fusion_info,
      dmr_network, dmr_ts1_groups, dmr_ts2_groups, dmr_info,
      dmr_color_code, dmr_callid, dmr_reflector,
      dstar_module, dstar_gateway,
      fusion_room, fusion_dgid, fusion_wiresx_node,
      nxdn_ran, nxdn_network,
      created, updated
    ) VALUES (
      UPPER(?), 0, UPPER(?), ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      datetime('now'), datetime('now')
    )`
    const mm = p.modes || {} as any
    const on = (v: any) => (typeof v === 'object' && v !== null ? (v.enabled ?? true) : !!v)
    const values = [
      p.callsign, p.keeper, p.latitude, p.longitude, p.place, p.location, p.info?.join('\r\n'), p.altitude, p.power,
      on(mm.fm) ? 1 : 0, on(mm.am) ? 1 : 0, on(mm.usb) ? 1 : 0, on(mm.lsb) ? 1 : 0, on(mm.dmr) ? 1 : 0, on(mm.dstar) ? 1 : 0, on(mm.fusion) ? 1 : 0, on(mm.nxdn) ? 1 : 0, on(mm.parrot) ? 1 : 0, on(mm.beacon) ? 1 : 0,
      p.freq.rx, p.freq.tx, p.freq.tone,
      p.internet?.echolink, p.internet?.allstarlink, p.internet?.zello, p.internet?.other,
      p.coverage_map_json,
      mm.dstar?.reflector, mm.dstar?.info,
      mm.fusion?.reflector, mm.fusion?.tg, mm.fusion?.info,
      mm.dmr?.network, mm.dmr?.ts1_groups, mm.dmr?.ts2_groups, mm.dmr?.info,
      mm.dmr?.color_code, mm.dmr?.callid, mm.dmr?.reflector,
      mm.dstar?.module, mm.dstar?.gateway,
      mm.fusion?.room, mm.fusion?.dgid, mm.fusion?.wiresx_node,
      mm.nxdn?.ran, mm.nxdn?.network
    ].map(v => v === undefined ? null : v)
    await DB.prepare(q).bind(...values).run()
  } catch (e: any) {
    return { failure: true, errors: { SQL: e.message }, code: 422 }
  }
  return await getRepeater(DB, p.callsign)
}

export const updateRepeater = async (DB: D1Database, rep: string, p: Repeater): Promise<Repeater | ErrorJSON> => {
  try {
    if (!rep) return { failure: true, errors: { "PARAMS": "Provide callsign parameter in url to update a repeater." }, code: 411 }

    const check_ret: Repeater | ErrorJSON = await getRepeater(DB, rep)
    const check_error = check_ret as ErrorJSON
    const check_rep = check_ret as Repeater
    if (check_error.failure) return check_ret;
    if (!check_rep.callsign) return { failure: true, errors: { "NOTFOUND": "Repeater not found in database." }, code: 404 }

    // Prepare update object: start from existing DB record, overlay provided fields.
    // Ignore user-supplied qth and freq.channel (they are derived server-side) WITHOUT dropping existing qth key.
    const pClean: any = { ...p }
    if ('qth' in pClean) delete pClean.qth
    if (pClean.freq && 'channel' in pClean.freq) { const f = { ...pClean.freq }; delete f.channel; pClean.freq = f }
    let u = { ...check_rep, ...pClean } // merge
    // Sanitize merged structure (only user-supplied string fields will be affected)
    u = sanitizeRepeater(u) as Repeater
    // Allow partial updates; perform a lightweight validation of unknown top-level keys instead of key-count equality.
    const allowedKeys = new Set(Object.keys(check_rep))
    for (const k of Object.keys(u)) {
      if (!allowedKeys.has(k)) return { failure: true, errors: { "INVALID": `Invalid key provided: ${k}` }, code: 417 }
    }

    // if (util.isDeepStrictEqual(check, u))
    //   return { failure: true, errors: { "SAME": "Nothing is updated." }, code: 417 }

    const q =
      `UPDATE repeaters SET 
        callsign = UPPER(?), disabled = ?, keeper = UPPER(?), latitude = ?, longitude = ?,
        place = ?, location = ?, info = ?, altitude = ?, power = ?,
        mode_fm = ?, mode_am = ?, mode_usb = ?, mode_lsb = ?, mode_dmr = ?, mode_dstar = ?, mode_fusion = ?, mode_nxdn = ?, mode_parrot = ?, mode_beacon = ?,
        freq_rx = ?, freq_tx = ?, tone = ?,
        net_echolink = ?, net_allstarlink = ?, net_zello = ?, net_other = ?,
        coverage_map_json = ?,
        dstar_reflector = ?, dstar_info = ?,
        fusion_reflector = ?, fusion_tg = ?, fusion_info = ?,
        dmr_network = ?, dmr_ts1_groups = ?, dmr_ts2_groups = ?, dmr_info = ?,
        dmr_color_code = ?, dmr_callid = ?, dmr_reflector = ?,
        dstar_module = ?, dstar_gateway = ?,
        fusion_room = ?, fusion_dgid = ?, fusion_wiresx_node = ?,
        nxdn_ran = ?, nxdn_network = ?,
        updated = datetime('now')
      WHERE callsign = UPPER(?)
      `
    const mmu = u.modes || {} as any
    const onU = (v: any) => (typeof v === 'object' && v !== null ? (v.enabled ?? true) : !!v)
    const values = [
      u.callsign, u.disabled, u.keeper, u.latitude, u.longitude,
      u.place, u.location, u.info?.join("\r\n"), u.altitude, u.power,
      onU(mmu.fm) ? 1 : 0, onU(mmu.am) ? 1 : 0, onU(mmu.usb) ? 1 : 0, onU(mmu.lsb) ? 1 : 0, onU(mmu.dmr) ? 1 : 0, onU(mmu.dstar) ? 1 : 0, onU(mmu.fusion) ? 1 : 0, onU(mmu.nxdn) ? 1 : 0, onU(mmu.parrot) ? 1 : 0, onU(mmu.beacon) ? 1 : 0,
      u.freq.rx, u.freq.tx, u.freq.tone,
      u.internet?.echolink, u.internet?.allstarlink, u.internet?.zello, u.internet?.other,
      u.coverage_map_json,
      mmu.dstar?.reflector, mmu.dstar?.info,
      mmu.fusion?.reflector, mmu.fusion?.tg, mmu.fusion?.info,
      mmu.dmr?.network, mmu.dmr?.ts1_groups, mmu.dmr?.ts2_groups, mmu.dmr?.info,
      mmu.dmr?.color_code, mmu.dmr?.callid, mmu.dmr?.reflector,
      mmu.dstar?.module, mmu.dstar?.gateway,
      mmu.fusion?.room, mmu.fusion?.dgid, mmu.fusion?.wiresx_node,
      mmu.nxdn?.ran, mmu.nxdn?.network,
      rep
    ].map(element => element === undefined ? null : element)

    await DB.prepare(q).bind(...values).run()
    return await getRepeater(DB, u.callsign)
  } catch (e: any) {
    return { failure: true, errors: { "SQL": e.message }, code: 422 }
  }
}

export const deleteRepeater = async (DB: D1Database, rep: string): Promise<Repeater | ErrorJSON> => {
  try {
    if (!rep) return { failure: true, errors: { "PARAMS": "Provide callsign parameter in url to delete a repeater." }, code: 411 }

    const check_ret: Repeater | ErrorJSON = await getRepeater(DB, rep)
    const check_error = check_ret as ErrorJSON
    const check_rep = check_ret as Repeater
    if (check_error.failure) return check_ret;
    if (!check_rep.callsign) return { failure: true, errors: { "NOTFOUND": "Repeater not found in database." }, code: 404 }

    const q = `DELETE FROM repeaters WHERE callsign = UPPER(?)`
    const values = [rep].map(element => element === undefined ? null : element)

    await DB.prepare(q).bind(...values).run()
    // Verify it's gone; return the previously existing record as confirmation
    const post: ErrorJSON | Repeater = await getRepeater(DB, rep)
    if ((post as ErrorJSON).failure) return check_rep
    return { failure: true, errors: { "INTERNAL": "Cannot delete repeater from database." }, code: 422 }
  } catch (e: any) {
    return { failure: true, errors: { "SQL": e.message }, code: 422 }
  }
}

// --- Changelog helpers and write wrappers ---

export const addChangelog = async (DB: D1Database, who: string, info: string): Promise<void | ErrorJSON> => {
  try {
    // Skip changelog entries for the integration test user INTUSER to avoid polluting history
    if (who && who.toUpperCase() === 'INTUSER') return
    const q = `INSERT INTO changelog (date, who, info) VALUES (datetime('now'), ?, ?)`
    await DB.prepare(q).bind(who.toUpperCase(), info).run()
  } catch (e: any) {
    return { failure: true, errors: { 'SQL': e.message }, code: 422 }
  }
}

// Convenience wrappers that accept a username to log changelog entries
export const addRepeaterWithLog = async (DB: D1Database, who: string, p: Repeater): Promise<Repeater | ErrorJSON> => {
  const res = await addRepeater(DB, p)
  if ((res as any).failure) return res as ErrorJSON
  await addChangelog(DB, who, `${who.toUpperCase()}: added new repeater: ${p.callsign}`)
  return res
}

const hasDiff = (a: any, b: any): boolean => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)

export const updateRepeaterWithLog = async (DB: D1Database, who: string, callsign: string, p: Repeater): Promise<Repeater | ErrorJSON> => {
  const before = await getRepeater(DB, callsign)
  if ((before as any).failure) return before as ErrorJSON
  const res = await updateRepeater(DB, callsign, p)
  if ((res as any).failure) return res as ErrorJSON
  const after = res as any
  const msgs: string[] = []
  const old = before as any
  if (old.callsign !== after.callsign) msgs.push(`Renamed to ${after.callsign}`)
  if (old.disabled !== after.disabled) msgs.push(after.disabled ? 'Disabled repeater' : 'Enabled repeater')
  if (hasDiff(old.place, after.place) || hasDiff(old.location, after.location)) msgs.push('updated location')
  if (hasDiff(old.freq, after.freq)) msgs.push('updated frequencies')
  if (hasDiff(old.modes, after.modes)) msgs.push('updated modes')
  if (hasDiff(old.internet, after.internet)) msgs.push('updated internet')
  if (hasDiff(old.digital, after.digital)) msgs.push('updated digital info')
  if (hasDiff(old.info, after.info)) msgs.push('updated info')
  if (hasDiff(old.power, after.power)) msgs.push('updated power')
  if (hasDiff(old.altitude, after.altitude)) msgs.push('updated altitude')
  if (hasDiff(old.coverage_map_json, after.coverage_map_json)) msgs.push('updated coverage map')
  const base = `${who.toUpperCase()}: updated repeater ${callsign}`
  const details = msgs.length ? `. ${msgs.join('. ')}` : ''
  await addChangelog(DB, who, base + details)
  return res
}

export const deleteRepeaterWithLog = async (DB: D1Database, who: string, callsign: string): Promise<Repeater | ErrorJSON> => {
  const before = await getRepeater(DB, callsign)
  if ((before as any).failure) return before as ErrorJSON
  const res = await deleteRepeater(DB, callsign)
  if ((res as any).failure) return res as ErrorJSON
  await addChangelog(DB, who, `${who.toUpperCase()}: deleted repeater ${callsign}`)
  return res
}

export const getChangelog = async (DB: D1Database): Promise<ChangelogEntry[] | ErrorJSON> => {
  try {
    const q = `SELECT date, who, info FROM changelog ORDER BY date DESC`;
    const { results } = await DB.prepare(q).all() || { results: [] };
    // Ensure ISO strings for date
    (results as any[]).forEach(r => {
      if (r.date) {
        const d = new Date(r.date);
        r.date = isNaN(d.getTime()) ? String(r.date) : d.toISOString();
      }
    });
    return results as ChangelogEntry[];
  } catch (e: any) {
    // If the table doesn't exist yet in a fresh DB, return an empty changelog instead of failing
    if (typeof e?.message === 'string' && /no such table/i.test(e.message)) {
      return [] as ChangelogEntry[];
    }
    return { failure: true, errors: { "SQL": e.message }, code: 422 }
  }
}






const getChannel = (f: number): string => {
  /* NOTE: calculations are based on repeater output freq
  IARU-R1
  Channel designation system for VHF/UHF FM channels
  https://www.iaru-r1.org/wp-content/uploads/2021/03/VHF_Handbook_V9.01.pdf
  section: 2.4.1 Principle
  The system is based upon the following principles:
  • For each band, there should be a "designator letter":
    1. 51 MHz : F
    2. 145 MHz : V
    3. 435 MHz : U
  • Each designator letter should be followed by two (for 50 and 145 MHz) or three (for 435 MHz) digits which indicate the channel.
  • If a channel is used as a repeater output, its designator should be preceded by the letter "R".
  • In the 50 MHz band the channel numbers start at F00 for 51.000 MHz and increment by one for each 10 kHz.
  • In the 145 MHz band the channel numbers start at V00 for 145.000 MHz and increment by one for each 12.5 kHz.
  • In the 435 MHz band the channel numbers start at U000 for 430 MHz and increment by one for each 12.5 kHz.
  */
  let chan = "N/A";
  if (f >= 145200000 && f < 145400000 && (f - 145200000) % 25000 == 0) { // VHF R8-R15
    chan = 'R' + (((f - 145200000) / 25000) + 8).toString()
  } else if (f >= 145600000 && f < 146000000 && (f - 145600000) % 25000 == 0) { // VHF R0-R7
    chan = 'R' + ((f - 145600000) / 25000).toString();
  } else if (f >= 430000000 && f < 440000000 && (f - 430000000) % 12500 == 0) { // UHF
    chan = 'RU' + ((f - 430000000) / 12500).toFixed(0).padStart(3, '0');
  }
  if (f >= 145000000 && f < 146000000 && (f - 145000000) % 12500 == 0) // VHF RV channels
    chan = (chan === 'N/A' ? '' : chan + ', ') + 'RV' + ((f - 145000000) / 12500).toFixed(0).padStart(2, '0');

  return chan;
}
