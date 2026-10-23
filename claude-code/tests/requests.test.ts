import { expect, test } from 'claude-code/testing'

import {
  choiceOf,
  confirm,
  fieldRoom,
  type Frame,
  geometry,
  grantButtons,
  initialState,
  type ListState,
  layout,
  listHeight,
  onClick,
  onKey,
  MENU_ROWS,
  menuOf,
  shownLength,
  shownText,
  TYPE_OPTION,
  view,
  withPastes,
} from '../hooks/requests'
import { END_CARET } from '../hooks/controls'
import type { RequestEntry } from '../hooks/requests-props'

const entry = (id: string, prompt: string, length = 0): RequestEntry => ({ id, kind: 'secret', prompt, source: 'echo', since: '04:00:00', length, text: null, offer: null, chosen: null })
const ENTRIES = [entry('a', '[sudo] password for alex'), entry('b', 'test token')]
const START = initialState(0, 'i1')
const FRAME: Frame = { columns: 60, rows: 100, message: null, typingOff: null }
/** Five 7-row cards with gaps between: 39 rows. */
const MANY = ['a', 'b', 'c', 'd', 'e'].map(id => entry(id, 'token ' + id))
/** Room for two cards and the gap between them under the two markers. */
const SHORT: Frame = { columns: 60, rows: 17, message: null, typingOff: null }

function type(state: ListState, ...keys: string[]) {
  for (const key of keys) state = onKey(state, ENTRIES, FRAME, { key }).state
  return state
}

test('typing becomes numbered edits for the first request', async () => {
  const state = type(START, 'h', 'hunter2')
  expect(state.pending).toEqual([
    { seq: 1, id: 'a', kind: 'insert', at: 0, text: 'h' },
    { seq: 2, id: 'a', kind: 'insert', at: 1, text: 'hunter2' },
  ])
  expect(shownLength(ENTRIES[0]!, state.pending)).toBe(8)
})

test('every post carries all unconfirmed edits, so a replaced post loses none', async () => {
  const typed = type(START, 'a')
  const { post } = onKey(typed, ENTRIES, FRAME, { key: 'b' })
  expect(post?.edits.map(e => e.seq)).toEqual([1, 2])
  expect(post?.instance).toBe('i1')
})

test('confirmed edits drop out; the shown length comes from the hooks then', async () => {
  const typed = type(START, 'ab', 'c')
  const confirmed = confirm(typed, 1)!
  expect(confirmed.pending.map(e => e.seq)).toEqual([2])
  expect(shownLength(entry('a', 'p', 2), confirmed.pending)).toBe(3)
  expect(confirm(confirmed, 1)).toBe(null)
  expect(confirm(confirmed, undefined)).toBe(null)
})

test('space arrives named; special keys and control sequences type nothing', async () => {
  expect(type(START, 'space').pending).toEqual([{ seq: 1, id: 'a', kind: 'insert', at: 0, text: ' ' }])
  expect(type(START, 'tab', 'left', '\x1bOP').pending).toEqual([])
})

test('backspace, ctrl+u and Enter are edits too, in order', async () => {
  const state = onKey(type(START, 'x', 'backspace'), ENTRIES, FRAME, { key: 'u', ctrl: true }).state
  const { post } = onKey(state, ENTRIES, FRAME, { key: 'return' })
  expect(post?.edits.map(e => e.kind)).toEqual(['insert', 'back', 'clear', 'submit'])
  expect(shownLength(entry('a', 'p', 5), state.pending)).toBe(0)
})

test('Ctrl+R or a click on Show asks to see the typed value; a card holding a vault entry has none', async () => {
  expect(onKey(START, ENTRIES, FRAME, { key: 'r', ctrl: true }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'peek' }])
  const fieldRow = view(ENTRIES, FRAME, START).findIndex(r => r.id === 'a' && r.kind === 'field')
  const show = 4 + fieldRoom(FRAME.columns, false)
  for (const x of [show, show + 4]) expect(onClick(START, ENTRIES, FRAME, fieldRow, x).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'peek' }])
  expect(onClick(START, ENTRIES, FRAME, fieldRow, show - 1).post?.edits).toEqual([])
  expect(onClick(START, ENTRIES, FRAME, fieldRow, show + 5).post?.edits).toEqual([])
  const offered = [{ ...entry('a', 'db'), offer: [{ id: 'e1', label: 'Prod DB · db' }], chosen: 'e1' }]
  expect(onClick(START, offered, FRAME, fieldRow, 4 + fieldRoom(FRAME.columns, true)).state.isMenuOpen).toBe(true)
  expect(shownText('abc', entry('a', 'p'), [{ seq: 1, id: 'a', kind: 'insert', at: 1, text: 'd' }, { seq: 2, id: 'b', kind: 'clear' }])).toBe('adbc')
})

test('down switches requests and tells the hooks; typing then goes to the new one', async () => {
  expect(onKey(START, ENTRIES, FRAME, { key: 'down' }).post).toEqual({ instance: 'i1', selected: 'b', edits: [], caret: END_CARET })
  const state = type(START, 'down', 'y')
  expect(state.pending).toEqual([{ seq: 1, id: 'b', kind: 'insert', at: 0, text: 'y' }])
})

test("a card's value edits at a caret: ←/→, Home/End, Backspace before it, Delete after it; the post says where it is", async () => {
  const typed = entry('a', 'p', 6)
  const list = [typed, ENTRIES[1]!]
  const keys = (state: ListState, ...names: string[]) => names.reduce((s, key) => onKey(s, list, FRAME, { key }).state, state)
  const moved = keys(START, 'left', 'left')
  expect([moved.caret, moved.pending]).toEqual([4, []])
  const edited = keys(moved, 'x', 'backspace', 'delete', 'home', 'delete')
  expect(edited.pending.map(e => ('at' in e ? `${e.kind}@${e.at}` : e.kind))).toEqual(['insert@4', 'back@5', 'del@4', 'del@0'])
  expect(shownLength(typed, edited.pending)).toBe(4)
  expect(edited.caret).toBe(0)
  expect(onKey(edited, list, FRAME, { key: 'end' }).state.caret).toBe(4)
  expect(onKey(edited, list, FRAME, { key: 'end' }).state.selected).toBe('a')
  expect(onKey(moved, list, FRAME, { key: 'q' }).post?.caret).toBe(5)
})

test('a click on a typing card\'s value puts the caret there; the hooks\' paste moves it past what was pasted', async () => {
  const typed = { ...entry('a', 'p', 6), text: 'abcdef' }
  const field = layout([typed], 60, null).findIndex(r => r.kind === 'field')
  const focused = { ...START, isFocused: true, selected: 'a' }
  const placed = onClick(focused, [typed], FRAME, field, 4 + 2)
  expect([placed.state.caret, placed.post?.caret]).toEqual([2, 2])
  expect(onClick(START, [typed], FRAME, field, 4 + 30).state.caret).toBe(6)
  const pastes = [{ seq: 9, id: 'a', at: 2, length: 3 }]
  const taken = withPastes(placed.state, { pastes, entries: [typed] })
  expect([taken.caret, taken.pasted]).toEqual([5, 9])
  expect(withPastes(taken, { pastes, entries: [typed] })).toBe(taken)
  expect(withPastes(placed.state, { pastes: [{ ...pastes[0]!, id: 'b' }], entries: [typed] }).caret).toBe(2)
})

test('every request is a card: what, where from, then its field and Cancel', async () => {
  expect(layout(ENTRIES, 60, null).map(r => r.kind)).toEqual([
    'cardTop', 'what', 'from', 'fieldTop', 'field', 'fieldBottom', 'cardBottom',
    'gap',
    'cardTop', 'what', 'from', 'fieldTop', 'field', 'fieldBottom', 'cardBottom',
  ])
  expect(layout([], 60, null)).toEqual([{ id: null, kind: 'empty' }])
})

test('a message sits above the cards, at least as tall as its ✕; alone it replaces the empty note', async () => {
  expect(layout(ENTRIES.slice(0, 1), 60, 'Short.').map(r => r.kind)).toEqual([
    'msgTop', 'msg', 'msg', 'msg', 'msgBottom',
    'gap',
    'cardTop', 'what', 'from', 'fieldTop', 'field', 'fieldBottom', 'cardBottom',
  ])
  expect(layout([], 60, 'Short.').map(r => r.kind)).toEqual(['msgTop', 'msg', 'msg', 'msg', 'msgBottom'])
})

test('a message wraps at word boundaries within the room left of the ✕', async () => {
  const text = 'A paste of 3+ lines or 800+ characters went into the prompt, not the request.'
  const lines = (layout([], 40, text).filter(r => r.kind === 'msg') as { text: string }[]).map(r => r.text).filter(t => t !== '')
  expect(lines.join(' ')).toBe(text)
  for (const line of lines) expect([...line].length <= geometry(40).fieldColumns).toBe(true)
})

test('a long source wraps over the card, at most four rows', async () => {
  const long = [{ ...entry('a', 'p'), source: 'x'.repeat(300) }]
  const from = layout(long, 60, null).filter(r => r.kind === 'from') as { text: string }[]
  expect(from.length).toBe(4)
  expect(from[0]!.text.length).toBe(geometry(60).inner)
  expect(from[3]!.text.endsWith('…')).toBe(true)
})

test('a click on a card selects it and tells the hooks; on its Cancel button, cancels it', async () => {
  const rows = layout(ENTRIES, 60, null)
  const bWhat = rows.findIndex(r => r.id === 'b' && r.kind === 'what')
  expect(onClick(START, ENTRIES, FRAME, bWhat, 3)).toEqual({
    state: { ...START, selected: 'b', isFocused: true },
    post: { instance: 'i1', selected: 'b', edits: [], caret: END_CARET },
  })
  const bField = rows.findIndex(r => r.id === 'b' && r.kind === 'field')
  const { buttonStart } = geometry(60)
  expect(onClick(START, ENTRIES, FRAME, bField, buttonStart + 1).post?.edits).toEqual([{ seq: 1, id: 'b', kind: 'cancel' }])
  expect(onClick(START, ENTRIES, FRAME, bField - 1, buttonStart).post?.edits).toEqual([{ seq: 1, id: 'b', kind: 'cancel' }])
  expect(onClick(START, ENTRIES, FRAME, bField, buttonStart - 2).post).toEqual({ instance: 'i1', selected: 'b', edits: [], caret: END_CARET })
  const gap = rows.findIndex(r => r.kind === 'gap')
  expect(onClick(START, ENTRIES, FRAME, gap, 3).post).toEqual({ instance: 'i1', selected: 'a', edits: [], caret: END_CARET })
})

test("a click on the message's ✕ dismisses it; elsewhere on it, only focuses", async () => {
  const { buttonStart } = geometry(60)
  for (const y of [1, 2, 3]) {
    expect(onClick(START, ENTRIES, { ...FRAME, message: 'Short.' }, y, buttonStart + 2).post).toEqual({ instance: 'i1', selected: 'a', edits: [{ seq: 1, kind: 'dismiss' }], caret: END_CARET })
  }
  expect(onClick(START, ENTRIES, { ...FRAME, message: 'Short.' }, 2, 3).post).toEqual({ instance: 'i1', selected: 'a', edits: [], caret: END_CARET })
  expect(onClick(START, ENTRIES, { ...FRAME, message: 'Short.' }, 0, buttonStart + 2).post).toEqual({ instance: 'i1', selected: 'a', edits: [], caret: END_CARET })
})

test('cards past the room scroll in a window between markers counting the cards cut off', async () => {
  const rows = view(MANY, SHORT, START)
  expect(rows.length).toBe(17)
  expect(rows[0]).toEqual({ id: null, kind: 'more', dir: 'up', count: 0 })
  expect(rows[16]).toEqual({ id: null, kind: 'more', dir: 'down', count: 3 })
  expect(rows.slice(1, 16).map(r => r.id)).toEqual([...'aaaaaaa', null, ...'bbbbbbb'])
  expect(view(MANY, SHORT, { ...START, scroll: 999 }).slice(1, 16).map(r => r.id)).toEqual([...'ddddddd', null, ...'eeeeeee'])
  expect(view(ENTRIES, SHORT, { ...START, scroll: 5 }).map(r => r.kind)).toEqual(layout(ENTRIES, 60, null).map(r => r.kind))
})

test('the arrows move the selection and the window follows to show the selected card whole', async () => {
  let state = START
  const press = (key: string) => (state = onKey(state, MANY, SHORT, { key }).state)
  press('down')
  expect([state.selected, state.scroll]).toEqual(['b', 0])
  press('down')
  expect([state.selected, state.scroll]).toEqual(['c', 8])
  expect(view(MANY, SHORT, state)[0]).toEqual({ id: null, kind: 'more', dir: 'up', count: 1 })
  press('up')
  expect([state.selected, state.scroll]).toEqual(['b', 8])
  press('end')
  expect([state.selected, state.scroll]).toEqual(['b', 8])
  // Home and End move a typing card's caret; on cards that take no typing they jump to the first and last.
  const signs = MANY.map(e => ({ ...e, kind: 'sign' as const }))
  state = onKey(state, signs, SHORT, { key: 'end' }).state
  expect([state.selected, state.scroll]).toEqual(['e', 24])
  state = onKey(state, signs, SHORT, { key: 'home' }).state
  expect([state.selected, state.scroll]).toEqual(['a', 0])
})

test('a click on a marker selects the next card cut off that way and scrolls to it', async () => {
  const at = { ...START, selected: 'c', scroll: 8 }
  expect(onClick(at, MANY, SHORT, 0, 3)).toEqual({
    state: { ...at, selected: 'a', isFocused: true, scroll: 0 },
    post: { instance: 'i1', selected: 'a', edits: [], caret: END_CARET },
  })
  expect(onClick(at, MANY, SHORT, 16, 3).state).toEqual({ ...at, selected: 'd', isFocused: true, scroll: 16 })
  expect(onClick(START, MANY, SHORT, 0, 3).post).toEqual({ instance: 'i1', selected: 'a', edits: [], caret: END_CARET })
})

test('the list stays its tallest card and gap short of the room; a list that fits keeps its height', async () => {
  expect(listHeight(MANY, 60, null, 30)).toBe(22)
  expect(listHeight([...MANY, { ...entry('f', 'p'), source: 'x'.repeat(300) }], 60, null, 30)).toBe(19)
  expect(listHeight(ENTRIES, 60, null, 100)).toBe(15)
  expect(listHeight([], 60, null, 30)).toBe(1)
})

test('a message stays on top while the cards under it scroll', async () => {
  const frame = { ...SHORT, message: 'Short.' }
  const rows = view(MANY, frame, { ...START, scroll: 999 })
  expect(rows.length).toBe(17)
  expect(rows.slice(0, 6).map(r => r.kind)).toEqual(['msgTop', 'msg', 'msg', 'msg', 'msgBottom', 'more'])
  expect(rows.at(-2)).toEqual({ id: 'e', kind: 'cardBottom' })
})

test('a sign card answers by its buttons and Enter gives once; typing does nothing to it', async () => {
  const entries: RequestEntry[] = [{ ...entry('g', 'Deploy key · deploy'), kind: 'sign' }]
  const rows = layout(entries, 60, null)
  expect(rows.map(r => r.kind)).toEqual(['cardTop', 'what', 'from', 'grantTop', 'grant', 'grantBottom', 'cardBottom'])
  const at = rows.findIndex(r => r.kind === 'grant')
  const kinds = grantButtons(60).map(b => onClick(START, entries, FRAME, at, b.start + 1).post?.edits[0]?.kind)
  expect(kinds).toEqual(['session', 'once', 'cancel'])
  expect(onClick(START, entries, FRAME, at - 1, grantButtons(60)[0]!.start).post?.edits).toEqual([{ seq: 1, id: 'g', kind: 'session', entry: null }])
  expect(onClick(START, entries, FRAME, at, grantButtons(60)[0]!.start - 2).post?.edits).toEqual([])
  expect(onKey(START, entries, FRAME, { key: 'return' }).post?.edits).toEqual([{ seq: 1, id: 'g', kind: 'once', entry: null }])
  expect(onKey(START, entries, FRAME, { key: 'x' }).post).toBe(undefined)
})

test('a card with no source command has no source row', async () => {
  const entries: RequestEntry[] = [{ ...entry('u', 'Password:'), source: '' }]
  expect(layout(entries, 60, null).map(r => r.kind)).toEqual(['cardTop', 'what', 'fieldTop', 'field', 'fieldBottom', 'cardBottom'])
})

/** The ▾ at the end of a field offering vault entries, past its text and Show. */
const ARROW = 4 + fieldRoom(FRAME.columns, true) + 5
const OFFER = ['Prod DB · db', 'Deploy · deploy', 'S3 · s3', 'SMTP · smtp', 'Sentry · sentry', 'Grafana · grafana', 'GitHub · gh', 'Stage DB · db2'].map(
  (label, i) => ({ id: `e${i}`, label }),
)

test('a request naming its key holds that entry in its field: Session, Once, or Enter gives it; typing does nothing', async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'DB password'), offer: OFFER, chosen: 'e0' }]
  const rows = layout(entries, 60, null)
  expect(rows.map(r => r.kind).slice(-4)).toEqual(['pickTop', 'pick', 'pickBottom', 'cardBottom'])
  expect(choiceOf(entries[0]!, [])).toEqual(OFFER[0])
  const at = rows.findIndex(r => r.kind === 'pick')
  const [session, once] = grantButtons(60, false)
  expect(onClick(START, entries, FRAME, at, session!.start + 1).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'session', entry: 'e0' }])
  expect(onClick(START, entries, FRAME, at, once!.start + 1).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'once', entry: 'e0' }])
  expect(onKey(START, entries, FRAME, { key: 'return' }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'once', entry: 'e0' }])
  expect(onKey(START, entries, FRAME, { key: 'x' }).post).toBe(undefined)
  expect(onKey(START, entries, FRAME, { key: 'backspace' }).post).toBe(undefined)
})

test('a request naming no key is a bare field that takes typing; a click in it types, its ▾ opens the menu: Type, then the entries', async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'deploy token'), offer: OFFER }]
  const rows = layout(entries, 60, null)
  expect(rows.map(r => r.kind)).toEqual(['cardTop', 'what', 'from', 'fieldTop', 'field', 'fieldBottom', 'cardBottom'])
  expect(onKey(START, entries, FRAME, { key: 'x' }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'insert', at: 0, text: 'x' }])
  const field = rows.findIndex(r => r.kind === 'field')
  for (const y of [field - 1, field, field + 1]) {
    const placed = onClick(START, entries, FRAME, y, 6).state
    expect(placed).toMatchObject({ isMenuOpen: false, isFocused: true, selected: 'a' })
    expect(onKey(placed, entries, FRAME, { key: 'x' }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'insert', at: 0, text: 'x' }])
  }
  const opened = onClick(START, entries, FRAME, field, ARROW).state
  expect(opened).toMatchObject({ isMenuOpen: true, cursor: null, selected: 'a' })
  const menu = menuOf(entries, FRAME, opened)!
  expect(menu).toMatchObject({ id: 'a', top: field + 2, first: 0, shown: MENU_ROWS })
  expect(menu.options).toEqual([TYPE_OPTION, ...OFFER.map(o => o.label)])
  expect(menuOf(entries, FRAME, START)).toBe(null)
})

test('in the menu ↑/↓ move, Enter or a click chooses, Tab or a click outside shuts it', async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'deploy token'), offer: OFFER }]
  const field = layout(entries, 60, null).findIndex(r => r.kind === 'field')
  const opened = onClick(START, entries, FRAME, field, ARROW).state
  let state = opened
  for (let i = 0; i < 7; i++) state = onKey(state, entries, FRAME, { key: 'down' }).state
  expect(state.cursor).toBe('e6')
  expect(menuOf(entries, FRAME, state)).toMatchObject({ first: 2, cursor: 7 })
  const chose = onKey(state, entries, FRAME, { key: 'return' })
  expect(chose.state.isMenuOpen).toBe(false)
  expect(chose.post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'choose', entry: 'e6' }])
  const chosen = chose.state
  expect(layout(entries, 60, null, chosen.pending).some(r => r.kind === 'pick')).toBe(true)
  expect(onKey(chosen, entries, FRAME, { key: 'return' }).post?.edits.at(-1)).toEqual({ seq: 2, id: 'a', kind: 'once', entry: 'e6' })
  const menu = menuOf(entries, FRAME, opened)!
  const clicked = onClick(opened, entries, FRAME, menu.top + 3, menu.left + 4)
  expect([clicked.state.isMenuOpen, clicked.post?.edits]).toEqual([false, [{ seq: 1, id: 'a', kind: 'choose', entry: 'e1' }]])
  expect(onClick(opened, entries, FRAME, menu.top, menu.left + 4).state).toEqual(opened)
  expect(onClick(opened, entries, FRAME, 1, 3).state).toMatchObject({ isMenuOpen: false, pending: [] })
  expect(onKey(opened, entries, FRAME, { key: 'tab' }).state.isMenuOpen).toBe(false)
  expect(onKey(START, entries, FRAME, { key: 'tab' }).state.isMenuOpen).toBe(true)
  expect(onKey(opened, entries, FRAME, { key: 'x' }).post).toBe(undefined)
})

test('Type in the menu turns a chosen entry back into a field that takes typing; the menu opens on what the field holds', async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'DB password'), offer: OFFER, chosen: 'e0' }]
  const field = layout(entries, 60, null).findIndex(r => r.kind === 'field')
  const opened = onClick(START, entries, FRAME, field, 6).state
  expect(opened.cursor).toBe('e0')
  const typing = onKey(onKey(opened, entries, FRAME, { key: 'up' }).state, entries, FRAME, { key: 'return' }).state
  expect(typing.pending).toEqual([{ seq: 1, id: 'a', kind: 'choose', entry: null }])
  expect(layout(entries, 60, null, typing.pending).some(r => r.kind === 'pick')).toBe(false)
  expect(onKey(typing, entries, FRAME, { key: 'return' }).post?.edits.at(-1)).toEqual({ seq: 2, id: 'a', kind: 'submit' })
  expect(onClick(typing, entries, FRAME, field, 6).state.cursor).toBe(null)
})

test('the menu cursor stays on its entry when the vault changes; with its entry gone, Enter chooses nothing', async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'deploy token'), offer: OFFER }]
  const field = layout(entries, 60, null).findIndex(r => r.kind === 'field')
  let state = onClick(START, entries, FRAME, field, ARROW).state
  for (let i = 0; i < 3; i++) state = onKey(state, entries, FRAME, { key: 'down' }).state
  expect(state.cursor).toBe('e2')
  const shifted: RequestEntry[] = [{ ...entries[0]!, offer: OFFER.filter(o => o.id !== 'e0') }]
  expect(onKey(state, shifted, FRAME, { key: 'return' }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'choose', entry: 'e2' }])
  const gone: RequestEntry[] = [{ ...entries[0]!, offer: OFFER.filter(o => o.id !== 'e2') }]
  expect(menuOf(gone, FRAME, state)!.cursor).toBe(-1)
  expect(onKey(state, gone, FRAME, { key: 'return' }).post).toBe(undefined)
  expect(onKey(state, gone, FRAME, { key: 'down' }).state.cursor).toBe(null)
})

test("a choice comes from the hooks, so another instance's card (pop-out or drawer) holds the same", async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'DB password'), offer: OFFER, chosen: 'e3' }]
  expect(choiceOf(entries[0]!, [])).toEqual(OFFER[3])
  expect(onKey(START, entries, FRAME, { key: 'return' }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'once', entry: 'e3' }])
  expect(choiceOf({ ...entries[0]!, chosen: null }, [])).toBe(null)
})

test('a selected card that leaves the list leaves nothing selected: keys wait, an open menu shuts', async () => {
  const entries: RequestEntry[] = [entry('a', 'one'), { ...entry('b', 'two'), offer: OFFER }]
  const field = layout(entries, 60, null).findIndex(r => r.id === 'b' && r.kind === 'field')
  const opened = onClick(START, entries, FRAME, field, ARROW).state
  const left = [entries[0]!]
  for (const key of ['return', 'x', 'down']) {
    const result = onKey(opened, left, FRAME, { key })
    expect(result.post?.edits ?? []).toEqual([])
    expect(result.state.isMenuOpen).toBe(false)
  }
  expect(onKey(opened, left, FRAME, { key: 'down' }).state.selected).toBe('a')
  const typedInB = onKey({ ...START, selected: 'b', isFocused: true }, left, FRAME, { key: 'y' })
  expect(typedInB.post).toBe(undefined)
})

test('a menu scrolled out of view takes no keys and shuts', async () => {
  const many = [...MANY.slice(0, 4), { ...entry('z', 'menu'), offer: OFFER }]
  const opened = onKey({ ...START, selected: 'z', isFocused: true, scroll: 999 }, many, SHORT, { key: 'tab' }).state
  expect(menuOf(many, SHORT, opened)).not.toBe(null)
  const hidden = { ...opened, scroll: 0 }
  expect(menuOf(many, SHORT, hidden)).toBe(null)
  for (const key of ['return', 'down', 'up']) {
    const result = onKey(hidden, many, SHORT, { key })
    expect(result.state).toMatchObject({ isMenuOpen: false, selected: 'z' })
    expect(result.post).toBe(undefined)
  }
})

test('multi-line and wide text take the rows and cells counted for them', async () => {
  const entries: RequestEntry[] = [{ ...entry('a', 'what\nnext'), source: 'git add -A\ngit push 日本語 🙂' }]
  const rows = layout(entries, 60, null)
  const what = rows.find(r => r.kind === 'what') as { text: string }
  expect(what.text).toBe('what⏎next')
  const from = rows.filter(r => r.kind === 'from') as { text: string }[]
  expect(from.map(r => r.text)).toEqual(['git add -A⏎git push 日本語 ?'])
  expect(rows.map(r => r.kind)).toEqual(['cardTop', 'what', 'from', 'fieldTop', 'field', 'fieldBottom', 'cardBottom'])
  // が written as か + U+3099, as macOS file names are: the mark sits in a wide range but joins the か.
  const voiced = layout([{ ...entry('a', 'が 〪') }], 60, null).find(r => r.kind === 'what') as { text: string }
  expect(voiced.text).toBe('か? ?')
})

test('the menu opens above its field when the room under it is short', async () => {
  const entries: RequestEntry[] = [entry('a', 'p'), { ...entry('b', 'deploy token'), offer: OFFER }]
  const frame: Frame = { columns: 60, rows: 18, message: null, typingOff: null }
  const fieldTop = layout(entries, 60, null).findIndex(r => r.id === 'b' && r.kind === 'fieldTop')
  const opened = onClick(START, entries, frame, fieldTop + 1, ARROW).state
  expect(menuOf(entries, frame, opened)!.top).toBe(fieldTop - 9)
})

test('a field with no vault entries to offer opens no menu', async () => {
  const field = layout(ENTRIES, 60, null).findIndex(r => r.kind === 'field')
  expect(onClick(START, ENTRIES, FRAME, field, 6).state.isMenuOpen).toBe(false)
  expect(onKey(START, ENTRIES, FRAME, { key: 'tab' }).state.isMenuOpen).toBe(false)
})

test('with typing off, the field takes no keys and no Enter; ✕ and a vault entry still answer', async () => {
  const off: Frame = { ...FRAME, typingOff: 'off: tracer could read it · Vault tab' }
  expect(onKey(START, ENTRIES, off, { key: 'x' }).post).toBe(undefined)
  expect(onKey(START, ENTRIES, off, { key: 'return' }).post).toBe(undefined)
  const field = layout(ENTRIES, 60, null).findIndex(r => r.kind === 'field')
  expect(onClick(START, ENTRIES, off, field, geometry(60).buttonStart + 1).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'cancel' }])
  const tagged: RequestEntry[] = [{ ...entry('a', 'DB'), offer: OFFER, chosen: 'e0' }]
  expect(onKey(START, tagged, off, { key: 'return' }).post?.edits).toEqual([{ seq: 1, id: 'a', kind: 'once', entry: 'e0' }])
})
