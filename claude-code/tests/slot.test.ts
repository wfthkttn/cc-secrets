import { expect, test } from 'claude-code/testing'

import { fillSlot, hasSlot } from '../hooks/slot'

const box = (props: object, children: unknown[]) => Object.freeze({ type: 'Box', props: Object.freeze(props), children: Object.freeze(children) })
const text = (s: string) => Object.freeze({ type: 'Text', props: {}, children: [s] })
const CONTENT = text('content')

test('fills the keyed Box deep in a frozen tree', async () => {
  const engine = { ref: 'engine row' }
  const tree = box({}, [engine, box({ position: 'absolute' }, [box({}, [text('title')]), box({ key: 'sidebar-drawer:pass' }, [])])])
  const filled = fillSlot(tree, 'sidebar-drawer:pass', () => CONTENT) as any
  expect(filled.children[0]).toBe(engine)
  expect(filled.children[1].children[1].children).toEqual([CONTENT])
  expect(filled.children[1].children[0]).toBe(tree.children[1] && (tree.children[1] as any).children[0])
})

test('no keyed Box: the same tree, content not built', async () => {
  const tree = box({}, [{ ref: 'engine row' }])
  let built = false
  expect(fillSlot(tree, 'sidebar-drawer:pass', () => ((built = true), CONTENT))).toBe(tree)
  expect(built).toBe(false)
})

test('hasSlot finds a keyed Box at any depth', async () => {
  const tree = box({}, [{ ref: 'engine row' }, box({}, [box({ key: 'sidebar-popout:pass' }, [])])])
  expect(hasSlot(tree, 'sidebar-popout:pass')).toBe(true)
  expect(hasSlot(tree, 'sidebar-drawer:pass')).toBe(false)
})

test('another tool\'s slot stays empty', async () => {
  const tree = box({}, [box({ key: 'sidebar-drawer:other' }, [])])
  expect(fillSlot(tree, 'sidebar-drawer:pass', () => CONTENT)).toBe(tree)
})
