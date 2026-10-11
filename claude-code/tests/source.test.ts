import { expect, test } from 'claude-code/testing'

import { sourceOf, vaultDecision } from '../hooks/source'

const WRAPPER = (command: string, quote = `'"'"'`) =>
  `/run/current-system/sw/bin/zsh -c source /home/alex/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '${command.split("'").join(quote)}' < /dev/null && pwd -P >| /tmp/claude-cwd`

test('the other way of quoting a quote', async () => {
  const command = `echo "got $($ASK_SECRET 'x')"`
  expect(sourceOf(WRAPPER(command, `'\\''`), [])).toBe(command)
})

test('a $ASK_SECRET inside a Bash call: that call\'s command', async () => {
  const command = `echo "got $($ASK_SECRET 'test token')"`
  expect(sourceOf(WRAPPER(command), ['ls', command])).toBe(command)
})

test('sudo -A asking: the Bash command that ran sudo', async () => {
  const command = 'cd /etc && sudo -A systemctl restart foo'
  expect(sourceOf('sudo -A systemctl restart foo', [command])).toBe(command)
})

test('a shorter running command inside the asker\'s command line loses to the one that ran it', async () => {
  expect(sourceOf('sudo -A make install', ['make', 'cd src && sudo -A make install'])).toBe('cd src && sudo -A make install')
  const command = `make && echo "$($ASK_SECRET 'x')"`
  expect(sourceOf(WRAPPER(command), ['make', command])).toBe(command)
})

test('a background call, no longer running: the command out of the Bash wrapper', async () => {
  const command = `echo "A=$($ASK_SECRET 'token A')"`
  expect(sourceOf(WRAPPER(command), [])).toBe(command)
})

test('no running call matches: the asking process\'s parent command line', async () => {
  expect(sourceOf('ssh host1', ['ls'])).toBe('ssh host1')
})

test("a subagent's vault get is refused; a main-loop one gets a session entry; anything else asks the person", async () => {
  const command = 'psql "$($SECRETS_VAULT get db)"'
  const allowed = { cmdline: WRAPPER(command), allowed: true, use: 'session' as const }
  expect(vaultDecision(allowed, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(vaultDecision({ ...allowed, allowed: false }, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(vaultDecision(allowed, [{ command, agentId: undefined }])).toBe('give')
  expect(vaultDecision({ ...allowed, use: 'each' }, [{ command, agentId: undefined }])).toBe('ask')
  expect(vaultDecision({ ...allowed, allowed: false }, [{ command, agentId: undefined }])).toBe('ask')
  expect(vaultDecision(allowed, [])).toBe('ask')
  expect(vaultDecision({ ...allowed, cmdline: '' }, [{ command, agentId: undefined }])).toBe('ask')
})
