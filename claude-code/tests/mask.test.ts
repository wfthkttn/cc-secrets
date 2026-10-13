import { expect, test } from 'claude-code/testing'

import { holdsMask, stringsIn, withStrings } from '../hooks/mask'

test("a tool result's strings go out and come back in place, the shape kept", async () => {
  const result = { stdout: 'a', meta: [1, 'b', { c: 'c', d: null }], ok: true }
  expect(stringsIn(result)).toEqual(['a', 'b', 'c'])
  expect(withStrings(result, ['A', 'B', 'C'])).toEqual({ stdout: 'A', meta: [1, 'B', { c: 'C', d: null }], ok: true })
  expect(withStrings('x', ['[secret]'])).toBe('[secret]')
})

test('masked text is recognised by its mark', async () => {
  expect(holdsMask('pw=[secret] ok')).toBe(true)
  expect(holdsMask('pw=secret')).toBe(false)
})
