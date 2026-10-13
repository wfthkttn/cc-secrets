import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { ConfigAction, ConfigMessage, ConfigProps, TextEdit } from './config-view-props'
import { drawTabs, TAB_ROWS, tabAt } from './tabs'

type Focus = 'text' | 'unlock' | 'mask' | 'forward'

export type ConfigState = {
  instance: string
  seq: number
  /** Text edits sent but not yet confirmed by the hooks. */
  pending: TextEdit[]
  focus: Focus
}

/** One row under the tabs. */
export type Row =
  | { kind: 'head' | 'gap' | 'buttonsTop' | 'buttons' | 'buttonsBottom' | 'unlock' | 'mask' | 'forward' }
  | { kind: 'text'; text: string; isLast: boolean }
  | { kind: 'error'; text: string }

type Result = { state: ConfigState; post?: ConfigMessage }

const HEAD = ' Auto mode · Secrets management:'
const BUTTONS = [
  { kind: 'apply', label: ' Apply ' },
  { kind: 'suggest', label: ' Suggested ' },
] as const
const FIELD_BACKGROUND = '#1f2a3a'
const SPECIAL_KEYS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab', 'backspace', 'delete'])
/** The rows around the text: head, buttons and gaps, the three settings, an error. */
const FIXED_ROWS = 1 + 1 + 3 + 1 + 3 + 1

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - [...text].length))
}

function edge(side: 'top' | 'bottom', width: number): string {
  const [left, right] = side === 'top' ? ['╭', '╮'] : ['╰', '╯']
  return left + '─'.repeat(width - 2) + right
}

export function initialState(instance: string): ConfigState {
  return { instance, seq: 0, pending: [], focus: 'text' }
}

/** The text as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownText(draft: string, pending: TextEdit[]): string {
  let text = draft
  for (const edit of pending) {
    if (edit.kind === 'append') text += edit.text
    else if (edit.kind === 'back') text = [...text].slice(0, -1).join('')
    else text = ''
  }
  return text
}

export function status(shown: string, applied: string | null): string {
  if (applied === null) return 'not in settings'
  return shown === applied ? 'applied' : 'changed, not applied'
}

/** Rows of at most `width`, broken after the last space that fits; a full last row leaves the cursor a row of its own. */
export function wrap(text: string, width: number, cursor: boolean): string[] {
  const chars = [...text]
  const rows: string[] = []
  let at = 0
  while (at < chars.length) {
    let end = Math.min(at + width, chars.length)
    const space = chars.lastIndexOf(' ', end - 1)
    if (end < chars.length && chars[end] !== ' ' && space > at) end = space + 1
    rows.push(chars.slice(at, end).join(''))
    at = end
  }
  if (rows.length === 0 || (cursor && [...rows.at(-1)!].length === width)) rows.push('')
  return rows
}

/** The view's rows; a text longer than the room shows its end, where typing goes. */
export function layout(props: Pick<ConfigProps, 'columns' | 'rows' | 'forward' | 'error'>, shown: string, cursor: boolean): Row[] {
  const lines = wrap(shown, props.columns - 2, cursor)
  const room = Math.max(1, props.rows - TAB_ROWS - FIXED_ROWS)
  const kept = lines.slice(-room)
  const rows: Row[] = [{ kind: 'head' }, ...kept.map((text, i) => ({ kind: 'text' as const, text, isLast: i === kept.length - 1 }))]
  rows.push({ kind: 'buttonsTop' }, { kind: 'buttons' }, { kind: 'buttonsBottom' }, { kind: 'gap' }, { kind: 'unlock' }, { kind: 'mask' })
  if (props.forward !== null) rows.push({ kind: 'forward' })
  if (props.error !== null) rows.push({ kind: 'error', text: props.error })
  return rows
}

/** The buttons from the left, each boxed, a column apart. */
export function buttons() {
  let start = 1
  return BUTTONS.map(b => {
    const button = { ...b, start, width: [...b.label].length + 2 }
    start += button.width + 1
    return button
  })
}

/** Where the mask row's `‹` and `›` sit. */
export function maskArrows(value: number) {
  const before = ' Mask values of at least ‹'
  const less = [...before].length - 1
  return { less, more: less + [...`‹ ${value} `].length }
}

function postOf(state: ConfigState, edits = state.pending, action?: ConfigAction): ConfigMessage {
  return { instance: state.instance, edits, textFocused: state.focus === 'text', ...(action === undefined ? {} : { action }) }
}

type EditBody = TextEdit extends infer E ? (E extends TextEdit ? Omit<E, 'seq'> : never) : never

function withEdit(state: ConfigState, edit: EditBody): Result {
  const seq = state.seq + 1
  const pending = [...state.pending, { ...edit, seq } as TextEdit]
  return { state: { ...state, seq, pending, focus: 'text' }, post: postOf({ ...state, focus: 'text' }, pending) }
}

export function confirm(state: ConfigState, confirmed: number | undefined): ConfigState | null {
  if (confirmed === undefined || !state.pending.some(e => e.seq <= confirmed)) return null
  return { ...state, pending: state.pending.filter(e => e.seq > confirmed) }
}

function act(state: ConfigState, action: ConfigAction): Result {
  return { state, post: postOf(state, state.pending, action) }
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

function settingAction(focus: Focus, props: Pick<ConfigProps, 'unlockAtStart' | 'maskMinLength' | 'forward'>, step: number): ConfigAction | null {
  if (focus === 'unlock') return { kind: 'unlockAtStart', on: !props.unlockAtStart }
  if (focus === 'forward' && props.forward !== null) return { kind: 'forward', on: !props.forward }
  if (focus === 'mask' && props.maskMinLength + step >= 1) return { kind: 'maskMinLength', value: props.maskMinLength + step }
  return null
}

export function onKey(state: ConfigState, props: Pick<ConfigProps, 'unlockAtStart' | 'maskMinLength' | 'forward'>, k: ClientKeyEvent): Result {
  const order: Focus[] = props.forward === null ? ['text', 'unlock', 'mask'] : ['text', 'unlock', 'mask', 'forward']
  const at = order.indexOf(state.focus)
  if (k.key === 'up' || k.key === 'down') return focusOn(state, order[Math.max(0, Math.min(order.length - 1, at + (k.key === 'up' ? -1 : 1)))]!)
  const isEnter = k.key === 'return' || k.key === '\n'
  if (state.focus === 'text') {
    if (isEnter) return act(state, { kind: 'apply' })
    if (k.key === 'backspace' || k.key === 'delete') return withEdit(state, { kind: 'back' })
    if (k.ctrl && k.key === 'u') return withEdit(state, { kind: 'clear' })
    const text = typedText(k)
    return text === null ? { state } : withEdit(state, { kind: 'append', text })
  }
  const step = state.focus === 'mask' ? (k.key === 'left' ? -1 : k.key === 'right' ? 1 : 0) : isEnter || k.key === 'space' ? 1 : 0
  const action = step === 0 ? null : settingAction(state.focus, props, step)
  return action === null ? { state } : act(state, action)
}

/** `y` and `x` count from the view's top left, the tab rows included. */
export function onClick(state: ConfigState, props: ConfigProps, y: number, x: number): Result {
  if (y < TAB_ROWS) {
    const tab = y === 0 ? tabAt(props.tabs, x) : null
    return tab !== null && tab !== 'config' ? { state, post: { ...postOf(state), tab } } : { state }
  }
  const row = layout(props, shownText(props.draft, state.pending), state.focus === 'text')[y - TAB_ROWS]
  if (row === undefined) return { state }
  if (row.kind === 'text' || row.kind === 'head') return focusOn(state, 'text')
  if (row.kind === 'buttonsTop' || row.kind === 'buttons' || row.kind === 'buttonsBottom') {
    const button = buttons().find(b => x >= b.start && x < b.start + b.width)
    return button === undefined ? { state } : act(state, { kind: button.kind })
  }
  if (row.kind === 'mask') {
    const arrows = maskArrows(props.maskMinLength)
    const step = x === arrows.less ? -1 : x === arrows.more ? 1 : 0
    const action = step === 0 ? null : settingAction('mask', props, step)
    const moved = { ...state, focus: 'mask' as const }
    return action === null ? focusOn(state, 'mask') : act(moved, action)
  }
  if (row.kind === 'unlock' || row.kind === 'forward') {
    const action = settingAction(row.kind, props, 1)
    const moved = { ...state, focus: row.kind }
    return action === null ? focusOn(state, row.kind) : act(moved, action)
  }
  return { state }
}

const ConfigView: ClientModule<ConfigProps, ConfigState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { columns } = props
  surface.onPointer(p => {
    if (p.type !== 'down') return
    const result = onClick(surface.state as ConfigState, props, p.y, p.x)
    surface.setState(result.state)
    if (result.post) surface.post(result.post)
  })
  surface.onKey(k => {
    const result = onKey(surface.state as ConfigState, props, k)
    surface.setState(result.state)
    if (result.post) surface.post(result.post)
  })
  let state = surface.state ?? initialState(Math.random().toString(36).slice(2))
  const confirmed = confirm(state, props.confirmed[state.instance])
  if (confirmed !== null) state = confirmed
  if (state !== surface.state) surface.setState(state)

  const shown = shownText(props.draft, state.pending)
  const look = (focus: Focus) => (state.focus === focus ? { color: 'claude' as const, bold: true } : {})
  const line = (text: string, style: object = {}) => Text({ ...style, children: [pad(text, columns)] })
  const check = (on: boolean) => (on ? '✓' : '·')
  const rows = layout(props, shown, state.focus === 'text').map(row => {
    switch (row.kind) {
      case 'head': {
        const right = status(shown, props.applied) + ' '
        return Box({
          flexDirection: 'row',
          children: [Text({ ...look('text'), children: [pad(HEAD, columns - [...right].length)] }), Text({ dimColor: true, children: [right] })],
        })
      }
      case 'text': {
        const cursor = row.isLast && state.focus === 'text' ? '▏' : ''
        return Box({
          flexDirection: 'row',
          children: [
            Text({ children: [' '] }),
            Text({ backgroundColor: FIELD_BACKGROUND, children: [pad(row.text + cursor, columns - 2)] }),
            Text({ children: [' '] }),
          ],
        })
      }
      case 'buttonsTop':
      case 'buttons':
      case 'buttonsBottom': {
        const faces = buttons().map(b =>
          Text({
            color: 'claude',
            children: [' ' + (row.kind === 'buttonsTop' ? edge('top', b.width) : row.kind === 'buttonsBottom' ? edge('bottom', b.width) : '│' + b.label + '│')],
          }),
        )
        const used = buttons().reduce((sum, b) => sum + b.width + 1, 0)
        return Box({ flexDirection: 'row', children: [...faces, Text({ children: [' '.repeat(Math.max(0, columns - used))] })] })
      }
      case 'unlock':
        return line(` ${check(props.unlockAtStart)} Unlock the vault at session start`, look('unlock'))
      case 'mask':
        return line(` Mask values of at least ‹ ${props.maskMinLength} › characters`, look('mask'))
      case 'forward':
        return line(` ${check(props.forward === true)} Your ssh-agent's keys too, this session`, look('forward'))
      case 'error':
        return line(' ' + row.text, { color: 'error' })
      default:
        return line('')
    }
  })
  return Box({ flexDirection: 'column', width: columns, children: [...drawTabs(surface.elements, props.tabs, columns), ...rows] })
}

export default ConfigView
