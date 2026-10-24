/** What the walk needs of the file system: a directory's entries, where a path lands, a file's bytes as base64. */
export type CodeFs = {
  list: (dir: string) => Promise<readonly { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean }[]>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; realPath?: string }>
  bytes: (path: string) => Promise<string>
}

/** The types the engine writes into a loaded plugin's folder: they follow the engine build and the MCP servers, not the plugin. */
const ENGINE_WRITTEN = '.claude-plugin/types'

/** Paths the walk takes at most: folders linked into each other many times over would make it endless in effect. */
const MAX_PATHS = 100_000

/** Where `path` lies in `base`, `/`-separated (`''` for `base` itself), or null outside it. `\` separates only on Windows, where a name can't hold one. */
function within(path: string, base: string): string | null {
  const isWindows = /^[A-Za-z]:[\\/]/.test(base) || base.startsWith('\\\\')
  const [p, b] = isWindows ? [path.replaceAll('\\', '/'), base.replaceAll('\\', '/')] : [path, base]
  if (p === b) return ''
  return p.startsWith(b + '/') ? p.slice(b.length + 1) : null
}

/** A folder the walk is in: where it is, and its path in the plugin. */
type Step = { real: string; at: string }

/** Where `target` lies in the plugin as walked: by the innermost folder of `steps` that holds it, or null. */
function placed(target: string, steps: readonly Step[]): string | null {
  for (const step of [...steps].reverse()) {
    const rest = within(target, step.real)
    if (rest !== null) return step.at === '' ? rest : rest === '' ? step.at : `${step.at}/${rest}`
  }
  return null
}

/**
 * A SHA-256 over every file under a plugin's folder, by path, links followed: the same code gives the same identity
 * wherever it is installed, and any change to a file in it, or to where a link in it leads, gives another. A link
 * counts with where it leads in the plugin as walked, so a plugin installed as links into a store has the identity of
 * its copy; a link out of it counts by what it holds; a folder reached by two paths counts under both. The engine's
 * types don't count where they sit, nor through a link to them; a link put in their place counts like any other.
 * Rejects when a file can't be read (over the 4 MiB a read takes, or gone mid-walk), or past `MAX_PATHS`, so a plugin
 * that can't be identified isn't taken for one that can.
 */
export async function codeIdentity(root: string, fs: CodeFs): Promise<string> {
  const top = (await fs.stat(root)).realPath
  if (top === undefined) throw new Error(`secrets: ${root} leads nowhere`)
  // a plugin without engine-written types has none to leave out
  const written = await fs.stat(`${top}/${ENGINE_WRITTEN}`).then(
    s => s.realPath,
    () => undefined,
  )
  const types = written !== undefined && within(written, top) === ENGINE_WRITTEN ? written : undefined
  const isEngineWritten = (real: string) => types !== undefined && within(real, types) !== null
  const files: [string, string | null][] = []
  const read = new Map<string, Promise<string>>()
  let taken = 0
  const walk = async (dir: string, at: string, steps: readonly Step[]) => {
    const real = (await fs.stat(dir)).realPath
    if (real === undefined) throw new Error(`secrets: ${dir} leads nowhere`)
    // the link that led back here counts by where it leads
    if (steps.some(step => step.real === real) || isEngineWritten(real)) return
    const here = [...steps, { real, at }]
    const entries = [...(await fs.list(real))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`
      if (entry.name === '.git' || (path === ENGINE_WRITTEN && types !== undefined)) continue
      taken += 1
      if (taken > MAX_PATHS) throw new Error(`secrets: ${root} holds over ${MAX_PATHS} paths`)
      const full = `${real}/${entry.name}`
      let kind = entry.kind
      let target = full
      if (entry.isLink) {
        const led = await fs.stat(full)
        kind = led.kind
        if (led.realPath !== undefined) {
          if (isEngineWritten(led.realPath)) continue
          target = led.realPath
          const lands = placed(led.realPath, here)
          // base64 has no ':', so this is no file's content
          if (lands !== null) files.push([path, `link:${lands}`])
        }
      } else if (isEngineWritten(full)) continue
      if (kind === 'dir') await walk(target, path, here)
      else if (kind === 'file') {
        if (!read.has(target)) read.set(target, fs.bytes(target))
        files.push([path, await read.get(target)!])
      } else files.push([path, null])
    }
  }
  await walk(root, '', [])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(files)))
  return 'sha256:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
