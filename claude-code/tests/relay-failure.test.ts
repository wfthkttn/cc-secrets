import { expect, test } from 'claude-code/testing'

import { failureKind } from '../hooks/relay-failure'

const withCode = (error: Error, code: unknown) => Object.assign(error, { code })

test("a failed relay call is told by the error's type and code, never its text", async () => {
  expect(failureKind(Object.assign(new Error('the operation was aborted'), { name: 'AbortError' }))).toBe('AbortError')
  expect(failureKind(withCode(new TypeError('Unable to connect: hunter2'), 'ConnectionRefused'))).toBe('TypeError, ConnectionRefused')
  expect(failureKind(new Error('connect ECONNREFUSED /run/user/1000/secrets.sock-ab'))).toBe('Error, ECONNREFUSED')
})

test('a code that could be request text, or an error that is no Error, is left out', async () => {
  expect(failureKind(withCode(new Error('x'), 'token=hunter2 sent to db'))).toBe('Error')
  expect(failureKind(withCode(new Error('x'), 42))).toBe('Error')
  expect(failureKind('relay down: hunter2')).toBe('no error type')
  expect(failureKind(Object.assign(new Error('x'), { name: 'a name with spaces' }))).toBe('no error type')
})
