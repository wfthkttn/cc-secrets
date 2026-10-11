import { expect, test } from 'claude-code/testing'

import { sourceOf } from '../hooks/source'

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

test('a background call, no longer running: the command out of the Bash wrapper', async () => {
  const command = `echo "A=$($ASK_SECRET 'token A')"`
  expect(sourceOf(WRAPPER(command), [])).toBe(command)
})

test('no running call matches: the asking process\'s parent command line', async () => {
  expect(sourceOf('ssh host1', ['ls'])).toBe('ssh host1')
})
