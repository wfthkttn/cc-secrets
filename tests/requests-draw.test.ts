import { expect, test } from 'claude-code/testing'

import Requests from '../hooks/requests'
import type { RequestsProps } from '../hooks/requests-props'

type Node = { type: string; children?: unknown[] }

function text(node: unknown): string {
  if (typeof node === 'string') return node
  return ((node as Node).children ?? []).map(text).join('')
}

function draw(props: RequestsProps) {
  let state: unknown
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
  return (draw(props, surface).children ?? []).map(text)
}

test('every row is exactly as wide as the list, before the surface has laid out too', async () => {
  const rows = draw({
    focusEpoch: 0,
    applied: {},
    columns: 60,
    rows: 40,
    message: 'A paste of 3+ lines or 800+ characters went into the prompt, not the request.',
    entries: [
      { id: 'a', prompt: '[sudo] password for alex', source: 'sudo -A systemctl restart foo', since: '04:00:00', length: 0 },
      { id: 'b', prompt: 'token B', source: 'echo "B=$($ASK_SECRET \'token B\')" && ' + 'x'.repeat(90), since: '04:00:05', length: 5 },
    ],
  })
  for (const row of rows) expect([...row].length).toBe(60)
})

test('an overflowing list draws exactly its rows, the markers included', async () => {
  const entries = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, prompt: 'token ' + id, source: 'echo', since: '04:00:00', length: 0 }))
  const rows = draw({ focusEpoch: 0, applied: {}, message: null, columns: 60, rows: 17, entries })
  expect(rows.length).toBe(17)
  expect(rows[16]!.trim()).toBe('▼ 3 more')
  for (const row of rows) expect([...row].length).toBe(60)
})
