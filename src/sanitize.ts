// Lightweight HTML sanitizer for repeater info fields.
// We avoid heavy dependencies to keep the Worker bundle small.
// Strategy:
// 1. Remove <script> and <style> blocks entirely.
// 2. Strip event handler attributes (on*) and javascript:/data: URIs in href/src.
// 3. Allow only a safe tag whitelist; encode angle brackets for others.
// 4. Preserve basic formatting tags and links.

const TAG_WHITELIST = new Set([
  'p','br','b','i','em','strong','u','small','sub','sup','code','pre','blockquote','ul','ol','li','a','span','img'
])

// Encode a string minimally (only angle brackets & ampersand) to neuter HTML.
const encode = (s: string): string => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const encodeAttr = (s: string): string => encode(s)
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

const unquoteAttr = (raw: string): string => {
  const v = String(raw || '').trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

const isSafeUrl = (value: string): boolean => {
  const v = String(value || '').trim()
  if (!v) return false
  if (/^(?:javascript|data|vbscript|file):/i.test(v)) return false
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    // Allow relative references: img/a.jpg, ./img/a.jpg, ../img/a.jpg, /img/a.jpg
    return /^(?:\/|\.{1,2}\/)?[^\s]+$/.test(v)
  }
}

export const sanitizeHtml = (input?: string | null): string | undefined => {
  if (input == null) return undefined
  let html = String(input)
  if (!html) return ''

  // Remove script/style blocks (greedy across lines)
  html = html.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')

  // Remove event handler attributes: onClick="..." etc.
  html = html.replace(/\s(on[a-zA-Z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, '')

  // Neutralize javascript: and data: URIs in href/src attributes.
  html = html.replace(/(href|src)\s*=\s*("|')(javascript:[^"']*|data:[^"']*)("|')/gi, '$1="#"')

  // Process tags: allow only whitelist; encode others completely.
  html = html.replace(/<\/?\s*([a-z0-9]+)([^>]*)>/gi, (full, tag: string, rest: string) => {
    tag = tag.toLowerCase()
    if (!TAG_WHITELIST.has(tag)) {
      return encode(full) // disallowed tag encoded entirely
    }
    // Remove any remaining potentially dangerous attributes (style, srcset, arbitrary JS protocols)
    let safeRest = rest
      // remove style attribute
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // remove srcset attribute
      .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // remove potentially dangerous iframe-related attributes
      .replace(/\ssandbox\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Clean href/src again for JS or data URIs (nested case)
    safeRest = safeRest.replace(/(href|src)\s*=\s*("|')(javascript:[^"']*|data:[^"']*)("|')/gi, '$1="#"')

    // For img tags, allow only a minimal safe attribute subset.
    if (tag === 'img') {
      const kept: string[] = []
      const attrRe = /\s([a-zA-Z_:][a-zA-Z0-9_:\-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g
      let m: RegExpExecArray | null
      while ((m = attrRe.exec(safeRest)) !== null) {
        const key = m[1].toLowerCase()
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

// Sanitize an array of info lines, returning a new array.
export const sanitizeInfoArray = (arr?: string[] | null): string[] | undefined => {
  if (!arr) return undefined
  return arr.map(s => sanitizeHtml(s) || '')
}

// Sanitize digital nested info fields in-place (copy object for purity).
export const sanitizeRepeater = <T extends { info?: string[]; modes?: any }>(rep: T): T => {
  const clone: any = { ...rep }
  if (clone.info) clone.info = sanitizeInfoArray(clone.info)
  // Sanitize possible string fields within modes' digital children
  if (clone.modes) {
    const m = { ...clone.modes }
    if (m.dstar) m.dstar = sanitizeDigitalSub(m.dstar)
    if (m.fusion) m.fusion = sanitizeDigitalSub(m.fusion)
    if (m.dmr) m.dmr = sanitizeDigitalSub(m.dmr)
    if (m.nxdn) m.nxdn = sanitizeDigitalSub(m.nxdn)
    clone.modes = m
  }
  return clone
}

function sanitizeDigitalSub(sub: any): any {
  const c: any = { ...sub }
  for (const k of Object.keys(c)) {
    if (typeof c[k] === 'string') c[k] = sanitizeHtml(c[k])
  }
  return c
}
