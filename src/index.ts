import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { basicAuth } from 'hono/basic-auth'
import { etag } from 'hono/etag'
import { poweredBy } from 'hono/powered-by'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { HTTPException } from "hono/http-exception"
import { swaggerUI } from '@hono/swagger-ui'
// import { swaggerEditor } from '@hono/swagger-editor'
import { html, raw } from 'hono/html'

import { api } from './api'
import * as db from './db'
// import { admin } from './api-admin'


const app = new Hono<{ Bindings: CloudflareBindings }>()

// CORS for API routes
app.use('/v1/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['X-Response-Time'],
  maxAge: 86400,
}))
app.route('/', api) // api will add its basePath (/api/v1)
// Explicit handler for trailing-slash variant of the list endpoint to avoid 404s on '/v1/'
app.get('/v1/', async (c) => {
  const r = await db.getRepeaters(c.env.RepsDB, {} as any)
  const err = r as any
  if (err && err.failure) return c.json(err, err.code || 422)
  return c.json(r, 200)
})

// app.use('/admin/*', basicAuth({
//   verifyUser: (u, p, c) => { return (u === "admin" && p === c.env.ADMIN_PW) }
// }))
// app.get('/admin/*', (c) => c.text('You are authorized'))
// app.route('/', admin) // api will add its basePath (/admin)


// Use the middleware to serve Swagger UI at /ui
app.get('/ui', swaggerUI({ url: '/v1/doc' }))
// app.get('/editor', swaggerEditor({ url: '/api/v1/doc' }))



app.get("/public/*", async (ctx) => {
  return await ctx.env.ASSETS.fetch(ctx.req.raw);
});


// Mount Builtin Middleware
app.use('*', poweredBy())
// app.use('*', logger())

// Add X-Response-Time header
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  c.header('X-Response-Time', `${ms}ms`)
})



// Add Custom Header
app.use('/hello/*', async (c, next) => {
  await next()
  c.header('X-message', 'This is addHeader middleware!')
})
// Use Response object directly
app.get('/hello', () => new Response('This is /hello'))



// Custom Not Found Message
app.notFound((c) => {
  return c.text('Custom 404 Not Found', 404)
})


// Error handling
// app.onError((err, c) => {
//   if (err instanceof HTTPException) {
//     return err.getResponse()
//   }
//   console.error(`${err}`)
//   return c.text('Custom Error Message', 500)
// })



// Routing
app.get('/', (c) => {
  return c.html(
    html`<html>
<head>
  <title>BG Repeaters API</title>
</head>
<body>
  <h1>BG Repeaters API</h1>
  <p>API for Bulgarian Repeaters Database</p>
  <h2>Endpoints</h2>
  <ul>
    <li><a href="/ui">API documentation and testing</a></li>
  </ul>

  <footer>
    <p>Contacts:</p>
    <ul>
      <li>Email: af@0xAF.org</li>
      <li>CallSign: LZ2SLL</li>
    </ul>
  </footer>
</body>
</html>`
  )
})


// Named parameter
app.get('/entry/:id', (c) => {
  const id = c.req.param('id')
  return c.text(`Your ID is ${id}`)
})



// Nested route
const book = new Hono()
book.get('/', (c) => c.text('List Books'))
book.get('/:id', (c) => {
  const id = c.req.param('id')
  return c.text('Get Book: ' + id)
})
book.post('/', (c) => c.text('Create Book'))
app.route('/book', book)



// Redirect
app.get('/redirect', (c) => c.redirect('/'))



app.use('/etag/*', etag())
// ETag
app.get('/etag/cached', (c) => c.text('Is this cached?'))



// Async
app.get('/fetch-url', async (c) => {
  const response = await fetch('https://0xAF.org/')
  return c.text(`https://0xAF.org/ is ${response.status}`)
})

// Request headers
app.get('/user-agent', (c) => {
  const userAgent = c.req.header('User-Agent')
  return c.text(`Your UserAgent is ${userAgent}`)
})



// JSON
app.get('/api/posts', prettyJSON(), (c) => {
  const posts = [
    { id: 1, title: 'Good Morning' },
    { id: 2, title: 'Good Afternoon' },
    { id: 3, title: 'Good Evening' },
    { id: 4, title: 'Good Night' }
  ]
  return c.json(posts)
})

// status code
app.post('/api/posts', (c) => c.json({ message: 'Created!' }, 201))

// default route
app.get('/api/*', (c) => c.text('API endpoint is not found', 404))

// Throw Error
// app.get('/error', () => {
//   throw Error('Error has occurred')
// })

// @ts-ignore
// app.get('/type-error', () => 'return not Response instance')

export default app
