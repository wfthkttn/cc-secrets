import { expect, test } from 'claude-code/testing'

import { buttonRows, checkbox, dropdown, fit, hitAt, type Line, listRows, moveFocus, radios, seg, stepper } from '../hooks/controls'

const text = (line: Line) => line.map(s => s.text).join('')
/** The hit of every cell of the line, left to right. */
const hits = (line: Line) => [...text(line)].map((_, x) => hitAt(line, x))

test('a fitted line is exactly as wide as asked: cut with … or filled with cells that reach nothing', async () => {
  expect(text(fit([seg('abc', undefined, 'a'), seg('def')], 5))).toBe('abcd…')
  const filled = fit([seg('ab', undefined, 'a')], 5)
  expect(text(filled)).toBe('ab   ')
  expect(hits(filled)).toEqual(['a', 'a', null, null, null])
  expect(text(fit([seg('日本語')], 4))).toBe('日… ')
})

test('a hit is found by the cells drawn, wide characters taking two', async () => {
  const line = [seg('日', undefined, 'wide'), seg('x', undefined, 'narrow')]
  expect([0, 1, 2, 3].map(x => hitAt(line, x))).toEqual(['wide', 'wide', 'narrow', null])
})

test('every cell of a boxed button presses it, on all three lines; the gaps press nothing', async () => {
  const rows = buttonRows(
    [
      { hit: 'save', label: 'Save' },
      { hit: 'cancel', label: 'Cancel', tone: 'danger' },
    ],
    'save',
  )
  expect(rows.map(text)).toEqual([' ╭──────╮ ╭────────╮', ' │ Save │ │ Cancel │', ' ╰──────╯ ╰────────╯'])
  for (const row of rows) {
    expect(hits(row)).toEqual([null, ...Array(8).fill('save'), null, ...Array(10).fill('cancel')])
  }
})

test('a checkbox toggles from its box and its label; a radio option picks itself; a stepper steps from its buttons', async () => {
  const box = checkbox('Unlock at start', true, 'unlock', false)
  expect(text(box)).toBe(' [x] Unlock at start')
  expect(hits(box).slice(1).every(h => h === 'unlock')).toBe(true)
  const radio = radios(
    [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
    'b',
    'kind',
    false,
  )
  expect(text(radio)).toBe('( ) Alpha   (•) Beta')
  expect(hitAt(radio, 0)).toBe('kind=a')
  expect(hitAt(radio, 10)).toBe(null)
  expect(hitAt(radio, 12)).toBe('kind=b')
  const step = stepper(6, 'mask', false)
  expect(text(step)).toBe('[ - ]  6  [ + ]')
  expect([0, 4, 5, 7, 10, 14].map(x => hitAt(step, x))).toEqual(['mask-', 'mask-', null, null, 'mask+', 'mask+'])
})

test("a dropdown is a field with ▾, all of it opening the list; the list's options each pick themselves", async () => {
  const drop = dropdown('Allowed', 13, 'access', false)
  expect(text(drop)).toBe('[ Allowed ▾ ]')
  expect(hits(drop).every(h => h === 'access')).toBe(true)
  const list = listRows(
    [
      { label: 'Ask', what: 'a card' },
      { label: 'Allowed', what: 'no card' },
    ],
    1,
    1,
    30,
    'pick',
  )
  expect(list.map(text)).toEqual([' ┌────────────────────────────┐', ' │  Ask     a card            │', ' │▸ Allowed no card           │', ' └────────────────────────────┘'])
  expect(hitAt(list[1], 5)).toBe('pick:0')
  expect(hitAt(list[2], 5)).toBe('pick:1')
  expect(hitAt(list[0], 5)).toBe(null)
})

test('the keyboard moves in reading order: Tab through all, ↑/↓ by line keeping the place, ←/→ within the line', async () => {
  const groups = [['a', 'b', 'c'], ['d'], ['e', 'f']]
  expect(moveFocus(groups, 'c', 'tab')).toBe('d')
  expect(moveFocus(groups, 'f', 'tab')).toBe('a')
  expect(moveFocus(groups, 'a', 'tab', true)).toBe('f')
  expect(moveFocus(groups, 'c', 'down')).toBe('d')
  expect(moveFocus(groups, 'd', 'down')).toBe('e')
  expect(moveFocus(groups, 'b', 'up')).toBe('b')
  expect(moveFocus(groups, 'b', 'right')).toBe('c')
  expect(moveFocus(groups, 'c', 'right')).toBe('c')
  expect(moveFocus(groups, 'gone', 'down')).toBe('a')
  expect(moveFocus(groups, 'gone', 'up')).toBe('f')
  expect(moveFocus(groups, 'gone', 'left')).toBe(null)
  expect(moveFocus(groups, 'a', 'x')).toBe(null)
})
