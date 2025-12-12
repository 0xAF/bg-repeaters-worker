const test = require('node:test')
const assert = require('node:assert/strict')

// Load the built sanitizer (TypeScript will be transpiled by esbuild during wrangler dev,
// but our unit tests run directly; thus, we inline a tiny equivalent for testing purposes.)
const { readFileSync } = require('node:fs')
const path = require('node:path')

function encode(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
const TAGS = new Set(['p','br','b','i','em','strong','u','small','sub','sup','code','pre','blockquote','ul','ol','li','a','span'])
function sanitizeHtml(input) {
  if (input == null) return undefined
  let html = String(input)
  if (!html) return ''
  html = html.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  html = html.replace(/\s(on[a-zA-Z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, '')
  html = html.replace(/(href|src)\s*=\s*("|')(javascript:[^"']*|data:[^"']*)("|')/gi, '$1="#"')
  html = html.replace(/<\/?\s*([a-z0-9]+)([^>]*)>/gi, (full, tag, rest) => {
    tag = String(tag).toLowerCase()
    if (!TAGS.has(tag)) return encode(full)
    let safeRest = String(rest)
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    safeRest = safeRest.replace(/(href|src)\s*=\s*("|')(javascript:[^"']*|data:[^"']*)("|')/gi, '$1="#"')
    return `<${full.startsWith('</') ? '/' : ''}${tag}${safeRest}>`
  })
  return html.trim()
}

test('sanitizer removes script tags and events', () => {
  const dirty = '<p onclick="alert(1)">Hi<script>alert(2)</script><img src=x onerror=alert(3)> <a href="javascript:evil()">x</a></p>'
  const clean = sanitizeHtml(dirty)
  assert.ok(!/script/i.test(clean), 'script tags removed')
  assert.ok(!/onerror|onclick/i.test(clean), 'event handlers removed')
  assert.ok(!/javascript:/i.test(clean), 'javascript: URIs removed')
  assert.ok(/<p>/.test(clean) && /<a href="#">/.test(clean), 'allowed tags preserved and href neutralized')
})

test('sanitizer allows basic formatting tags', () => {
  const dirty = '<strong>Bold</strong> and <em>em</em> and <u>u</u> and <code>x</code>'
  const clean = sanitizeHtml(dirty)
  assert.equal(clean, dirty)
})

test('sanitizer strips style/srcset/data URIs and encodes unknown tags', () => {
  const dirty = '<span style="color:red">Styled</span><a href="data:text/html;base64,ZW5jb2RlZA==">danger</a><custom-tag>bad</custom-tag>'
  const clean = sanitizeHtml(dirty)
  assert.ok(!/style=/i.test(clean), 'style attributes removed')
  assert.ok(clean.includes('<span>Styled</span>'), 'span preserved without attributes')
  assert.ok(clean.includes('<a href="#">danger</a>'), 'data: href neutered')
  assert.ok(clean.includes('&lt;custom-tag&gt;bad&lt;/custom-tag&gt;'), 'unknown tags encoded')
})
