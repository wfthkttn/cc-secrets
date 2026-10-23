/**
 * Where a plugin's hooks see secrets: calls of this plugin as they cross to the host, which every hook on them in any
 * plugin sees (relay requests with the passphrase and typed values, the relay's start, the shell prefix that turns
 * masking on); `tool.call`, whose hooks beneath this plugin's get a tool's result before it is masked;
 * `classic.PostToolUse`, which fires inside the tool's run with its raw result; and `classic.PostToolBatch`,
 * which carries every raw result of a batch of calls.
 */
export const CARRIERS = ['http.fetch', 'process.spawn', 'env.set', 'tool.call', 'classic.PostToolUse', 'classic.PostToolBatch'] as const

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

/** What an Allow is kept under: the plugin and exactly the code it has (`codeIdentity`), so a change to it asks again. */
export function allowKey(name: string, code: string): string {
  return `${name}\n${code}`
}

/** The plugin an Allow was given to, whatever code it had then. */
export function allowedName(key: string): string {
  const cut = key.indexOf('\n')
  return cut < 0 ? key : key.slice(0, cut)
}
