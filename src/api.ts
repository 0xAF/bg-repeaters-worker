import { z } from '@hono/zod-openapi'
import { createRoute } from '@hono/zod-openapi'
import { OpenAPIHono } from '@hono/zod-openapi'
import { RepeaterRequestSchema, RepeaterSchema, RepeaterQuerySchema } from './api/RepeaterSchema'
import { ChangelogEntrySchema, ChangelogResponseSchema } from './api/ChangelogSchema'
import { UserCreateSchema, UserUpdateSchema, UserResponseSchema, UsersListSchema, UserRequestSchema } from './api/UserSchema'
import { RequestSubmissionSchema, RequestSubmissionResponseSchema, RequestListQuerySchema, RequestListResponseSchema, RequestRecordSchema, RequestIdParamSchema, RequestUpdateSchema } from './api/RequestSchema'
import { ErrorSchema } from './api/ErrorSchema'
import * as db from "./db"
import { createSessionToken, verifySessionToken, SESSION_IDLE_DEFAULT_MS, type SessionClaims } from './session'
import { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Context } from 'hono'

type Repeater = z.infer<typeof RepeaterSchema>;
type ErrorJSON = z.infer<typeof ErrorSchema>;
type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;
type ChangelogResponse = z.infer<typeof ChangelogResponseSchema>;
type RequestRecord = z.infer<typeof RequestRecordSchema>;
type RequestListResponse = z.infer<typeof RequestListResponseSchema>;

const repeaterSuggestionSchema = RepeaterSchema.partial();
const repeaterModeKeys: Array<keyof Repeater['modes']> = [
  'fm',
  'am',
  'usb',
  'lsb',
  'dmr',
  'dstar',
  'fusion',
  'nxdn',
  'parrot',
  'beacon',
];

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
api.use('/admin/requests', adminGuard)
api.use('/admin/requests/*', adminGuard)

const authOptionalPaths = new Set(['/admin/login', '/requests'])

// Require Bearer auth for all non-GET operations except the login endpoint
api.use('/*', async (c, next) => {
  if (c.req.method === 'GET') return await next()
  const path = new URL(c.req.url).pathname.replace(/^\/v1/, '')
  if (authOptionalPaths.has(path)) return await next()
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

// --- Guest Request Endpoints --- //
api.openapi(
  createRoute({
    method: 'post',
    path: '/requests',
    request: {
      body: { content: { 'application/json': { schema: RequestSubmissionSchema } }, required: true },
    },
    responses: {
      201: {
        content: { 'application/json': { schema: RequestSubmissionResponseSchema } },
        description: 'Submit a guest request',
      },
      '*': {
        content: { 'application/json': { schema: ErrorSchema } },
        description: 'Error description',
      }
    }
  }),
  async (c) => {
    const submission = await c.req.valid('json')
    const secret = (c.env as any).BGREPS_TURNSTILE_SECRET
    if (!secret) {
      return c.json({ failure: true, errors: { TURNSTILE: 'Turnstile secret is not configured.' }, code: 500 }, 500) as any
    }
    const clientIp = getClientIp(c)
    const verification = await verifyTurnstileToken(secret, submission.turnstileToken, clientIp)
    if (!verification.success) {
      console.warn('Turnstile verification failed', {
        ip: clientIp,
        errorCodes: verification.errorCodes,
      })
      return c.json({ failure: true, errors: { TURNSTILE: 'Turnstile verification failed.' }, code: 403 }, 403) as any
    }

    const contact = submission.contact.trim()
    const name = submission.name.trim()
    const contactHash = await db.sha256Hex(contact.toLowerCase())
    const windowMinutes = getRequestWindowMinutes(c.env)
    const limit = getRequestLimit(c.env)

    const pruneResult = await db.pruneRequestRateLimitHits(c.env.RepsDB, windowMinutes)
    if (pruneResult && (pruneResult as ErrorJSON).failure) {
      const status = ((pruneResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(pruneResult, status) as any
    }

    const countsResult = await db.countRequestRateLimitHits(c.env.RepsDB, { contactHash, ip: clientIp }, windowMinutes)
    if ((countsResult as ErrorJSON).failure) {
      const status = ((countsResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(countsResult, status) as any
    }
    const counts = countsResult as { byContact: number; byIp: number }

    if (counts.byContact >= limit || (clientIp && counts.byIp >= limit)) {
      return c.json({ failure: true, errors: { RATELIMIT: `Too many requests within ${windowMinutes} minutes.` }, code: 429 }, 429) as any
    }

    const payloadData: Record<string, unknown> = {}
    if (submission.message !== undefined) payloadData.message = submission.message
    if (submission.repeater) payloadData.repeater = submission.repeater
    const payloadValue = Object.keys(payloadData).length ? payloadData : undefined

    const insertResult = await db.insertGuestRequest(c.env.RepsDB, {
      name,
      contact,
      contactHash,
      payload: payloadValue,
      status: 'pending',
      ip: clientIp,
      userAgent: c.req.header('User-Agent') || null,
      cfRay: c.req.header('CF-Ray') || null,
      cfCountry: c.req.header('CF-IPCountry') || null,
    })
    if ((insertResult as ErrorJSON).failure) {
      const status = ((insertResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(insertResult, status) as any
    }
    const inserted = insertResult as RequestRecord

    const logResult = await db.recordRequestRateLimitHit(c.env.RepsDB, { contactHash, ip: clientIp })
    if (logResult && (logResult as ErrorJSON).failure) {
      const status = ((logResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(logResult, status) as any
    }

    const usedByContact = counts.byContact + 1
    const usedByIp = clientIp ? counts.byIp + 1 : 0
    const used = clientIp ? Math.max(usedByContact, usedByIp) : usedByContact
    const remaining = Math.max(0, limit - used)

    return c.json({
      id: inserted.id,
      status: inserted.status,
      rateLimit: { limit, remaining, windowMinutes },
    }, 201) as any
  }
)

api.openapi(
  createRoute({
    method: 'get',
    path: '/admin/requests',
    request: { query: RequestListQuerySchema },
    responses: {
      200: { content: { 'application/json': { schema: RequestListResponseSchema } }, description: 'List guest requests' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' },
    }
  }),
  async (c) => {
    const query = c.req.valid('query')
    const listResult = await db.listGuestRequests(c.env.RepsDB, query)
    if ((listResult as ErrorJSON).failure) {
      const status = ((listResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(listResult, status) as any
    }
    const list = listResult as RequestListResponse
    return c.json({ requests: list.requests, nextCursor: list.nextCursor }, 200) as any
  }
)

api.openapi(
  createRoute({
    method: 'get',
    path: '/admin/requests/{id}',
    request: { params: RequestIdParamSchema },
    responses: {
      200: { content: { 'application/json': { schema: RequestRecordSchema } }, description: 'Get a guest request' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' },
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const result = await db.getGuestRequest(c.env.RepsDB, id)
    if ((result as ErrorJSON).failure) {
      const status = ((result as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(result, status) as any
    }
    return c.json(result, 200) as any
  }
)

api.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/requests/{id}',
    request: {
      params: RequestIdParamSchema,
      body: { content: { 'application/json': { schema: RequestUpdateSchema } }, required: true },
    },
    responses: {
      200: { content: { 'application/json': { schema: RequestRecordSchema } }, description: 'Update a guest request' },
      '*': { content: { 'application/json': { schema: ErrorSchema } }, description: 'Error description' },
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param')
    const body = await c.req.valid('json')
    // @ts-ignore
    const adminUser = c.get('authUser') as string | undefined
    const existingResult = await db.getGuestRequest(c.env.RepsDB, id)
    if ((existingResult as ErrorJSON).failure) {
      const status = ((existingResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(existingResult, status) as any
    }
    const requestRecord = existingResult as RequestRecord
    let nextStatus = body.status
    if (body.status === 'approved') {
      const applyResult = await applyRepeaterSuggestionFromRequest(c.env, requestRecord, adminUser)
      if ((applyResult as ErrorJSON).failure) {
        const status = ((applyResult as ErrorJSON).code || 422) as ContentfulStatusCode
        return c.json(applyResult, status) as any
      }
      nextStatus = 'approved'
    }
    const updatePayload: { status?: RequestRecord['status']; adminNotes?: string; resolvedBy?: string | null } = {
      adminNotes: body.adminNotes,
      resolvedBy: adminUser ?? null,
    }
    if (nextStatus) updatePayload.status = nextStatus
    const updateResult = await db.updateGuestRequest(c.env.RepsDB, id, updatePayload)
    if ((updateResult as ErrorJSON).failure) {
      const status = ((updateResult as ErrorJSON).code || 422) as ContentfulStatusCode
      return c.json(updateResult, status) as any
    }
    return c.json(updateResult, 200) as any
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

type ApplyRepeaterResult = { action: 'created' | 'updated'; repeater: Repeater }

async function applyRepeaterSuggestionFromRequest(
  env: CloudflareBindings,
  request: RequestRecord,
  adminUser?: string,
): Promise<ApplyRepeaterResult | ErrorJSON> {
  if (request.status !== 'pending') {
    return { failure: true, errors: { STATUS: 'Only pending requests can be approved.' }, code: 409 }
  }
  const rawSuggestion = request.payload?.repeater
  if (!rawSuggestion || typeof rawSuggestion !== 'object') {
    return { failure: true, errors: { REPEATER: 'This request does not include repeater details to apply.' }, code: 422 }
  }
  const parsed = repeaterSuggestionSchema.safeParse(rawSuggestion)
  if (!parsed.success) {
    return { failure: true, errors: formatZodErrors(parsed.error), code: 422 }
  }
  const suggestion = parsed.data
  const callsign = typeof suggestion.callsign === 'string' ? suggestion.callsign.trim().toUpperCase() : undefined
  if (!callsign) {
    return { failure: true, errors: { CALLSIGN: 'Repeater suggestion must include a callsign.' }, code: 422 }
  }
  suggestion.callsign = callsign
  const normalizedUser = adminUser?.trim().toUpperCase() || 'SYSTEM'
  const existing = await db.getRepeater(env.RepsDB, callsign)
  if ((existing as ErrorJSON).failure && (existing as ErrorJSON).code !== 404) {
    return existing as ErrorJSON
  }
  if ((existing as ErrorJSON).failure) {
    const prepared = prepareNewRepeaterFromSuggestion(suggestion)
    const validated = RepeaterSchema.safeParse(prepared)
    if (!validated.success) {
      return { failure: true, errors: formatZodErrors(validated.error), code: 422 }
    }
    const created = await db.addRepeaterWithLog(env.RepsDB, normalizedUser, validated.data)
    if ((created as ErrorJSON).failure) return created as ErrorJSON
    return { action: 'created', repeater: created as Repeater }
  }
  const merged = mergeRepeaterRecords(existing as Repeater, suggestion)
  const validated = RepeaterSchema.safeParse(merged)
  if (!validated.success) {
    return { failure: true, errors: formatZodErrors(validated.error), code: 422 }
  }
  const updated = await db.updateRepeaterWithLog(env.RepsDB, normalizedUser, callsign, validated.data)
  if ((updated as ErrorJSON).failure) return updated as ErrorJSON
  return { action: 'updated', repeater: updated as Repeater }
}

function prepareNewRepeaterFromSuggestion(suggestion: Partial<Repeater>): Repeater {
  const prepared: Repeater = { ...suggestion } as Repeater
  prepared.modes = mergeRepeaterModes(undefined, suggestion.modes)
  prepared.freq = mergeRepeaterFreq(undefined, suggestion.freq)
  const mergedInternet = mergeRepeaterInternet(undefined, suggestion.internet)
  if (mergedInternet) prepared.internet = mergedInternet
  else delete (prepared as any).internet
  if ('info' in suggestion) {
    prepared.info = Array.isArray(suggestion.info) ? [...suggestion.info] : undefined
  }
  return prepared
}

function mergeRepeaterRecords(base: Repeater, patch: Partial<Repeater>): Repeater {
  const merged: Repeater = { ...base, ...patch } as Repeater
  merged.modes = mergeRepeaterModes(base.modes, patch.modes)
  merged.freq = mergeRepeaterFreq(base.freq, patch.freq)
  const mergedInternet = mergeRepeaterInternet(base.internet, patch.internet)
  if (mergedInternet) merged.internet = mergedInternet
  else delete (merged as any).internet
  if ('info' in patch) {
    merged.info = Array.isArray(patch.info) ? [...patch.info] : undefined
  }
  return merged
}

function mergeRepeaterModes(
  base?: Repeater['modes'],
  patch?: Repeater['modes'],
): Repeater['modes'] {
  const seed = base ?? createEmptyModeState()
  const result: Partial<Repeater['modes']> = {}
  for (const key of repeaterModeKeys) {
    const baseEntry = seed[key] ? { ...seed[key] } : {}
    const patchEntry = patch?.[key]
    result[key] = patchEntry ? { ...baseEntry, ...patchEntry } : baseEntry
  }
  return result as Repeater['modes']
}

function createEmptyModeState(): Repeater['modes'] {
  const state: Partial<Repeater['modes']> = {}
  for (const key of repeaterModeKeys) {
    state[key] = { enabled: false } as any
  }
  return state as Repeater['modes']
}

function mergeRepeaterFreq(
  base?: Repeater['freq'],
  patch?: Partial<Repeater['freq']>,
): Repeater['freq'] {
  const result: Repeater['freq'] = base ? { ...base } : { rx: 0, tx: 0 }
  if (patch) {
    if ('rx' in patch && patch.rx !== undefined) result.rx = patch.rx
    if ('tx' in patch && patch.tx !== undefined) result.tx = patch.tx
    if ('tone' in patch) result.tone = patch.tone
    if ('channel' in patch) result.channel = patch.channel
  }
  return result
}

function mergeRepeaterInternet(
  base?: Repeater['internet'],
  patch?: Repeater['internet'],
): Repeater['internet'] | undefined {
  if (!base && !patch) return undefined
  const result: Record<string, unknown> = { ...(base ?? {}) }
  if (patch) {
    for (const key of Object.keys(patch)) {
      const value = (patch as any)[key]
      if (value === undefined) delete result[key]
      else result[key] = value
    }
  }
  return Object.keys(result).length ? (result as Repeater['internet']) : undefined
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

const getClientIp = (c: Context<{ Bindings: CloudflareBindings }>): string | undefined => {
  const cfIp = c.req.header('CF-Connecting-IP') || ''
  if (cfIp.trim().length) return cfIp.trim()
  const forwarded = c.req.header('X-Forwarded-For') || ''
  if (forwarded.trim().length) return forwarded.split(',')[0]?.trim() || undefined
  return undefined
}

const DEFAULT_REQUEST_LIMIT = 5
const MAX_REQUEST_LIMIT = 100
const DEFAULT_REQUEST_WINDOW_MINUTES = 24 * 60
const MAX_REQUEST_WINDOW_MINUTES = 7 * 24 * 60

const getRequestLimit = (env: CloudflareBindings): number => {
  const raw = Number((env as any).BGREPS_REQUEST_LIMIT)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.min(MAX_REQUEST_LIMIT, Math.floor(raw)))
  }
  return DEFAULT_REQUEST_LIMIT
}

export const getRequestWindowMinutes = (env: CloudflareBindings): number => {
  const raw = Number((env as any).BGREPS_REQUEST_WINDOW_MINUTES)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(5, Math.min(MAX_REQUEST_WINDOW_MINUTES, Math.floor(raw)))
  }
  return DEFAULT_REQUEST_WINDOW_MINUTES
}

type TurnstileVerificationResult = { success: boolean; errorCodes?: string[] }

const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const verifyTurnstileToken = async (secret: string, token: string, remoteIp?: string): Promise<TurnstileVerificationResult> => {
  const form = new URLSearchParams()
  form.set('secret', secret)
  form.set('response', token)
  if (remoteIp) form.set('remoteip', remoteIp)
  try {
    const resp = await fetch(TURNSTILE_VERIFY_ENDPOINT, {
      method: 'POST',
      body: form,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    const data: any = await resp.json()
    const errorCodes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : undefined
    if (!resp.ok) {
      console.error('Turnstile verification HTTP error', { status: resp.status, errorCodes })
      return { success: false, errorCodes: errorCodes ?? ['http-error'] }
    }
    return { success: !!data?.success, errorCodes }
  } catch (err) {
    console.error('Turnstile verification error', err)
    return { success: false, errorCodes: ['verification-error'] }
  }
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