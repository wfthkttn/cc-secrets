import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { ConfigAction, ConfigMessage, ConfigProps, TextEdit } from './config-view-props'
import {
  buttonRows,
  type ButtonSpec,
  caretAfter,
  checkbox,
  drawLine,
  editText,
  END_CARET,
  FIELD_BACKGROUND,
  fit,
  FOCUSED,
  hitAt,
  type Line,
  moveFocus,
  type Piece,
  seg,
  stepper,
  type TextEdit as Edit,
  textKey,
  textLine,
  textPieces,
} from './controls'
import { cells, displayed, pad } from './display'
import { drawTabs, type Tab, TAB_ROWS, tabAt } from './tabs'

type Focus = 'unlock' | 'mask' | 'text' | 'apply' | 'suggest'

export type ConfigState = {
  instance: string
  seq: number
  /** Text edits sent but not yet confirmed by the hooks. */
  pending: TextEdit[]
  focus: Focus
  /** Where typing goes in the text: a character index, past the end counting as the end. */
  caret: number
  /** The last of the hooks' pastes (`ConfigProps.pastes`) this view took in. */
  pasted: number
}

type Result = { state: ConfigState; post?: ConfigMessage }

const AUTO_HEAD = ' Auto mode rule'
const BUTTONS: ButtonSpec[] = [
  { hit: 'apply', label: 'Save' },
  { hit: 'suggest', label: 'Reset to default' },
]
const GROUPS: readonly (readonly Focus[])[] = [['unlock'], ['mask'], ['text'], ['apply', 'suggest']]
/** The lines around the text: two headings, the two settings, a gap, the box's borders, the buttons, an error. */
const FIXED_LINES = 2 + 2 + 1 + 2 + 3 + 1

export function initialState(instance: string): ConfigState {
  return { instance, seq: 0, pending: [], focus: 'text', caret: END_CARET, pasted: 0 }
}

/** The text as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownText(draft: string, pending: TextEdit[]): string {
  return pending.reduce((text, edit) => (edit.kind === 'action' || edit.kind === 'tab' ? text : editText(text, edit)), draft)
}

export function status(shown: string, applied: string | null): string {
  if (applied === null) return 'not set'
  return shown === applied ? 'saved' : 'unsaved changes'
}

/**
 * A text's pieces (its characters, and the caret while it has one) in rows of at most `width` cells, broken after
 * the last space that fits; a piece wider than a row takes one of its own. At least one row.
 */
export function wrap(pieces: readonly Piece[], width: number): Piece[][] {
  const rows: Piece[][] = []
  let rest = pieces
  while (rest.length > 0) {
    let fits = 0
    let used = 0
    while (fits < rest.length && used + cells(rest[fits]!.text) <= width) used += cells(rest[fits++]!.text)
    fits = Math.max(1, fits)
    const space = rest.slice(0, fits).findLastIndex(p => p.text === ' ')
    const end = fits < rest.length && rest[fits]!.text !== ' ' && space > 0 ? space + 1 : fits
    rows.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  return rows.length === 0 ? [[]] : rows
}

/** Where a click past a row's end puts the caret: after its last character, else where its caret is. */
function rowEnd(row: readonly Piece[], length: number): number {
  const last = row.findLast(p => p.isCaret !== true)
  return last !== undefined ? last.index + 1 : (row[0]?.index ?? length)
}

/**
 * The view's lines under its tabs. A text longer than the room shows its end, or from the caret's row when the
 * caret is above that; a click on a character reaches `text@<index>`.
 */
export function drawPage(props: ConfigProps, state: Pick<ConfigState, 'focus' | 'pending' | 'caret'>): Line[] {
  const { columns } = props
  const at = (focus: Focus) => state.focus === focus
  const shown = shownText(props.draft, state.pending)
  const lines: Line[] = [[seg(' Vault', { bold: true })]]
  lines.push(checkbox('Ask to unlock at session start', props.unlockAtStart, 'unlock', at('unlock')))
  lines.push([seg(' Mask values of at least ', at('mask') ? FOCUSED : undefined), ...stepper(props.maskMinLength, 'mask', at('mask')), seg(' characters')])
  lines.push([])
  const right = status(shown, props.applied) + ' '
  lines.push([seg(pad(AUTO_HEAD, columns - cells(right)), { bold: true }), seg(right, { dimColor: true })])

  const inner = columns - 4
  const rows = wrap(textPieces(shown, at('text') ? state.caret : null), inner)
  const room = Math.max(1, props.rows - TAB_ROWS - FIXED_LINES)
  const caretRow = rows.findIndex(row => row.some(p => p.isCaret === true))
  const end = Math.max(0, rows.length - room)
  const first = caretRow < 0 ? end : Math.min(caretRow, end)
  const kept = rows.slice(first, first + room)
  const box = at('text') ? FOCUSED : { color: 'claude' as const }
  const back = { backgroundColor: FIELD_BACKGROUND }
  const length = [...shown].length
  lines.push([seg('┌' + '─'.repeat(columns - 2) + '┐', box, 'text')])
  for (const row of kept) {
    const used = row.reduce((sum, p) => sum + cells(p.text), 0)
    lines.push([
      seg('│ ', box, 'text'),
      ...row.map(p => seg(p.text, back, `text@${p.index}`)),
      seg(' '.repeat(Math.max(0, inner - used)), back, `text@${rowEnd(row, length)}`),
      seg(' │', box, 'text'),
    ])
  }
  lines.push([seg('└' + '─'.repeat(columns - 2) + '┘', box, 'text')])
  lines.push(...buttonRows(BUTTONS, state.focus))
  if (props.error !== null) lines.push(textLine(' ' + displayed(props.error), { color: 'error' }))
  return lines
}

function postOf(state: ConfigState, edits = state.pending): ConfigMessage {
  return { instance: state.instance, edits, textFocused: state.focus === 'text', caret: state.caret }
}

type EditBody = TextEdit extends infer E ? (E extends TextEdit ? Omit<E, 'seq'> : never) : never

/** A numbered edit; a text edit gives the text the keyboard. */
function withEdit(state: ConfigState, edit: EditBody): Result {
  const seq = state.seq + 1
  const pending = [...state.pending, { ...edit, seq } as TextEdit]
  const focus = edit.kind === 'action' || edit.kind === 'tab' ? state.focus : 'text'
  return { state: { ...state, seq, pending, focus }, post: postOf({ ...state, focus }, pending) }
}

export function confirm(state: ConfigState, confirmed: number | undefined): ConfigState | null {
  if (confirmed === undefined || !state.pending.some(e => e.seq <= confirmed)) return null
  return { ...state, pending: state.pending.filter(e => e.seq > confirmed) }
}

function act(state: ConfigState, action: ConfigAction): Result {
  return withEdit(state, { kind: 'action', action })
}

/** The keyboard goes to `focus`; on the text, the caret to its end, or to `caret`. */
function focusOn(state: ConfigState, focus: Focus, caret = END_CARET): Result {
  const moved = { ...state, focus, caret }
  return { state: moved, post: postOf(moved) }
}

/**
 * Takes in the hooks' pastes this instance hasn't: the hooks made each at this view's caret, so while the text has
 * the keyboard the caret moves past it.
 */
export function withPastes(state: ConfigState, props: Pick<ConfigProps, 'pastes'>): ConfigState {
  let next = state
  for (const paste of props.pastes) {
    if (paste.seq > next.pasted) next = { ...next, pasted: paste.seq, ...(next.focus === 'text' ? { caret: paste.at + paste.length } : {}) }
  }
  return next
}

/** The mask minimum stepped by `step`; it never goes below 1. */
function maskStep(state: ConfigState, props: Pick<ConfigProps, 'maskMinLength'>, step: number): Result {
  const value = props.maskMinLength + step
  const there = { ...state, focus: 'mask' as const }
  return value >= 1 ? act(there, { kind: 'maskMinLength', value }) : focusOn(state, 'mask')
}

/** What a click on a control, or Enter or Space on the focused one, does. */
function onHit(state: ConfigState, props: Pick<ConfigProps, 'unlockAtStart' | 'maskMinLength'>, hit: string | null): Result {
  if (hit === 'unlock') return act({ ...state, focus: 'unlock' }, { kind: 'unlockAtStart', on: !props.unlockAtStart })
  if (hit === 'mask-') return maskStep(state, props, -1)
  if (hit === 'mask+') return maskStep(state, props, 1)
  if (hit === 'text') return focusOn(state, 'text')
  if (hit?.startsWith('text@')) return focusOn(state, 'text', Number(hit.slice('text@'.length)))
  if (hit === 'apply' || hit === 'suggest') return act({ ...state, focus: hit }, { kind: hit })
  return { state }
}

export function onKey(state: ConfigState, props: Pick<ConfigProps, 'unlockAtStart' | 'maskMinLength' | 'draft'>, k: ClientKeyEvent): Result {
  const isEnter = k.key === 'return' || k.key === '\n'
  if (state.focus === 'mask' && (k.key === 'left' || k.key === 'right' || k.key === '-' || k.key === '+')) {
    return maskStep(state, props, k.key === 'left' || k.key === '-' ? -1 : 1)
  }
  if (state.focus === 'text') {
    if (isEnter) return act(state, { kind: 'apply' })
    const change = textKey(k, state.caret, [...shownText(props.draft, state.pending)].length)
    if (change?.kind === 'move') return { state: { ...state, caret: change.caret } }
    if (change !== null) return withEdit({ ...state, caret: caretAfter(change) }, change)
  }
  const to = moveFocus(GROUPS, state.focus, k.key, k.shift === true) as Focus | null
  if (to !== null) return focusOn(state, to)
  return isEnter || k.key === 'space' ? onHit(state, props, state.focus === 'mask' ? null : state.focus) : { state }
}

/** `y` and `x` count from the view's top left, the tab rows included. */
export function onClick(state: ConfigState, props: ConfigProps, y: number, x: number): Result {
  if (y < TAB_ROWS) {
    const tab: Tab | null = y === 0 ? tabAt(props.tabs, x) : null
    return tab !== null && tab !== 'config' ? withEdit(state, { kind: 'tab', tab }) : { state }
  }
  return onHit(state, props, hitAt(drawPage(props, state)[y - TAB_ROWS], x))
}

/** Every change posts, with the state the next instance resumes from. */
function sent(result: Result): ConfigMessage {
  const { pending: _pending, ...ui } = result.state
  return { ...(result.post ?? postOf(result.state)), ui }
}

const ConfigView: ClientModule<ConfigProps, ConfigState> = (props, surface) => {
  const { columns } = props
  surface.onPointer(p => {
    if (p.type !== 'down') return
    const result = onClick(surface.state as ConfigState, props, p.y, p.x)
    surface.setState(result.state)
    surface.post(sent(result))
  })
  surface.onKey(k => {
    const result = onKey(surface.state as ConfigState, props, k)
    surface.setState(result.state)
    surface.post(sent(result))
  })
  let state = surface.state ?? (props.resume === null ? initialState(Math.random().toString(36).slice(2)) : { ...props.resume, pending: [] })
  const confirmed = confirm(state, props.confirmed[state.instance])
  if (confirmed !== null) state = confirmed
  const pasted = withPastes(state, props)
  if (state !== surface.state || pasted !== state) surface.setState(pasted)
  // The hooks drop a paste once a post says it was taken in.
  if (pasted !== state) surface.post(sent({ state: pasted }))
  state = pasted

  const lines = drawPage(props, state).map(line => drawLine(surface.elements, fit(line, columns)))
  return surface.elements.Box({ flexDirection: 'column', width: columns, children: [...drawTabs(surface.elements, props.tabs, columns), ...lines] })
}

export default ConfigView
