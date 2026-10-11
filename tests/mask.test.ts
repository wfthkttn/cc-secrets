import { expect, test } from 'claude-code/testing'

import { mask, remember } from '../hooks/mask'

test('a value at least the minimum long is masked; a shorter one is left as it is', async () => {
  remember('swordfish', 6)
  remember('pin1', 6)
  expect(mask('swordfish and pin1')).toBe('[secret] and pin1')
})

test('the minimum counts characters, not bytes', async () => {
  remember('ключик', 6)
  expect(mask('a ключик')).toBe('a [secret]')
})
