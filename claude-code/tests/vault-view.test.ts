import type { ClientKeyEvent } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { END_CARET, hitAt } from '../hooks/controls'
import { TAB_ROWS, tabSpans } from '../hooks/tabs'
import VaultView, {
  accessLabel,
  contentRows,
  drawPage,
  initialState,
  onClick,
  onDrag,
  onKey,
  onPress,
  onRelease,
  pageOf,
  shownEntries,
  shownPage,
  shownText,
  tagOptions,
  type ViewState,
  withPastes,
} from '../hooks/vault-view'
import type { ValueEdit, VaultAction, VaultMessage, VaultProps, ViewEntry } from '../hooks/vault-view-props'

const ENTRIES: ViewEntry[] = [
  { id: 'e1', name: 'Prod DB', tag: 'db', kind: 'password', access: 'allowed' },
  { id: 'e2', name: 'Deploy', tag: 'deploy', kind: 'token', access: 'ask' },
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
  forward: false,
  tabs: { active: 'vault', requests: 1, vaultMark: true },
  columns: 60,
  rows: 40,
  applied: {},
  lengths: { value: 0, passphrase: 0, again: 0 },
  peeked: {},
  pastes: [],
  formEpoch: 0,
  error: null,
  resume: null,
  mirror: false,
}
const LOCKED: VaultProps = { ...PROPS, state: 'locked', entries: [], suggestions: [] }
const START = initialState(0, 'v1')
const CLOSED = initialState(0, 'v1', true)

const actionOf = (r: { post?: { edits: ValueEdit[] } }): VaultAction | undefined =>
  r.post?.edits.findLast((e): e is Extract<ValueEdit, { kind: 'action' }> => e.kind === 'action')?.action
const key = (state: ViewState, k: string | ClientKeyEvent, props = PROPS) => onKey(state, props, typeof k === 'string' ? { key: k } : k)
const keys = (state: ViewState, list: string[], props = PROPS) => list.reduce((s, k) => key(s, k, props).state, state)

/** The first cell the control `hit` takes on screen, under the tabs. */
function cellOf(props: VaultProps, state: ViewState, hit: string): { y: number; x: number } {
  const lines = shownPage(props, state).lines
  for (let y = 0; y < lines.length; y++) {
    for (let x = 0; x < props.columns; x++) if (hitAt(lines[y], x) === hit) return { y, x }
  }
  throw new Error(`no ${hit} drawn on the ${pageOf(props, state)} page`)
}
const click = (state: ViewState, hit: string, props = PROPS) => {
  const { y, x } = cellOf(props, state, hit)
  return onClick(state, props, y + TAB_ROWS, x)
}

function draw(props: VaultProps, state?: ViewState): string[] {
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
  const text = (node: unknown): string => (typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join(''))
  const view = VaultView as unknown as (p: VaultProps, s: typeof surface) => { children: unknown[] }
  return view(props, surface).children.map(text)
}
const expectWidths = (rows: string[]) => {
  for (const row of rows) expect([...row].length).toBe(PROPS.columns)
}

/** One instance of the view, as the engine runs it: its own state, the listeners it set, what it posted. */
function instance(props: VaultProps) {
  let current: unknown
  let onPointer: (p: object) => void = () => {}
  let onKeyFn: (k: object) => void = () => {}
  const posts: VaultMessage[] = []
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
    onPointer: (fn: (p: object) => void) => ((onPointer = fn), () => {}),
    onKey: (fn: (k: object) => void) => ((onKeyFn = fn), () => {}),
    post: (data: VaultMessage) => posts.push(data),
  }
  const text = (node: unknown): string => (typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join(''))
  const view = VaultView as unknown as (p: VaultProps, s: typeof surface) => { children: unknown[] }
  const draw = (p: VaultProps) => view(p, surface).children.map(text)
  draw(props)
  return {
    draw,
    posts,
    click: (hit: string) => {
      const { y, x } = cellOf(props, current as ViewState, hit)
      onPointer({ type: 'down', y: y + TAB_ROWS, x })
    },
    key: (key: string) => onKeyFn({ key }),
  }
}

test('a new instance, as each new transcript row makes, goes on from the state the last one posted', async () => {
  const first = instance(PROPS)
  first.click('add')
  first.key('G')
  first.key('tab')
  first.key('return')
  const ui = first.posts.at(-1)!.ui!
  expect([ui.form?.name, ui.focus, ui.open]).toEqual(['G', 'tag', 'tag'])
  expect('pending' in ui).toBe(false)
  const resumed = { ...PROPS, resume: ui }
  const next = instance(resumed)
  const rows = next.draw(resumed)
  expect(rows[TAB_ROWS]).toMatch(/^ New entry/)
  expect(rows.some(r => r.startsWith(' Name    [ G '))).toBe(true)
  expect(rows.some(r => r.includes('▸ Custom tag…'))).toBe(true)
  next.key('up')
  next.key('return')
  expect(next.posts.at(-1)!.ui!.form?.tag).toBe('sudo')
  expect(instance({ ...PROPS, resume: { ...ui, isClosed: false } }).draw({ ...PROPS, state: 'locked', resume: ui })[TAB_ROWS]).toMatch(/^ Vault locked/)
})

test("the sidebar's copy over a held instance draws what the held one posts, posts nothing, and a key claims it", async () => {
  const held = instance(PROPS)
  held.click('add')
  held.key('G')
  const shown = () => ({ ...PROPS, mirror: true, resume: held.posts.at(-1)!.ui! })
  const copy = instance(shown())
  held.key('o')
  const rows = copy.draw(shown())
  expect(rows[TAB_ROWS]).toMatch(/^ New entry/)
  expect(rows.some(r => r.startsWith(' Name') && r.includes('Go'))).toBe(true)
  expect(copy.posts).toEqual([])
  copy.key('x')
  expect(copy.posts.at(-1)!.claimed).toBe(true)
  expect(copy.posts.at(-1)!.ui!.form?.name).toBe('Gox')
  copy.draw({ ...shown(), mirror: false })
  copy.key('!')
  expect(copy.posts.at(-1)!.claimed).toBe(undefined)
  expect(copy.posts.at(-1)!.ui!.form?.name).toBe('Gox!')
})

test('a copy acts on what it draws: a form the hooks closed since takes none of its keys', async () => {
  const held = instance(PROPS)
  held.click('add')
  held.key('G')
  const saved = { ...PROPS, formEpoch: 1, mirror: true, resume: held.posts.at(-1)!.ui! }
  const copy = instance(saved)
  expect(copy.draw(saved)[TAB_ROWS]).not.toMatch(/^ New entry/)
  copy.key('x')
  expect(copy.posts.map(p => p.ui?.form?.name ?? null)).not.toContain('Gx')
})

test("a form the hooks closed leaves none of its fields the keys, as Cancel does: typing reaches no hidden value", async () => {
  const held = instance(PROPS)
  held.click('add')
  for (let i = 0; i < 8 && held.posts.at(-1)!.ui!.focus !== 'value'; i++) held.key('tab')
  const ui = held.posts.at(-1)!.ui!
  expect(ui.focus).toBe('value')
  const saved = { ...PROPS, formEpoch: 1, resume: ui }
  const next = instance(saved)
  next.key('x')
  expect(next.posts.flatMap(p => p.edits).some(e => 'field' in e && e.field === 'value' && e.kind === 'insert')).toBe(false)
  expect(next.posts.at(-1)?.ui?.focus).toBe('add')
})

test('a locked vault: one passphrase field with Show, and Unlock; typing fills it, Enter or Unlock opens', async () => {
  const rows = draw(LOCKED, CLOSED)
  expectWidths(rows)
  expect(rows[TAB_ROWS]).toMatch(/^ Vault locked/)
  expect(rows.some(r => r.startsWith(' Passphrase  [ ▏') && r.includes('Show ]'))).toBe(true)
  expect(rows.some(r => r.includes('│ Unlock │'))).toBe(true)
  expect(rows.some(r => r.includes('Repeat'))).toBe(false)
  const typed = key(CLOSED, 'p4ss', LOCKED)
  expect(typed.post).toEqual({ instance: 'v1', edits: [{ seq: 1, field: 'passphrase', kind: 'insert', at: 0, text: 'p4ss' }], focused: 'passphrase', caret: 4, formOpen: false })
  expect(actionOf(key(typed.state, 'return', LOCKED))).toEqual({ kind: 'open' })
  expect(actionOf(click(CLOSED, 'open', LOCKED))).toEqual({ kind: 'open' })
})

test('a new vault takes its passphrase twice; ↓ goes to the second, Tab passes Show on the way', async () => {
  const absent = { ...LOCKED, state: 'absent' as const }
  const rows = draw(absent, CLOSED)
  expect(rows[TAB_ROWS]).toMatch(/^ Create a vault/)
  expect(rows.some(r => r.startsWith(' Repeat '))).toBe(true)
  expect(rows.some(r => r.includes('│ Create │'))).toBe(true)
  const again = key(CLOSED, 'down', absent)
  expect(again.post?.focused).toBe('again')
  expect(key(again.state, 'x', absent).post?.edits).toEqual([{ seq: 1, field: 'again', kind: 'insert', at: 0, text: 'x' }])
  expect(key(CLOSED, 'tab', absent).state.focus).toBe('show:passphrase')
  expect(key(CLOSED, 'tab', absent).post?.focused).toBe('passphrase')
  expect(click(again.state, 'passphrase', absent).post?.focused).toBe('passphrase')
})

test('Show turns a held field to plain text and back; Ctrl+R does it from the field; only peeked text reaches the view', async () => {
  const props = { ...LOCKED, lengths: { value: 0, passphrase: 4, again: 0 } }
  expect(click(CLOSED, 'show:passphrase', props).post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'peek' }])
  expect(key(CLOSED, { key: 'r', ctrl: true }, props).post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'peek' }])
  const hidden = draw(props, CLOSED)
  expect(hidden.some(r => r.includes('[ ••••▏') && r.includes('Show ]'))).toBe(true)
  const shown = draw({ ...props, peeked: { passphrase: 'abcd' } }, CLOSED)
  expect(shown.some(r => r.includes('[ abcd▏') && r.includes('Hide ]'))).toBe(true)
  expectWidths(shown)
  const typing = key(CLOSED, 'e', props).state
  expect(draw({ ...props, peeked: { passphrase: 'abcd' } }, typing).some(r => r.includes('abcde'))).toBe(true)
  expect(shownText('abcd', 'passphrase', [{ seq: 1, field: 'passphrase', kind: 'back', at: 2 }, { seq: 2, field: 'again', kind: 'clear' }])).toBe('acd')
})

test('a held field edits at a caret too: the edits name where, a click places it, the hooks\' paste moves it past', async () => {
  const props = { ...LOCKED, lengths: { value: 0, passphrase: 4, again: 0 } }
  const moved = key(key(CLOSED, 'left', props).state, 'left', props)
  expect([moved.state.caret, moved.post]).toEqual([2, undefined])
  expect(draw(props, moved.state).some(r => r.includes('[ ••▏••'))).toBe(true)
  const typed = key(moved.state, 'x', props)
  expect(typed.post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'insert', at: 2, text: 'x' }])
  expect(typed.post?.caret).toBe(3)
  expect(key(key(moved.state, 'home', props).state, 'delete', props).post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'del', at: 0 }])
  expect(key(moved.state, 'backspace', props).post?.edits).toEqual([{ seq: 1, field: 'passphrase', kind: 'back', at: 2 }])
  const clicked = click(CLOSED, 'passphrase@1', props)
  expect([clicked.state.caret, clicked.post?.caret]).toEqual([1, 1])
  const pasted = withPastes(clicked.state, { ...props, pastes: [{ seq: 4, field: 'passphrase', at: 1, length: 6 }] })
  expect([pasted.caret, pasted.pasted]).toEqual([7, 4])
  expect(withPastes(clicked.state, { ...props, pastes: [{ seq: 4, field: 'again', at: 0, length: 6 }] }).caret).toBe(1)
})

test('the open vault: buttons, then the entries right under their column names, with each access a dropdown at the row end', async () => {
  const rows = draw(PROPS)
  expectWidths(rows)
  expect(rows[TAB_ROWS + 1]).toMatch(/^ │ \+ Add entry │ │ Change passphrase │ │ Lock vault │ +$/)
  expect(rows[TAB_ROWS + 3]).toMatch(/^ Name +Tag +Type +Access *$/)
  expect(rows.find(r => r.startsWith(' Prod DB'))).toMatch(/^ Prod DB +db +Password +\[ Allow   ▾ \] $/)
  expect(rows.find(r => r.startsWith(' Deploy'))).toMatch(/^ Deploy +deploy +Token +\[ Ask     ▾ \] $/)
  expect(rows.some(r => r.startsWith('   Drag a row or press Shift+↑/↓ to reorder'))).toBe(true)
  expect(rows).toContain(' Unsaved values' + ' '.repeat(45))
  expect(accessLabel('refused')).toBe('Deny')
})

test("a row opens its entry; only the row's dropdown changes access, through a list that says what each means", async () => {
  expect(click(START, 'row:e1').state.form).toEqual({ id: 'e1', suggestion: null, name: 'Prod DB', tag: 'db', kind: 'password' })
  const opened = click(START, 'access:e2')
  expect(opened.state.open).toBe('access:e2')
  expect(opened.post).toBeDefined()
  expect(actionOf(opened)).toBe(undefined)
  const rows = draw(PROPS, opened.state)
  expectWidths(rows)
  expect(rows.some(r => r.includes('▸ Ask') && r.includes('confirm each use'))).toBe(true)
  expect(rows.some(r => r.includes('Allow') && r.includes('use without asking'))).toBe(true)
  expect(rows.some(r => r.includes('Deny') && r.includes('never hand it out'))).toBe(true)
  expect(actionOf(click(opened.state, 'pick:2'))).toEqual({ kind: 'access', id: 'e2', access: 'refused' })
  expect(click(opened.state, 'pick:2').state.open).toBe(null)
  const outside = click(opened.state, 'add')
  expect(outside.state.open).toBe(null)
  expect(outside.state.form?.id).toBe(null)
  expect(click(opened.state, 'access:e2').state.open).toBe(null)
})

test('the access list works from the keyboard: Enter opens it on the current access, ↓ and Enter pick', async () => {
  const onAccess = keys(START, ['down', 'right'])
  expect(onAccess.focus).toBe('access:e1')
  const opened = key(onAccess, 'return').state
  expect([opened.open, opened.cursor]).toEqual(['access:e1', 1])
  expect(actionOf(key(key(opened, 'down').state, 'return'))).toEqual({ kind: 'access', id: 'e1', access: 'refused' })
  expect(key(opened, 'tab').state.open).toBe(null)
})

test('Lock asks first, for every session; Cancel goes back, Lock locks', async () => {
  const asked = click(START, 'lock')
  expect(pageOf(PROPS, asked.state)).toBe('confirm')
  expect(actionOf(asked)).toBe(undefined)
  const rows = draw(PROPS, asked.state)
  expectWidths(rows)
  expect(rows[TAB_ROWS]).toMatch(/^ Lock the vault\?/)
  expect(asked.state.focus).toBe('cancel')
  expect(pageOf(PROPS, key(asked.state, 'return').state)).toBe('list')
  expect(actionOf(click(asked.state, 'confirm'))).toEqual({ kind: 'lock' })
})

test('Add opens an empty form: Name, Tag, Type and Value, then Save and Cancel', async () => {
  const opened = click(START, 'add')
  expect(opened.state.form).toEqual({ id: null, suggestion: null, name: '', tag: '', kind: 'password' })
  expect(opened.post).toEqual({ instance: 'v1', edits: [{ seq: 1, field: 'value', kind: 'clear' }], focused: 'name', caret: END_CARET, formOpen: true })
  const rows = draw(PROPS, opened.state)
  expectWidths(rows)
  expect(rows[TAB_ROWS]).toMatch(/^ New entry/)
  expect(rows.some(r => r.startsWith(' Name    [ ▏'))).toBe(true)
  expect(rows.some(r => r.startsWith(' Tag     [ none (one is generated)') && r.endsWith('▾ ] '))).toBe(true)
  expect(rows.some(r => r.startsWith(' Type    (•) Password   ( ) Token   ( ) SSH key'))).toBe(true)
  expect(rows.some(r => r.startsWith(' Value   [ ') && r.endsWith('Show ] '))).toBe(true)
  expect(rows.some(r => r.includes('│ Save │ │ Cancel │'))).toBe(true)
})

test('the form fills from the keyboard: typing, Tab between fields, ←/→ on Kind, held typing on Value, Enter saves', async () => {
  let state = click(START, 'add').state
  state = keys(state, ['G', 'H', 'backspace', 'i'])
  expect(state.form?.name).toBe('Gi')
  state = key(state, 'tab').state
  expect(state.focus).toBe('tag')
  state = keys(state, ['m', 'y'])
  expect([state.form?.tag, state.ownTag]).toEqual(['my', 'my'])
  state = keys(state, ['down', 'right'])
  expect(state.form?.kind).toBe('token')
  const toValue = key(state, 'down')
  expect(toValue.post?.focused).toBe('value')
  const typed = key(toValue.state, 's3cret')
  expect(typed.post?.edits.at(-1)).toEqual({ seq: 2, field: 'value', kind: 'insert', at: 0, text: 's3cret' })
  expect(actionOf(key(typed.state, 'return'))).toEqual({ kind: 'save', form: { id: null, suggestion: null, name: 'Gi', tag: 'my', kind: 'token' } })
})

test("the tag dropdown lists what agents ask for, each with what asks, then the person's own", async () => {
  const form = click(START, 'add').state
  expect(tagOptions(PROPS, form.form!).map(o => o.tag)).toEqual(['sudo'])
  const opened = click(form, 'tag')
  expect([opened.state.open, opened.state.cursor]).toEqual(['tag', 1])
  const rows = draw(PROPS, opened.state)
  expectWidths(rows)
  expect(rows.some(r => r.includes('sudo') && r.includes('sudo -A asks for your password'))).toBe(true)
  expect(rows.some(r => r.includes('▸ Custom tag…'))).toBe(true)
  const typedInto = keys(opened.state, ['g', 'i', 't'])
  expect([typedInto.open, typedInto.form?.tag]).toEqual(['tag', 'git'])
  expect(draw(PROPS, typedInto).some(r => r.includes('▸ Custom tag…'))).toBe(true)
  const picked = click(opened.state, 'pick:0').state
  expect(picked.form?.tag).toBe('sudo')
  expect(draw(PROPS, picked).some(r => r.startsWith(' Tag     [ sudo · sudo -A asks for your password'))).toBe(true)
  const typedOver = keys(picked, ['x'])
  expect(typedOver.form?.tag).toBe('x')
  const back = click(click(typedOver, 'tag').state, 'pick:0').state
  expect(click(click(back, 'tag').state, 'pick:1').state.form?.tag).toBe('x')
  const editing = click(START, 'row:e1').state
  expect(tagOptions(PROPS, editing.form!).map(o => o.tag)).toEqual(['sudo', 'db'])
  const sshKey = click(editing, 'kind=ssh-key').state
  expect(tagOptions(PROPS, sshKey.form!)).toEqual([])
  expect(draw(PROPS, sshKey).some(r => r.startsWith(' Tag     [ db') && !r.includes('▾'))).toBe(true)
  expect(draw(PROPS, sshKey).some(r => r.startsWith(' File    [ leave empty to keep'))).toBe(true)
})

test('Kind is a radio group: a click picks; to or from an SSH key the typed value is dropped', async () => {
  const form = click(START, 'add').state
  const token = click(form, 'kind=token')
  expect(token.state.form?.kind).toBe('token')
  expect(token.post?.edits).toEqual(form.pending)
  const sshKey = click(form, 'kind=ssh-key')
  expect(sshKey.post?.edits.at(-1)).toEqual({ seq: 2, field: 'value', kind: 'clear' })
})

test('an entry: Save, Delete after confirming, Cancel back to its row', async () => {
  const edit = click(START, 'row:e1').state
  expect(draw(PROPS, edit)[TAB_ROWS]).toMatch(/^ Edit entry/)
  expect(draw(PROPS, edit).some(r => r.includes('│ Save │ │ Delete │ │ Cancel │'))).toBe(true)
  expect(actionOf(click(edit, 'save'))).toEqual({ kind: 'save', form: edit.form })
  const asked = click(edit, 'delete')
  expect(actionOf(asked)).toBe(undefined)
  expect(draw(PROPS, asked.state)[TAB_ROWS]).toMatch(/^ Delete Prod DB\?/)
  expect(actionOf(click(asked.state, 'confirm'))).toEqual({ kind: 'delete', id: 'e1' })
  expect(pageOf(PROPS, click(asked.state, 'cancel').state)).toBe('form')
  const closed = click(edit, 'cancel')
  expect(closed.state.form).toBe(null)
  expect(closed.state.focus).toBe('row:e1')
  expect(closed.post?.edits.at(-1)).toEqual({ seq: 2, field: 'value', kind: 'clear' })
  expect(closed.post?.formOpen).toBe(false)
})

test('a typed value opens as an entry to keep, named by its prompt; no SSH key, no value to type, Discard drops it', async () => {
  const opened = click(START, 'sugg:s1')
  expect(opened.state.form).toEqual({ id: null, suggestion: 's1', name: '[sudo] password for alex', tag: '', kind: 'password' })
  const rows = draw(PROPS, opened.state)
  expect(rows[TAB_ROWS]).toMatch(/^ Save typed value/)
  expect(rows.some(r => r.includes('SSH key'))).toBe(false)
  expect(rows.some(r => r.startsWith(' Value   the value you typed'))).toBe(true)
  expect(rows.some(r => r.includes('│ Save │ │ Discard │ │ Cancel │'))).toBe(true)
  expect(keys(opened.state, ['down', 'down', 'right', 'right']).form?.kind).toBe('password')
  expect(actionOf(click(opened.state, 'dismiss'))).toEqual({ kind: 'dismiss', id: 's1' })
})

test('Change passphrase empties both fields first; Enter or Change sends it, Cancel leaves', async () => {
  const opened = click(START, 'rekey')
  expect(opened.state.rekeying).toBe(true)
  expect(opened.post?.edits).toEqual([
    { seq: 1, field: 'passphrase', kind: 'clear' },
    { seq: 2, field: 'again', kind: 'clear' },
  ])
  expect(opened.post?.focused).toBe('passphrase')
  const again = key(key(opened.state, 'n3w').state, 'down')
  expect(again.post?.focused).toBe('again')
  expect(actionOf(key(again.state, 'return'))).toEqual({ kind: 'rekey' })
  expect(actionOf(click(again.state, 'change'))).toEqual({ kind: 'rekey' })
  const left = click(again.state, 'cancel')
  expect(left.state.rekeying).toBe(false)
  expect(left.post?.edits.slice(-2).map(e => ('field' in e ? e.field + ' ' + e.kind : e.kind))).toEqual(['passphrase clear', 'again clear'])
  const rows = draw(PROPS, again.state)
  expectWidths(rows)
  expect(rows[TAB_ROWS]).toMatch(/^ Change passphrase/)
  expect(draw({ ...PROPS, formEpoch: 1 }, again.state).some(r => r.includes('+ Add entry'))).toBe(true)
})

test("the session's own ssh-agent: a checkbox under its heading, only when there is one", async () => {
  const rows = draw(PROPS)
  expect(rows).toContain(' SSH agent' + ' '.repeat(50))
  expect(rows.some(r => r.startsWith(' [ ] Forward my SSH agent to this session'))).toBe(true)
  expect(actionOf(click(START, 'forward'))).toEqual({ kind: 'forward', on: true })
  expect(actionOf(click(START, 'forward', { ...PROPS, forward: true }))).toEqual({ kind: 'forward', on: false })
  expect(draw({ ...PROPS, forward: true }).some(r => r.startsWith(' [x] Forward my SSH agent'))).toBe(true)
  expect(draw({ ...PROPS, forward: null }).some(r => r.includes('SSH agent'))).toBe(false)
  const failed = draw({ ...PROPS, error: 'there is no ssh-agent of yours to forward to' })
  expect(failed.some(r => r.startsWith(' there is no ssh-agent of yours to forward to'))).toBe(true)
  const onForward = key(START, { key: 'tab', shift: true })
  expect(onForward.state.focus).toBe('forward')
  expect(actionOf(key(onForward.state, 'space'))).toEqual({ kind: 'forward', on: true })
})

test("the focus stays on its entry when another session's change moves the rows; once it went, keys act on nothing", async () => {
  const onDeploy = keys(START, ['down', 'down'])
  expect(onDeploy.focus).toBe('row:e2')
  const shifted = { ...PROPS, entries: [ENTRIES[1]!] }
  expect(key(onDeploy, 'return', shifted).state.form?.id).toBe('e2')
  const gone = { ...PROPS, entries: [ENTRIES[0]!] }
  expect(key(onDeploy, 'space', gone).post).toBe(undefined)
  expect(key(onDeploy, 'return', gone).post).toBe(undefined)
  expect(key(onDeploy, 'down', gone).state.focus).toBe('add')
})

test('the Requests tab switches back; a saved form closes when the hooks bump the epoch', async () => {
  const requests = tabSpans(PROPS.tabs)[0]!
  expect(onClick(START, PROPS, 0, requests.start + 1).post?.edits.find(e => e.kind === 'tab')).toEqual({ seq: 1, kind: 'tab', tab: 'requests' })
  const edit = click(START, 'row:e1').state
  expect(draw({ ...PROPS, formEpoch: 1 }, edit).some(r => r.includes('+ Add entry'))).toBe(true)
})

test('the view is as tall as its tallest page with its longest list open, so nothing waits for it to grow', async () => {
  const rows = contentRows(PROPS)
  const pages = [
    START,
    click(START, 'access:e1').state,
    click(click(START, 'add').state, 'tag').state,
    click(START, 'rekey').state,
    click(START, 'lock').state,
    click(click(START, 'row:e1').state, 'delete').state,
  ]
  for (const state of pages) expect(drawPage(PROPS, state).lines.length).toBeLessThanOrEqual(rows)
  expect(contentRows(LOCKED)).toBe(drawPage(LOCKED, CLOSED).lines.length)
  for (const state of pages) expect(draw({ ...PROPS, error: 'tag db is taken or not made of letters, digits, - _ .' }, state).length).toBe(TAB_ROWS + contentRows({ ...PROPS, error: 'x' }))
})

test('a page taller than the view scrolls to keep the focus in view', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, name: `Entry ${i}`, tag: `t${i}`, kind: 'password' as const, access: 'ask' as const }))
  const props = { ...PROPS, entries: many, rows: 14 }
  const atLast = keys(START, Array(20).fill('down'), props)
  expect(atLast.focus).toBe('row:m19')
  const shown = shownPage(props, atLast).lines
  expect(shown.length).toBe(12)
  expect(click(atLast, 'row:m19', props).state.form?.id).toBe('m19')
})

test('a colliding plugin replaces the vault with what it hooks and Allow / Block; keys do nothing there', async () => {
  const props = { ...PROPS, collisions: [{ name: 'tracer', carriers: ['http.fetch'], refused: false, changed: false }] }
  const rows = draw(props)
  expectWidths(rows)
  expect(rows[TAB_ROWS]).toContain('⚠ tracer sees secrets in http.fetch')
  expect(rows.some(r => r.includes('code changed'))).toBe(false)
  const changed = draw({ ...props, collisions: [{ ...props.collisions[0]!, changed: true }] })
  expect(changed[TAB_ROWS + 1]).toContain('Its code changed since you allowed it.')
  expectWidths(changed)
  expect(rows.some(r => r.includes('│ Block │'))).toBe(true)
  expect(rows.some(r => r.includes('+ Add entry'))).toBe(false)
  expect(actionOf(click(START, 'allow:tracer', props))).toEqual({ kind: 'collision', name: 'tracer', decision: 'allow' })
  expect(actionOf(click(START, 'refuse:tracer', props))).toEqual({ kind: 'collision', name: 'tracer', decision: 'refuse' })
  expect(key(START, 'return', props).post).toBe(undefined)
  const refused = draw({ ...props, collisions: [{ ...props.collisions[0]!, refused: true }] })
  expect(refused.some(r => r.includes('│ Allow │'))).toBe(false)
  expect(refused.some(r => r.includes('Blocked from the next session start.'))).toBe(true)
  expectWidths(refused)
})

test('Name and Tag edit at a caret: ←/→, Home/End, Backspace before it, Delete after it, a click on a character places it', async () => {
  const opened = click(START, 'sugg:s1').state
  expect(opened.caret).toBe(END_CARET)
  let state = keys(opened, ['home', 'delete'])
  expect(state.form?.name).toBe('sudo] password for alex')
  state = keys(state, ['right', 'right', 'right', 'right', 'delete', 'end', 'backspace', 'left', 'X'])
  expect(state.form?.name).toBe('sudo password for alXe')
  expect(draw(PROPS, state).some(r => r.startsWith(' Name    [ sudo password for alX▏e'))).toBe(true)
  const placed = click(state, 'name@5')
  expect([placed.state.focus, placed.state.caret]).toEqual(['name', 5])
  expect(placed.post?.focused).toBe('name')
  expect(key(placed.state, '-').state.form?.name).toBe('sudo -password for alXe')
  const typedTag = keys(key(placed.state, 'tab').state, ['d', 'b', 'left', 'x'])
  expect([typedTag.form?.tag, typedTag.ownTag]).toEqual(['dxb', 'dxb'])
  const offered = click(click(typedTag, 'tag').state, 'pick:0').state
  expect(keys(offered, ['left', 'home', 'end']).form?.tag).toBe('sudo')
  expect(keys(offered, ['q']).form?.tag).toBe('q')
})

test('a paste into Name or Tag comes in props: taken in once, at the caret, then posted so the hooks drop it', async () => {
  const view = instance(PROPS)
  view.click('add')
  view.key('a')
  view.key('b')
  view.key('left')
  expect(view.posts.at(-1)!.focused).toBe('name')
  const pastes = [{ seq: 7, field: 'name' as const, text: 'XY' }]
  view.draw({ ...PROPS, pastes })
  const taken = view.posts.at(-1)!
  expect([taken.ui?.form?.name, taken.ui?.caret, taken.ui?.pasted]).toEqual(['aXYb', 3, 7])
  const before = view.posts.length
  view.draw({ ...PROPS, pastes })
  expect(view.posts.length).toBe(before)
  const form = { ...initialState(0, 'v1'), form: { id: null, suggestion: null, name: 'n', tag: 'db', kind: 'password' as const }, focus: 'name', caret: 0 }
  const toTag = withPastes(form, { ...PROPS, pastes: [{ seq: 1, field: 'tag', text: '-2' }] })
  expect([toTag.form?.tag, toTag.ownTag, toTag.caret, toTag.form?.name]).toEqual(['db-2', 'db-2', 0, 'n'])
  expect(withPastes({ ...form, form: null }, { ...PROPS, pastes: [{ seq: 1, field: 'name', text: 'x' }] }).pasted).toBe(1)
  expect(key(START, 'down').post?.focused).toBe(null)
})

test('Shift+↑/↓ on a row moves its entry, shown at once; past either end it stays', async () => {
  const onFirst = key(START, 'down').state
  expect(onFirst.focus).toBe('row:e1')
  const moved = key(onFirst, { key: 'down', shift: true })
  expect(actionOf(moved)).toEqual({ kind: 'move', id: 'e1', to: 1 })
  expect(shownEntries(PROPS.entries, moved.state).map(e => e.id)).toEqual(['e2', 'e1'])
  expect(draw(PROPS, moved.state).findIndex(r => r.startsWith(' Deploy'))).toBeLessThan(draw(PROPS, moved.state).findIndex(r => r.startsWith(' Prod DB')))
  expect(moved.state.focus).toBe('row:e1')
  expect(actionOf(key(moved.state, { key: 'down', shift: true }))).toBe(undefined)
  expect(actionOf(key(onFirst, { key: 'up', shift: true }))).toBe(undefined)
  expect(actionOf(key(moved.state, { key: 'up', shift: true }))).toEqual({ kind: 'move', id: 'e1', to: 0 })
})

test('a row held by the pointer: let go in place it opens, dragged it moves to where it is let go', async () => {
  const at = (state: ViewState, hit: string) => {
    const { y, x } = cellOf(PROPS, state, hit)
    return { y: y + TAB_ROWS, x }
  }
  const first = at(START, 'row:e1')
  const held = onPress(START, PROPS, first.y, first.x).state
  expect([held.drag, held.form, held.focus]).toEqual([{ id: 'e1', to: 0 }, null, 'row:e1'])
  expect(onRelease(held, PROPS)!.state.form?.id).toBe('e1')
  const dragged = onDrag(held, PROPS, at(START, 'row:e2').y)!.state
  expect(dragged.drag).toEqual({ id: 'e1', to: 1 })
  expect(shownEntries(PROPS.entries, dragged).map(e => e.id)).toEqual(['e2', 'e1'])
  expect(onDrag(dragged, PROPS, first.y + 9)).toBe(null)
  const dropped = onRelease(dragged, PROPS)!
  expect(actionOf(dropped)).toEqual({ kind: 'move', id: 'e1', to: 1 })
  expect(dropped.state.drag).toBe(null)
  expect(onDrag(START, PROPS, first.y)).toBe(null)
  expect(onRelease(START, PROPS)).toBe(null)
  expect(onPress(START, PROPS, at(START, 'add').y, at(START, 'add').x).state.form?.id).toBe(null)
})
