import { expect, test } from 'claude-code/testing'

import {
  buttonRows,
  caretAfter,
  caretAt,
  caretText,
  checkbox,
  dropdown,
  editText,
  fit,
  hitAt,
  lengthAfter,
  type Line,
  listKey,
  listRows,
  moveFocus,
  radios,
  seg,
  stepper,
  textField,
  textKey,
} from '../hooks/controls'

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

test('a text field draws its caret where it is and keeps it in view; a click on a character puts the caret before it', async () => {
  const field = textField('abcdef', 2, 12, 'f', true)
  expect(text(field)).toBe('[ ab▏cdef  ]')
  expect(hits(field)).toEqual(['f', 'f', 'f@0', 'f@1', 'f@2', 'f@2', 'f@3', 'f@4', 'f@5', 'f@6', 'f', 'f'])
  expect(text(textField('abcdefghijkl', 12, 12, 'f', true))).toBe('[ …ghijkl▏ ]')
  expect(hits(textField('abcdefghijkl', 12, 12, 'f', true))[2]).toBe('f@6')
  expect(text(textField('abcdefghijkl', 0, 12, 'f', true))).toBe('[ ▏abcdef… ]')
  expect(text(textField('abcdefghijkl', 6, 12, 'f', true))).toBe('[ abcdef▏… ]')
  expect(text(textField('abcdefghijkl', 0, 12, 'f', false))).toBe('[ abcdefg… ]')
  expect(hits(textField('abcdefghijkl', 0, 12, 'f', false)).slice(2, 4)).toEqual(['f@0', 'f@1'])
  const empty = textField('', 0, 12, 'f', false, { placeholder: 'none' })
  expect(text(empty)).toBe('[ none     ]')
  expect(empty.find(s => s.text === 'none')?.look?.dimColor).toBe(true)
  expect(caretText('日本', 1, 8)).toBe('日▏本')
  for (const caret of [0, 3, 6, 9, 12]) expect([...text(textField('abcdefghijkl', caret, 12, 'f', true))].length).toBe(12)
  const withTail = textField('ab', 1, 16, 'f', true, { tail: seg(' Show', undefined, 'show') })
  expect(text(withTail)).toBe('[ a▏b     Show ]')
  expect(hitAt(withTail, 11)).toBe('show')
  expect([0, 2, 3, 5].map(x => caretAt('abcdefghijkl', 12, 8, x))).toEqual([6, 7, 8, 10])
  expect(caretAt('ab', null, 8, 6)).toBe(2)
})

test('a key on a text: a caret move, or an edit at the caret that editText applies the same way everywhere', async () => {
  const k = (key: string, mods: { ctrl?: true } = {}) => textKey({ key, ...mods }, 2, 4)
  expect([k('left'), k('right'), k('home'), k('end')]).toEqual([2 - 1, 3, 0, 4].map(caret => ({ kind: 'move', caret })))
  expect(textKey({ key: 'backspace' }, 0, 4)).toEqual({ kind: 'move', caret: 0 })
  expect(textKey({ key: 'delete' }, 4, 4)).toEqual({ kind: 'move', caret: 4 })
  expect([k('backspace'), k('delete'), k('x'), k('space'), k('u', { ctrl: true })]).toEqual([
    { kind: 'back', at: 2 },
    { kind: 'del', at: 2 },
    { kind: 'insert', at: 2, text: 'x' },
    { kind: 'insert', at: 2, text: ' ' },
    { kind: 'clear' },
  ])
  expect([k('tab'), k('up'), k('\x1bOP'), k('r', { ctrl: true })]).toEqual([null, null, null, null])
  expect(textKey({ key: 'left' }, Number.MAX_SAFE_INTEGER, 4)).toEqual({ kind: 'move', caret: 3 })
  expect(['back', 'del'].map(kind => editText('abcd', { kind: kind as 'back', at: 2 }))).toEqual(['acd', 'abd'])
  expect(editText('abcd', { kind: 'insert', at: 99, text: 'é' })).toBe('abcdé')
  expect(editText('日本', { kind: 'insert', at: 1, text: 'x' })).toBe('日x本')
  expect([caretAfter({ kind: 'insert', at: 1, text: 'xy' }), caretAfter({ kind: 'back', at: 3 }), caretAfter({ kind: 'del', at: 3 })]).toEqual([3, 2, 3])
  expect(lengthAfter(4, { kind: 'back', at: 0 })).toBe(4)
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

test('an open list: ↑/↓ move within it, Enter picks, Tab shuts; over text every other key is the text, a pick-only list takes Space', async () => {
  const text = { cursor: 1, count: 3, takesText: true }
  expect(listKey({ key: 'up' }, text)).toEqual({ kind: 'cursor', cursor: 0 })
  expect(listKey({ key: 'down' }, { ...text, cursor: 2 })).toEqual({ kind: 'cursor', cursor: 2 })
  expect(listKey({ key: 'down' }, { ...text, cursor: -1 })).toEqual({ kind: 'cursor', cursor: 0 })
  expect(listKey({ key: 'return' }, text)).toEqual({ kind: 'pick', index: 1 })
  expect(listKey({ key: 'return' }, { ...text, cursor: -1 })).toBe(null)
  expect(listKey({ key: 'tab' }, text)).toEqual({ kind: 'shut' })
  for (const key of ['g', 'space', 'backspace', 'left', 'delete']) expect(listKey({ key }, text)).toEqual({ kind: 'text' })
  const pickOnly = { ...text, takesText: false }
  expect(listKey({ key: 'space' }, pickOnly)).toEqual({ kind: 'pick', index: 1 })
  expect(listKey({ key: 'g' }, pickOnly)).toBe(null)
})
