import { expect, test } from 'claude-code/testing'

import { codeIdentity, type CodeFs } from '../hooks/code-id'

/** Files by absolute path, and symbolic links by absolute path to their target. */
function fakeFs(files: Record<string, string>, links: Record<string, string> = {}): CodeFs {
  const resolve = (path: string): string => {
    const parts = path.split('/').filter(p => p !== '')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = '/' + parts.slice(0, i).join('/')
      const target = links[prefix]
      if (target !== undefined) return resolve([target, ...parts.slice(i)].join('/'))
    }
    return '/' + parts.join('/')
  }
  const kindOf = (real: string) =>
    files[real] !== undefined ? 'file' : Object.keys(files).some(f => f.startsWith(real + '/')) ? 'dir' : 'other'
  return {
    list: async dir => {
      const real = resolve(dir)
      const names = new Set([...Object.keys(files), ...Object.keys(links)].filter(p => p.startsWith(real + '/')).map(p => p.slice(real.length + 1).split('/')[0]!))
      return [...names].map(name => {
        const path = `${real}/${name}`
        const isLink = links[path] !== undefined
        return { name, kind: isLink ? 'other' : kindOf(path), isLink }
      })
    },
    stat: async path => {
      const real = resolve(path)
      const kind = kindOf(real)
      return kind === 'other' ? { kind } : { kind, realPath: real }
    },
    bytes: async path => {
      const text = files[resolve(path)]
      if (text === undefined) throw new Error(`no file at ${path}`)
      return btoa(text)
    },
  }
}

const PLUGIN: Record<string, string> = {
  '.claude-plugin/plugin.json': '{"name":"tracer"}',
  'hooks/hooks.json': '{"modules":["./register.ts"]}',
  'hooks/register.ts': 'export const register = on => {}',
}

function under(root: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text]))
}

test('the same code has one identity wherever it is installed; a changed, added or removed file gives another', async () => {
  const id = await codeIdentity('/store/tracer', fakeFs(under('/store/tracer', PLUGIN)))
  expect(id).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(await codeIdentity('/dev/tracer', fakeFs(under('/dev/tracer', PLUGIN)))).toBe(id)
  expect(await codeIdentity('/p', fakeFs(under('/p', { ...PLUGIN, 'hooks/register.ts': 'export const register = on => { on("*") }' })))).not.toBe(id)
  expect(await codeIdentity('/p', fakeFs(under('/p', { ...PLUGIN, 'hooks/extra.ts': '' })))).not.toBe(id)
  const { 'hooks/hooks.json': _gone, ...fewer } = PLUGIN
  expect(await codeIdentity('/p', fakeFs(under('/p', fewer)))).not.toBe(id)
})

test("the types the engine writes and a git folder don't count; a linked folder or file counts by what it holds", async () => {
  const id = await codeIdentity('/p', fakeFs(under('/p', PLUGIN)))
  const written = { ...PLUGIN, '.claude-plugin/types/claude-code/index.d.ts': 'x', '.git/HEAD': 'ref' }
  expect(await codeIdentity('/p', fakeFs(under('/p', written)))).toBe(id)
  expect(await codeIdentity('/mods/tracer', fakeFs(under('/repo', PLUGIN), { '/mods/tracer': '/repo' }))).toBe(id)
  const { 'hooks/register.ts': register, ...rest } = PLUGIN
  const linked = (text: string) => fakeFs({ ...under('/p', rest), '/elsewhere/r.ts': text }, { '/p/hooks/register.ts': '/elsewhere/r.ts' })
  expect(await codeIdentity('/p', linked(register!))).toBe(id)
  expect(await codeIdentity('/p', linked('changed'))).not.toBe(id)
})

test('a folder linked back into itself is walked once, and a link leading nowhere still counts', async () => {
  const id = await codeIdentity('/p', fakeFs(under('/p', PLUGIN)))
  expect(await codeIdentity('/p', fakeFs(under('/p', PLUGIN), { '/p/hooks/again': '/p' }))).toMatch(/^sha256:/)
  expect(await codeIdentity('/p', fakeFs(under('/p', PLUGIN), { '/p/dangling': '/nowhere' }))).not.toBe(id)
})

test("a file that can't be read rejects", async () => {
  const fs = fakeFs(under('/p', PLUGIN))
  const failing: CodeFs = { ...fs, bytes: async path => (path.endsWith('register.ts') ? Promise.reject(new Error('over 4 MiB')) : fs.bytes(path)) }
  await expect(codeIdentity('/p', failing)).rejects.toThrow('over 4 MiB')
})
