import { RepeaterSchema, RepeaterQueryInternalSchema } from './api/RepeaterSchema'
import { ErrorSchema } from './api/ErrorSchema'
import { z } from '@hono/zod-openapi'
// import { util } from 'zod';
import Maidenhead from '@amrato/maidenhead-ts';

type Repeater = z.infer<typeof RepeaterSchema>;
type RepeaterQueryInternal = z.infer<typeof RepeaterQueryInternalSchema>;
type ErrorJSON = z.infer<typeof ErrorSchema>;

export const getRepeaters = async (DB: D1Database, r: Repeater | RepeaterQueryInternal): Promise<Repeater[] | ErrorJSON> => {
  try {
    let q = `SELECT * FROM repeaters WHERE disabled = 0`
    let values = []
    if (r.callsign) { q += " AND UPPER(callsign) = UPPER(?)"; values.push(r.callsign) }
    if (r.keeper) { q += " AND UPPER(keeper) = UPPER(?)"; values.push(r.keeper) }
    if (r.place) { q += " AND UPPER(place) LIKE UPPER(?)"; values.push('%' + r.place + '%') }
    if (r.location) { q += " AND UPPER(location) LIKE UPPER(?)"; values.push('%' + r.location + '%') }
    if (r.info) { q += " AND UPPER(info) LIKE UPPER(?)"; values.push('%' + r.info.join("\r\n") + '%') }

    if ((<Repeater>r).modes || (<Repeater>r).freq || (<Repeater>r).internet) {
      const rr = r as Repeater
      if (rr.modes?.fm) { q += " AND mode_fm = ?"; values.push(rr.modes.fm ? 1 : 0) }
      if (rr.modes?.am) { q += " AND mode_am = ?"; values.push(rr.modes.am ? 1 : 0) }
      if (rr.modes?.usb) { q += " AND mode_usb = ?"; values.push(rr.modes.usb ? 1 : 0) }
      if (rr.modes?.lsb) { q += " AND mode_lsb = ?"; values.push(rr.modes.lsb ? 1 : 0) }
      if (rr.modes?.dmr) { q += " AND mode_dmr = ?"; values.push(rr.modes.dmr ? 1 : 0) }
      if (rr.modes?.dstar) { q += " AND mode_dstar = ?"; values.push(rr.modes.dstar ? 1 : 0) }
      if (rr.modes?.fusion) { q += " AND mode_fusion = ?"; values.push(rr.modes.fusion ? 1 : 0) }
      if (rr.modes?.parrot) { q += " AND mode_parrot = ?"; values.push(rr.modes.parrot ? 1 : 0) }
      if (rr.modes?.beacon) { q += " AND mode_beacon = ?"; values.push(rr.modes.beacon ? 1 : 0) }
      if (rr.freq?.rx) { q += " AND freq_rx = ?"; values.push(rr.freq.rx) }
      if (rr.freq?.tx) { q += " AND freq_tx = ?"; values.push(rr.freq.tx) }
      if (rr.freq?.tone) { q += " AND tone = ?"; values.push(rr.freq.tone) }
      if (rr.internet?.echolink) {
        if (rr.internet.echolink == 1) q += " AND net_echolink > 0"
        else { q += " AND net_echolink = ?"; values.push(rr.internet.echolink) }
      }
      if (rr.internet?.allstarlink) {
        if (rr.internet.allstarlink == 1) q += " AND net_allstarlink > 0"
        else { q += " AND net_allstarlink = ?"; values.push(rr.internet.allstarlink) }
      }
      if (rr.internet?.zello) q += " AND net_zello IS NOT NULL";
      if (rr.internet?.other) q += " AND net_other IS NOT NULL";
    }

    if ((<RepeaterQueryInternal>r).have) {
      const rr = r as RepeaterQueryInternal
      if (rr.have?.rx?.from) { q += " AND freq_rx >= ?"; values.push(rr.have.rx.from) }
      if (rr.have?.rx?.to) { q += " AND freq_rx >= ?"; values.push(rr.have.rx.to) }
      if (rr.have?.tx?.from) { q += " AND freq_tx >= ?"; values.push(rr.have.tx.from) }
      if (rr.have?.tx?.to) { q += " AND freq_tx >= ?"; values.push(rr.have.tx.to) }
      if (rr.have?.tone) q += " AND tone > 0"
      if (rr.have?.fm) q += " AND mode_fm > 0"
      if (rr.have?.am) q += " AND mode_am > 0"
      if (rr.have?.usb) q += " AND mode_usb > 0"
      if (rr.have?.lsb) q += " AND mode_lsb > 0"
      if (rr.have?.dmr) q += " AND mode_dmr > 0"
      if (rr.have?.dstar) q += " AND mode_dstar > 0"
      if (rr.have?.fusion) q += " AND mode_fusion > 0"
      if (rr.have?.parrot) q += " AND mode_parrot > 0"
      if (rr.have?.beacon) q += " AND mode_beacon > 0"
      if (rr.have?.echolink) q += " AND net_echolink > 0"
      if (rr.have?.allstarlink) q += " AND net_allstarlink > 0"
      if (rr.have?.zello) q += " AND net_zello IS NOT NULL"
      if (rr.have?.other) q += " AND net_other IS NOT NULL"
    }

    // const values = [ r ].map(element => element === undefined ? null : element)
    let { results } = await DB.prepare(q).bind(...values).all() || []

    function deleteAndReturn<T extends object, K extends keyof T>(obj: T, prop: K): T[K] | undefined {
      if (prop in obj) {
        const value = obj[prop]; // Store the value
        delete obj[prop]; // Delete the property
        return value; // Return the deleted value
      }
      return undefined; // Return undefined if the property does not exist
    }
    results.map(e => {
      e.added = deleteAndReturn(e, 'created')
      if (e.latitude && e.longitude) e.qth = Maidenhead.fromCoordinates(e.latitude as number, e.longitude as number, 3).locator
      e.modes = {
        fm: deleteAndReturn(e, 'mode_fm') ? true : false,
        am: deleteAndReturn(e, 'mode_am') ? true : false,
        usb: deleteAndReturn(e, 'mode_usb') ? true : false,
        lsb: deleteAndReturn(e, 'mode_lsb') ? true : false,
        dmr: deleteAndReturn(e, 'mode_dmr') ? true : false,
        dstar: deleteAndReturn(e, 'mode_dstar') ? true : false,
        fusion: deleteAndReturn(e, 'mode_fusion') ? true : false,
        parrot: deleteAndReturn(e, 'mode_parrot') ? true : false,
        beacon: deleteAndReturn(e, 'mode_beacon') ? true : false,
      }
      let channel = getChannel(parseInt(<string>e.freq_tx, 10))
      e.freq = {
        rx: deleteAndReturn(e, 'freq_rx'),
        tx: deleteAndReturn(e, 'freq_tx'),
        tone: deleteAndReturn(e, 'tone'),
        channel
      }
      e.internet = {
        echolink: deleteAndReturn(e, 'net_echolink'),
        allstarlink: deleteAndReturn(e, 'net_allstarlink'),
        zello: deleteAndReturn(e, 'net_zello'),
        other: deleteAndReturn(e, 'net_other'),
      }
      let c = deleteAndReturn(e, 'coverage_map_json') as string;
      if (c) e.coverage_map = JSON.parse(c);
    })
    return results as Repeater[]
  } catch (e: any) {
    return { failure: true, errors: { "SQL": e.message }, code: 422 }
  }
}

export const getRepeater = async (DB: D1Database, r: string): Promise<Repeater | ErrorJSON> => {
  const res: Repeater[] | ErrorJSON = await getRepeaters(DB, { callsign: r } as Repeater)
  if ((res as ErrorJSON).failure) return res as ErrorJSON
  if (!(res as Repeater[])[0]) return { failure: true, errors: { "NOTFOUND": "Repeater not found." }, code: 404 }
  return (res as Repeater[])[0] || {} as Repeater
}

export const addRepeater = async (DB: D1Database, p: Repeater): Promise<Repeater | ErrorJSON> => {
  try {
    const check = await getRepeater(DB, p.callsign)
    if ((check as ErrorJSON).failure && (check as ErrorJSON).code != 404) return check as ErrorJSON;
    if ((check as Repeater).callsign) return { failure: true, errors: { "EXISTS": "Repeater with this callsign already exists in database." }, code: 406 }

    const q =
      `INSERT INTO repeaters (
				callsign, disabled, keeper, latitude, longitude, place, location, info, altitude, power,
				mode_fm, mode_am, mode_usb, mode_lsb, mode_dmr, mode_dstar, mode_fusion, mode_parrot, mode_beacon,
				freq_rx, freq_tx, tone,
				net_echolink, net_allstarlink, net_zello, net_other,
				coverage_map_json,
				created, updated
			) VALUES (
			 	UPPER(?), 0, UPPER(?), ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?, ?, ?, ?, ?, ?, ?,
				?, ?, ?,
				?, ?, ?, ?,
				?,
				datetime('now'), datetime('now')
			)
			`
    const values = [
      p.callsign, p.keeper, p.latitude, p.longitude, p.place, p.location, p.info?.join("\r\n"), p.altitude, p.power,
      p.modes.fm, p.modes.am, p.modes.usb, p.modes.lsb, p.modes.dmr, p.modes.dstar, p.modes.fusion, p.modes.parrot, p.modes.beacon,
      p.freq.rx, p.freq.tx, p.freq.tone,
      p.internet?.echolink, p.internet?.allstarlink, p.internet?.zello, p.internet?.other,
      p.coverage_map_json
    ].map(element => element === undefined ? null : element)
    await DB.prepare(q).bind(...values).run()
  } catch (e: any) {
    return { failure: true, errors: { "SQL": e.message }, code: 422 }
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

    const u = { ...check_rep, ...p } // use DB data as defaults for the update object

    if (Object.keys(check_rep).length != Object.keys(u).length)
      return { failure: true, errors: { "INVALID": "Invalid keys are provided." }, code: 417 }

    // if (util.isDeepStrictEqual(check, u))
    //   return { failure: true, errors: { "SAME": "Nothing is updated." }, code: 417 }

    const q =
      `UPDATE repeaters SET 
				callsign = UPPER(?), disabled = ?, keeper = UPPER(?), latitude = ?, longitude = ?,
				place = ?, location = ?, info = ?, altitude = ?, power = ?,
				mode_fm = ?, mode_am = ?, mode_usb = ?, mode_lsb = ?, mode_dmr = ?, mode_dstar = ?, mode_fusion = ?, mode_parrot = ?, mode_beacon = ?,
				freq_rx = ?, freq_tx = ?, tone = ?,
				net_echolink = ?, net_allstarlink = ?, net_zello = ?, net_other = ?,
				coverage_map_json = ?,
				updated = datetime('now')
			WHERE callsign = UPPER(?)
			`
    const values = [
      u.callsign, u.disabled, u.keeper, u.latitude, u.longitude,
      u.place, u.location, u.info?.join("\r\n"), u.altitude, u.power,
      u.modes.fm, u.modes.am, u.modes.usb, u.modes.lsb, u.modes.dmr, u.modes.dstar, u.modes.fusion, u.modes.parrot, u.modes.beacon,
      u.freq.rx, u.freq.tx, u.freq.tone,
      u.internet?.echolink, u.internet?.allstarlink, u.internet?.zello, u.internet?.other,
      u.coverage_map_json,
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

    const ret: ErrorJSON = await getRepeater(DB, rep) as ErrorJSON
    if (ret.failure) return {} as Repeater
    return { failure: true, errors: { "INTERNAL": "Cannot delete repeater from database." }, code: 422 }
  } catch (e: any) {
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

  // NOTE: in JS the % operator is 'reminder', not 'modulo'.
  // it's not working correctly with numbers < 1
  // Try in your browser console
  // 0.5 % 0.05
  // 0.1 % 0.01
  // so I had to get the freq to integer
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
