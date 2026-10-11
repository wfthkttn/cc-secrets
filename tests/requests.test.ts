import { expect, test } from 'claude-code/testing'

import { confirm, type Frame, geometry, initialState, type ListState, layout, listHeight, onClick, onKey, shownLength, view } from '../hooks/requests'
import type { RequestEntry } from '../hooks/requests-props'

const entry = (id: string, prompt: string, length = 0): RequestEntry => ({ id, prompt, source: 'echo', since: '04:00:00', length })
const ENTRIES = [entry('a', '[sudo] password for alex'), entry('b', 'test token')]
const START = initialState(0, 'i1')
const FRAME: Frame = { columns: 60, rows: 100, message: null }
/** Five 7-row cards with gaps between: 39 rows. */
const MANY = ['a', 'b', 'c', 'd', 'e'].map(id => entry(id, 'token ' + id))
/** Room for two cards and the gap between them under the two markers. */
const SHORT: Frame = { columns: 60, rows: 17, message: null }

function type(state: ListState, ...keys: string[]) {
  for (const key of keys) state = onKey(state, ENTRIES, FRAME, { key }).state
  return state
}

test('typing becomes numbered edits for the first request', async () => {
  const state = type(START, 'h', 'hunter2')
  expect(state.pending).toEqual([
    { seq: 1, id: 'a', kind: 'append', text: 'h' },
    { seq: 2, id: 'a', kind: 'append', text: 'hunter2' },
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
  expect(type(START, 'space').pending).toEqual([{ seq: 1, id: 'a', kind: 'append', text: ' ' }])
  expect(type(START, 'tab', 'left', '\x1bOP').pending).toEqual([])
})

test('backspace, ctrl+u and Enter are edits too, in order', async () => {
  const state = onKey(type(START, 'x', 'backspace'), ENTRIES, FRAME, { key: 'u', ctrl: true }).state
  const { post } = onKey(state, ENTRIES, FRAME, { key: 'return' })
  expect(post?.edits.map(e => e.kind)).toEqual(['append', 'back', 'clear', 'submit'])
  expect(shownLength(entry('a', 'p', 5), state.pending)).toBe(0)
})

test('down switches requests and tells the hooks; typing then goes to the new one', async () => {
  expect(onKey(START, ENTRIES, FRAME, { key: 'down' }).post).toEqual({ instance: 'i1', selected: 'b', edits: [] })
  const state = type(START, 'down', 'y')
  expect(state.pending).toEqual([{ seq: 1, id: 'b', kind: 'append', text: 'y' }])
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
    post: { instance: 'i1', selected: 'b', edits: [] },
  })
  const bField = rows.findIndex(r => r.id === 'b' && r.kind === 'field')
  const { buttonStart } = geometry(60)
  expect(onClick(START, ENTRIES, FRAME, bField, buttonStart + 1).post?.edits).toEqual([{ seq: 1, id: 'b', kind: 'cancel' }])
  expect(onClick(START, ENTRIES, FRAME, bField - 1, buttonStart).post?.edits).toEqual([{ seq: 1, id: 'b', kind: 'cancel' }])
  expect(onClick(START, ENTRIES, FRAME, bField, buttonStart - 2).post).toEqual({ instance: 'i1', selected: 'b', edits: [] })
  const gap = rows.findIndex(r => r.kind === 'gap')
  expect(onClick(START, ENTRIES, FRAME, gap, 3).post).toEqual({ instance: 'i1', selected: 'a', edits: [] })
})

test("a click on the message's ✕ dismisses it; elsewhere on it, only focuses", async () => {
  const { buttonStart } = geometry(60)
  for (const y of [1, 2, 3]) {
    expect(onClick(START, ENTRIES, { ...FRAME, message: 'Short.' }, y, buttonStart + 2).post).toEqual({ instance: 'i1', selected: 'a', edits: [], dismiss: true })
  }
  expect(onClick(START, ENTRIES, { ...FRAME, message: 'Short.' }, 2, 3).post).toEqual({ instance: 'i1', selected: 'a', edits: [] })
  expect(onClick(START, ENTRIES, { ...FRAME, message: 'Short.' }, 0, buttonStart + 2).post).toEqual({ instance: 'i1', selected: 'a', edits: [] })
})

test('cards past the room scroll in a window between markers counting the cards cut off', async () => {
  const rows = view(MANY, SHORT, 0)
  expect(rows.length).toBe(17)
  expect(rows[0]).toEqual({ id: null, kind: 'more', dir: 'up', count: 0 })
  expect(rows[16]).toEqual({ id: null, kind: 'more', dir: 'down', count: 3 })
  expect(rows.slice(1, 16).map(r => r.id)).toEqual([...'aaaaaaa', null, ...'bbbbbbb'])
  expect(view(MANY, SHORT, 999).slice(1, 16).map(r => r.id)).toEqual([...'ddddddd', null, ...'eeeeeee'])
  expect(view(ENTRIES, SHORT, 5).map(r => r.kind)).toEqual(layout(ENTRIES, 60, null).map(r => r.kind))
})

test('the arrows move the selection and the window follows to show the selected card whole', async () => {
  let state = START
  const press = (key: string) => (state = onKey(state, MANY, SHORT, { key }).state)
  press('down')
  expect([state.selected, state.scroll]).toEqual(['b', 0])
  press('down')
  expect([state.selected, state.scroll]).toEqual(['c', 8])
  expect(view(MANY, SHORT, state.scroll)[0]).toEqual({ id: null, kind: 'more', dir: 'up', count: 1 })
  press('up')
  expect([state.selected, state.scroll]).toEqual(['b', 8])
  press('end')
  expect([state.selected, state.scroll]).toEqual(['e', 24])
  press('home')
  expect([state.selected, state.scroll]).toEqual(['a', 0])
})

test('a click on a marker selects the next card cut off that way and scrolls to it', async () => {
  const at = { ...START, selected: 'c', scroll: 8 }
  expect(onClick(at, MANY, SHORT, 0, 3)).toEqual({
    state: { ...at, selected: 'a', isFocused: true, scroll: 0 },
    post: { instance: 'i1', selected: 'a', edits: [] },
  })
  expect(onClick(at, MANY, SHORT, 16, 3).state).toEqual({ ...at, selected: 'd', isFocused: true, scroll: 16 })
  expect(onClick(START, MANY, SHORT, 0, 3).post).toEqual({ instance: 'i1', selected: 'a', edits: [] })
})

test('the list stays its tallest card and gap short of the room; a list that fits keeps its height', async () => {
  expect(listHeight(MANY, 60, null, 30)).toBe(22)
  expect(listHeight([...MANY, { ...entry('f', 'p'), source: 'x'.repeat(300) }], 60, null, 30)).toBe(19)
  expect(listHeight(ENTRIES, 60, null, 100)).toBe(15)
  expect(listHeight([], 60, null, 30)).toBe(1)
})

test('a message stays on top while the cards under it scroll', async () => {
  const frame = { ...SHORT, message: 'Short.' }
  const rows = view(MANY, frame, 999)
  expect(rows.length).toBe(17)
  expect(rows.slice(0, 6).map(r => r.kind)).toEqual(['msgTop', 'msg', 'msg', 'msg', 'msgBottom', 'more'])
  expect(rows.at(-2)).toEqual({ id: 'e', kind: 'cardBottom' })
})
