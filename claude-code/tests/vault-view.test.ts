import { expect, test } from 'claude-code/testing'

import { TAB_ROWS, tabSpans } from '../hooks/tabs'
import VaultView, {
  accessLabel,
  closedRows,
  collisionButtons,
  collisionRows,
  contentRows,
  doorButtons,
  formButtons,
  formRows,
  initialState,
  listRows,
  nextAccess,
  onClick,
  onKey,
  rekeyButtons,
  rekeyRows,
  shownText,
  tagOptions,
  type ViewState,
} from '../hooks/vault-view'
import type { ValueEdit, VaultProps, ViewEntry } from '../hooks/vault-view-props'

const isAction = (e: ValueEdit): e is Extract<ValueEdit, { kind: 'action' }> => e.kind === 'action'
const isTab = (e: ValueEdit): e is Extract<ValueEdit, { kind: 'tab' }> => e.kind === 'tab'

const ENTRIES: ViewEntry[] = [
  { id: 'e1', name: 'Prod DB', tag: 'db', kind: 'password', use: 'session', access: 'allowed' },
  { id: 'e2', name: 'Deploy', tag: 'deploy', kind: 'token', use: 'each', access: 'ask' },
]
const PROPS: VaultProps = {
  state: 'open',
  collisions: [],
  entries: ENTRIES,
  suggestions: [{ id: 's1', prompt: '[sudo] password for alex' }],
  tagChoices: [
    { tag: 'sudo', what: 'sudo -A asks for your password' },
    { tag: 'db', what: 'an agent asked for it this session' },
  ],
  tabs: { active: 'vault', requests: 1, vaultMark: true },
  columns: 60,
  rows: 20,
  applied: {},
  lengths: { value: 0, passphrase: 0, again: 0 },
  peeked: {},
  formEpoch: 0,
  error: null,
}
const START = initialState(0, 'v1')
const CLOSED = initialState(0, 'v1', true)
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

test('a closed vault shows its passphrase field, twice for a new one, and one button', async () => {
  expect(closedRows({ state: 'locked', error: null }).map(r => r.kind)).toEqual(['closed', 'door', 'gap', 'buttonsTop', 'buttons', 'buttonsBottom'])
  expect(closedRows({ state: 'absent', error: 'The two differ.' }).filter(r => r.kind === 'door').length).toBe(2)
  expect(doorButtons('absent')[0]!.label).toBe(' Create ')
  expect(doorButtons('locked')[0]!.label).toBe(' Unlock ')
})

test('keys on a closed vault go to its passphrase; Enter or the button opens it', async () => {
  const locked = { ...PROPS, state: 'locked' as const, entries: [], suggestions: [] }
  const typed = onKey(CLOSED, locked, { key: 'p4ss' })
  expect(typed.post).toEqual({ instance: 'v1', edits: [{ seq: 1, field: 'passphrase', kind: 'append', text: 'p4ss' }], focused: 'passphrase', formOpen: false })
  expect(onKey(typed.state, locked, { key: 'return' }).post?.edits.find(isAction)?.action).toEqual({ kind: 'open' })
  expect(click(CLOSED, 3, doorButtons('locked')[0]!.start + 1, locked).post?.edits.find(isAction)?.action).toEqual({ kind: 'open' })
  const absent = { ...locked, state: 'absent' as const }
  const again = onKey(CLOSED, absent, { key: 'down' })
  expect(again.post?.focused).toBe('again')
  expect(onKey(again.state, absent, { key: 'x' }).post?.edits).toEqual([{ seq: 1, field: 'again', kind: 'append', text: 'x' }])
  expect(click(CLOSED, 1, 20, absent).post?.focused).toBe('passphrase')
})

test('an open vault lists its entries, then what was typed this session to keep', async () => {
  expect(listRows(PROPS).map(r => r.kind)).toEqual(['add', 'rekey', 'entryHead', 'entry', 'entry', 'suggestHead', 'suggestion'])
  expect(listRows({ entries: [], suggestions: [] }).map(r => r.kind)).toEqual(['add', 'rekey', 'none'])
})

test("each entry row shows this session's access under a header naming the columns", async () => {
  const rows = draw(PROPS)
  for (const row of rows) expect([...row].length).toBe(60)
  const at = (kind: string) => TAB_ROWS + listRows(PROPS).findIndex(r => r.kind === kind)
  expect(rows[at('entryHead')]).toMatch(/^ Agent +Name +Tag +Kind *$/)
  expect(rows[at('entry')]).toMatch(/^ allowed +Prod DB +db +password *$/)
  expect(rows[at('entry') + 1]).toMatch(/^ ask each +Deploy +deploy +token *$/)
  expect(accessLabel({ access: 'refused', use: 'each' })).toBe('refused')
})

test('the view is as tall as its tallest open page, so a form opens without waiting for it to grow', async () => {
  expect(contentRows(PROPS)).toBe(Math.max(listRows(PROPS).length, formRows(null).length))
  expect(contentRows({ ...PROPS, entries: [], suggestions: [] })).toBe(formRows(null).length)
  expect(contentRows({ ...PROPS, state: 'locked' })).toBe(closedRows({ state: 'locked', error: null }).length)
  const collisions = [{ name: 'tracer', carriers: ['http.fetch'], refused: false }]
  expect(contentRows({ ...PROPS, collisions })).toBe(collisionRows(collisions).length)
})

test('the tag field offers what the agent asks for, then the tag typed; tags other entries hold are left out', async () => {
  let state = onKey(click(START, 0, 4).state, PROPS, { key: 'down' }).state
  expect(state.field).toBe('tag')
  expect(tagOptions(PROPS, state.form!).map(o => o.tag)).toEqual(['sudo'])
  state = onKey(state, PROPS, { key: 'right' }).state
  expect(state.form?.tag).toBe('sudo')
  const drawn = draw(PROPS, state)
  for (const row of drawn) expect([...row].length).toBe(60)
  expect(drawn.some(r => r.includes('‹ sudo ›') && r.includes('sudo -A asks for your password'))).toBe(true)
  state = onKey(state, PROPS, { key: 'x' }).state
  expect(state.form?.tag).toBe('x')
  state = onKey(onKey(state, PROPS, { key: 'space' }).state, PROPS, { key: 'y' }).state
  expect(state.form?.tag).toBe('y')
  state = onKey(onKey(state, PROPS, { key: 'right' }).state, PROPS, { key: 'left' }).state
  expect(state.form?.tag).toBe('y')
  expect(draw(PROPS, state).some(r => r.includes('‹ y▏ ›') && r.includes('your own'))).toBe(true)
  const editing = click(START, 3, 20).state
  expect(tagOptions(PROPS, editing.form!).map(o => o.tag)).toEqual(['sudo', 'db'])
  expect(tagOptions(PROPS, { ...editing.form!, kind: 'ssh-key' })).toEqual([])
})

test('Change passphrase takes the new one twice with both fields emptied first; Enter or Change sends it, ✕ leaves', async () => {
  const opened = click(START, 1, 4)
  expect(opened.state.rekeying).toBe(true)
  expect(opened.post?.edits).toEqual([
    { seq: 1, field: 'passphrase', kind: 'clear' },
    { seq: 2, field: 'again', kind: 'clear' },
  ])
  expect(opened.post?.focused).toBe('passphrase')
  const typed = onKey(opened.state, PROPS, { key: 'n3w' })
  expect(typed.post?.edits.at(-1)).toEqual({ seq: 3, field: 'passphrase', kind: 'append', text: 'n3w' })
  const again = onKey(typed.state, PROPS, { key: 'down' })
  expect(again.post?.focused).toBe('again')
  expect(onKey(again.state, PROPS, { key: 'return' }).post?.edits.find(isAction)?.action).toEqual({ kind: 'rekey' })
  const [change, cancel] = rekeyButtons()
  const buttonsRow = rekeyRows(null).findIndex(r => r.kind === 'buttons')
  expect(click(again.state, buttonsRow, change!.start + 1).post?.edits.find(isAction)?.action).toEqual({ kind: 'rekey' })
  const left = click(again.state, buttonsRow, cancel!.start + 1)
  expect(left.state.rekeying).toBe(false)
  expect(left.post?.edits.slice(-2).map(e => ('field' in e ? e.field + ' ' + e.kind : e.kind))).toEqual(['passphrase clear', 'again clear'])
  const drawn = draw(PROPS, again.state)
  for (const row of drawn) expect([...row].length).toBe(60)
  expect(drawn.some(r => r.includes('│ Change │'))).toBe(true)
  expect(draw({ ...PROPS, formEpoch: 1 }, again.state).some(r => r.includes('+ Add'))).toBe(true)
})

test('a held field shows its text only while peeked: the mark or Ctrl+R asks, the hooks send the text', async () => {
  const locked = { ...PROPS, state: 'locked' as const, entries: [], suggestions: [], lengths: { value: 0, passphrase: 4, again: 0 } }
  expect(onKey(CLOSED, locked, { key: 'r', ctrl: true }).post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'peek' }])
  expect(click(CLOSED, 1, 60 - 4, locked).post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'peek' }])
  expect(click(CLOSED, 1, 20, locked).post?.edits).toEqual([])
  const hidden = draw(locked, CLOSED)
  expect(hidden.some(r => r.includes('••••▏') && r.includes('○'))).toBe(true)
  const shown = draw({ ...locked, peeked: { passphrase: 'abcd' } }, CLOSED)
  expect(shown.some(r => r.includes('abcd') && r.includes('◉'))).toBe(true)
  for (const row of shown) expect([...row].length).toBe(60)
  const typing = onKey(CLOSED, locked, { key: 'e' }).state
  expect(draw({ ...locked, peeked: { passphrase: 'abcd' } }, typing).some(r => r.includes('abcde'))).toBe(true)
  expect(shownText('abcd', 'passphrase', [{ seq: 1, field: 'passphrase', kind: 'back' }, { seq: 2, field: 'again', kind: 'clear' }])).toBe('abc')
})

test('Add opens an empty form and drops any value left; typed text fills the field with the keyboard', async () => {
  const opened = click(START, 0, 4)
  expect(opened.state.form).toEqual({ id: null, suggestion: null, name: '', tag: '', kind: 'password', use: 'session' })
  expect(opened.post).toEqual({ instance: 'v1', edits: [{ seq: 1, field: 'value', kind: 'clear' }], focused: null, formOpen: true })
  let state = opened.state
  for (const key of ['G', 'H', 'backspace', 'i']) state = onKey(state, PROPS, { key }).state
  expect(state.form?.name).toBe('Gi')
  state = onKey(state, PROPS, { key: 'down' }).state
  state = onKey(state, PROPS, { key: 'g' }).state
  state = onKey(state, PROPS, { key: 'down' }).state
  state = onKey(state, PROPS, { key: 'right' }).state
  expect(state.form).toEqual({ id: null, suggestion: null, name: 'Gi', tag: 'g', kind: 'token', use: 'session' })
  state = onKey(state, PROPS, { key: 'down' }).state
  state = onKey(state, PROPS, { key: 'space' }).state
  expect(state.form?.use).toBe('each')
  const toValue = onKey(state, PROPS, { key: 'down' })
  expect(toValue.post?.focused).toBe('value')
  const typed = onKey(toValue.state, PROPS, { key: 's3cret' })
  expect(typed.post?.edits.at(-1)).toEqual({ seq: 2, field: 'value', kind: 'append', text: 's3cret' })
  expect(onKey(typed.state, PROPS, { key: 'return' }).post?.edits.find(isAction)?.action).toEqual({ kind: 'save', form: typed.state.form })
})

test('an entry opens for editing; a click on its access or Space turns it over: ask, allowed, refused', async () => {
  expect(click(START, 3, 20).state.form).toEqual({ id: 'e1', suggestion: null, name: 'Prod DB', tag: 'db', kind: 'password', use: 'session' })
  expect(click(START, 3, 1).post?.edits.find(isAction)?.action).toEqual({ kind: 'access', id: 'e1', access: 'refused' })
  expect(click(START, 3, 9).post?.edits.find(isAction)?.action).toEqual({ kind: 'access', id: 'e1', access: 'refused' })
  expect(click(START, 4, 1).post?.edits.find(isAction)?.action).toEqual({ kind: 'access', id: 'e2', access: 'refused' })
  const onDeploy = ['down', 'down', 'down'].reduce((state, key) => onKey(state, PROPS, { key }).state, START)
  expect(onKey(onDeploy, PROPS, { key: 'space' }).post?.edits.find(isAction)?.action).toEqual({ kind: 'access', id: 'e2', access: 'refused' })
  const session = { use: 'session' as const }
  expect([nextAccess({ ...session, access: 'ask' }), nextAccess({ ...session, access: 'allowed' }), nextAccess({ ...session, access: 'refused' })]).toEqual([
    'allowed',
    'refused',
    'ask',
  ])
  expect([nextAccess({ use: 'each', access: 'ask' }), nextAccess({ use: 'each', access: 'refused' })]).toEqual(['refused', 'ask'])
})

test("the selection stays on its entry when another session's change moves the rows; once it went, keys act on nothing", async () => {
  const onDeploy = ['down', 'down', 'down'].reduce((state, key) => onKey(state, PROPS, { key }).state, START)
  const shifted = { ...PROPS, entries: [ENTRIES[1]!] }
  expect(onKey(onDeploy, shifted, { key: 'space' }).post?.edits.find(isAction)?.action).toEqual({ kind: 'access', id: 'e2', access: 'refused' })
  const gone = { ...PROPS, entries: [ENTRIES[0]!] }
  expect(onKey(onDeploy, gone, { key: 'space' }).post).toBe(undefined)
  expect(onKey(onDeploy, gone, { key: 'return' }).post).toBe(undefined)
  expect(onKey(onDeploy, gone, { key: 'down' }).state.selected).toBe('add')
})

test('a suggestion opens as a new entry named by its prompt; its value is not typed again, nor an ssh key', async () => {
  const opened = click(START, 6, 6)
  expect(opened.state.form).toEqual({ id: null, suggestion: 's1', name: '[sudo] password for alex', tag: '', kind: 'password', use: 'session' })
  expect(formButtons(opened.state.form!).map(b => b.kind)).toEqual(['save', 'dismiss', 'cancel'])
  let state = opened.state
  for (const key of ['down', 'down', 'right', 'right']) state = onKey(state, PROPS, { key }).state
  expect(state.form?.kind).toBe('password')
  for (const key of ['down', 'down']) state = onKey(state, PROPS, { key }).state
  const atValue = onKey(state, PROPS, { key: 'x' })
  expect(atValue.post).toBe(undefined)
  const buttonsRow = 5 + 1 + 1
  const dismiss = formButtons(opened.state.form!)[1]!
  expect(click(opened.state, buttonsRow, dismiss.start + 1).post?.edits.find(isAction)?.action).toEqual({ kind: 'dismiss', id: 's1' })
})

test('the form saves, deletes an existing entry, or closes on ✕', async () => {
  const add = click(START, 0, 4).state
  expect(formButtons(add.form!).map(b => b.kind)).toEqual(['save', 'cancel'])
  const edit = click(START, 3, 20).state
  const buttons = formButtons(edit.form!)
  expect(buttons.map(b => b.kind)).toEqual(['save', 'delete', 'cancel'])
  const buttonsRow = 5 + 1 + 1
  expect(click(edit, buttonsRow, buttons[1]!.start + 1).post?.edits.find(isAction)?.action).toEqual({ kind: 'delete', id: 'e1' })
  expect(click(edit, buttonsRow, buttons[0]!.start).post?.edits.find(isAction)?.action).toEqual({ kind: 'save', form: edit.form })
  const closed = click(edit, buttonsRow - 1, buttons[2]!.start + 2)
  expect(closed.state.form).toBe(null)
  expect(closed.post?.edits.at(-1)).toEqual({ seq: 2, field: 'value', kind: 'clear' })
  expect(closed.post?.formOpen).toBe(false)
})

test('the Requests tab switches back; a saved form closes when the hooks bump the epoch', async () => {
  const requests = tabSpans(PROPS.tabs)[0]!
  expect(onClick(START, PROPS, 0, requests.start + 1).post?.edits.find(isTab)?.tab).toBe('requests')
  const edit = click(START, 3, 20).state
  const rows = draw({ ...PROPS, formEpoch: 1 }, edit)
  expect(rows.some(r => r.includes('+ Add'))).toBe(true)
})

test('every drawn row is exactly as wide as the view: the list, the form, the closed vault', async () => {
  for (const row of draw(PROPS)) expect([...row].length).toBe(60)
  const form = click(START, 3, 20).state
  const rows = draw({ ...PROPS, error: 'tag db is taken or not made of letters, digits, - _ .' }, form)
  for (const row of rows) expect([...row].length).toBe(60)
  expect(rows.some(r => r.includes('│ Delete │'))).toBe(true)
  const closed = draw({ ...PROPS, state: 'absent', entries: [], suggestions: [], lengths: { value: 0, passphrase: 4, again: 0 }, error: 'Wrong passphrase.' })
  for (const row of closed) expect([...row].length).toBe(60)
  expect(closed.some(r => r.includes('••••'))).toBe(true)
  expect(closed.some(r => r.includes('│ Create │'))).toBe(true)
})

test('a colliding plugin replaces the vault with what it hooks and Allow / Refuse; keys do nothing there', async () => {
  const props = { ...PROPS, collisions: [{ name: 'tracer', carriers: ['http.fetch'], refused: false }] }
  const rows = draw(props)
  for (const row of rows) expect([...row].length).toBe(60)
  expect(rows[TAB_ROWS]).toContain('⚠ tracer hooks http.fetch')
  expect(rows.some(r => r.includes('+ Add'))).toBe(false)
  const [allow, refuse] = collisionButtons()
  const at = collisionRows(props.collisions).findIndex(r => r.kind === 'collisionButtons')
  expect(click(START, at, allow!.start + 1, props).post?.edits.find(isAction)?.action).toEqual({ kind: 'collision', name: 'tracer', decision: 'allow' })
  expect(click(START, at, refuse!.start + 1, props).post?.edits.find(isAction)?.action).toEqual({ kind: 'collision', name: 'tracer', decision: 'refuse' })
  expect(onKey(START, props, { key: 'return' }).post).toBe(undefined)
  const refused = draw({ ...props, collisions: [{ ...props.collisions[0]!, refused: true }] })
  expect(refused.some(r => r.includes('│ Allow │'))).toBe(false)
  expect(refused.some(r => r.includes('Refused from the next start'))).toBe(true)
})
