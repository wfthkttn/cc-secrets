/**
 * Where a plugin's hooks see secrets: calls of this plugin as they cross to the host, which every hook on them in any
 * plugin sees (relay requests with the passphrase and typed values, the relay's start, the shell prefix that turns
 * masking on); `tool.call`, whose hooks beneath this plugin's get a tool's result before it is masked; and
 * `classic.PostToolUse`, which fires inside the tool's run with its raw result.
 */
export const CARRIERS = ['http.fetch', 'process.spawn', 'env.set', 'tool.call', 'classic.PostToolUse'] as const

/** Whether an `on(...)` pattern (a name, `*`, `namespace.*`, or `!` before either) selects `event`. */
export function selects(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) return !selects(pattern.slice(1), event)
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1))
  return pattern === event
}

/** The carriers a plugin's hook patterns select. */
export function carriersSeen(events: readonly string[]): string[] {
  return CARRIERS.filter(carrier => events.some(pattern => selects(pattern, carrier)))
}

/** What an Allow is kept under: the plugin and exactly the patterns it hooks, so a change to them asks again. */
export function allowKey(name: string, events: readonly string[]): string {
  return `${name}\n${[...events].sort().join('\n')}`
}
