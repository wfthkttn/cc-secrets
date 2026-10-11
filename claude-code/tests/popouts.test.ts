import { expect, test } from 'claude-code/testing'

import { Popouts } from '../hooks/popouts'

function clock() {
  let now = 0
  const pending: { at: number; fn: () => void; live: boolean }[] = []
  return {
    after: (ms: number, fn: () => void) => {
      const timer = { at: now + ms, fn, live: true }
      pending.push(timer)
      return { cancel: () => (timer.live = false) }
    },
    advance(ms: number) {
      now += ms
      for (const timer of pending) {
        if (timer.live && timer.at <= now) {
          timer.live = false
          timer.fn()
        }
      }
    },
  }
}

function setup() {
  const c = clock()
  let changes = 0
  const popouts = new Popouts(15000, c.after, () => changes++)
  return { c, popouts, changes: () => changes }
}

test('a card left alone hides after 15 s', async () => {
  const { c, popouts } = setup()
  popouts.add('a')
  c.advance(14999)
  expect(popouts.shown()).toEqual(['a'])
  c.advance(1)
  expect(popouts.shown()).toEqual([])
})

test('focus stops the wait; losing it starts a fresh 15 s', async () => {
  const { c, popouts } = setup()
  popouts.add('a')
  c.advance(10000)
  popouts.focus('a')
  c.advance(60000)
  expect(popouts.shown()).toEqual(['a'])
  popouts.blur()
  c.advance(14999)
  expect(popouts.shown()).toEqual(['a'])
  c.advance(1)
  expect(popouts.shown()).toEqual([])
})

test('focusing another card unfocuses the first', async () => {
  const { c, popouts } = setup()
  popouts.add('a')
  popouts.add('b')
  popouts.focus('a')
  c.advance(10000)
  popouts.focus('b')
  expect(popouts.shown()).toEqual(['a', 'b'])
  c.advance(15000)
  expect(popouts.shown()).toEqual(['b'])
})

test('answered, gone or opened in the list: the card goes at once', async () => {
  const { c, popouts, changes } = setup()
  popouts.add('a')
  popouts.add('b')
  popouts.remove('a')
  expect(popouts.shown()).toEqual(['b'])
  popouts.clear()
  expect(popouts.shown()).toEqual([])
  const before = changes()
  c.advance(20000)
  expect(changes()).toBe(before)
})
