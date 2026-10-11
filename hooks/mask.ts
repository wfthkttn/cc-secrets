const MASK = '[secret]'
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v'])
const UNRESERVED = /^[A-Za-z0-9_.~-]$/

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Python's `urllib.parse.quote` over UTF-8: unreserved and `safe` kept, the rest `%XX`; `plus` writes a space as `+`. */
function percent(bytes: Uint8Array, safe: string, plus: boolean): string {
  let out = ''
  for (const b of bytes) {
    const ch = String.fromCharCode(b)
    if (plus && b === 0x20) out += '+'
    else if (b < 0x80 && (UNRESERVED.test(ch) || safe.includes(ch))) out += ch
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** The ways `value` turns up in output: raw, escaped, percent-, hex- and base64-encoded; `bin/mask-run` makes the same. */
export function forms(value: string): Set<string> {
  const bytes = new TextEncoder().encode(value)
  const json = JSON.stringify(value).slice(1, -1)
  const found = new Set<string>([
    value,
    json,
    json.replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
    value.split("'").join("'\\''"),
    value.split("'").join(`'"'"'`),
    hex(bytes),
    hex(bytes).toUpperCase(),
  ])
  for (const encoded of [percent(bytes, '', false), percent(bytes, "!~*'()", false), percent(bytes, '', true)]) {
    found.add(encoded)
    found.add(encoded.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()))
  }
  for (let offset = 0; offset < 3; offset++) {
    // The characters fully determined by the value's bits, wherever it sits in the encoded run.
    const padded = [...new Uint8Array(offset), ...bytes, 0, 0, 0]
    const encoded = btoa(String.fromCharCode(...padded)).slice(Math.ceil((8 * offset) / 6), Math.floor((8 * (offset + bytes.length)) / 6))
    found.add(encoded)
    found.add(encoded.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  found.delete('')
  return found
}

export class Masker {
  private patterns = new Set<string>()

  add(value: string) {
    for (const form of forms(value)) this.patterns.add(form)
  }

  /** Each whitespace-delimited token holding a form becomes `[secret]`. */
  mask(text: string): string {
    const spans: [number, number][] = []
    for (const pattern of this.patterns) {
      for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) {
        let start = at
        let end = at + pattern.length
        while (start > 0 && !WHITESPACE.has(text[start - 1]!)) start--
        while (end < text.length && !WHITESPACE.has(text[end]!)) end++
        spans.push([start, end])
      }
    }
    spans.sort((a, b) => a[0] - b[0])
    let out = ''
    let at = 0
    for (const [start, end] of spans) {
      if (end <= at) continue
      if (start >= at) out += text.slice(at, start) + MASK
      at = end
    }
    return out + text.slice(at)
  }
}

const masker = new Masker()
let isRemembering = false

/** A value shorter than `minLength` characters is left unmasked: it would turn up in ordinary text. */
export function remember(value: string, minLength: number) {
  if ([...value].length < minLength) return
  masker.add(value)
  isRemembering = true
}

export function mask(text: string): string {
  return masker.mask(text)
}

/** A value is masked this session, so `[secret]` in content may be a masked read (by the hooks or mask-run). */
export function masksValues(): boolean {
  return isRemembering
}

export function holdsMask(text: string): boolean {
  return text.includes(MASK)
}

/** Every string inside `value` masked, the shape kept. */
export function maskStrings<T>(value: T): T {
  if (typeof value === 'string') return mask(value) as T
  if (Array.isArray(value)) return value.map(maskStrings) as T
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v)])) as T
}
