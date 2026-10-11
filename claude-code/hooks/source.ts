/** A single quote inside a single-quoted shell word, in the two ways shells write it. */
const QUOTED_QUOTE = /'\\''|'"'"'/g
/** Bash's wrapper shell runs the command as `eval '<command>'`. */
const WRAPPED = new RegExp(`\\beval '((?:[^']|${QUOTED_QUOTE.source})*)'`)

/** The running Bash call a request came from, by the asking process's command line. */
export function callOf<C extends { command: string }>(cmdline: string, calls: readonly C[]): C | undefined {
  // A command that ran the asker (`sudo -A …`) holds its command line.
  const ran = calls.find(c => c.command.includes(cmdline))
  if (ran !== undefined) return ran
  // An asker inside Bash's wrapper holds the command; the longest match, so `make` doesn't win over `make install`.
  const unquoted = cmdline.replace(QUOTED_QUOTE, "'")
  return calls.filter(c => unquoted.includes(c.command)).sort((a, b) => b.command.length - a.command.length)[0]
}

/**
 * What a vault get gets: a subagent's or a teammate's command nothing; a main-loop command an entry allowed
 * for the session; a command matching no running call (a `!` command, a background task) the person's card.
 */
export function vaultDecision(
  get: { cmdline: string; allowed: boolean; use: 'session' | 'each' },
  calls: readonly { command: string; agentId: string | undefined }[],
): 'refuse' | 'give' | 'ask' {
  const call = get.cmdline === '' ? undefined : callOf(get.cmdline, calls)
  if (call?.agentId !== undefined) return 'refuse'
  return call !== undefined && get.allowed && get.use === 'session' ? 'give' : 'ask'
}

/** The running Bash command a request came from, else the command out of the asker's wrapper, else its command line. */
export function sourceOf(cmdline: string, commands: string[]): string {
  const call = callOf(cmdline, commands.map(command => ({ command })))
  if (call !== undefined) return call.command
  const wrapped = WRAPPED.exec(cmdline)
  return wrapped === null ? cmdline : wrapped[1]!.replace(QUOTED_QUOTE, "'")
}
