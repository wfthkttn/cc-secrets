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

test('a link re-pointed to another folder the plugin holds gives another identity', async () => {
  const two = under('/p', { ...PLUGIN, 'a/impl.ts': 'one', 'b/impl.ts': 'two' })
  const toA = await codeIdentity('/p', fakeFs(two, { '/p/z': '/p/a' }))
  expect(await codeIdentity('/p', fakeFs(two, { '/p/z': '/p/b' }))).not.toBe(toA)
  expect(await codeIdentity('/p', fakeFs(two))).not.toBe(toA)
})

test('a file link re-pointed to a file with the same bytes gives another identity', async () => {
  const twins = under('/p', { ...PLUGIN, 'a/entry.ts': 'same', 'b/entry.ts': 'same' })
  const toA = await codeIdentity('/p', fakeFs(twins, { '/p/active.ts': '/p/a/entry.ts' }))
  expect(await codeIdentity('/p', fakeFs(twins, { '/p/active.ts': '/p/b/entry.ts' }))).not.toBe(toA)
})

test("the engine's types don't count through a link to the folder that holds them either", async () => {
  const typed = (text: string) => fakeFs(under('/p', { ...PLUGIN, '.claude-plugin/types/claude-code/index.d.ts': text }), { '/p/z': '/p/.claude-plugin' })
  expect(await codeIdentity('/p', typed('one'))).toBe(await codeIdentity('/p', typed('two')))
})

test('a link put in place of the types counts, so code it leads to still does', async () => {
  const changed = (text: string) => fakeFs(under('/p', { ...PLUGIN, 'hooks/register.ts': text }), { '/p/.claude-plugin/types': '/p' })
  expect(await codeIdentity('/p', changed('one'))).not.toBe(await codeIdentity('/p', changed('two')))
})

test('a backslash in a name is part of it outside Windows', async () => {
  const named = (text: string) => fakeFs(under('/p', { ...PLUGIN, '.claude-plugin/types/claude-code/index.d.ts': 'x', '.claude-plugin\\types/payload.js': text }))
  expect(await codeIdentity('/p', named('one'))).not.toBe(await codeIdentity('/p', named('two')))
})

test('a link inside a folder installed as a link into a store counts as in the copy', async () => {
  const hooks = { 'hooks/hooks.json': PLUGIN['hooks/hooks.json']!, 'hooks/register.ts': PLUGIN['hooks/register.ts']!, 'hooks/impl.ts': 'impl' }
  const copy = fakeFs(under('/p', { ...PLUGIN, ...hooks }), { '/p/hooks/active.ts': '/p/hooks/impl.ts' })
  const store = fakeFs(
    { '/p/.claude-plugin/plugin.json': PLUGIN['.claude-plugin/plugin.json']!, ...under('/store', hooks) },
    { '/p/hooks': '/store/hooks', '/store/hooks/active.ts': '/store/hooks/impl.ts' },
  )
  expect(await codeIdentity('/p', store)).toBe(await codeIdentity('/p', copy))
})

test('a link back into the plugin counts by which folder it leads to', async () => {
  const files = under('/p', PLUGIN)
  const toRoot = await codeIdentity('/p', fakeFs(files, { '/p/hooks/up': '/p' }))
  expect(await codeIdentity('/p', fakeFs(files, { '/p/hooks/up': '/p/hooks' }))).not.toBe(toRoot)
  expect(await codeIdentity('/p', fakeFs(files, { '/p/hooks/up': '/p' }))).toBe(toRoot)
})

test('folders linked into each other past the limit reject', async () => {
  const links: Record<string, string> = {}
  const files: Record<string, string> = {}
  for (let level = 0; level <= 20; level++) {
    files[`/p/d${level}/f`] = 'leaf'
    if (level === 20) continue
    links[`/p/d${level}/x`] = `/p/d${level + 1}`
    links[`/p/d${level}/y`] = `/p/d${level + 1}`
  }
  await expect(codeIdentity('/p/d0', fakeFs(files, links))).rejects.toThrow('paths')
})

test("a file that can't be read rejects", async () => {
  const fs = fakeFs(under('/p', PLUGIN))
  const failing: CodeFs = { ...fs, bytes: async path => (path.endsWith('register.ts') ? Promise.reject(new Error('over 4 MiB')) : fs.bytes(path)) }
  await expect(codeIdentity('/p', failing)).rejects.toThrow('over 4 MiB')
})
