import { expect, test } from 'claude-code/testing'

import { forms, holdsMask, Masker, mask, masksValues, remember } from '../hooks/mask'
import cases from './mask-cases'

test('the shared cases: forms found, tokens widened, overlaps merged', async () => {
  for (const c of cases) {
    const masker = new Masker()
    for (const value of c.values) if ([...value].length >= c.min) masker.add(value)
    expect([c.input, masker.mask(c.input)]).toEqual([c.input, c.output])
  }
})

test('every form of a value is as many characters as base64 makes of it or more', async () => {
  for (const form of forms('hunter22')) expect(form.length >= 8).toBe(true)
})

test('a value at least the minimum long is masked; a shorter one is left as it is and arms nothing', async () => {
  remember('pin1', 6)
  expect(masksValues()).toBe(false)
  remember('swordfish', 6)
  expect(masksValues()).toBe(true)
  expect(mask('swordfish and pin1')).toBe('[secret] and pin1')
  expect(holdsMask(mask('swordfish'))).toBe(true)
})

test('the minimum counts characters, not bytes', async () => {
  remember('ключик', 6)
  expect(mask('a ключик')).toBe('a [secret]')
})
