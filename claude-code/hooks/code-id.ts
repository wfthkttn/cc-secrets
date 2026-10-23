/** What the walk needs of the file system: a directory's entries, where a path lands, a file's bytes as base64. */
export type CodeFs = {
  list: (dir: string) => Promise<readonly { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean }[]>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; realPath?: string }>
  bytes: (path: string) => Promise<string>
}

/** The types the engine writes into a loaded plugin's folder: they follow the engine build and the MCP servers, not the plugin. */
const ENGINE_WRITTEN = '.claude-plugin/types'

/**
 * A SHA-256 over every file under a plugin's folder, by path, links followed: the same code gives the same identity
 * wherever it is installed, and any change to a file in it gives another. Rejects when a file can't be read
 * (over the 4 MiB a read takes, or gone mid-walk), so a plugin that can't be identified isn't taken for one that can.
 */
export async function codeIdentity(root: string, fs: CodeFs): Promise<string> {
  const files: [string, string | null][] = []
  const walked = new Set<string>()
  const walk = async (dir: string, at: string) => {
    const real = (await fs.stat(dir)).realPath
    if (real === undefined) throw new Error(`secrets: ${dir} leads nowhere`)
    if (walked.has(real)) return
    walked.add(real)
    const entries = [...(await fs.list(real))].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = at === '' ? entry.name : `${at}/${entry.name}`
      if (entry.name === '.git' || path === ENGINE_WRITTEN) continue
      const full = `${real}/${entry.name}`
      const kind = entry.isLink ? (await fs.stat(full)).kind : entry.kind
      if (kind === 'dir') await walk(full, path)
      else files.push([path, kind === 'file' ? await fs.bytes(full) : null])
    }
  }
  await walk(root, '')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(files)))
  return 'sha256:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
