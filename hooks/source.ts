/** A single quote inside a single-quoted shell word, in the two ways shells write it. */
const QUOTED_QUOTE = /'\\''|'"'"'/g

/** The running command a request came from, else the asking process's parent command line. */
export function sourceOf(cmdline: string, commands: string[]): string {
  // Bash's wrapper shell carries the command single-quoted.
  const unquoted = cmdline.replace(QUOTED_QUOTE, "'")
  const match = commands.find(c => c !== '' && (unquoted.includes(c) || c.includes(cmdline)))
  if (match !== undefined) return match
  const wrapped = /\beval '((?:[^']|'\\''|'"'"')*)'/.exec(cmdline)
  return wrapped === null ? cmdline : wrapped[1]!.replace(QUOTED_QUOTE, "'")
}
