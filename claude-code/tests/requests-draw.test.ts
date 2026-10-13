import { expect, test } from 'claude-code/testing'

import Requests, { initialState, type ListState } from '../hooks/requests'
import type { RequestsProps } from '../hooks/requests-props'

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

test('every row is exactly as wide as the list, before the surface has laid out too', async () => {
  const rows = draw({
    focusEpoch: 0, tabs: null,
    applied: {},
    columns: 60,
    rows: 40,
    message: 'A paste of 3+ lines or 800+ characters went into the prompt, not the request.',
    typingOff: null,
    entries: [
      { id: 'a', kind: 'secret', prompt: '[sudo] password for alex', source: 'sudo -A systemctl restart foo', since: '04:00:00', length: 0, offer: null, chosen: null },
      {
        id: 'b',
        kind: 'secret',
        prompt: 'token B',
        source: 'echo "B=$(secrets ask \'token B\')" && ' + 'x'.repeat(90),
        since: '04:00:05',
        length: 5,
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
    message: null, typingOff: null,
    entries: [
      { id: 'g', kind: 'sign', prompt: 'Deploy key · deploy', source: 'git push', since: '04:00:00', length: 0, offer: null, chosen: null },
      { id: 'u', kind: 'secret', prompt: 'DB password', source: '', since: '04:00:01', length: 0, offer: LONG, chosen: 'e1' },
    ],
  })
  for (const row of rows) expect([...row].length).toBe(60)
  expect(rows.some(r => r.includes('│ Session │ │ Once │ │ ✕ │'))).toBe(true)
  expect(rows.some(r => r.includes('A very long') && r.includes('…') && r.includes('▾'))).toBe(true)
  expect(rows.some(r => r.includes('│ Session │ │ Once │') && !r.includes('✕'))).toBe(true)
})

test('the rows fill the whole room, blank under the cards, so a shut menu leaves nothing behind', async () => {
  const entries = [{ id: 'u', kind: 'secret' as const, prompt: 'deploy token', source: '', since: '04:00:01', length: 0, offer: LONG, chosen: null }]
  const rows = draw({ focusEpoch: 0, tabs: null, applied: {}, columns: 60, rows: 40, message: null, typingOff: null, entries })
  expect(rows.length).toBe(40)
  expect(rows.slice(6).every(r => r.trim() === '')).toBe(true)
})

test('an open menu is a window over the rows under the field: Type, the entries, the cursor and where it is', async () => {
  const entries = [{ id: 'u', kind: 'secret' as const, prompt: 'deploy token', source: '', since: '04:00:01', length: 0, offer: LONG, chosen: null }]
  const all = nodes({ focusEpoch: 0, tabs: null, applied: {}, columns: 60, rows: 40, message: null, typingOff: null, entries }, {
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
  const entries = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, kind: 'secret' as const, prompt: 'token ' + id, source: 'echo', since: '04:00:00', length: 0, offer: null, chosen: null }))
  const rows = draw({ focusEpoch: 0, tabs: null, applied: {}, message: null, typingOff: null, columns: 60, rows: 17, entries })
  expect(rows.length).toBe(17)
  expect(rows[16]!.trim()).toBe('▼ 3 more')
  for (const row of rows) expect([...row].length).toBe(60)
})
