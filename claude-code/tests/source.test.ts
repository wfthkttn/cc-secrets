import { expect, test } from 'claude-code/testing'

import { askDecision, listDecision, pasteTarget, requestSource, runsIn, signDecision, sourceOf } from '../hooks/source'

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
  const allowed = { cmdline: WRAPPER(command), inside: true, access: 'allowed' as const, use: 'session' as const }
  expect(signDecision(allowed, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(signDecision({ ...allowed, access: 'ask' }, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(signDecision(allowed, [{ command, agentId: undefined }])).toBe('give')
  expect(signDecision({ ...allowed, use: 'each' }, [{ command, agentId: undefined }])).toBe('ask')
  expect(signDecision({ ...allowed, access: 'ask' }, [{ command, agentId: undefined }])).toBe('ask')
  expect(signDecision(allowed, [])).toBe('ask')
  expect(signDecision({ ...allowed, cmdline: '' }, [{ command, agentId: undefined }])).toBe('ask')
})

test('a key or an entry the session refused is refused to anyone, with no card', async () => {
  const command = 'git push'
  const refused = { cmdline: WRAPPER(command), inside: true, access: 'refused' as const, use: 'session' as const }
  for (const calls of [[{ command, agentId: undefined }], [{ command, agentId: 'a-1' }], []]) {
    expect(signDecision(refused, calls)).toBe('refuse')
    expect(askDecision({ cmdline: refused.cmdline, inside: true, entry: refused }, calls)).toBe('refuse')
  }
  expect(askDecision({ cmdline: 'fake', inside: false, entry: { ...refused, use: 'each' } }, [])).toBe('refuse')
})

test("an ask: a main-loop call's allowed session entry comes without a card; a subagent's card offers no entries", async () => {
  const command = 'psql "$(secrets ask --tag db "DB")"'
  const ask = { cmdline: WRAPPER(command), inside: true, entry: { access: 'allowed' as const, use: 'session' as const } }
  expect(askDecision(ask, [{ command, agentId: undefined }])).toBe('give')
  expect(askDecision({ ...ask, entry: { access: 'allowed', use: 'each' } }, [{ command, agentId: undefined }])).toBe('card')
  expect(askDecision({ ...ask, entry: { access: 'ask', use: 'session' } }, [{ command, agentId: undefined }])).toBe('card')
  expect(askDecision({ ...ask, entry: null }, [{ command, agentId: undefined }])).toBe('card')
  expect(askDecision(ask, [{ command, agentId: 'a-1' }])).toBe('typed card')
  expect(askDecision(ask, [])).toBe('card')
})

test('a requester outside the session is never matched to a call: its own argv could name any command', async () => {
  const command = 'psql "$(secrets ask --tag db "DB")"'
  const outside = { cmdline: `fake ${command}`, inside: false, access: 'allowed' as const, use: 'session' as const }
  expect(signDecision(outside, [{ command, agentId: undefined }])).toBe('ask')
  expect(askDecision({ ...outside, entry: { access: 'allowed', use: 'session' } }, [{ command, agentId: undefined }])).toBe('card')
  expect(listDecision(outside, [{ command, agentId: undefined }])).toBe('refuse')
  expect(listDecision({ ...outside, inside: true, cmdline: WRAPPER(command) }, [{ command, agentId: undefined }])).toBe('give')
  expect(listDecision({ ...outside, inside: true, cmdline: WRAPPER(command) }, [{ command, agentId: 'a-1' }])).toBe('refuse')
  expect(requestSource({ cmdline: 'secrets list', pid: 7, inside: false }, [])).toBe('outside this session: secrets list')
  expect(requestSource({ cmdline: WRAPPER(command), pid: 7, inside: true }, [])).toBe(command)
})

test('the same command running in the main loop and a subagent gets no vault: a key is refused, an ask gets a typed card', async () => {
  const command = 'git push origin main'
  const both = [
    { command, agentId: undefined },
    { command, agentId: 'a-1' },
  ]
  const sign = { cmdline: WRAPPER(command), inside: true, access: 'allowed' as const, use: 'session' as const }
  expect(signDecision(sign, both)).toBe('refuse')
  expect(signDecision(sign, [...both].reverse())).toBe('refuse')
  expect(askDecision({ ...sign, entry: { access: 'allowed', use: 'session' } }, both)).toBe('typed card')
  expect(listDecision(sign, both)).toBe('refuse')
  expect(signDecision(sign, [both[0]!, both[0]!])).toBe('give')
})

test('the same command in two subagents only is a subagent\'s: refused, no entries offered', async () => {
  const command = 'ssh prod uptime'
  const subagents = [
    { command, agentId: 'a-1' },
    { command, agentId: 'a-2' },
  ]
  const sign = { cmdline: WRAPPER(command), inside: true, access: 'allowed' as const, use: 'session' as const }
  expect(signDecision(sign, subagents)).toBe('refuse')
  expect(askDecision({ ...sign, entry: { access: 'allowed', use: 'session' } }, subagents)).toBe('typed card')
  expect(listDecision(sign, subagents)).toBe('refuse')
})

test("a mask-run's command line runs the command its wrapper holds, either way of quoting", async () => {
  const command = `echo 'quoted' && secrets ask x`
  expect(runsIn(WRAPPER(command), command)).toBe(true)
  expect(runsIn(WRAPPER(command, `'\\''`), command)).toBe(true)
  expect(runsIn(WRAPPER('ls'), command)).toBe(false)
})

test('a secrets list that matches no running call is refused, as from a background call', async () => {
  expect(listDecision({ cmdline: WRAPPER('secrets list'), inside: true }, [])).toBe('refuse')
})

test('a paste goes into a card only while its field takes typing', async () => {
  expect(pasteTarget({ kind: 'secret', chosen: null }, null)).toBe('card')
  expect(pasteTarget(undefined, null)).toBe('no card')
  expect(pasteTarget({ kind: 'secret', chosen: 'entry-1' }, null)).toBe('untyped')
  expect(pasteTarget({ kind: 'sign', chosen: null }, null)).toBe('untyped')
  expect(pasteTarget({ kind: 'secret', chosen: null }, 'off: tracer could read it · Vault tab')).toBe('untyped')
})
