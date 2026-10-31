import { expect, mock, test } from 'claude-code/testing'

const SESSION = { cwd: '/home/u/p', surface: 'terminal', isInteractive: true }
const READ = { tool: 'Read', file_path: '/home/u/p/a', tool_use_id: 't1', agentId: 'sub1' }

/** Puts up the sidebar noun; an inline plugin sees nothing of this file. */
const mods = {
  name: 'mods',
  register(on: any) {
    on('engine.create', async (_$: unknown, e: unknown, next: (e: unknown) => Promise<any>) => {
      const built = await next(e)
      const none = async () => undefined
      return { ...built, sidebar: Object.fromEntries(['badge', 'hold', 'mirrored', 'popout', 'press', 'register', 'room', 'select', 'selected'].map(n => [n, none])) }
    })
  },
}
const OPTIONS = { plugins: [mods] }

/** The host, with what an earlier load left; `world.attach` lets the daemon's stream begin. */
function setup(on: any, wasAttached: boolean) {
  const world = {
    ran: [] as string[],
    masked: 0,
    attach: (() => undefined) as () => void,
    tellMasking: (() => undefined) as () => void,
    isMaskingLate: false,
    canRegister: true,
    canReadVault: true,
    canStartBeneath: true,
  }
  const value = (v: unknown) => () => ({ value: v })
  const clock = mock.clock(on)
  on('state.get', ($: unknown, e: { key: string }) => ({ value: { value: e.key === 'wasAttached' ? wasAttached : undefined, version: 1 } }))
  on('state.set', value({ isSet: true, version: 2 }))
  on('store.get', value(undefined))
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'XDG_RUNTIME_DIR' ? '/run/u' : e.name === 'HOME' ? '/home/u' : undefined }))
  on('env.set', value(undefined))
  on('session.id', value('A'))
  on('command.register', value(undefined))
  on('tool.register', () => {
    if (!world.canRegister) throw new Error('no tools here')
    return { value: { tool: 'mcp__cc-secrets__vault' } }
  })
  on('ui.log', value(undefined))
  on('ui.toast', value(undefined))
  on('ui.invalidate', value(undefined))
  on('fs.read', value('{}'))
  on('http.fetch', ($: unknown, e: { url: string; body?: string }) => {
    if (e.url.endsWith('/mask')) world.masked += 1
    if (e.url.endsWith('/vault') && !world.canReadVault) return { value: { status: 500, text: '' } }
    if (e.url.endsWith('/session') || e.url.endsWith('/settings')) return { value: { status: 204, text: '' } }
    const body = e.url.endsWith('/mask') ? JSON.parse(e.body!) : { state: 'locked', entries: [], suggestions: [], forward: false }
    return { value: { status: 200, text: JSON.stringify(body) } }
  })
  on('process.spawn', async function* () {
    await new Promise<void>(resolve => {
      world.attach = resolve
    })
    yield { stream: 'stdout', text: `${JSON.stringify({ ready: '/run/u/s-1', agent: '/run/u/s-1.agent', vault: 'locked', bin: '/b' })}\n` }
    if (world.isMaskingLate) {
      await new Promise<void>(resolve => {
        world.tellMasking = resolve
      })
    }
    yield { stream: 'stdout', text: '{"masking":true}\n' }
    await new Promise(() => undefined)
  })
  on('session.start', () => {
    if (!world.canStartBeneath) throw new Error('a hook beneath failed')
    return { cwd: SESSION.cwd }
  })
  on('tool.call', ($: unknown, e: { tool: string }) => {
    world.ran.push(e.tool)
    return { result: { text: 'read' } }
  })
  return { clock, world }
}

test('a subagent call in a reload waits for the attach, and its result goes through masking', OPTIONS, async ($, on) => {
  const { clock, world } = setup(on, true)
  const called = ($ as any).tool.call(READ)
  const starting = ($ as any).session.start(SESSION)
  for (let i = 0; i < 20; i++) await clock.advance(1)
  expect(world.ran).toEqual([])
  world.attach()
  await Promise.all([called, starting])
  expect(world.ran).toEqual(['Read'])
  expect(world.masked).toBe(1)
})

test('the ready event alone does not let a call through: the guards read the masking event behind it', OPTIONS, async ($, on) => {
  const { clock, world } = setup(on, true)
  world.isMaskingLate = true
  const called = ($ as any).tool.call(READ)
  const starting = ($ as any).session.start(SESSION)
  for (let i = 0; i < 20; i++) await clock.advance(1)
  world.attach()
  for (let i = 0; i < 20; i++) await clock.advance(1)
  expect(world.ran).toEqual([])
  world.tellMasking()
  await Promise.all([called, starting])
  expect(world.masked).toBe(1)
})

test('a subagent call in a reload is withheld when the vault could not be read after the attach', OPTIONS, async ($, on) => {
  const { clock, world } = setup(on, true)
  world.canReadVault = false
  const called = ($ as any).tool.call(READ)
  const starting = ($ as any).session.start(SESSION).catch(() => undefined)
  for (let i = 0; i < 20; i++) await clock.advance(1)
  world.attach()
  await starting
  expect(await called).toEqual({ deny: 'secrets: masking this tool call failed, so its result is withheld' })
  expect(world.ran).toEqual([])
})

test('a subagent call in a reload is withheld, not left waiting, when a session.start hook beneath fails', OPTIONS, async ($, on) => {
  const { world } = setup(on, true)
  world.canStartBeneath = false
  const called = ($ as any).tool.call(READ)
  await ($ as any).session.start(SESSION).catch(() => undefined)
  expect(await called).toEqual({ deny: 'secrets: masking this tool call failed, so its result is withheld' })
  expect(world.ran).toEqual([])
})

test('a subagent call in a reload whose attach fails is withheld', OPTIONS, async ($, on) => {
  const { world } = setup(on, true)
  world.canRegister = false
  const called = ($ as any).tool.call(READ)
  await ($ as any).session.start(SESSION).catch(() => undefined)
  expect(await called).toEqual({ deny: 'secrets: masking this tool call failed, so its result is withheld' })
  expect(world.ran).toEqual([])
})

test('a call before the first attach of a session runs as it did', OPTIONS, async ($, on) => {
  const { world } = setup(on, false)
  await ($ as any).tool.call(READ)
  expect(world.ran).toEqual(['Read'])
})
