import { expect, test } from 'claude-code/testing'

import { allowedName, allowKey, carriersSeen, selects } from '../hooks/guard'

test('a pattern selects by name, by *, by namespace glob, and a negation selects everything else', async () => {
  expect(selects('http.fetch', 'http.fetch')).toBe(true)
  expect(selects('http.*', 'http.fetch')).toBe(true)
  expect(selects('*', 'env.set')).toBe(true)
  expect(selects('!tool.describe', 'http.fetch')).toBe(true)
  expect(selects('!http.*', 'http.fetch')).toBe(false)
  expect(selects('process.spawn', 'process.run')).toBe(false)
  expect(selects('env.*', 'environment.set')).toBe(false)
})

test("a plugin's hooks name where they see secrets: the sidebar's nowhere, talking-bridge's in tool results", async () => {
  expect(carriersSeen(['tool.check', 'http.fetch'])).toEqual(['http.fetch'])
  expect(carriersSeen(['*'])).toEqual(['http.fetch', 'process.spawn', 'env.set', 'tool.call', 'classic.PostToolUse', 'classic.PostToolBatch'])
  expect(carriersSeen(['tool.*'])).toEqual(['tool.call'])
  expect(carriersSeen(['classic.*', 'classic.Stop'])).toEqual(['classic.PostToolUse', 'classic.PostToolBatch'])
  expect(carriersSeen(['classic.PostToolBatch'])).toEqual(['classic.PostToolBatch'])
  expect(carriersSeen(['!http.fetch'])).toEqual(['process.spawn', 'env.set', 'tool.call', 'classic.PostToolUse', 'classic.PostToolBatch'])
  expect(carriersSeen(['ui.render', 'ui.message', 'session.start', 'engine.create', 'command.run', 'classic.SessionStart'])).toEqual([])
  expect(carriersSeen(['session.start', 'tool.call', 'session.append', 'classic.PermissionDenied'])).toEqual(['tool.call'])
})

test('an allow holds for exactly the code it was given, and names its plugin, as an allow of the hooks alone did', async () => {
  expect(allowKey('tracer', 'sha256:aa')).not.toBe(allowKey('tracer', 'sha256:bb'))
  expect(allowedName(allowKey('tracer', 'sha256:aa'))).toBe('tracer')
  expect(allowedName('tracer\nhttp.fetch\ntool.call')).toBe('tracer')
})
