const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
export const SESSION_TTL_DEFAULT_MS = DAY_MS
export const SESSION_IDLE_DEFAULT_MS = 2 * HOUR_MS

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let cachedSecretString: string | null = null
let cachedKeyPromise: Promise<CryptoKey> | null = null

const base64urlEncode = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const base64urlDecode = (input: string): Uint8Array => {
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  while (normalized.length % 4) normalized += '='
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const getDuration = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const ensureSecretString = (env: CloudflareBindings): string => {
  if (env.BGREPS_JWT_SECRET && env.BGREPS_JWT_SECRET.trim().length) {
    cachedSecretString = env.BGREPS_JWT_SECRET.trim()
    return cachedSecretString
  }
  if (cachedSecretString) return cachedSecretString
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  cachedSecretString = base64urlEncode(bytes)
  console.warn('BGREPS_JWT_SECRET is not set. Generated ephemeral secret; tokens reset on restart.')
  return cachedSecretString
}

const getSecretKey = (env: CloudflareBindings) => {
  if (cachedKeyPromise) return cachedKeyPromise
  cachedKeyPromise = (async () => {
    const secret = ensureSecretString(env)
    const bytes = encoder.encode(secret)
    return await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  })()
  return cachedKeyPromise
}

export type SessionClaims = {
  username: string
  token_version: number
  issued_at: number
  exp: number
  idle_expires: number
  ua?: string
  device?: string
}

export type SessionIssueParams = {
  username: string
  tokenVersion: number
  uaHash?: string
  deviceId?: string
  now?: number
}

export const createSessionToken = async (env: CloudflareBindings, params: SessionIssueParams): Promise<string> => {
  const now = typeof params.now === 'number' ? params.now : Date.now()
  const ttlMs = getDuration(env.BGREPS_JWT_TTL_MS, SESSION_TTL_DEFAULT_MS)
  const idleMs = getDuration(env.BGREPS_JWT_IDLE_MS, SESSION_IDLE_DEFAULT_MS)
  const claims: SessionClaims = {
    username: params.username,
    token_version: params.tokenVersion,
    issued_at: now,
    exp: now + ttlMs,
    idle_expires: now + idleMs,
  }
  if (params.uaHash) claims.ua = params.uaHash
  if (params.deviceId) claims.device = params.deviceId
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64urlEncode(encoder.encode(JSON.stringify(header)))
  const payloadB64 = base64urlEncode(encoder.encode(JSON.stringify(claims)))
  const data = `${headerB64}.${payloadB64}`
  const key = await getSecretKey(env)
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return `${data}.${base64urlEncode(signature)}`
}

export const verifySessionToken = async (env: CloudflareBindings, token: string): Promise<SessionClaims> => {
  const segments = token.split('.')
  if (segments.length !== 3) throw new Error('INVALID_TOKEN')
  const [headerB64, payloadB64, signatureB64] = segments
  const key = await getSecretKey(env)
  const data = `${headerB64}.${payloadB64}`
  const expected = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  const provided = base64urlDecode(signatureB64)
  const expectedBytes = new Uint8Array(expected)
  if (!timingSafeEqual(provided, expectedBytes)) throw new Error('INVALID_SIGNATURE')

  const payloadJson = decoder.decode(base64urlDecode(payloadB64))
  let claims: SessionClaims
  try {
    claims = JSON.parse(payloadJson)
  } catch (_) {
    throw new Error('INVALID_PAYLOAD')
  }
  if (!claims || typeof claims.username !== 'string' || typeof claims.token_version !== 'number') throw new Error('INVALID_PAYLOAD')
  return claims
}
