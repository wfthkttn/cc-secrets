/** The auto-mode environment line this plugin owns in the user's settings: this label, then the user's text. */
export const LABEL = 'Secrets management: '

export const SUGGESTED =
  '`secrets ask [--tag TAG] "what"` gives a command a secret the user types or approves in the secrets panel; nothing else hands one out. ' +
  'Allow it when the value goes straight into the command that uses it, to the service it belongs to (`psql` to its database, an `Authorization` header to its API), ' +
  'or into the env or config file the program using it reads (`.env`, kubeconfig, `.netrc`). ' +
  'Block it when the value is printed to output, written anywhere else (notes, logs, scripts, temp files), sent to anything other than its service, ' +
  'or when a file holding it is added to git or shared.'

type Settings = Record<string, unknown> & { autoMode?: unknown }

function parse(settings: string): Settings {
  let parsed: unknown
  try {
    parsed = JSON.parse(settings)
  } catch (error) {
    throw new Error(`settings.json is not valid JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object')
  return parsed as Settings
}

function autoModeOf(settings: Settings): Record<string, unknown> {
  const autoMode = settings.autoMode ?? {}
  if (autoMode === null || typeof autoMode !== 'object' || Array.isArray(autoMode)) throw new Error('settings.json: autoMode is not an object')
  return autoMode as Record<string, unknown>
}

const isOurs = (entry: unknown) => typeof entry === 'string' && entry.startsWith(LABEL)

/** The text after the label of the line in `settings`, or null when there is none. */
export function appliedText(settings: string): string | null {
  const environment = autoModeOf(parse(settings)).environment
  const line = Array.isArray(environment) ? (environment.find(isOurs) as string | undefined) : undefined
  return line === undefined ? null : line.slice(LABEL.length)
}

/**
 * `settings` with the line set to `text`: replaced where it is, else added last. A new environment list starts
 * with `"$defaults"`, since a list without it drops the built-in entries. Written as settings.json is, 2-space JSON.
 */
export function withText(settings: string, text: string): string {
  const parsed = parse(settings)
  const autoMode = autoModeOf(parsed)
  const environment: unknown[] = Array.isArray(autoMode.environment) ? [...(autoMode.environment as unknown[])] : ['$defaults']
  const at = environment.findIndex(isOurs)
  if (at >= 0) environment[at] = LABEL + text
  else environment.push(LABEL + text)
  return JSON.stringify({ ...parsed, autoMode: { ...autoMode, environment } }, null, 2) + '\n'
}
