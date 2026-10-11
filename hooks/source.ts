/** A single quote inside a single-quoted shell word, in the two ways shells write it. */
const QUOTED_QUOTE = /'\\''|'"'"'/g
/** Bash's wrapper shell runs the command as `eval '<command>'`. */
const WRAPPED = new RegExp(`\\beval '((?:[^']|${QUOTED_QUOTE.source})*)'`)

/** The running Bash command a request came from, else the command out of the asker's wrapper, else its command line. */
export function sourceOf(cmdline: string, commands: string[]): string {
  // A command that ran the asker (`sudo -A …`) holds its command line.
  const ran = commands.find(c => c.includes(cmdline))
  if (ran !== undefined) return ran
  // An asker inside Bash's wrapper holds the command; the longest match, so `make` doesn't win over `make install`.
  const unquoted = cmdline.replace(QUOTED_QUOTE, "'")
  const held = commands.filter(c => unquoted.includes(c)).sort((a, b) => b.length - a.length)[0]
  if (held !== undefined) return held
  const wrapped = WRAPPED.exec(cmdline)
  return wrapped === null ? cmdline : wrapped[1]!.replace(QUOTED_QUOTE, "'")
}
