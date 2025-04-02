import { z } from '@hono/zod-openapi'
import { createRoute } from '@hono/zod-openapi'
import { OpenAPIHono } from '@hono/zod-openapi'
import { RepeaterRequestSchema, RepeaterSchema, RepeaterQuerySchema } from './api/RepeaterSchema'
import { ErrorSchema } from './api/ErrorSchema'
import { basicAuth } from 'hono/basic-auth'
import * as db from "./db"
import { ContentfulStatusCode } from 'hono/utils/http-status'

type Repeater = z.infer<typeof RepeaterSchema>;
type ErrorJSON = z.infer<typeof ErrorSchema>;


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

api.use('/*', async (c, next) => {
  if (c.req.method !== 'GET') {
    const auth = basicAuth({ username: 'admin', password: c.env.ADMIN_PW })
    return auth(c, next)
  } else {
    await next()
  }
})




api.openapi(
  createRoute({
    method: 'get',
    path: '/{callsign}',
    request: { params: RepeaterRequestSchema },
    responses: {
      200: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Retrieve repeater object"
      }
    }
  }),
  async (c) => {
    const { callsign } = c.req.valid('param')
    const r = await db.getRepeater(c.env.RepsDB, callsign)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422)
    return c.json(r, 200)
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
    // console.log(nestedData)
    const r = await db.getRepeaters(c.env.RepsDB, nestedData as Repeater)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422)
    return c.json(r, 200)
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
      200: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Create new repeater"
      }
    }
  }),
  async (c) => {
    const param = await c.req.valid('json')
    const r = await db.addRepeater(c.env.RepsDB, param)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422)
    return c.json(r, 201)
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
      200: {
        content: { 'application/json': { schema: RepeaterSchema } },
        description: "Update repeater"
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
      return c.json({ failure: true, errors: { "JSON": "Cannot parse JSON data" }, code: 422 }, 422)
    }
    const r = await db.updateRepeater(c.env.RepsDB, callsign, data as Repeater)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422)
    return c.json(r, 202)
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
      }
    }
  }),
  async (c) => {
    const { callsign } = c.req.valid('param')
    const r = await db.deleteRepeater(c.env.RepsDB, callsign)
    if ((r as ErrorJSON).failure)
      return c.json((r as ErrorJSON), (r as ErrorJSON).code as ContentfulStatusCode || 422)
    return c.json(r, 200)
  }
)





export { api }

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