import { expect, test } from 'claude-code/testing'

import { appliedText, LABEL, SUGGESTED, withText } from '../hooks/auto-mode'

const PLAIN = JSON.stringify({ env: { A: '1' }, permissions: { allow: [] }, theme: 'dark' }, null, 2) + '\n'

test('with no auto-mode block, the line goes into a new environment list after "$defaults"; the rest stays as written', async () => {
  expect(appliedText(PLAIN)).toBe(null)
  const applied = withText(PLAIN, SUGGESTED)
  expect(applied.startsWith(PLAIN.slice(0, -3))).toBe(true)
  expect(JSON.parse(applied).autoMode).toEqual({ environment: ['$defaults', LABEL + SUGGESTED] })
  expect(appliedText(applied)).toBe(SUGGESTED)
})

test('an existing line is replaced in place; the other entries and keys stay', async () => {
  const settings = JSON.stringify({ autoMode: { environment: ['$defaults', LABEL + 'old', 'Source control: x'], allow: ['$defaults'] } }, null, 2) + '\n'
  const applied = JSON.parse(withText(settings, 'mine'))
  expect(applied.autoMode).toEqual({ environment: ['$defaults', LABEL + 'mine', 'Source control: x'], allow: ['$defaults'] })
})

test("a list the user wrote without \"$defaults\" keeps it that way: it's theirs", async () => {
  const settings = JSON.stringify({ autoMode: { environment: ['Source control: x'] } }, null, 2) + '\n'
  expect(JSON.parse(withText(settings, 'mine')).autoMode.environment).toEqual(['Source control: x', LABEL + 'mine'])
})

test('a broken file is refused, not rewritten', async () => {
  expect(() => withText('{ "a": ', 'mine')).toThrow('settings.json is not valid JSON')
  expect(() => withText('{ "autoMode": [] }', 'mine')).toThrow('autoMode is not an object')
})
