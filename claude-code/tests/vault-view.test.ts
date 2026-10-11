import { expect, test } from 'claude-code/testing'

import { TAB_ROWS, tabSpans } from '../hooks/tabs'
import VaultView, { formButtons, initialState, listRows, onClick, onKey, type ViewState } from '../hooks/vault-view'
import type { VaultProps, ViewEntry } from '../hooks/vault-view-props'

const ENTRIES: ViewEntry[] = [
  { id: 'e1', name: 'Prod DB', tag: 'db', kind: 'password', use: 'session', allowed: true },
  { id: 'e2', name: 'Deploy', tag: 'deploy', kind: 'token', use: 'each', allowed: false },
  { id: 't1', name: '[sudo] password for alex', tag: 'typed-abc', kind: 'typed', use: 'each', allowed: false },
]
const PROPS: VaultProps = {
  state: 'open',
  entries: ENTRIES,
  forward: null,
  tabs: { active: 'vault', requests: 1, vaultMark: true },
  columns: 60,
  rows: 20,
  applied: {},
  valueLength: 0,
  formEpoch: 0,
  error: null,
}
const START = initialState(0, 'v1')
/** A click on the row `at` under the tabs. */
const click = (state: ViewState, at: number, x: number, props = PROPS) => onClick(state, props, at + TAB_ROWS, x)

function draw(props: VaultProps, state?: ViewState) {
  let current: unknown = state
  const surface = {
    elements: { Box: (p: object) => ({ type: 'Box', ...p }), Text: (p: object) => ({ type: 'Text', ...p }) },
    get state() {
      return current
    },
    setState: (next: unknown) => {
      current = next
    },
    columns: 0,
    rows: 0,
    every: () => () => {},
    onPointer: () => () => {},
    onKey: () => () => {},
    post: () => {},
  }
  const text = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join('')
  const view = VaultView as unknown as (p: VaultProps, s: typeof surface) => { children: unknown[] }
  return view(props, surface).children.map(text)
}

test('a vault that is absent or locked offers one button; an open one lists entries, typed ones apart', async () => {
  expect(listRows({ state: 'absent', entries: [], forward: null })).toEqual([{ kind: 'closed', text: 'No vault yet.', button: ' Create ' }])
  expect(listRows({ state: 'locked', entries: [], forward: null })[0]).toEqual({ kind: 'closed', text: 'Vault locked.', button: ' Unlock ' })
  expect(listRows(PROPS).map(r => r.kind)).toEqual(['add', 'entry', 'entry', 'typedHead', 'typed'])
  expect(listRows({ state: 'open', entries: [], forward: null }).map(r => r.kind)).toEqual(['add', 'none'])
})

test("with an agent of the user's, a row switches its keys on and off, the vault locked or not", async () => {
  expect(listRows({ ...PROPS, forward: false }).map(r => r.kind)).toEqual(['add', 'entry', 'entry', 'forward', 'typedHead', 'typed'])
  const locked = { ...PROPS, state: 'locked' as const, entries: [], forward: true }
  expect(listRows(locked)).toEqual([{ kind: 'closed', text: 'Vault locked.', button: ' Unlock ' }, { kind: 'forward', on: true }])
  expect(click(START, 1, 5, locked).post?.action).toEqual({ kind: 'forward', on: false })
  const onForward = onKey(START, locked, { key: 'down' }).state
  expect(onKey(onForward, locked, { key: 'space' }).post?.action).toEqual({ kind: 'forward', on: false })
  for (const row of draw({ ...PROPS, forward: true })) expect([...row].length).toBe(60)
})

test('the closed button unlocks; text before it only selects', async () => {
  const props = { ...PROPS, state: 'locked' as const, entries: [] }
  expect(click(START, 0, 20, props).post?.action).toEqual({ kind: 'unlock' })
  expect(click(START, 0, 3, props).post).toBe(undefined)
  expect(onKey(START, props, { key: 'return' }).post?.action).toEqual({ kind: 'unlock' })
})

test('Add opens an empty form and drops any value left; typed text fills the field with the keyboard', async () => {
  const opened = click(START, 0, 4)
  expect(opened.state.form).toEqual({ id: null, name: '', tag: '', kind: 'password', use: 'session' })
  expect(opened.post).toEqual({ instance: 'v1', edits: [{ seq: 1, kind: 'clear' }], valueFocused: false, formOpen: true })
  let state = opened.state
  for (const key of ['G', 'H', 'backspace', 'i']) state = onKey(state, PROPS, { key }).state
  expect(state.form?.name).toBe('Gi')
  state = onKey(state, PROPS, { key: 'down' }).state
  state = onKey(state, PROPS, { key: 'g' }).state
  state = onKey(state, PROPS, { key: 'down' }).state
  state = onKey(state, PROPS, { key: 'right' }).state
  expect(state.form).toEqual({ id: null, name: 'Gi', tag: 'g', kind: 'token', use: 'session' })
  state = onKey(state, PROPS, { key: 'down' }).state
  state = onKey(state, PROPS, { key: 'space' }).state
  expect(state.form?.use).toBe('each')
  const toValue = onKey(state, PROPS, { key: 'down' })
  expect(toValue.post?.valueFocused).toBe(true)
  const typed = onKey(toValue.state, PROPS, { key: 's3cret' })
  expect(typed.post?.edits.at(-1)).toEqual({ seq: 2, kind: 'append', text: 's3cret' })
  expect(typed.state.form?.name).toBe('Gi')
  expect(onKey(typed.state, PROPS, { key: 'return' }).post?.action).toEqual({ kind: 'save', form: typed.state.form })
})

test('an entry opens for editing; its dot or space allows or revokes it for the session', async () => {
  const edit = click(START, 1, 10)
  expect(edit.state.form).toEqual({ id: 'e1', name: 'Prod DB', tag: 'db', kind: 'password', use: 'session' })
  expect(click(START, 2, 1).post?.action).toEqual({ kind: 'allow', id: 'e2', allowed: true })
  const onDeploy = onKey(onKey(START, PROPS, { key: 'down' }).state, PROPS, { key: 'down' }).state
  expect(onKey(onDeploy, PROPS, { key: 'space' }).post?.action).toEqual({ kind: 'allow', id: 'e2', allowed: true })
})

test('a typed value opens as a new full entry over the same id, its tag left for the relay to keep', async () => {
  const opened = click(START, 4, 6)
  expect(opened.state.form).toEqual({ id: 't1', name: '[sudo] password for alex', tag: '', kind: 'password', use: 'session' })
})

test('the form saves, deletes an existing entry, or closes on ✕', async () => {
  const add = click(START, 0, 4).state
  expect(formButtons(add.form!).map(b => b.kind)).toEqual(['save', 'cancel'])
  const edit = click(START, 1, 10).state
  const buttons = formButtons(edit.form!)
  expect(buttons.map(b => b.kind)).toEqual(['save', 'delete', 'cancel'])
  const buttonsRow = 5 + 1 + 1
  expect(click(edit, buttonsRow, buttons[1]!.start + 1).post?.action).toEqual({ kind: 'delete', id: 'e1' })
  expect(click(edit, buttonsRow, buttons[0]!.start).post?.action).toEqual({ kind: 'save', form: edit.form })
  const closed = click(edit, buttonsRow - 1, buttons[2]!.start + 2)
  expect(closed.state.form).toBe(null)
  expect(closed.post?.edits.at(-1)?.kind).toBe('clear')
  expect(closed.post?.formOpen).toBe(false)
})

test('the Requests tab switches back; a saved form closes when the hooks bump the epoch', async () => {
  const requests = tabSpans(PROPS.tabs)[0]!
  expect(onClick(START, PROPS, 0, requests.start + 1).post?.tab).toBe('requests')
  const edit = click(START, 1, 10).state
  const rows = draw({ ...PROPS, formEpoch: 1 }, edit)
  expect(rows.some(r => r.includes('+ Add'))).toBe(true)
})

test('every drawn row is exactly as wide as the view, the list and the form alike', async () => {
  for (const row of draw(PROPS)) expect([...row].length).toBe(60)
  const form = click(START, 1, 10).state
  const rows = draw({ ...PROPS, error: 'tag db is taken or not made of letters, digits, - _ .' }, form)
  for (const row of rows) expect([...row].length).toBe(60)
  expect(rows.some(r => r.includes('│ Delete │'))).toBe(true)
  for (const row of draw({ ...PROPS, state: 'absent', entries: [] })) expect([...row].length).toBe(60)
})
