/**
 * Text from outside (prompts, commands, names) drawn into a fixed grid of rows and columns. Clicks map by the grid,
 * so every drawn character must take the cells counted for it: a line break, or a character the terminal draws wider
 * or narrower than counted, moves everything after it. There is no width measure in the host, so a character is
 * drawn only when its width is certain: narrow scripts and symbols count one cell, CJK, Hangul and fullwidth forms
 * two; anything else (emoji, combining marks, zero-width and direction marks, other scripts) is drawn as `?`.
 */

const NARROW: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa1, 0xac],
  [0xae, 0x2ff],
  [0x370, 0x482],
  [0x48a, 0x52f],
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x20a0, 0x20c0],
  [0x2190, 0x21ff],
  [0x2500, 0x25fc],
]

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

function within(ranges: readonly (readonly [number, number])[], code: number): boolean {
  return ranges.some(([low, high]) => code >= low && code <= high)
}

/** The text with every character it can draw at a known width: a line break as `⏎`, a tab as a space, the rest `?`. */
export function displayed(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (char === '\n') out += '⏎'
    else if (char === '\r') continue
    else if (char === '\t') out += ' '
    // Some combining marks sit inside the wide ranges (U+3099 voices kana); they join the character before them.
    else if (/\p{M}/u.test(char)) out += '?'
    else out += within(NARROW, code) || within(WIDE, code) ? char : '?'
  }
  return out
}

/** The cells a displayed text takes. */
export function cells(text: string): number {
  let count = 0
  for (const char of text) count += within(WIDE, char.codePointAt(0)!) ? 2 : 1
  return count
}

/** A displayed text cut to `width` cells, its last one `…` when cut. */
export function clip(text: string, width: number): string {
  if (cells(text) <= width) return text
  let out = ''
  for (const char of text) {
    if (cells(out + char) > width - 1) break
    out += char
  }
  return out + '…'
}

/** A displayed text filled out with spaces to `width` cells. */
export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cells(text)))
}

/** A displayed text cut into rows of at most `width` cells; a wide character never straddles two rows. */
export function rowsOf(text: string, width: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const char of text) {
    if (cells(row + char) > width) {
      rows.push(row)
      row = ''
    }
    row += char
  }
  if (row !== '' || rows.length === 0) rows.push(row)
  return rows
}
