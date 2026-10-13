const MASK = '[secret]'

/** Masked text holds `[secret]`: written back, it would replace the real value. */
export function holdsMask(text: string): boolean {
  return text.includes(MASK)
}

/** Every string inside `value`, depth first. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(stringsIn)
}

/** `value` with its strings replaced, in `stringsIn`'s order, by `texts`; the shape kept. Throws when `texts` falls short. */
export function withStrings<T>(value: T, texts: readonly string[]): T {
  let at = 0
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const text = texts[at++]
      if (text === undefined) throw new Error(`secrets: ${at - 1} masked strings came back for more`)
      return text
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k, walk(inner)]))
  }
  return walk(value) as T
}
