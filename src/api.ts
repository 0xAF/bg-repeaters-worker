import { z } from '@hono/zod-openapi'
import { createRoute } from '@hono/zod-openapi'
import { OpenAPIHono } from '@hono/zod-openapi'
import { RepeaterRequestSchema, RepeaterSchema, RepeaterQuerySchema } from './api/RepeaterSchema'
import { ChangelogEntrySchema, ChangelogResponseSchema } from './api/ChangelogSchema'
import { UserCreateSchema, UserUpdateSchema, UserResponseSchema, UsersListSchema, UserRequestSchema } from './api/UserSchema'
import { ErrorSchema } from './api/ErrorSchema'
import * as db from "./db"
import { createSessionToken, verifySessionToken, SESSION_IDLE_DEFAULT_MS, type SessionClaims } from './session'
import { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Context } from 'hono'

type Repeater = z.infer<typeof RepeaterSchema>;
type ErrorJSON = z.infer<typeof ErrorSchema>;
type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;
type ChangelogResponse = z.infer<typeof ChangelogResponseSchema>;

const LoginRequestBodySchema = z.object({
  deviceId: z.string().max(256).optional().openapi({ description: 'Client-provided device identifier for fingerprinting / audit.' })
}).openapi('AdminLoginRequest')

const LoginResponseSchema = z.object({
  token: z.string().openapi({ description: 'JWT bearer token to be used for subsequent requests.' })
}).openapi('AdminLoginResponse')


const api = new OpenAPIHono<{ Bindings: CloudflareBindings }>({
  defaultHook: (result, c): ErrorJSON | any => {
    if (!result.success) {
      return c.json({
        failure: true,
        errors: formatZodErrors(result.error),
        // source: 'custom_error_handler',
      }, 422)
    }
  },
}).basePath('/v1')

api.openapi(
  createRoute({
    method: 'post',
    path: '/admin/login',
    request: {
      body: {
        content: { 'application/json': { schema: LoginRequestBodySchema } },
        required: false,
      }
    },
    responses: {
      200: { content: { 'application/json': { schema: LoginResponseSchema } }, description: 'Issue JWT session token' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' }
    }
  }),
  async (c) => {
    const url = new URL(c.req.url)
    if (shouldEnforceHttps(c.env) && !isSecureRequest(url, c.req.header('Host'))) {
      console.warn('Insecure login attempt', {
        url: c.req.url,
        host: c.req.header('Host'),
        clientIp: c.req.header('CF-Connecting-IP') || 'unknown',
        referer: c.req.header('Referer') || 'none',
        proto: url.protocol,
      })
      return c.json({ failure: true, errors: { HTTPS: 'HTTPS is required for authentication (dev bypass failed).' }, code: 403 }, 403) as any
    }
    const authHeader = c.req.header('Authorization') ?? ''
    if (!/^Basic\s+/i.test(authHeader)) {
      return c.json({ failure: true, errors: { AUTH: 'Basic authorization required.' }, code: 401 }, 401) as any
    }
    const username = await db.authenticateUser(c.env.RepsDB, authHeader, { superadminPassword: c.env.SUPERADMIN_PW })
    if (!username) {
      console.warn('Basic auth failed', {
        authProvided: !!authHeader,
        decodedUser: decodeBasicUsername(authHeader),
      })
      return c.json({ failure: true, errors: { AUTH: 'Invalid credentials.' }, code: 401 }, 401) as any
    }
    const userRecord = await db.getUser(c.env.RepsDB, username)
    if (!(userRecord as any).username) {
      return c.json({ failure: true, errors: { AUTH: 'User not found.' }, code: 404 }, 404) as any
    }
    if ((userRecord as any).enabled === 0) {
      return c.json({ failure: true, errors: { AUTH: 'User disabled.' }, code: 403 }, 403) as any
    }
    let bodyDeviceId: string | undefined
    if ((c.req.header('Content-Type') || '').includes('application/json')) {
      try {
        const body = await c.req.json()
        bodyDeviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined
      } catch (_) {
        bodyDeviceId = undefined
      }
    }
    const headerDeviceId = c.req.header('X-Device-Id') || undefined
    const deviceId = (bodyDeviceId || headerDeviceId || '').trim() || undefined
    const ua = c.req.header('User-Agent') || ''
    const uaHash = ua ? await db.sha256Hex(ua) : undefined
    const recorded = await db.recordUserLogin(c.env.RepsDB, username, deviceId, uaHash)
    if ((recorded as ErrorJSON)?.failure) {
      const status = ((recorded as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(recorded, status) as any
    }
    const token = await createSessionToken(c.env, {
      username,
      tokenVersion: (userRecord as any).token_version || 1,
      uaHash,
      deviceId,
    })
    return c.json({ token }, 200) as any
  }
)

api.openapi(
  createRoute({
    method: 'post',
    path: '/admin/logout',
    responses: {
      200: { content: { 'application/json': { schema: UserResponseSchema } }, description: 'Invalidate current user sessions' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' }
    }
  }),
  async (c) => {
    // @ts-ignore - resolved by middleware earlier
    const user = c.get('authUser') as string | undefined
    if (!user) return c.json({ failure: true, errors: { AUTH: 'Authentication required.' }, code: 401 }, 401) as any
    const bumped = await db.bumpTokenVersion(c.env.RepsDB, user)
    if ((bumped as ErrorJSON).failure)
      return c.json((bumped as ErrorJSON), (bumped as ErrorJSON).code as ContentfulStatusCode || 422) as any
    const record = bumped as any
    return c.json({
      username: record.username,
      enabled: !!record.enabled,
      created: record.created,
      updated: record.updated,
    }, 200) as any
  }
)

// The OpenAPI documentation will be available at /doc
api.doc('/doc', (c) => ({
  openapi: '3.0.0',
  info: {
    version: '1.0.0',
    title: 'BG Repeaters API',
    description: "Bulgarian Repeaters Database API",
    contact: { /*email: 'af@0xAF.org',*/ name: "Stanislav Lechev (LZ2SLL)", url: 'https://0xAF.org' },
    license: { name: 'MIT', url: 'https://af.mit-license.org/' },
  },
  servers: [{
    url: new URL(c.req.url).origin,
    description: 'Current environment',
  }]
}))

// JWT guard for admin user management endpoints (covers both /admin/users and descendants)
const adminGuard = async (c: any, next: any) => {
  // @ts-ignore - hono Context stores arbitrary values
  const currentUser = c.get('authUser') as string | undefined
  if (currentUser) return await next()
  const auth = await ensureBearerAuth(c)
  if (!auth.ok) return c.json(auth.error, auth.status) as any
  if (auth.newToken) c.header('X-New-JWT', auth.newToken)
  // @ts-ignore - store resolved username for downstream handlers
  c.set('authUser', auth.username)
  await next()
}

api.use('/admin/users', adminGuard)
api.use('/admin/users/*', adminGuard)

// Require Bearer auth for all non-GET operations except the login endpoint
api.use('/*', async (c, next) => {
  if (c.req.method === 'GET') return await next()
  const path = new URL(c.req.url).pathname.replace(/^\/v1/, '')
  if (path === '/admin/login') return await next()
  // @ts-ignore
  if (c.get('authUser')) return await next()
  const auth = await ensureBearerAuth(c)
  if (!auth.ok) return c.json(auth.error, auth.status) as any
  if (auth.newToken) c.header('X-New-JWT', auth.newToken)
  // @ts-ignore
  c.set('authUser', auth.username)
  await next()
})

// --- Admin Users CRUD Endpoints --- //
api.openapi(
  createRoute({
    method: 'get',
    path: '/admin/users',
    responses: {
      200: { content: { 'application/json': { schema: UsersListSchema } }, description: 'List admin users' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' }
    }
  }),
  async (c) => {
    const r = await db.listUsers(c.env.RepsDB)
    if ((r as any).failure) return c.json(r, (r as any).code || 422) as any
    // map enabled numeric to boolean
    const users = (r as any[]).map(u => ({ username: u.username, enabled: !!u.enabled, created: u.created, updated: u.updated }))
    return c.json(users, 200) as any
  }
)

api.openapi(
  createRoute({
    method: 'post',
    path: '/admin/users',
    request: { body: { content: { 'application/json': { schema: UserCreateSchema } }, required: true } },
    responses: {
      201: { content: { 'application/json': { schema: UserResponseSchema } }, description: 'Create user' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' }
    }
  }),
  async (c) => {
    const data = await c.req.valid('json')
    const r = await db.createUser(c.env.RepsDB, data.username, data.password, data.enabled !== undefined ? data.enabled : true)
    if ((r as any).failure) return c.json(r, (r as any).code || 422) as any
    const ret = r as any
    return c.json({ username: ret.username, enabled: !!ret.enabled }, 201) as any
  }
)

api.openapi(
  createRoute({
    method: 'put',
    path: '/admin/users/{username}',
    request: { params: UserRequestSchema, body: { content: { 'application/json': { schema: UserUpdateSchema } }, required: true } },
    responses: {
      202: { content: { 'application/json': { schema: UserResponseSchema } }, description: 'Update user' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' }
    }
  }),
  async (c) => {
    const { username } = c.req.valid('param')
    let body
    try { body = await c.req.json() } catch { return c.json({ failure: true, errors: { JSON: 'Cannot parse JSON data' }, code: 422 }, 422) as any }
    const r = await db.updateUser(c.env.RepsDB, username, body)
    if ((r as any).failure) return c.json(r, (r as any).code || 422) as any
    const ret = r as any
    return c.json({ username: ret.username, enabled: !!ret.enabled }, 202) as any
  }
)

api.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/users/{username}',
    request: { params: UserRequestSchema },
    responses: {
      200: { content: { 'application/json': { schema: UserResponseSchema } }, description: 'Delete user' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' }
    }
  }),
  async (c) => {
    const { username } = c.req.valid('param')
    const r = await db.deleteUser(c.env.RepsDB, username)
    if ((r as any).failure) return c.json(r, (r as any).code || 422) as any
    const ret = r as any
    return c.json({ username: ret.username, enabled: !!ret.enabled }, 200) as any
  }
)




// Changelog endpoint - define BEFORE the dynamic "/{callsign}" route so it doesn't get shadowed
api.openapi(
  createRoute({
    method: 'get',
    path: '/changelog',
    responses: {
      200: {
        content: { 'application/json': { schema: ChangelogResponseSchema } },
        description: 'Changelog overview',
      },
      "*": {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Error description',
      }
    }
  }),
  async (c) => {
    const r = await db.getChangelog(c.env.RepsDB)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    const changes = r as ChangelogEntry[]
    const lastChanged = (changes[0]?.date as string | undefined) ?? null
    const payload: ChangelogResponse = { lastChanged, changes }
    return c.json(payload, 200) as any
  }
)

api.openapi(
  createRoute({
    method: 'get',
    path: '/{callsign}',
    request: { params: RepeaterRequestSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Retrieve repeater object"
      },
      "*": {
        content: { 'application/json': { schema: ErrorSchema } },
        description: "Error description"
      }
    }
  }),
  async (c) => {
    const { callsign } = c.req.valid('param')
    const r = await db.getRepeater(c.env.RepsDB, callsign)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 200) as any
  }
)


const optionalRepeaterQuerySchema = RepeaterQuerySchema.partial();
api.openapi(
  createRoute({
    method: 'get',
    path: '/',
    request: {
      query: optionalRepeaterQuerySchema,
    },
    responses: {
      200: {
        content: { 'application/json': { schema: z.array(RepeaterSchema) } },
        description: "Search for repeaters or get all of them"
      },
      "*": {
        content: { 'application/json': { schema: ErrorSchema } },
        description: "Error description"
      }
    }
  }),
  async (c) => {
    const data = c.req.valid('query')
    // const data = await c.req.query();
    // console.log(data)
  const nestedData = convertDotNotationToNestedObject(data);
  // Ensure we use the internal query shape to preserve boolean flags like disabled/include_disabled
  const r = await db.getRepeaters(c.env.RepsDB, nestedData as any)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 200) as any
  }
)

// Alias route to support GET /v1 without trailing slash behaving the same as GET /v1/
api.openapi(
  createRoute({
    method: 'get',
    path: '',
    request: {
      query: optionalRepeaterQuerySchema,
    },
    responses: {
      200: {
        content: { 'application/json': { schema: z.array(RepeaterSchema) } },
        description: 'Search for repeaters or get all of them (alias)'
      },
      '*': {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Error description'
      }
    }
  }),
  async (c) => {
    const data = c.req.valid('query')
    const nestedData = convertDotNotationToNestedObject(data)
    const r = await db.getRepeaters(c.env.RepsDB, nestedData as any)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 200) as any
  }
)

// create new repeater
api.openapi(
  createRoute({
    method: 'post',
    path: '/',
    request: {
      body: { content: { 'application/json': { schema: RepeaterSchema } }, required: true },
    },
    responses: {
      201: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Create new repeater"
      },
      "*": {
        content: { 'application/json': { schema: ErrorSchema } },
        description: "Error description"
      }
    }
  }),
  async (c) => {
    const param = await c.req.valid('json')
    // @ts-ignore
    const user = c.get('authUser') as string | undefined
    const r = user
      ? await db.addRepeaterWithLog(c.env.RepsDB, user, param)
      : await db.addRepeater(c.env.RepsDB, param)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 201) as any
  }
)

// Alias route to support POST /v1 without trailing slash
api.openapi(
  createRoute({
    method: 'post',
    path: '',
    request: {
      body: { content: { 'application/json': { schema: RepeaterSchema } }, required: true },
    },
    responses: {
      201: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: 'Create new repeater (alias)'
      },
      '*': {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Error description'
      }
    }
  }),
  async (c) => {
    const param = await c.req.valid('json')
    // @ts-ignore
    const user = c.get('authUser') as string | undefined
    const r = user
      ? await db.addRepeaterWithLog(c.env.RepsDB, user, param)
      : await db.addRepeater(c.env.RepsDB, param)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 201) as any
  }
)

// update repeater
api.openapi(
  createRoute({
    method: 'put',
    path: '/{callsign}',
    request: {
      params: RepeaterRequestSchema,
      body: { content: { 'application/json': { schema: z.object({}) } }, required: true },
    },
    responses: {
      202: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Update repeater"
      },
      "*": {
        content: { 'application/json': { schema: ErrorSchema } },
        description: "Error description"
      }
    }
  }),
  async (c) => {
    const { callsign } = c.req.valid('param')
    // const data = await c.req.valid('json')
    let data;
    try {
      data = await c.req.json()
    } catch (e) {
      return c.json({ failure: true, errors: { "JSON": "Cannot parse JSON data" }, code: 422 }, 422) as any
    }
    // @ts-ignore
    const user = c.get('authUser') as string | undefined
    const r = user
      ? await db.updateRepeaterWithLog(c.env.RepsDB, user, callsign, data as Repeater)
      : await db.updateRepeater(c.env.RepsDB, callsign, data as Repeater)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 202) as any
  }
)

api.openapi(
  createRoute({
    method: 'delete',
    path: '/{callsign}',
    request: { params: RepeaterRequestSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Delete repeater object"
      },
      "*": {
        content: { 'application/json': { schema: ErrorSchema } },
        description: "Error description"
      }
    }
  }),
  async (c) => {
    const { callsign } = c.req.valid('param')
    // @ts-ignore
    const user = c.get('authUser') as string | undefined
    const r = user
      ? await db.deleteRepeaterWithLog(c.env.RepsDB, user, callsign)
      : await db.deleteRepeater(c.env.RepsDB, callsign)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422) as any
    return c.json(r, 200) as any
  }
)


function formatZodErrors(error: z.ZodError) {
  return error.errors.reduce((acc, err) => {
    const field = err.path.join(".");
    acc[field] = err.message;
    return acc;
  }, {} as Record<string, string>);
}



type NestedObject = { [key: string]: any };

function convertDotNotationToNestedObject(obj: { [key: string]: any }): NestedObject {
  const result: NestedObject = {};

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      // Preserve certain keys as-is (do not split by underscore)
      if (key === 'include_disabled') {
        result[key] = obj[key];
        continue;
      }
      const keys = key.split('_');
      let currentLevel = result;

      for (let i = 0; i < keys.length; i++) {
        const nestedKey = keys[i];

        // If this is the last key, assign the value
        if (i === keys.length - 1) {
          currentLevel[nestedKey] = obj[key];
        } else {
          // Otherwise, create a new nested object if it doesn't exist
          if (!currentLevel[nestedKey]) {
            currentLevel[nestedKey] = {};
          }
          currentLevel = currentLevel[nestedKey];
        }
      }
    }
  }

  return result;
}

type BearerAuthSuccess = { ok: true; username: string; newToken?: string }
type BearerAuthFailure = { ok: false; status: ContentfulStatusCode; error: ErrorJSON }
type BearerAuthResult = BearerAuthSuccess | BearerAuthFailure

const ensureBearerAuth = async (c: Context<{ Bindings: CloudflareBindings }>): Promise<BearerAuthResult> => {
  const authHeader = c.req.header('Authorization') || ''
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return authError(401, 'Bearer token required.')
  const token = match[1].trim()
  if (!token.length) return authError(401, 'Bearer token missing.')

  let claims: SessionClaims
  try {
    claims = await verifySessionToken(c.env, token)
  } catch (_) {
    return authError(401, 'Invalid token.')
  }

  const now = Date.now()
  if (claims.exp && claims.exp < now) return authError(401, 'Session expired.')
  if (claims.idle_expires && claims.idle_expires < now) return authError(401, 'Session expired due to inactivity.')

  const userRecord = await db.getUser(c.env.RepsDB, claims.username)
  if (!(userRecord as any).username) return authError(401, 'User not found.')
  if ((userRecord as any).enabled === 0) return authError(403, 'User disabled.')

  const currentVersion = (userRecord as any).token_version || 1
  if (currentVersion !== claims.token_version) return authError(401, 'Session revoked.')

  const ua = c.req.header('User-Agent') || ''
  let requestUaHash: string | undefined
  if (claims.ua) {
    if (!ua) return authError(401, 'User agent mismatch.')
    requestUaHash = await db.sha256Hex(ua)
    if (requestUaHash !== claims.ua) return authError(401, 'User agent mismatch.')
  }

  const deviceId = getRequestDeviceId(c)
  if (claims.device && deviceId && claims.device !== deviceId) return authError(401, 'Device mismatch.')

  if (!requestUaHash && ua) requestUaHash = await db.sha256Hex(ua)

  const refreshWindow = computeIdleRefreshWindow(c.env)
  const shouldRefresh = refreshWindow > 0 && (claims.idle_expires - now) <= refreshWindow
  const newToken = shouldRefresh
    ? await createSessionToken(c.env, {
      username: claims.username,
      tokenVersion: currentVersion,
      uaHash: claims.ua ?? requestUaHash,
      deviceId: claims.device ?? deviceId,
      now,
    })
    : undefined

  return { ok: true, username: claims.username, newToken }
}

const authError = (status: ContentfulStatusCode, message: string): BearerAuthFailure => ({
  ok: false,
  status: status as ContentfulStatusCode,
  error: { failure: true, errors: { AUTH: message }, code: status },
})

const getRequestDeviceId = (c: Context<{ Bindings: CloudflareBindings }>): string | undefined => {
  const headerDevice = c.req.header('X-Device-Id') || c.req.header('X-Device-ID') || ''
  const trimmed = headerDevice.trim()
  return trimmed.length ? trimmed : undefined
}

const computeIdleRefreshWindow = (env: CloudflareBindings): number => {
  const idleMs = getIdleDurationMs(env)
  if (idleMs <= 0) return 0
  const window = Math.floor(idleMs / 4)
  const maxWindow = 15 * 60 * 1000
  return Math.max(60_000, Math.min(window, maxWindow))
}

const getIdleDurationMs = (env: CloudflareBindings): number => {
  const parsed = Number((env as any).BGREPS_JWT_IDLE_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_IDLE_DEFAULT_MS
}

const isSecureRequest = (url: URL, hostHeader?: string | null): boolean => {
  if (url.protocol === 'https:') return true
  const headerHost = hostHeader?.split(':')[0]?.replace(/\[|\]/g, '').toLowerCase()
  const candidateHosts = [headerHost, url.hostname?.toLowerCase()].filter(Boolean) as string[]
  return candidateHosts.some(isTrustedLocalHost)
}

const isTrustedLocalHost = (hostname: string): boolean => {
  if (hostname === 'localhost' || hostname === 'localhost.') return true
  if (hostname === '0.0.0.0') return true
  if (hostname === '::1' || hostname === '::ffff:127.0.0.1') return true
  if (hostname === '[::1]') return true
  if (/^127\./.test(hostname)) return true
  if (/^10\./.test(hostname)) return true
  if (/^192\.168\./.test(hostname)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true
  return false
}

const shouldEnforceHttps = (env: CloudflareBindings): boolean => {
  const flag = String((env as any).BGREPS_REQUIRE_HTTPS ?? 'true').toLowerCase().trim()
  return !(flag === '0' || flag === 'false' || flag === 'no' || flag === 'off')
}

const decodeBasicUsername = (authHeader: string | null): string | null => {
  if (!authHeader) return null
  const base64 = authHeader.replace(/^Basic\s+/i, '')
  try {
    const decoded = atob(base64)
    return decoded.split(':')[0] || null
  } catch {
    return null
  }
}

export { api }