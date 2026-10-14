import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { ConfigAction, ConfigMessage, ConfigProps, TextEdit } from './config-view-props'
import { buttonRows, type ButtonSpec, checkbox, drawLine, FIELD_BACKGROUND, fit, FOCUSED, hitAt, type Line, moveFocus, seg, stepper, textLine } from './controls'
import { cells, displayed, pad, rowsOf } from './display'
import { drawTabs, type Tab, TAB_ROWS, tabAt } from './tabs'

type Focus = 'unlock' | 'mask' | 'text' | 'apply' | 'suggest'

export type ConfigState = {
  instance: string
  seq: number
  /** Text edits sent but not yet confirmed by the hooks. */
  pending: TextEdit[]
  focus: Focus
}

type Result = { state: ConfigState; post?: ConfigMessage }

const AUTO_HEAD = ' Auto mode · Secrets management'
const BUTTONS: ButtonSpec[] = [
  { hit: 'apply', label: 'Apply' },
  { hit: 'suggest', label: 'Suggested' },
]
const GROUPS: readonly (readonly Focus[])[] = [['unlock'], ['mask'], ['text'], ['apply', 'suggest']]
const SPECIAL_KEYS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab', 'backspace', 'delete'])
/** The lines around the text: two headings, the two settings, a gap, the box's borders, the buttons, an error. */
const FIXED_LINES = 2 + 2 + 1 + 2 + 3 + 1

export function initialState(instance: string): ConfigState {
  return { instance, seq: 0, pending: [], focus: 'text' }
}

/** The text as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownText(draft: string, pending: TextEdit[]): string {
  let text = draft
  for (const edit of pending) {
    if (edit.kind === 'append') text += edit.text
    else if (edit.kind === 'back') text = [...text].slice(0, -1).join('')
    else if (edit.kind === 'clear') text = ''
  }
  return text
}

export function status(shown: string, applied: string | null): string {
  if (applied === null) return 'not in settings'
  return shown === applied ? 'applied' : 'changed, not applied'
}

/**
 * A displayed text in rows of at most `width` cells, broken after the last space that fits; a full last row leaves
 * the cursor a row of its own.
 */
export function wrap(text: string, width: number, cursor: boolean): string[] {
  const rows: string[] = []
  let rest = text
  while (rest !== '') {
    const fits = rowsOf(rest, width)[0]!
    const space = fits.lastIndexOf(' ')
    const end = fits.length < rest.length && !rest.slice(fits.length).startsWith(' ') && space > 0 ? space + 1 : fits.length
    rows.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rows.length === 0 || (cursor && cells(rows.at(-1)!) === width)) rows.push('')
  return rows
}

/** The view's lines under its tabs; a text longer than the room shows its end, where typing goes. */
export function drawPage(props: ConfigProps, state: Pick<ConfigState, 'focus' | 'pending'>): Line[] {
  const { columns } = props
  const at = (focus: Focus) => state.focus === focus
  const shown = shownText(props.draft, state.pending)
  const lines: Line[] = [[seg(' Vault', { bold: true })]]
  lines.push(checkbox('Unlock the vault at session start', props.unlockAtStart, 'unlock', at('unlock')))
  lines.push([seg(' Mask values of at least ', at('mask') ? FOCUSED : undefined), ...stepper(props.maskMinLength, 'mask', at('mask')), seg(' characters')])
  lines.push([])
  const right = status(shown, props.applied) + ' '
  lines.push([seg(pad(AUTO_HEAD, columns - cells(right)), { bold: true }), seg(right, { dimColor: true })])

  const inner = columns - 4
  const text = wrap(displayed(shown), inner, at('text'))
  const kept = text.slice(-Math.max(1, props.rows - TAB_ROWS - FIXED_LINES))
  const box = at('text') ? FOCUSED : { color: 'claude' as const }
  lines.push([seg('┌' + '─'.repeat(columns - 2) + '┐', box, 'text')])
  kept.forEach((row, i) => {
    const cursor = i === kept.length - 1 && at('text') ? '▏' : ''
    lines.push([seg('│ ', box, 'text'), seg(pad(row + cursor, inner), { backgroundColor: FIELD_BACKGROUND }, 'text'), seg(' │', box, 'text')])
  })
  lines.push([seg('└' + '─'.repeat(columns - 2) + '┘', box, 'text')])
  lines.push(...buttonRows(BUTTONS, state.focus))
  if (props.error !== null) lines.push(textLine(' ' + displayed(props.error), { color: 'error' }))
  return lines
}

function postOf(state: ConfigState, edits = state.pending): ConfigMessage {
  return { instance: state.instance, edits, textFocused: state.focus === 'text' }
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

function focusOn(state: ConfigState, focus: Focus): Result {
  const moved = { ...state, focus }
  return { state: moved, post: postOf(moved) }
}

function typedText(k: ClientKeyEvent): string | null {
  if (k.ctrl || k.meta) return null
  if (k.key === 'space') return ' '
  if (SPECIAL_KEYS.has(k.key) || /[\x00-\x1f\x7f]/.test(k.key)) return null
  return k.key
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
  if (hit === 'apply' || hit === 'suggest') return act({ ...state, focus: hit }, { kind: hit })
  return { state }
}

export function onKey(state: ConfigState, props: Pick<ConfigProps, 'unlockAtStart' | 'maskMinLength'>, k: ClientKeyEvent): Result {
  const isEnter = k.key === 'return' || k.key === '\n'
  if (state.focus === 'mask' && (k.key === 'left' || k.key === 'right' || k.key === '-' || k.key === '+')) {
    return maskStep(state, props, k.key === 'left' || k.key === '-' ? -1 : 1)
  }
  const to = moveFocus(GROUPS, state.focus, k.key, k.shift === true) as Focus | null
  if (to !== null) return focusOn(state, to)
  if (state.focus === 'text') {
    if (isEnter) return act(state, { kind: 'apply' })
    if (k.key === 'backspace' || k.key === 'delete') return withEdit(state, { kind: 'back' })
    if (k.ctrl && k.key === 'u') return withEdit(state, { kind: 'clear' })
    const text = typedText(k)
    return text === null ? { state } : withEdit(state, { kind: 'append', text })
  }
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
  if (state !== surface.state) surface.setState(state)

  const lines = drawPage(props, state).map(line => drawLine(surface.elements, fit(line, columns)))
  return surface.elements.Box({ flexDirection: 'column', width: columns, children: [...drawTabs(surface.elements, props.tabs, columns), ...lines] })
}

export default ConfigView
