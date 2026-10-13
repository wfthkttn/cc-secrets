/** A single quote inside a single-quoted shell word, in the two ways shells write it. */
const QUOTED_QUOTE = /'\\''|'"'"'/g
/** Bash's wrapper shell runs the command as `eval '<command>'`. */
const WRAPPED = new RegExp(`\\beval '((?:[^']|${QUOTED_QUOTE.source})*)'`)

/** The running Bash calls a request may have come from, by the asking process's command line: all that match best. */
function matchesOf<C extends { command: string }>(cmdline: string, calls: readonly C[]): C[] {
  // A command that ran the asker (`sudo -A …`) holds its command line.
  const ran = calls.filter(c => c.command.includes(cmdline))
  if (ran.length > 0) return ran
  // An asker inside Bash's wrapper holds the command; the longest match, so `make` doesn't win over `make install`.
  const unquoted = cmdline.replace(QUOTED_QUOTE, "'")
  const held = calls.filter(c => unquoted.includes(c.command))
  const longest = Math.max(0, ...held.map(c => c.command.length))
  return held.filter(c => c.command.length === longest)
}

/** The running Bash call a request came from, by the asking process's command line. */
export function callOf<C extends { command: string }>(cmdline: string, calls: readonly C[]): C | undefined {
  return matchesOf(cmdline, calls)[0]
}

type Requester = { cmdline: string; inside: boolean }
type Call = { command: string; agentId: string | undefined }
type Calls = readonly Call[]
type Granted = { access: 'ask' | 'allowed' | 'refused'; use: 'session' | 'each' }

/**
 * The Bash call a requester runs in. Only one `inside` the session is matched: its command line is the one Claude
 * Code ran. The same command in the main loop and a subagent can't be told apart: `unknown`; in subagents only, it is
 * a subagent's either way.
 */
function callFor(requester: Requester, calls: Calls): Call | 'unknown' | undefined {
  if (!requester.inside || requester.cmdline === '') return undefined
  const matches = matchesOf(requester.cmdline, calls)
  const loops = new Set(matches.map(c => c.agentId))
  return loops.size > 1 && loops.has(undefined) ? 'unknown' : matches[0]
}

/** Whether a `secrets-mask-run` command line (Bash's wrapper) runs `command`. */
export function runsIn(cmdline: string, command: string): boolean {
  return cmdline.replace(QUOTED_QUOTE, "'").includes(command)
}

/**
 * What a signature with a vault key gets: nothing with a key the session refused, nor for a subagent's or a
 * teammate's command, nor one that can't be told from a subagent's; a main-loop command a key allowed for the
 * session; anything else (a `!` command, a background task, a process outside the session) the person's card.
 */
export function signDecision(sign: Requester & Granted, calls: Calls): 'refuse' | 'give' | 'ask' {
  if (sign.access === 'refused') return 'refuse'
  const call = callFor(sign, calls)
  if (call === 'unknown' || call?.agentId !== undefined) return 'refuse'
  return call !== undefined && sign.access === 'allowed' && sign.use === 'session' ? 'give' : 'ask'
}

/**
 * How a `secrets ask` is answered: refused when its tag names an entry the session refused; a main-loop command
 * whose tagged entry is allowed for the session gets it without a card; any other gets a card, with the vault's
 * entries to pick unless it is, or may be, a subagent's or a teammate's.
 */
export function askDecision(ask: Requester & { entry: Granted | null }, calls: Calls): 'refuse' | 'give' | 'card' | 'typed card' {
  if (ask.entry?.access === 'refused') return 'refuse'
  const call = callFor(ask, calls)
  if (call === 'unknown' || call?.agentId !== undefined) return 'typed card'
  return call !== undefined && ask.entry !== null && ask.entry.access === 'allowed' && ask.entry.use === 'session' ? 'give' : 'card'
}

/** The vault's tags and names: only to a main-loop command; refused to any other and to one that can't be matched. */
export function listDecision(list: Requester, calls: Calls): 'give' | 'refuse' {
  const call = callFor(list, calls)
  return call !== undefined && call !== 'unknown' && call.agentId === undefined ? 'give' : 'refuse'
}

/**
 * Where a paste into the list goes: the selected card's typed value, else the prompt, when no card is selected or the
 * card takes no typing (a sign card, a vault entry in its field, typing off).
 */
export function pasteTarget(card: { kind: string; chosen: string | null } | undefined, typingOff: string | null): 'card' | 'no card' | 'untyped' {
  if (card === undefined) return 'no card'
  return card.kind === 'sign' || card.chosen !== null || typingOff !== null ? 'untyped' : 'card'
}

/** The source shown on a request's card; a requester outside the session is marked so. */
export function requestSource(request: { cmdline: string; pid: number; inside: boolean }, commands: string[]): string {
  const source = sourceOf(request.cmdline || `pid ${request.pid}`, commands)
  return request.inside ? source : `outside this session: ${source}`
}

/** The running Bash command a request came from, else the command out of the asker's wrapper, else its command line. */
export function sourceOf(cmdline: string, commands: string[]): string {
  const call = callOf(cmdline, commands.map(command => ({ command })))
  if (call !== undefined) return call.command
  const wrapped = WRAPPED.exec(cmdline)
  return wrapped === null ? cmdline : wrapped[1]!.replace(QUOTED_QUOTE, "'")
}
