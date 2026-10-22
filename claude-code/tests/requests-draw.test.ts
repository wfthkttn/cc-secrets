import { expect, test } from 'claude-code/testing'

import Requests, { initialState, type ListState } from '../hooks/requests'
import type { RequestsMessage, RequestsProps } from '../hooks/requests-props'

type Node = { type: string; position?: string; top?: number; left?: number; children?: unknown[] }

function text(node: unknown): string {
  if (typeof node === 'string') return node
  return ((node as Node).children ?? []).map(text).join('')
}

function draw(props: RequestsProps, initial?: ListState) {
  return nodes(props, initial).filter(n => n.position !== 'absolute').map(text)
}

function nodes(props: RequestsProps, initial?: ListState): Node[] {
  let state: unknown = initial
  const surface = {
    elements: {
      Box: (p: object) => ({ type: 'Box', ...p }),
      Text: (p: object) => ({ type: 'Text', ...p }),
    },
    get state() {
      return state
    },
    setState: (next: unknown) => {
      state = next
    },
    columns: 0,
    rows: 0,
    every: () => () => {},
    onPointer: () => () => {},
    onKey: () => () => {},
    post: () => {},
  }
  const draw = Requests as unknown as (p: RequestsProps, s: typeof surface) => Node
  draw(props, surface)
  return (draw(props, surface).children ?? []) as Node[]
}

/** One instance of the list, as the engine runs it: its own state, the listeners it set, what it posted. */
function instance(props: RequestsProps) {
  let state: unknown
  let onPointer: (p: object) => void = () => {}
  let onKey: (k: object) => void = () => {}
  const posts: RequestsMessage[] = []
  const surface = {
    elements: { Box: (p: object) => ({ type: 'Box', ...p }), Text: (p: object) => ({ type: 'Text', ...p }) },
    get state() {
      return state
    },
    setState: (next: unknown) => {
      state = next
    },
    columns: 0,
    rows: 0,
    every: () => () => {},
    onPointer: (fn: (p: object) => void) => ((onPointer = fn), () => {}),
    onKey: (fn: (k: object) => void) => ((onKey = fn), () => {}),
    post: (data: RequestsMessage) => posts.push(data),
  }
  const view = Requests as unknown as (p: RequestsProps, s: typeof surface) => Node
  const draw = (p: RequestsProps) => (view(p, surface).children ?? []) as Node[]
  draw(props)
  return { draw, posts, pointer: (y: number, x: number) => onPointer({ type: 'down', y, x }), key: (key: string) => onKey({ key }) }
}

test('a new instance, as each new transcript row makes, goes on from the state the last one posted; typed characters stay out of it', async () => {
  const offer = [{ id: 'e1', label: 'Prod DB · db' }]
  const entries = [
    { id: 'a', kind: 'secret' as const, prompt: 'first', source: '', since: '04:00:00', length: 0, text: null, offer: null, chosen: null },
    { id: 'b', kind: 'secret' as const, prompt: 'second', source: '', since: '04:00:01', length: 0, text: null, offer, chosen: null },
  ]
  const props: RequestsProps = { focusEpoch: 0, tabs: null, applied: {}, columns: 60, rows: 40, message: null, typingOff: null, pastes: [], resume: null, entries }
  const first = instance(props)
  first.key('down')
  first.key('s3cr3t')
  first.key('tab')
  const ui = first.posts.at(-1)!.ui!
  expect([ui.selected, ui.isMenuOpen]).toEqual(['b', true])
  expect(JSON.stringify(ui)).not.toContain('s3cr3t')
  expect(first.posts.at(-1)!.edits).toEqual([{ seq: 1, id: 'b', kind: 'insert', at: 0, text: 's3cr3t' }])
  const next = instance({ ...props, applied: { [ui.instance]: 1 }, resume: ui })
  const drawn = next.draw({ ...props, applied: { [ui.instance]: 1 }, resume: ui })
  expect(drawn.some(n => n.position === 'absolute' && text(n).includes('Prod DB · db'))).toBe(true)
  next.key('return')
  expect(next.posts.at(-1)!.edits).toEqual([{ seq: 2, id: 'b', kind: 'choose', entry: null }])
})

test('a typed value shows as dots with Show, or as text with Hide while the hooks send it', async () => {
  const props = (text: string | null): RequestsProps => ({
    focusEpoch: 0,
    tabs: null,
    applied: {},
    columns: 60,
    rows: 20,
    message: null,
    typingOff: null, pastes: [], resume: null,
    entries: [{ id: 'a', kind: 'secret', prompt: 'token', source: '', since: '04:00:00', length: 4, text, offer: null, chosen: null }],
  })
  const hidden = draw(props(null))
  expect(hidden.some(r => r.includes('••••') && r.includes(' Show │'))).toBe(true)
  const shown = draw(props('s3cr'))
  expect(shown.some(r => r.includes('s3cr') && r.includes(' Hide │'))).toBe(true)
  for (const row of shown) expect([...row].length).toBe(60)
  const typing = { ...initialState(0, 'i1'), isFocused: true, caret: 1 }
  expect(draw(props('s3cr'), typing).some(r => r.includes('s▏3cr'))).toBe(true)
  expect(draw(props(null), typing).some(r => r.includes('•▏•••'))).toBe(true)
})

test("a paste the hooks made is taken in once and posted, so the hooks drop it", async () => {
  const entries = [{ id: 'a', kind: 'secret' as const, prompt: 'token', source: '', since: '04:00:00', length: 4, text: null, offer: null, chosen: null }]
  const props: RequestsProps = { focusEpoch: 0, tabs: null, applied: {}, columns: 60, rows: 20, message: null, typingOff: null, pastes: [], resume: null, entries }
  const list = instance(props)
  list.key('left')
  const pasted = { ...props, entries: [{ ...entries[0]!, length: 9 }], pastes: [{ seq: 3, id: 'a', at: 3, length: 5 }] }
  list.draw(pasted)
  expect([list.posts.at(-1)!.ui?.pasted, list.posts.at(-1)!.caret]).toEqual([3, 8])
  const before = list.posts.length
  list.draw(pasted)
  expect(list.posts.length).toBe(before)
})

test('every row is exactly as wide as the list, before the surface has laid out too', async () => {
  const rows = draw({
    focusEpoch: 0, tabs: null,
    applied: {},
    columns: 60,
    rows: 40,
    message: 'A paste of 3+ lines or 800+ characters went into the prompt, not the request.',
    typingOff: null, pastes: [], resume: null,
    entries: [
      { id: 'a', kind: 'secret', prompt: '[sudo] password for alex', source: 'sudo -A systemctl restart foo', since: '04:00:00', length: 0, text: null, offer: null, chosen: null },
      {
        id: 'b',
        kind: 'secret',
        prompt: 'token B',
        source: 'echo "B=$(secrets ask \'token B\')" && ' + 'x'.repeat(90),
        since: '04:00:05',
        length: 5,
        text: null,
        offer: null,
        chosen: null,
      },
    ],
  })
  for (const row of rows) expect([...row].length).toBe(60)
})

const LONG = [{ id: 'e1', label: 'A very long entry name that will not fit · db' }, ...['b', 'c', 'd', 'e', 'f', 'g', 'h'].map(t => ({ id: t, label: `${t} · ${t}` }))]

test('a sign card draws its three buttons and a named key its row, each row as wide as the list', async () => {
  const rows = draw({
    focusEpoch: 0, tabs: null,
    applied: {},
    columns: 60,
    rows: 40,
    message: null, typingOff: null, pastes: [], resume: null,
    entries: [
      { id: 'g', kind: 'sign', prompt: 'Deploy key · deploy', source: 'git push', since: '04:00:00', length: 0, text: null, offer: null, chosen: null },
      { id: 'u', kind: 'secret', prompt: 'DB password', source: '', since: '04:00:01', length: 0, text: null, offer: LONG, chosen: 'e1' },
    ],
  })
  for (const row of rows) expect([...row].length).toBe(60)
  expect(rows.some(r => r.includes('│ Allow for session │ │ Allow once │ │ ✕ │'))).toBe(true)
  expect(rows.some(r => r.includes('A very long') && r.includes('…') && r.includes('▾'))).toBe(true)
  expect(rows.some(r => r.includes('│ Allow for session │ │ Allow once │') && !r.includes('✕'))).toBe(true)
})

test('the rows fill the whole room, blank under the cards, so a shut menu leaves nothing behind', async () => {
  const entries = [{ id: 'u', kind: 'secret' as const, prompt: 'deploy token', source: '', since: '04:00:01', length: 0, text: null, offer: LONG, chosen: null }]
  const rows = draw({ focusEpoch: 0, tabs: null, applied: {}, columns: 60, rows: 40, message: null, typingOff: null, pastes: [], resume: null, entries })
  expect(rows.length).toBe(40)
  expect(rows.slice(6).every(r => r.trim() === '')).toBe(true)
})

test('an open menu is a window over the rows under the field: Type, the entries, the cursor and where it is', async () => {
  const entries = [{ id: 'u', kind: 'secret' as const, prompt: 'deploy token', source: '', since: '04:00:01', length: 0, text: null, offer: LONG, chosen: null }]
  const all = nodes({ focusEpoch: 0, tabs: null, applied: {}, columns: 60, rows: 40, message: null, typingOff: null, pastes: [], resume: null, entries }, {
    ...initialState(0, 'i'),
    selected: 'u',
    isFocused: true,
    isMenuOpen: true,
  })
  const menu = all.find(n => n.position === 'absolute')!
  expect([menu.top, menu.left]).toEqual([5, 2])
  const lines = (menu.children ?? []).map(text)
  for (const line of lines) expect([...line].length).toBe(lines[0]!.length)
  expect(lines[1]).toContain('▸ Type')
  expect(lines[2]).toContain('A very long')
  expect(lines.some(l => l.includes('1 of 9, ↑/↓'))).toBe(true)
  expect(lines.length).toBe(6 + 3)
})

test('an overflowing list draws exactly its rows, the markers included', async () => {
  const entries = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, kind: 'secret' as const, prompt: 'token ' + id, source: 'echo', since: '04:00:00', length: 0, text: null, offer: null, chosen: null }))
  const rows = draw({ focusEpoch: 0, tabs: null, applied: {}, message: null, typingOff: null, pastes: [], resume: null, columns: 60, rows: 17, entries })
  expect(rows.length).toBe(17)
  expect(rows[16]!.trim()).toBe('▼ 3 more')
  for (const row of rows) expect([...row].length).toBe(60)
})
