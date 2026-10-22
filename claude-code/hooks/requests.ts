import type { ClientKeyEvent, ClientModule } from 'claude-code'

import { caretAfter, caretAt, caretText, editText, END_CARET, lengthAfter, type TextEdit, textKey } from './controls'
import { cells, clip, displayed, pad, rowsOf } from './display'
import type { Edit, Offered, RequestEntry, RequestsMessage, RequestsProps } from './requests-props'
import { drawTabs, type Tab, TAB_ROWS, tabAt } from './tabs'

export type ListState = {
  /** Tells this instance's edits apart from another's, the pop-out's and the list's. */
  instance: string
  seq: number
  /** Edits sent but not yet confirmed by the hooks. */
  pending: Edit[]
  /** The card the keys go to; null picks the first, and a card that left the list leaves nothing selected. */
  selected: string | null
  isFocused: boolean
  epoch: number
  /** The first card row shown; clamped when drawn. */
  scroll: number
  /** The selected card's menu is open. */
  isMenuOpen: boolean
  /** The menu's highlighted option: an entry's id, null for Type; it stays on its entry when the vault changes. */
  cursor: string | null
  /** Where typing goes in the selected card's value: a character index, past the end counting as the end. */
  caret: number
  /** The last of the hooks' pastes (`RequestsProps.pastes`) this list took in. */
  pasted: number
}

/** One screen row of the list: a message row, a request card's row, a gap, or the empty note. */
type Row =
  | {
      id: string
      kind: 'cardTop' | 'cardBottom' | 'fieldTop' | 'field' | 'fieldBottom' | 'grantTop' | 'grant' | 'grantBottom' | 'pickTop' | 'pick' | 'pickBottom'
    }
  | { id: string; kind: 'what'; text: string; since: string }
  | { id: string; kind: 'from'; text: string }
  | { id: null; kind: 'msgTop' | 'msgBottom' }
  | { id: null; kind: 'msg'; text: string; index: number }
  | { id: null; kind: 'gap' | 'empty' }

/** A row on screen: a layout row, or a marker for the cards cut off above or below. */
type ViewRow = Row | { id: null; kind: 'more'; dir: 'up' | 'down'; count: number }

/** The list's room, the message pinned above its cards, and why a typed value can't be sent now (null when it can). */
export type Frame = { columns: number; rows: number; message: string | null; typingOff: string | null }

/**
 * The open menu, a window over the rows under its card's field (above it when there is no room below): `top`
 * counts view rows, `first` is the first option shown and `shown` how many, `cursor` the highlighted one (-1 when its
 * entry went).
 */
export type Menu = { id: string; top: number; left: number; width: number; first: number; shown: number; cursor: number; options: string[] }

type Result = { state: ListState; post?: RequestsMessage }

const CANCEL_LABEL = ' ✕ '
/** The Cancel button: its label inside a border. */
const BUTTON_COLUMNS = CANCEL_LABEL.length + 2
/** A card's border and padding on each side. */
const CARD_EDGE = 2
const FROM_MAX_ROWS = 4
const MESSAGE_MAX_ROWS = 6
/** The options a menu shows at once; it scrolls past them. */
export const MENU_ROWS = 6
/** The menu's first option: the field takes typing. */
export const TYPE_OPTION = 'Type a value'
const BUTTON_ROW_TEXT = [edge('top', BUTTON_COLUMNS), '│' + CANCEL_LABEL + '│', edge('bottom', BUTTON_COLUMNS)] as const
/** A grant card's answers, left to right; ✕ refuses. */
const GRANT_BUTTONS = [
  { kind: 'session', label: ' Allow for session ' },
  { kind: 'once', label: ' Allow once ' },
  { kind: 'cancel', label: CANCEL_LABEL },
] as const
const FIELD_BACKGROUND = '#1f2a3a'
/** The Show or Hide button after a typed value. */
const SHOW_COLUMNS = 5
/** Where a field's text starts: the card's edge, then the field's own. */
const FIELD_TEXT_START = CARD_EDGE + 2

function edge(side: 'top' | 'bottom', width: number): string {
  const [left, right] = side === 'top' ? ['╭', '╮'] : ['╰', '╯']
  return left + '─'.repeat(width - 2) + right
}

export function initialState(focusEpoch: number, instance: string): ListState {
  return { instance, seq: 0, pending: [], selected: null, isFocused: false, epoch: focusEpoch, scroll: 0, isMenuOpen: false, cursor: null, caret: END_CARET, pasted: 0 }
}

/** The vault entries a card may be answered with; none for a sign card or a closed vault. */
function offerOf(entry: RequestEntry): Offered[] {
  return entry.kind === 'secret' ? (entry.offer ?? []) : []
}

/** The menu's options as the cursor names them: null for Type, then the entries' ids. */
function optionIds(entry: RequestEntry): (string | null)[] {
  return [null, ...offerOf(entry).map(o => o.id)]
}

/** The entry the card's field holds, with this instance's unconfirmed menu choices on top; null while it takes typing. */
export function choiceOf(entry: RequestEntry, pending: Edit[]): Offered | null {
  let id = entry.chosen
  for (const edit of pending) if (edit.kind === 'choose' && edit.id === entry.id) id = edit.entry
  return offerOf(entry).find(o => o.id === id) ?? null
}

function selectedOf(state: ListState, entries: RequestEntry[]): string | null {
  if (state.selected === null) return entries[0]?.id ?? null
  return entries.some(e => e.id === state.selected) ? state.selected : null
}

function postOf(state: ListState, selected: string | null, edits = state.pending): RequestsMessage {
  return { instance: state.instance, selected, edits, caret: state.caret }
}

/** Drops the edits the hooks confirmed; null when none were. */
export function confirm(state: ListState, applied: number | undefined): ListState | null {
  if (applied === undefined || !state.pending.some(e => e.seq <= applied)) return null
  return { ...state, pending: state.pending.filter(e => e.seq > applied) }
}

/** This instance's unconfirmed edits of the card's value. */
function editsOf(entry: RequestEntry, pending: Edit[]): TextEdit[] {
  return pending.flatMap(edit =>
    'id' in edit && edit.id === entry.id && (edit.kind === 'insert' || edit.kind === 'back' || edit.kind === 'del' || edit.kind === 'clear') ? [edit] : [],
  )
}

/** The value's length as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownLength(entry: RequestEntry, pending: Edit[]): number {
  return editsOf(entry, pending).reduce(lengthAfter, entry.length)
}

/** A peeked value as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownText(text: string, entry: RequestEntry, pending: Edit[]): string {
  return editsOf(entry, pending).reduce(editText, text)
}

/** The card's value as its field draws it, unclipped: dots, or its text while peeked. */
function valueOf(entry: RequestEntry, pending: Edit[]): string {
  return entry.text === null ? '•'.repeat(shownLength(entry, pending)) : shownText(entry.text, entry, pending)
}

/**
 * Takes in the hooks' pastes this instance hasn't: the hooks made each at this list's caret, so on the selected card
 * the caret moves past it.
 */
export function withPastes(state: ListState, props: Pick<RequestsProps, 'pastes' | 'entries'>): ListState {
  let next = state
  for (const paste of props.pastes) {
    if (paste.seq <= next.pasted) continue
    next = { ...next, pasted: paste.seq, ...(paste.id === selectedOf(next, props.entries) ? { caret: paste.at + paste.length } : {}) }
  }
  return next
}

/** The columns of a card's field text: short of its Show button and its menu mark. */
export function fieldRoom(columns: number, hasMenu: boolean): number {
  return geometry(columns).fieldColumns - 4 - (hasMenu ? 2 : 0) - SHOW_COLUMNS
}

/** Whether a card's field takes typing now: no vault entry in it, typing not off. */
function takesTyping(entry: RequestEntry, pending: Edit[], frame: Frame): boolean {
  return entry.kind === 'secret' && choiceOf(entry, pending) === null && frame.typingOff === null
}

function wrapWords(text: string, width: number, maxRows: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(/\s+/).filter(w => w !== '')) {
    const joined = row === '' ? word : row + ' ' + word
    if (cells(joined) <= width) {
      row = joined
      continue
    }
    if (row !== '') rows.push(row)
    const pieces = rowsOf(word, width)
    rows.push(...pieces.slice(0, -1))
    row = pieces.at(-1)!
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

/** The grant buttons, right-aligned in the card as the field's ✕ is, a column apart; under a chosen entry, no ✕. */
export function grantButtons(columns: number, withCancel = true) {
  const { inner } = geometry(columns)
  const shown = GRANT_BUTTONS.filter(b => withCancel || b.kind !== 'cancel')
  const widths = shown.map(b => [...b.label].length + 2)
  const total = widths.reduce((sum, w) => sum + w, 0) + widths.length - 1
  let start = CARD_EDGE + inner - total
  return shown.map((b, i) => {
    const button = { ...b, start, width: widths[i]! }
    start += widths[i]! + 1
    return button
  })
}

/** The rows the request cards take; text from outside is drawn displayed (`display.ts`), one screen row each. */
export function layout(entries: RequestEntry[], columns: number, message: string | null, pending: Edit[] = []): Row[] {
  if (entries.length === 0 && message === null) return [{ id: null, kind: 'empty' }]
  const { inner, fieldColumns } = geometry(columns)
  const rows: Row[] = []
  if (message !== null) {
    const lines = wrapWords(displayed(message), fieldColumns, MESSAGE_MAX_ROWS)
    rows.push({ id: null, kind: 'msgTop' })
    for (let index = 0; index < Math.max(BUTTON_ROW_TEXT.length, lines.length); index++) {
      rows.push({ id: null, kind: 'msg', text: lines[index] ?? '', index })
    }
    rows.push({ id: null, kind: 'msgBottom' })
  }
  for (const entry of entries) {
    if (rows.length > 0) rows.push({ id: null, kind: 'gap' })
    rows.push({ id: entry.id, kind: 'cardTop' })
    rows.push({ id: entry.id, kind: 'what', text: displayed(entry.prompt), since: entry.since })
    if (entry.source !== '') {
      const from = rowsOf(displayed(entry.source), inner)
      const kept = from.slice(0, FROM_MAX_ROWS)
      if (from.length > FROM_MAX_ROWS) kept[FROM_MAX_ROWS - 1] = clip(kept[FROM_MAX_ROWS - 1]! + '…', inner)
      for (const text of kept) rows.push({ id: entry.id, kind: 'from', text })
    }
    const answer = entry.kind === 'sign' ? (['grantTop', 'grant', 'grantBottom'] as const) : (['fieldTop', 'field', 'fieldBottom'] as const)
    for (const kind of answer) rows.push({ id: entry.id, kind })
    if (choiceOf(entry, pending) !== null) for (const kind of ['pickTop', 'pick', 'pickBottom'] as const) rows.push({ id: entry.id, kind })
    rows.push({ id: entry.id, kind: 'cardBottom' })
  }
  return rows
}

/** The rows an open menu takes: its options shown and its border; one more when it scrolls. */
function menuHeight(count: number): number {
  return Math.min(count, MENU_ROWS) + 2 + (count > MENU_ROWS ? 1 : 0)
}

/**
 * The list's height in `rows` of room: a card and its gap short of it, since
 * the room's bottom edge may be off screen or under the engine's pill. With a
 * menu to open, room for it under the last card's field.
 */
export function listHeight(entries: RequestEntry[], columns: number, message: string | null, rows: number): number {
  const counts = new Map<string, number>()
  for (const row of layout(entries, columns, null)) if (row.id !== null) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const tallestCard = Math.max(0, ...counts.values()) + 1
  const menuRoom = Math.max(0, ...entries.map(e => (offerOf(e).length > 0 ? menuHeight(offerOf(e).length + 1) : 0)))
  return Math.min(layout(entries, columns, message).length + menuRoom, rows - tallestCard)
}

type Window = { head: Row[]; body: Row[]; top: number; room: number; fits: boolean }

/** The message rows, the card rows, and which card rows fit under the message. */
function windowOf(entries: RequestEntry[], frame: Frame, state: ListState): Window {
  const all = layout(entries, frame.columns, frame.message, state.pending)
  const headLength = all.findIndex(r => r.kind === 'msgBottom') + 1
  const head = all.slice(0, headLength)
  const body = all.slice(headLength)
  if (all.length <= frame.rows) return { head, body, top: 0, room: body.length, fits: true }
  const room = Math.max(1, frame.rows - headLength - 2)
  return { head, body, top: Math.max(0, Math.min(state.scroll, body.length - room)), room, fits: false }
}

export function view(entries: RequestEntry[], frame: Frame, state: ListState): ViewRow[] {
  const w = windowOf(entries, frame, state)
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

/** The selected card's open menu, placed under its field, or above it when the room below is short; null when shut or not on screen. */
export function menuOf(entries: RequestEntry[], frame: Frame, state: ListState): Menu | null {
  if (!state.isMenuOpen) return null
  const entry = entries.find(e => e.id === selectedOf(state, entries))
  if (entry === undefined || offerOf(entry).length === 0) return null
  const rows = view(entries, frame, state)
  const fieldTop = rows.findIndex(r => r.id === entry.id && r.kind === 'fieldTop')
  if (fieldTop < 0) return null
  const options = [TYPE_OPTION, ...offerOf(entry).map(o => displayed(o.label))]
  const height = menuHeight(options.length)
  const below = fieldTop + 3
  const top = below + height <= frame.rows || fieldTop - height < 0 ? below : fieldTop - height
  const cursor = optionIds(entry).indexOf(state.cursor)
  const first = Math.max(0, Math.min(options.length - MENU_ROWS, cursor - MENU_ROWS + 1))
  const { fieldColumns } = geometry(frame.columns)
  return { id: entry.id, top, left: CARD_EDGE, width: fieldColumns, first, shown: Math.min(options.length, MENU_ROWS), cursor, options }
}

/** The scroll that shows the card whole, or from its top when it is taller than the window. */
function reveal(entries: RequestEntry[], frame: Frame, state: ListState, id: string): number {
  const w = windowOf(entries, frame, state)
  if (w.fits) return 0
  const start = w.body.findIndex(r => r.id === id && r.kind === 'cardTop')
  const end = w.body.findIndex(r => r.id === id && r.kind === 'cardBottom')
  if (start < w.top) return start
  if (end >= w.top + w.room) return Math.min(start, end - w.room + 1)
  return w.top
}

/** Selects the card and scrolls to it; tells the hooks when the selection changed, or always when `tell`. */
function selectCard(state: ListState, entries: RequestEntry[], frame: Frame, id: string, tell = false): Result {
  const isNew = id !== selectedOf(state, entries)
  const moved = { ...state, selected: id, isFocused: true, isMenuOpen: false, caret: isNew ? END_CARET : state.caret }
  const shown = { ...moved, scroll: reveal(entries, frame, moved, id) }
  return tell || isNew ? { state: shown, post: postOf(shown, id) } : { state: shown }
}

/** Opens the card's menu on what its field holds now, the card scrolled into view. */
function openMenu(state: ListState, entries: RequestEntry[], frame: Frame, entry: RequestEntry): Result {
  const opened = { ...state, selected: entry.id, isFocused: true, isMenuOpen: true, cursor: choiceOf(entry, state.pending)?.id ?? null }
  return { state: { ...opened, scroll: reveal(entries, frame, opened, entry.id) }, post: postOf(state, entry.id) }
}

type EditBody = Edit extends infer E ? (E extends Edit ? Omit<E, 'seq'> : never) : never

function withEdit(state: ListState, selected: string | null, edit: EditBody): Result {
  const seq = state.seq + 1
  const pending = [...state.pending, { ...edit, seq } as Edit]
  return { state: { ...state, seq, pending, selected, isFocused: true }, post: postOf(state, selected, pending) }
}

/** The menu's option `index` goes into the field: 0 makes it take typing, any other is that entry. */
function choose(state: ListState, entry: RequestEntry, index: number): Result {
  const chosen = index === 0 ? null : (offerOf(entry)[index - 1]?.id ?? null)
  return withEdit({ ...state, isMenuOpen: false }, entry.id, { id: entry.id, kind: 'choose', entry: chosen })
}

export function onKey(state: ListState, entries: RequestEntry[], frame: Frame, k: ClientKeyEvent): Result {
  const selected = selectedOf(state, entries)
  if (selected === null) {
    // The selected card left: the keys wait for a new selection rather than go to another card.
    const closed = { ...state, isMenuOpen: false }
    const first = k.key === 'down' || k.key === 'home' ? entries[0] : k.key === 'up' || k.key === 'end' ? entries.at(-1) : undefined
    return first === undefined ? { state: closed } : selectCard(closed, entries, frame, first.id, true)
  }
  const at = entries.findIndex(e => e.id === selected)
  const entry = entries[at]!
  const offer = offerOf(entry)
  const isEnter = k.key === 'return' || k.key === '\n'
  if (state.isMenuOpen) {
    const menu = menuOf(entries, frame, state)
    // A menu no longer drawn takes the key that finds it gone, rather than let it act on a card unseen.
    if (menu === null) return { state: { ...state, isMenuOpen: false } }
    const ids = optionIds(entry)
    // With the highlighted entry gone, an arrow starts again from Type.
    if (k.key === 'up') return { state: { ...state, cursor: ids[Math.max(0, menu.cursor - 1)]! } }
    if (k.key === 'down') return { state: { ...state, cursor: ids[menu.cursor < 0 ? 0 : Math.min(offer.length, menu.cursor + 1)]! } }
    if (isEnter) return menu.cursor < 0 ? { state } : choose(state, entry, menu.cursor)
    if (k.key === 'tab') return { state: { ...state, isMenuOpen: false } }
    return { state }
  }
  // Escape never reaches a Client and ↑/↓ move between cards, so Tab opens the menu.
  if (k.key === 'tab' && offer.length > 0) return openMenu(state, entries, frame, entry)
  // Home and End go to the first and last card, unless the card takes typing: there they move the caret.
  const typing = takesTyping(entry, state.pending, frame)
  const jumps: Record<string, number> = typing ? { up: at - 1, down: at + 1 } : { up: at - 1, down: at + 1, home: 0, end: entries.length - 1 }
  const to = jumps[k.key]
  if (to !== undefined) return selectCard(state, entries, frame, entries[Math.max(0, Math.min(entries.length - 1, to))]!.id)
  if (entry.kind === 'sign') return isEnter ? withEdit(state, selected, { id: selected, kind: 'once', entry: null }) : { state }
  const chosen = choiceOf(entry, state.pending)
  if (chosen !== null) return isEnter ? withEdit(state, selected, { id: selected, kind: 'once', entry: chosen.id }) : { state }
  if (frame.typingOff !== null) return { state }
  if (isEnter) return withEdit(state, selected, { id: selected, kind: 'submit' })
  if (k.ctrl && k.key === 'r') return withEdit(state, selected, { id: selected, kind: 'peek' })
  const change = textKey(k, state.caret, shownLength(entry, state.pending))
  if (change === null) return { state }
  if (change.kind === 'move') return { state: { ...state, caret: change.caret, isFocused: true } }
  return withEdit({ ...state, caret: caretAfter(change) }, selected, { id: selected, ...change })
}

/** Another tab was clicked: a numbered edit, so a later post in the same frame keeps it. */
export function onTab(state: ListState, entries: RequestEntry[], tab: Tab): Result {
  return withEdit(state, selectedOf(state, entries), { kind: 'tab', tab })
}

/** A click gives the list the keyboard, so it always tells the hooks what is selected. */
export function onClick(state: ListState, entries: RequestEntry[], frame: Frame, y: number, x: number): Result {
  const menu = menuOf(entries, frame, state)
  if (menu !== null) {
    const entry = entries.find(e => e.id === menu.id)!
    const inside = x >= menu.left && x < menu.left + menu.width && y >= menu.top && y < menu.top + menuHeight(menu.options.length)
    if (inside && y > menu.top && y <= menu.top + menu.shown) return choose(state, entry, menu.first + y - menu.top - 1)
    if (inside) return { state }
    // A click outside shuts the menu and goes on to what it hit.
    state = { ...state, isMenuOpen: false }
  }
  const row = view(entries, frame, state)[y]
  const current = selectedOf(state, entries)
  const { buttonStart } = geometry(frame.columns)
  const onButton = x >= buttonStart && x < buttonStart + BUTTON_COLUMNS
  const focused = { ...state, isFocused: true }
  if (row?.kind === 'more') {
    const w = windowOf(entries, frame, state)
    const id =
      row.dir === 'up'
        ? w.body.slice(0, w.top).filter(r => r.kind === 'cardTop').at(-1)?.id
        : w.body.slice(w.top + w.room).find(r => r.kind === 'cardBottom')?.id
    if (id != null) return selectCard(state, entries, frame, id, true)
  }
  if (row?.kind === 'msg' && row.index < BUTTON_ROW_TEXT.length && onButton) return withEdit(state, current, { kind: 'dismiss' })
  if (row?.id == null) return { state: focused, post: postOf(state, current) }
  const entry = entries.find(e => e.id === row.id)!
  const isField = row.kind === 'fieldTop' || row.kind === 'field' || row.kind === 'fieldBottom'
  if (isField && onButton) return withEdit(state, current, { id: row.id, kind: 'cancel' })
  const showStart = FIELD_TEXT_START + fieldRoom(frame.columns, offerOf(entry).length > 0)
  if (row.kind === 'field' && x >= showStart && x < showStart + SHOW_COLUMNS && takesTyping(entry, state.pending, frame)) {
    return withEdit(state, row.id, { id: row.id, kind: 'peek' })
  }
  // A click on the field, whatever it holds, opens its menu.
  if (isField && offerOf(entry).length > 0) return openMenu(state, entries, frame, entry)
  if (row.kind === 'field' && x >= FIELD_TEXT_START && x < showStart && takesTyping(entry, state.pending, frame)) {
    const drawnCaret = row.id === current && state.isFocused ? state.caret : null
    const caret = caretAt(valueOf(entry, state.pending), drawnCaret, fieldRoom(frame.columns, false), x - FIELD_TEXT_START)
    const placed = { ...focused, selected: row.id, caret }
    return { state: placed, post: postOf(placed, row.id) }
  }
  if (row.kind === 'grantTop' || row.kind === 'grant' || row.kind === 'grantBottom') {
    const button = grantButtons(frame.columns).find(b => x >= b.start && x < b.start + b.width)
    if (button?.kind === 'cancel') return withEdit(state, current, { id: row.id, kind: 'cancel' })
    if (button !== undefined) return withEdit(state, current, { id: row.id, kind: button.kind, entry: null })
  }
  const chosen = choiceOf(entry, state.pending)
  if (chosen !== null && (row.kind === 'pickTop' || row.kind === 'pick' || row.kind === 'pickBottom')) {
    const button = grantButtons(frame.columns, false).find(b => x >= b.start && x < b.start + b.width)
    if (button !== undefined && button.kind !== 'cancel') return withEdit(state, current, { id: row.id, kind: button.kind, entry: chosen.id })
  }
  const selecting = { ...focused, selected: row.id, caret: row.id === current ? state.caret : END_CARET }
  return { state: selecting, post: postOf(selecting, row.id) }
}

/** Every change posts, with the state the next instance resumes from. */
function sent(result: Result, entries: RequestEntry[]): RequestsMessage {
  const { pending: _pending, ...ui } = result.state
  return { ...(result.post ?? postOf(result.state, selectedOf(result.state, entries))), ui }
}

const Requests: ClientModule<RequestsProps, ListState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { columns } = props
  const frame: Frame = { columns, rows: props.rows, message: props.message, typingOff: props.typingOff }
  const tabRows = props.tabs === null ? 0 : TAB_ROWS
  surface.onPointer(p => {
    if (p.type !== 'down') return
    if (p.y < tabRows) {
      const tab = p.y === 0 && props.tabs !== null ? tabAt(props.tabs, p.x) : null
      if (tab === null || tab === 'requests') return
      const result = onTab(surface.state as ListState, props.entries, tab)
      surface.setState(result.state)
      surface.post(sent(result, props.entries))
      return
    }
    const result = onClick(surface.state as ListState, props.entries, frame, p.y - tabRows, p.x)
    surface.setState(result.state)
    surface.post(sent(result, props.entries))
  })
  surface.onKey(k => {
    const result = onKey(surface.state as ListState, props.entries, frame, k)
    surface.setState(result.state)
    surface.post(sent(result, props.entries))
  })
  let state = surface.state ?? (props.resume === null ? initialState(props.focusEpoch, Math.random().toString(36).slice(2)) : { ...props.resume, pending: [] })
  const confirmed = confirm(state, props.applied[state.instance])
  if (confirmed !== null) state = confirmed
  if (state.epoch !== props.focusEpoch) state = { ...state, isFocused: false, isMenuOpen: false, epoch: props.focusEpoch }
  const pasted = withPastes(state, props)
  if (state !== surface.state || pasted !== state) surface.setState(pasted)
  // The hooks drop a paste once a post says it was taken in.
  if (pasted !== state) surface.post(sent({ state: pasted }, props.entries))
  state = pasted

  const selected = selectedOf(state, props.entries)
  const entriesById = new Map(props.entries.map(e => [e.id, e]))
  const { inner, fieldColumns } = geometry(columns)
  const active = (id: string) => id === selected && state.isFocused
  const look = (id: string) => (active(id) ? { color: 'claude' as const, bold: true } : { dimColor: true })
  const line = (id: string, children: ReturnType<typeof Text>[]) =>
    Box({ flexDirection: 'row', children: [Text({ ...look(id), children: ['│ '] }), ...children, Text({ ...look(id), children: [' │'] })] })

  const rows = view(props.entries, frame, state).map(row => {
    switch (row.kind) {
      case 'empty':
        return Text({ dimColor: true, children: [pad('No requests', columns)] })
      case 'more': {
        const label = row.count === 0 ? '' : `${row.dir === 'up' ? '▲' : '▼'} ${row.count} more`
        return Text({ dimColor: true, children: [pad(' '.repeat(Math.floor((columns - cells(label)) / 2)) + label, columns)] })
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
        const entry = entriesById.get(row.id)!
        const hasMenu = offerOf(entry).length > 0
        const room = fieldRoom(columns, hasMenu)
        const chosen = choiceOf(entry, state.pending)
        const count = shownLength(entry, state.pending)
        const isOff = chosen === null && props.typingOff !== null
        const typing = active(row.id) && chosen === null && !isOff
        const shown =
          chosen !== null
            ? clip(displayed(chosen.label), room)
            : isOff
              ? clip(displayed(props.typingOff!), room)
              : typing || count > 0
                ? caretText(valueOf(entry, state.pending), typing ? state.caret : null, room)
                : 'type or paste'
        const isDim = chosen === null && !typing && (count === 0 || isOff)
        const show = takesTyping(entry, state.pending, frame) ? (entry.text === null ? ' Show' : ' Hide') : ' '.repeat(SHOW_COLUMNS)
        return line(row.id, [
          Text({ ...look(row.id), children: ['│ '] }),
          Text({ backgroundColor: FIELD_BACKGROUND, bold: active(row.id), dimColor: isDim, children: [pad(shown, room)] }),
          Text({ backgroundColor: FIELD_BACKGROUND, color: 'claude', underline: true, children: [show] }),
          Text({ backgroundColor: FIELD_BACKGROUND, color: 'claude', children: [hasMenu ? ' ▾' : ''] }),
          Text({ ...look(row.id), children: [' │ '] }),
          Text({ color: 'error', children: [BUTTON_ROW_TEXT[1]] }),
        ])
      }
      case 'grantTop':
      case 'grant':
      case 'grantBottom':
      case 'pickTop':
      case 'pick':
      case 'pickBottom': {
        const isGrant = row.kind === 'grantTop' || row.kind === 'grant' || row.kind === 'grantBottom'
        const buttons = grantButtons(columns, isGrant)
        const position = row.kind === 'grantTop' || row.kind === 'pickTop' ? 'top' : row.kind === 'grantBottom' || row.kind === 'pickBottom' ? 'bottom' : 'middle'
        const face = (label: string, width: number) => (position === 'top' ? edge('top', width) : position === 'bottom' ? edge('bottom', width) : '│' + label + '│')
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
  // Every row of the room is drawn, blank ones too, so nothing an earlier frame drew (a shut menu) stays.
  while (rows.length < props.rows) rows.push(Text({ children: [' '.repeat(columns)] }))
  const menu = menuOf(props.entries, frame, state)
  const window =
    menu === null
      ? []
      : [
          Box({
            position: 'absolute',
            top: tabRows + menu.top,
            left: menu.left,
            flexDirection: 'column',
            children: [
              Text({ color: 'claude', children: [edge('top', menu.width)] }),
              ...menu.options.slice(menu.first, menu.first + menu.shown).map((option, i) => {
                const isCursor = menu.first + i === menu.cursor
                return Box({
                  flexDirection: 'row',
                  children: [
                    Text({ color: 'claude', children: ['│'] }),
                    Text({
                      backgroundColor: FIELD_BACKGROUND,
                      ...(isCursor ? { color: 'claude' as const, bold: true } : {}),
                      children: [pad((isCursor ? ' ▸ ' : '   ') + clip(option, menu.width - 5), menu.width - 2)],
                    }),
                    Text({ color: 'claude', children: ['│'] }),
                  ],
                })
              }),
              ...(menu.options.length > MENU_ROWS
                ? [
                    Box({
                      flexDirection: 'row',
                      children: [
                        Text({ color: 'claude', children: ['│'] }),
                        Text({ backgroundColor: FIELD_BACKGROUND, dimColor: true, children: [pad(`   ${menu.cursor < 0 ? '–' : menu.cursor + 1} of ${menu.options.length}, ↑/↓`, menu.width - 2)] }),
                        Text({ color: 'claude', children: ['│'] }),
                      ],
                    }),
                  ]
                : []),
              Text({ color: 'claude', children: [edge('bottom', menu.width)] }),
            ],
          }),
        ]
  const tabs = props.tabs === null ? [] : drawTabs(surface.elements, props.tabs, columns)
  return Box({ flexDirection: 'column', width: columns, children: [...tabs, ...rows, ...window] })
}

export default Requests
