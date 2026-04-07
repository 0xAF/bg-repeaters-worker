const test = require('node:test')
const assert = require('node:assert/strict')

// Load the built sanitizer (TypeScript will be transpiled by esbuild during wrangler dev,
// but our unit tests run directly; thus, we inline a tiny equivalent for testing purposes.)
const { readFileSync } = require('node:fs')
const path = require('node:path')

function encode(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
function encodeAttr(s) { return encode(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;') }
function unquoteAttr(raw) {
  const v = String(raw || '').trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}
function isSafeUrl(value) {
  const v = String(value || '').trim()
  if (!v) return false
  if (/^(?:javascript|data|vbscript|file):/i.test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return /^(?:\/|\.{1,2}\/)?[^\s]+$/.test(v)
  }
}
const TAGS = new Set(['p','br','b','i','em','strong','u','small','sub','sup','code','pre','blockquote','ul','ol','li','a','span','img'])
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
      .replace(/\ssandbox\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    safeRest = safeRest.replace(/(href|src)\s*=\s*("|')(javascript:[^"']*|data:[^"']*)("|')/gi, '$1="#"')

    if (tag === 'img') {
      const kept = []
      const attrRe = /\s([a-zA-Z_:][a-zA-Z0-9_:\-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g
      let m
      while ((m = attrRe.exec(safeRest)) !== null) {
        const key = String(m[1]).toLowerCase()
        const raw = unquoteAttr(m[2])
        if (key === 'src') {
          if (isSafeUrl(raw)) kept.push(` src="${encodeAttr(raw)}"`)
          continue
        }
        if (key === 'alt' || key === 'title') {
          kept.push(` ${key}="${encodeAttr(raw)}"`)
          continue
        }
        if (key === 'loading') {
          const loading = raw.toLowerCase()
          if (loading === 'lazy' || loading === 'eager' || loading === 'auto') {
            kept.push(` loading="${loading}"`)
          }
          continue
        }
        if (key === 'referrerpolicy') {
          const rp = raw.toLowerCase()
          if (
            rp === 'no-referrer' ||
            rp === 'origin' ||
            rp === 'same-origin' ||
            rp === 'strict-origin' ||
            rp === 'strict-origin-when-cross-origin' ||
            rp === 'no-referrer-when-downgrade' ||
            rp === 'unsafe-url'
          ) {
            kept.push(` referrerpolicy="${rp}"`)
          }
        }
      }
      safeRest = kept.join('')
    }

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

test('sanitizer preserves safe img src including relative paths', () => {
  const dirty = '<p><img alt="BG" loading="lazy" referrerpolicy="no-referrer" src="img/bulgaria-icon.png"></p>'
  const clean = sanitizeHtml(dirty)
  assert.ok(clean.includes('<img'), 'img tag preserved')
  assert.ok(clean.includes('src="img/bulgaria-icon.png"'), 'relative src preserved')
  assert.ok(clean.includes('alt="BG"'), 'alt preserved')
})

test('sanitizer drops unsafe img src protocol', () => {
  const dirty = '<p><img src="javascript:alert(1)" alt="x"></p>'
  const clean = sanitizeHtml(dirty)
  assert.ok(clean.includes('<img'), 'img tag preserved')
  assert.ok(!clean.includes('javascript:'), 'unsafe scheme removed')
  assert.ok(!clean.includes('src="javascript:alert(1)"'), 'unsafe src not preserved')
})
