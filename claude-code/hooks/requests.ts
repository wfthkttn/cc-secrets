import type { ClientKeyEvent, ClientModule } from 'claude-code'

import type { Edit, RequestEntry, RequestsMessage, RequestsProps } from './requests-props'
import { drawTabs, TAB_ROWS, tabAt } from './tabs'

export type ListState = {
  /** Tells this instance's edits apart from another's, the pop-out's and the list's. */
  instance: string
  seq: number
  /** Edits sent but not yet confirmed by the hooks. */
  pending: Edit[]
  selected: string | null
  isFocused: boolean
  epoch: number
  /** The first card row shown; clamped when drawn. */
  scroll: number
}

/** One screen row of the list: a message row, a request card's row, a gap, or the empty note. */
type Row =
  | { id: string; kind: 'cardTop' | 'cardBottom' | 'fieldTop' | 'field' | 'fieldBottom' | 'grantTop' | 'grant' | 'grantBottom' }
  | { id: string; kind: 'what'; text: string; since: string }
  | { id: string; kind: 'from'; text: string }
  | { id: null; kind: 'msgTop' | 'msgBottom' }
  | { id: null; kind: 'msg'; text: string; index: number }
  | { id: null; kind: 'gap' | 'empty' }

/** A row on screen: a layout row, or a marker for the cards cut off above or below. */
type ViewRow = Row | { id: null; kind: 'more'; dir: 'up' | 'down'; count: number }

/** The list's room, and the message pinned above its cards. */
export type Frame = { columns: number; rows: number; message: string | null }

type Result = { state: ListState; post?: RequestsMessage }

const CANCEL_LABEL = ' ✕ '
/** The Cancel button: its label inside a border. */
const BUTTON_COLUMNS = CANCEL_LABEL.length + 2
/** A card's border and padding on each side. */
const CARD_EDGE = 2
const FROM_MAX_ROWS = 4
const MESSAGE_MAX_ROWS = 6
const BUTTON_ROW_TEXT = [edge('top', BUTTON_COLUMNS), '│' + CANCEL_LABEL + '│', edge('bottom', BUTTON_COLUMNS)] as const
/** A grant card's answers, left to right; ✕ refuses. */
const GRANT_BUTTONS = [
  { kind: 'session', label: ' Session ' },
  { kind: 'once', label: ' Once ' },
  { kind: 'cancel', label: CANCEL_LABEL },
] as const
const FIELD_BACKGROUND = '#1f2a3a'
/** Names a `Client` gets for special keys; any other `key` is typed text, a burst arriving whole. */
const SPECIAL_KEYS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab', 'backspace', 'delete'])

function edge(side: 'top' | 'bottom', width: number): string {
  const [left, right] = side === 'top' ? ['╭', '╮'] : ['╰', '╯']
  return left + '─'.repeat(width - 2) + right
}

/** `text` cut to `width` characters, the last one `…` when cut. */
function clip(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : chars.slice(0, width - 1).join('') + '…'
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - [...text].length))
}

export function initialState(focusEpoch: number, instance: string): ListState {
  return { instance, seq: 0, pending: [], selected: null, isFocused: false, epoch: focusEpoch, scroll: 0 }
}

function typedText(k: ClientKeyEvent): string | null {
  if (k.ctrl || k.meta) return null
  if (k.key === 'space') return ' '
  if (SPECIAL_KEYS.has(k.key) || /[\x00-\x1f\x7f]/.test(k.key)) return null
  return k.key
}

function selectedOf(state: ListState, entries: RequestEntry[]): string | null {
  if (state.selected !== null && entries.some(e => e.id === state.selected)) return state.selected
  return entries[0]?.id ?? null
}

function postOf(state: ListState, selected: string | null, edits = state.pending, dismiss = false): RequestsMessage {
  return { instance: state.instance, selected, edits, ...(dismiss ? { dismiss: true as const } : {}) }
}

/** Drops the edits the hooks confirmed; null when none were. */
export function confirm(state: ListState, applied: number | undefined): ListState | null {
  if (applied === undefined || !state.pending.some(e => e.seq <= applied)) return null
  return { ...state, pending: state.pending.filter(e => e.seq > applied) }
}

/** The value's length as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownLength(entry: RequestEntry, pending: Edit[]): number {
  let length = entry.length
  for (const edit of pending) {
    if (edit.id !== entry.id) continue
    if (edit.kind === 'append') length += [...edit.text].length
    else if (edit.kind === 'back') length = Math.max(0, length - 1)
    else if (edit.kind === 'clear') length = 0
  }
  return length
}

function wrap(text: string, width: number, maxRows: number): string[] {
  const chars = [...text]
  const rows: string[] = []
  for (let i = 0; i < chars.length && rows.length < maxRows; i += width) rows.push(chars.slice(i, i + width).join(''))
  if (chars.length > width * maxRows) rows[maxRows - 1] = clip(rows[maxRows - 1]! + '…', width)
  return rows.length === 0 ? [''] : rows
}

function wrapWords(text: string, width: number, maxRows: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    const joined = row === '' ? word : row + ' ' + word
    if ([...joined].length <= width) {
      row = joined
      continue
    }
    if (row !== '') rows.push(row)
    row = word
    while ([...row].length > width) {
      rows.push([...row].slice(0, width).join(''))
      row = [...row].slice(width).join('')
    }
  }
  if (row !== '') rows.push(row)
  if (rows.length <= maxRows) return rows
  const kept = rows.slice(0, maxRows)
  kept[maxRows - 1] = clip(kept[maxRows - 1]! + '…', width)
  return kept
}

/** The columns inside a card, and where its Cancel button starts. */
export function geometry(columns: number) {
  const inner = columns - 2 * CARD_EDGE
  return { inner, fieldColumns: inner - 1 - BUTTON_COLUMNS, buttonStart: CARD_EDGE + inner - BUTTON_COLUMNS }
}

/** The grant buttons, right-aligned in the card as the field's ✕ is, a column apart. */
export function grantButtons(columns: number) {
  const { inner } = geometry(columns)
  const widths = GRANT_BUTTONS.map(b => [...b.label].length + 2)
  const total = widths.reduce((sum, w) => sum + w, 0) + widths.length - 1
  let start = CARD_EDGE + inner - total
  return GRANT_BUTTONS.map((b, i) => {
    const button = { ...b, start, width: widths[i]! }
    start += widths[i]! + 1
    return button
  })
}

export function layout(entries: RequestEntry[], columns: number, message: string | null): Row[] {
  if (entries.length === 0 && message === null) return [{ id: null, kind: 'empty' }]
  const { inner, fieldColumns } = geometry(columns)
  const rows: Row[] = []
  if (message !== null) {
    const lines = wrapWords(message, fieldColumns, MESSAGE_MAX_ROWS)
    rows.push({ id: null, kind: 'msgTop' })
    for (let index = 0; index < Math.max(BUTTON_ROW_TEXT.length, lines.length); index++) {
      rows.push({ id: null, kind: 'msg', text: lines[index] ?? '', index })
    }
    rows.push({ id: null, kind: 'msgBottom' })
  }
  for (const entry of entries) {
    if (rows.length > 0) rows.push({ id: null, kind: 'gap' })
    rows.push({ id: entry.id, kind: 'cardTop' })
    rows.push({ id: entry.id, kind: 'what', text: entry.prompt, since: entry.since })
    if (entry.source !== '') for (const text of wrap(entry.source, inner, FROM_MAX_ROWS)) rows.push({ id: entry.id, kind: 'from', text })
    const answer = entry.kind === 'grant' ? (['grantTop', 'grant', 'grantBottom'] as const) : (['fieldTop', 'field', 'fieldBottom'] as const)
    for (const kind of answer) rows.push({ id: entry.id, kind })
    rows.push({ id: entry.id, kind: 'cardBottom' })
  }
  return rows
}

/**
 * The list's height in `rows` of room: a card and its gap short of it, since
 * the room's bottom edge may be off screen or under the engine's pill.
 */
export function listHeight(entries: RequestEntry[], columns: number, message: string | null, rows: number): number {
  const counts = new Map<string, number>()
  for (const row of layout(entries, columns, null)) if (row.id !== null) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const tallestCard = Math.max(0, ...counts.values()) + 1
  return Math.min(layout(entries, columns, message).length, rows - tallestCard)
}

type Window = { head: Row[]; body: Row[]; top: number; room: number; fits: boolean }

/** The message rows, the card rows, and which card rows fit under the message. */
function windowOf(entries: RequestEntry[], frame: Frame, scroll: number): Window {
  const all = layout(entries, frame.columns, frame.message)
  const headLength = all.findIndex(r => r.kind === 'msgBottom') + 1
  const head = all.slice(0, headLength)
  const body = all.slice(headLength)
  if (all.length <= frame.rows) return { head, body, top: 0, room: body.length, fits: true }
  const room = Math.max(1, frame.rows - headLength - 2)
  return { head, body, top: Math.max(0, Math.min(scroll, body.length - room)), room, fits: false }
}

export function view(entries: RequestEntry[], frame: Frame, scroll: number): ViewRow[] {
  const w = windowOf(entries, frame, scroll)
  if (w.fits) return [...w.head, ...w.body]
  const above = w.body.slice(0, w.top).filter(r => r.kind === 'cardTop').length
  const below = w.body.slice(w.top + w.room).filter(r => r.kind === 'cardBottom').length
  return [
    ...w.head,
    { id: null, kind: 'more', dir: 'up', count: above },
    ...w.body.slice(w.top, w.top + w.room),
    { id: null, kind: 'more', dir: 'down', count: below },
  ]
}

/** The scroll that shows the card whole, or from its top when it is taller than the window. */
function reveal(entries: RequestEntry[], frame: Frame, scroll: number, id: string): number {
  const w = windowOf(entries, frame, scroll)
  if (w.fits) return 0
  const start = w.body.findIndex(r => r.id === id && r.kind === 'cardTop')
  const end = w.body.findIndex(r => r.id === id && r.kind === 'cardBottom')
  if (start < w.top) return start
  if (end >= w.top + w.room) return Math.min(start, end - w.room + 1)
  return w.top
}

/** Selects the card and scrolls to it; tells the hooks when the selection changed, or always when `tell`. */
function selectCard(state: ListState, entries: RequestEntry[], frame: Frame, id: string, tell = false): Result {
  const moved = { ...state, selected: id, isFocused: true, scroll: reveal(entries, frame, state.scroll, id) }
  return tell || id !== selectedOf(state, entries) ? { state: moved, post: postOf(state, id) } : { state: moved }
}

type EditBody = Edit extends infer E ? (E extends Edit ? Omit<E, 'seq'> : never) : never

function withEdit(state: ListState, selected: string | null, edit: EditBody): Result {
  const seq = state.seq + 1
  const pending = [...state.pending, { ...edit, seq } as Edit]
  return { state: { ...state, seq, pending, selected, isFocused: true }, post: postOf(state, selected, pending) }
}

export function onKey(state: ListState, entries: RequestEntry[], frame: Frame, k: ClientKeyEvent): Result {
  const selected = selectedOf(state, entries)
  if (selected === null) return { state }
  const at = entries.findIndex(e => e.id === selected)
  const jumps: Record<string, number> = { up: at - 1, down: at + 1, home: 0, end: entries.length - 1 }
  const to = jumps[k.key]
  if (to !== undefined) return selectCard(state, entries, frame, entries[Math.max(0, Math.min(entries.length - 1, to))]!.id)
  const isEnter = k.key === 'return' || k.key === '\n'
  if (entries[at]!.kind === 'grant') return isEnter ? withEdit(state, selected, { id: selected, kind: 'once' }) : { state }
  if (isEnter) return withEdit(state, selected, { id: selected, kind: 'submit' })
  if (k.key === 'backspace' || k.key === 'delete') return withEdit(state, selected, { id: selected, kind: 'back' })
  if (k.ctrl && k.key === 'u') return withEdit(state, selected, { id: selected, kind: 'clear' })
  const text = typedText(k)
  return text === null ? { state } : withEdit(state, selected, { id: selected, kind: 'append', text })
}

/** A click gives the list the keyboard, so it always tells the hooks what is selected. */
export function onClick(state: ListState, entries: RequestEntry[], frame: Frame, y: number, x: number): Result {
  const row = view(entries, frame, state.scroll)[y]
  const current = selectedOf(state, entries)
  const { buttonStart } = geometry(frame.columns)
  const onButton = x >= buttonStart && x < buttonStart + BUTTON_COLUMNS
  const focused = { ...state, isFocused: true }
  if (row?.kind === 'more') {
    const w = windowOf(entries, frame, state.scroll)
    const id =
      row.dir === 'up'
        ? w.body.slice(0, w.top).filter(r => r.kind === 'cardTop').at(-1)?.id
        : w.body.slice(w.top + w.room).find(r => r.kind === 'cardBottom')?.id
    if (id != null) return selectCard(state, entries, frame, id, true)
  }
  if (row?.kind === 'msg' && row.index < BUTTON_ROW_TEXT.length && onButton) return { state: focused, post: postOf(state, current, state.pending, true) }
  if (row?.id == null) return { state: focused, post: postOf(state, current) }
  if ((row.kind === 'fieldTop' || row.kind === 'field' || row.kind === 'fieldBottom') && onButton) {
    return withEdit(state, current, { id: row.id, kind: 'cancel' })
  }
  if (row.kind === 'grantTop' || row.kind === 'grant' || row.kind === 'grantBottom') {
    const button = grantButtons(frame.columns).find(b => x >= b.start && x < b.start + b.width)
    if (button !== undefined) return withEdit(state, current, { id: row.id, kind: button.kind })
  }
  return { state: { ...focused, selected: row.id }, post: postOf(state, row.id) }
}

const Requests: ClientModule<RequestsProps, ListState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { columns } = props
  const frame: Frame = { columns, rows: props.rows, message: props.message }
  const tabRows = props.tabs === null ? 0 : TAB_ROWS
  surface.onPointer(p => {
    if (p.type !== 'down') return
    if (p.y < tabRows) {
      const current = surface.state as ListState
      if (p.y === 0 && props.tabs !== null && tabAt(props.tabs, p.x) === 'vault') surface.post({ ...postOf(current, selectedOf(current, props.entries)), tab: 'vault' })
      return
    }
    const result = onClick(surface.state as ListState, props.entries, frame, p.y - tabRows, p.x)
    surface.setState(result.state)
    if (result.post) surface.post(result.post)
  })
  surface.onKey(k => {
    const result = onKey(surface.state as ListState, props.entries, frame, k)
    surface.setState(result.state)
    if (result.post) surface.post(result.post)
  })
  let state = surface.state ?? initialState(props.focusEpoch, Math.random().toString(36).slice(2))
  const confirmed = confirm(state, props.applied[state.instance])
  if (confirmed !== null) state = confirmed
  if (state.epoch !== props.focusEpoch) state = { ...state, isFocused: false, epoch: props.focusEpoch }
  if (state !== surface.state) surface.setState(state)

  const selected = selectedOf(state, props.entries)
  const entriesById = new Map(props.entries.map(e => [e.id, e]))
  const { inner, fieldColumns } = geometry(columns)
  const active = (id: string) => id === selected && state.isFocused
  const look = (id: string) => (active(id) ? { color: 'claude' as const, bold: true } : { dimColor: true })
  const line = (id: string, children: ReturnType<typeof Text>[]) =>
    Box({ flexDirection: 'row', children: [Text({ ...look(id), children: ['│ '] }), ...children, Text({ ...look(id), children: [' │'] })] })

  const rows = view(props.entries, frame, state.scroll).map(row => {
    switch (row.kind) {
      case 'empty':
        return Text({ dimColor: true, children: ['No requests'] })
      case 'more': {
        const label = row.count === 0 ? '' : `${row.dir === 'up' ? '▲' : '▼'} ${row.count} more`
        return Text({ dimColor: true, children: [pad(' '.repeat(Math.floor((columns - [...label].length) / 2)) + label, columns)] })
      }
      case 'msgTop':
      case 'msgBottom':
        return Text({ color: 'error', children: [edge(row.kind === 'msgTop' ? 'top' : 'bottom', columns)] })
      case 'msg':
        return Box({
          flexDirection: 'row',
          children: [
            Text({ color: 'error', children: ['│ '] }),
            Text({ children: [pad(row.text, fieldColumns) + ' '] }),
            Text({ color: 'error', children: [pad(BUTTON_ROW_TEXT[row.index] ?? '', BUTTON_COLUMNS) + ' │'] }),
          ],
        })
      case 'gap':
        return Text({ children: [' '.repeat(columns)] })
      case 'cardTop':
      case 'cardBottom':
        return Text({ ...look(row.id), children: [edge(row.kind === 'cardTop' ? 'top' : 'bottom', columns)] })
      case 'what': {
        const since = ' ' + row.since
        const room = inner - since.length
        return line(row.id, [Text({ bold: true, children: [pad(clip(row.text, room), room)] }), Text({ dimColor: true, children: [since] })])
      }
      case 'from':
        return line(row.id, [Text({ children: [pad(row.text, inner)] })])
      case 'fieldTop':
      case 'fieldBottom': {
        const side = row.kind === 'fieldTop' ? 'top' : 'bottom'
        return line(row.id, [
          Text({ ...look(row.id), children: [edge(side, fieldColumns) + ' '] }),
          Text({ color: 'error', children: [BUTTON_ROW_TEXT[side === 'top' ? 0 : 2]] }),
        ])
      }
      case 'field': {
        const count = shownLength(entriesById.get(row.id)!, state.pending)
        const room = fieldColumns - 4
        const shown = active(row.id)
          ? (count + 1 > room ? '…' + '•'.repeat(room - 2) : '•'.repeat(count)) + '▏'
          : count > 0
            ? '•'.repeat(Math.min(count, room))
            : entriesById.get(row.id)!.kind === 'unlock'
              ? 'passphrase'
              : 'password'
        return line(row.id, [
          Text({ ...look(row.id), children: ['│ '] }),
          Text({ backgroundColor: FIELD_BACKGROUND, bold: active(row.id), dimColor: !active(row.id) && count === 0, children: [pad(shown, room)] }),
          Text({ ...look(row.id), children: [' │ '] }),
          Text({ color: 'error', children: [BUTTON_ROW_TEXT[1]] }),
        ])
      }
      case 'grantTop':
      case 'grant':
      case 'grantBottom': {
        const buttons = grantButtons(columns)
        const face = (label: string, width: number) =>
          row.kind === 'grantTop' ? edge('top', width) : row.kind === 'grantBottom' ? edge('bottom', width) : '│' + label + '│'
        const lead = buttons[0]!.start - CARD_EDGE
        return line(row.id, [
          Text({ children: [' '.repeat(lead)] }),
          ...buttons.map((b, i) =>
            Text({ ...(b.kind === 'cancel' ? { color: 'error' as const } : look(row.id)), children: [(i > 0 ? ' ' : '') + face(b.label, b.width)] }),
          ),
        ])
      }
    }
  })
  const tabs = props.tabs === null ? [] : drawTabs(surface.elements, props.tabs, columns)
  return Box({ flexDirection: 'column', width: columns, children: [...tabs, ...rows] })
}

export default Requests
