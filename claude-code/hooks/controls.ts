import type { ClientElements, RenderElement } from 'claude-code'

import { cells, clip, pad } from './display'

/**
 * The views' controls. A line is a list of segments, each with its text, its look and the control a click on it
 * reaches (`hit`); drawing and hit-testing read the same segments, so a control reacts on exactly the cells it draws.
 */

export type Look = {
  color?: 'claude' | 'error' | 'success'
  bold?: boolean
  dimColor?: boolean
  backgroundColor?: string
  inverse?: boolean
  underline?: boolean
}
export type Seg = { text: string; look?: Look; hit?: string }
export type Line = Seg[]

export const FIELD_BACKGROUND = '#1f2a3a'
export const FOCUSED: Look = { color: 'claude', bold: true }
/** An option of a dropdown: what it sets, and what that means. */
export type Option = { label: string; what: string }
/** The options a dropdown's list shows at once; it scrolls past them. */
export const LIST_ROWS = 8

export function seg(text: string, look?: Look, hit?: string): Seg {
  return { text, ...(look === undefined ? {} : { look }), ...(hit === undefined ? {} : { hit }) }
}

export function lineWidth(line: Line): number {
  return line.reduce((sum, s) => sum + cells(s.text), 0)
}

/** The line exactly `columns` wide: cut, its last cell `…`, or filled out with blank cells that reach nothing. */
export function fit(line: Line, columns: number): Line {
  const out: Line = []
  let used = 0
  for (const s of line) {
    const room = columns - used
    if (room <= 0) break
    if (cells(s.text) <= room) {
      out.push(s)
      used += cells(s.text)
      continue
    }
    const cut = clip(s.text, room)
    out.push({ ...s, text: cut })
    used += cells(cut)
    break
  }
  if (used < columns) out.push(seg(' '.repeat(columns - used)))
  return out
}

/** The control under column `x`, or null. */
export function hitAt(line: Line | undefined, x: number): string | null {
  if (line === undefined) return null
  let start = 0
  for (const s of line) {
    const end = start + cells(s.text)
    if (x >= start && x < end) return s.hit ?? null
    start = end
  }
  return null
}

export function drawLine({ Box, Text }: Pick<ClientElements, 'Box' | 'Text'>, line: Line): RenderElement {
  return Box({ flexDirection: 'row', children: line.map(s => Text({ ...s.look, children: [s.text] })) })
}

/** A line of plain text: it reaches nothing. */
export function textLine(text: string, look?: Look): Line {
  return [seg(text, look)]
}

/** A section's heading. */
export function heading(text: string): Line {
  return [seg(' ' + text, { bold: true })]
}

export type ButtonSpec = { hit: string; label: string; tone?: 'danger' }

function edge(side: 'top' | 'bottom', width: number): string {
  const [left, right] = side === 'top' ? ['╭', '╮'] : ['╰', '╯']
  return left + '─'.repeat(width - 2) + right
}

/** Boxed buttons from column `lead`, a column apart: their top, label and bottom lines; every cell of a box presses it. */
export function buttonRows(buttons: readonly ButtonSpec[], focus: string | null, lead = 1): [Line, Line, Line] {
  const rows: [Line, Line, Line] = [[seg(' '.repeat(lead))], [seg(' '.repeat(lead))], [seg(' '.repeat(lead))]]
  buttons.forEach((b, i) => {
    if (i > 0) for (const row of rows) row.push(seg(' '))
    const width = cells(b.label) + 4
    const look: Look = { color: b.tone === 'danger' ? 'error' : 'claude', ...(b.hit === focus ? { bold: true } : {}) }
    rows[0].push(seg(edge('top', width), look, b.hit))
    rows[1].push(seg('│', look, b.hit), seg(` ${b.label} `, b.hit === focus ? { ...look, inverse: true } : look, b.hit), seg('│', look, b.hit))
    rows[2].push(seg(edge('bottom', width), look, b.hit))
  })
  return rows
}

/** `[x] label`: the box and its label toggle together. */
export function checkbox(label: string, on: boolean, hit: string, focused: boolean, lead = 1): Line {
  return [seg(' '.repeat(lead)), seg(`[${on ? 'x' : ' '}] ${label}`, focused ? FOCUSED : undefined, hit)]
}

/** `(•) A   ( ) B`: each option picks itself; its hit is `<hit>=<value>`. */
export function radios(options: readonly { value: string; label: string }[], value: string, hit: string, focused: boolean): Line {
  const line: Line = []
  options.forEach((o, i) => {
    if (i > 0) line.push(seg('   '))
    const isOn = o.value === value
    line.push(seg(`(${isOn ? '•' : ' '}) ${o.label}`, focused && isOn ? FOCUSED : isOn ? undefined : { dimColor: true }, `${hit}=${o.value}`))
  })
  return line
}

/** `[ - ]  6  [ + ]`: the buttons' hits are `<hit>-` and `<hit>+`. */
export function stepper(value: number, hit: string, focused: boolean): Line {
  const look = focused ? FOCUSED : { color: 'claude' as const }
  return [seg('[ - ]', look, hit + '-'), seg(`  ${value}  `, focused ? { bold: true } : undefined), seg('[ + ]', look, hit + '+')]
}

/**
 * `[ text            tail ]`, `width` cells on the field background: the brackets and text reach `hit`, the tail
 * (a Show button, a ▾) its own. `dim` draws a placeholder.
 */
export function field(text: string, width: number, hit: string, focused: boolean, opts: { dim?: boolean; look?: Look; tail?: Seg } = {}): Line {
  const back = { backgroundColor: FIELD_BACKGROUND }
  const frame: Look = focused ? { ...back, ...FOCUSED } : back
  const tail = opts.tail === undefined ? [] : [{ ...opts.tail, look: { ...back, ...opts.tail.look } }]
  const shown = pad(clip(text, fieldRoom(width, tail[0])), fieldRoom(width, tail[0]))
  const look = { ...back, ...opts.look, ...(focused ? { bold: true } : {}), ...(opts.dim ? { dimColor: true } : {}) }
  return [seg('[ ', frame, hit), seg(shown, look, hit), ...tail, seg(' ]', frame, hit)]
}

/** The cells a field `width` wide leaves its text, beside its tail. */
export function fieldRoom(width: number, tail?: Seg): number {
  return Math.max(1, width - 4 - (tail === undefined ? 0 : cells(tail.text)))
}

/** A dropdown: a field whose ▾ and text both open its list. */
export function dropdown(text: string, width: number, hit: string, focused: boolean, opts: { dim?: boolean; look?: Look } = {}): Line {
  return field(text, width, hit, focused, { ...opts, tail: seg(' ▾', focused ? FOCUSED : { color: 'claude' }, hit) })
}

/**
 * Where a key moves the keyboard among a view's controls, given in reading order a group per line: Tab and
 * Shift+Tab through all of them, ↑/↓ to the line above or below (the same place in it, as near as it has),
 * ←/→ within the line. Null for any other key. From a control no longer there, ↓ and Tab start at the first, ↑
 * and Shift+Tab at the last.
 */
export function moveFocus(groups: readonly (readonly string[])[], focus: string | null, key: string, shift = false): string | null {
  const all = groups.flat()
  if (all.length === 0) return null
  const row = groups.findIndex(g => g.includes(focus ?? ''))
  if (key === 'tab') {
    const at = all.indexOf(focus ?? '')
    if (at < 0) return shift ? all.at(-1)! : all[0]!
    return all[(at + (shift ? -1 : 1) + all.length) % all.length]!
  }
  if (key === 'up' || key === 'down') {
    if (row < 0) return key === 'down' ? all[0]! : all.at(-1)!
    const to = groups[Math.max(0, Math.min(groups.length - 1, row + (key === 'up' ? -1 : 1)))]!
    const place = groups[row]!.indexOf(focus!)
    return to[Math.min(place, to.length - 1)]!
  }
  if ((key === 'left' || key === 'right') && row >= 0) {
    const group = groups[row]!
    const place = group.indexOf(focus!)
    return group[Math.max(0, Math.min(group.length - 1, place + (key === 'left' ? -1 : 1)))]!
  }
  return null
}

/** The Show or Hide button inside a held field. */
export function showButton(isShown: boolean, hit: string): Seg {
  return seg(isShown ? ' Hide' : ' Show', { color: 'claude', underline: true }, hit)
}

/** The first option a list of `count` shows so `cursor` is in view. */
export function listFirst(count: number, cursor: number): number {
  return Math.max(0, Math.min(count - LIST_ROWS, cursor - LIST_ROWS + 1))
}

/**
 * An open dropdown's list from column `lead`, `width` wide: a box, one option a line with its description, the
 * cursor's marked; option `i` reaches `<hit>:<i>`. Past `LIST_ROWS` it shows the window around the cursor.
 */
export function listRows(options: readonly Option[], cursor: number, lead: number, width: number, hit: string): Line[] {
  const inner = width - 2
  const labelColumns = Math.min(Math.max(...options.map(o => cells(o.label))) + 2, Math.floor(inner / 2))
  const first = listFirst(options.length, cursor)
  const shown = options.slice(first, first + LIST_ROWS)
  const box: Look = { color: 'claude' }
  const lines: Line[] = [[seg(' '.repeat(lead)), seg('┌' + '─'.repeat(inner) + '┐', box)]]
  shown.forEach((o, i) => {
    const at = first + i
    const isCursor = at === cursor
    const text = (isCursor ? '▸ ' : '  ') + pad(clip(o.label, labelColumns - 2), labelColumns - 2) + ' ' + o.what
    lines.push([
      seg(' '.repeat(lead)),
      seg('│', box),
      seg(pad(clip(text, inner), inner), { backgroundColor: FIELD_BACKGROUND, ...(isCursor ? FOCUSED : {}) }, `${hit}:${at}`),
      seg('│', box),
    ])
  })
  lines.push([seg(' '.repeat(lead)), seg('└' + '─'.repeat(inner) + '┘', box)])
  return lines
}

/** The lines `listRows` draws for `count` options. */
export function listHeight(count: number): number {
  return Math.min(count, LIST_ROWS) + 2
}
