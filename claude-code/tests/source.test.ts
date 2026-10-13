import { expect, test } from 'claude-code/testing'

import { askDecision, listDecision, requestSource, signDecision, sourceOf } from '../hooks/source'

const WRAPPER = (command: string, quote = `'"'"'`) =>
  `/run/current-system/sw/bin/zsh -c source /home/alex/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval '${command.split("'").join(quote)}' < /dev/null && pwd -P >| /tmp/claude-cwd`

test('the other way of quoting a quote', async () => {
  const command = `echo "got $(secrets ask 'x')"`
  expect(sourceOf(WRAPPER(command, `'\\''`), [])).toBe(command)
})

test('a secrets ask inside a Bash call: that call\'s command', async () => {
  const command = `echo "got $(secrets ask 'test token')"`
  expect(sourceOf(WRAPPER(command), ['ls', command])).toBe(command)
})

test('sudo -A asking: the Bash command that ran sudo', async () => {
  const command = 'cd /etc && sudo -A systemctl restart foo'
  expect(sourceOf('sudo -A systemctl restart foo', [command])).toBe(command)
})

test('a shorter running command inside the asker\'s command line loses to the one that ran it', async () => {
  expect(sourceOf('sudo -A make install', ['make', 'cd src && sudo -A make install'])).toBe('cd src && sudo -A make install')
  const command = `make && echo "$(secrets ask 'x')"`
  expect(sourceOf(WRAPPER(command), ['make', command])).toBe(command)
})

test('a background call, no longer running: the command out of the Bash wrapper', async () => {
  const command = `echo "A=$(secrets ask 'token A')"`
  expect(sourceOf(WRAPPER(command), [])).toBe(command)
})

test('no running call matches: the asking process\'s parent command line', async () => {
  expect(sourceOf('ssh host1', ['ls'])).toBe('ssh host1')
})

test("a subagent's signature is refused; a main-loop one gets a session key; anything else asks the person", async () => {
  const command = 'git push'
  const allowed = { cmdline: WRAPPER(command), inside: true, allowed: true, use: 'session' as const }
  expect(signDecision(allowed, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(signDecision({ ...allowed, allowed: false }, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(signDecision(allowed, [{ command, agentId: undefined }])).toBe('give')
  expect(signDecision({ ...allowed, use: 'each' }, [{ command, agentId: undefined }])).toBe('ask')
  expect(signDecision({ ...allowed, allowed: false }, [{ command, agentId: undefined }])).toBe('ask')
  expect(signDecision(allowed, [])).toBe('ask')
  expect(signDecision({ ...allowed, cmdline: '' }, [{ command, agentId: undefined }])).toBe('ask')
})

test("an ask: a main-loop call's allowed session entry comes without a card; a subagent's card offers no entries", async () => {
  const command = 'psql "$(secrets ask --tag db "DB")"'
  const ask = { cmdline: WRAPPER(command), inside: true, entry: { allowed: true, use: 'session' as const } }
  expect(askDecision(ask, [{ command, agentId: undefined }])).toBe('give')
  expect(askDecision({ ...ask, entry: { allowed: true, use: 'each' } }, [{ command, agentId: undefined }])).toBe('card')
  expect(askDecision({ ...ask, entry: { allowed: false, use: 'session' } }, [{ command, agentId: undefined }])).toBe('card')
  expect(askDecision({ ...ask, entry: null }, [{ command, agentId: undefined }])).toBe('card')
  expect(askDecision(ask, [{ command, agentId: 'a-1' }])).toBe('typed card')
  expect(askDecision(ask, [])).toBe('card')
})

test('a requester outside the session is never matched to a call: its own argv could name any command', async () => {
  const command = 'psql "$(secrets ask --tag db "DB")"'
  const outside = { cmdline: `fake ${command}`, inside: false, allowed: true, use: 'session' as const }
  expect(signDecision(outside, [{ command, agentId: undefined }])).toBe('ask')
  expect(askDecision({ ...outside, entry: { allowed: true, use: 'session' } }, [{ command, agentId: undefined }])).toBe('card')
  expect(listDecision(outside, [{ command, agentId: undefined }])).toBe('refuse')
  expect(listDecision({ ...outside, inside: true, cmdline: WRAPPER(command) }, [{ command, agentId: undefined }])).toBe('give')
  expect(listDecision({ ...outside, inside: true, cmdline: WRAPPER(command) }, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(requestSource({ cmdline: 'secrets list', pid: 7, inside: false }, [])).toBe('outside this session: secrets list')
  expect(requestSource({ cmdline: WRAPPER(command), pid: 7, inside: true }, [])).toBe(command)
})
