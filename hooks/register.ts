import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'
import type { SidebarDrawerSlot, SidebarPopoutSlot, SidebarRowComponent } from 'sidebar'

import { holdsMask, masksValues, maskStrings, remember } from './mask'
import { Popouts } from './popouts'
import { listHeight } from './requests'
import type { RequestEntry, RequestsMessage, RequestsProps } from './requests-props'
import { fillSlot, hasSlot } from './slot'
import { sourceOf } from './source'

const SIDEBAR_ID = 'pass'
const DRAWER_SLOT: SidebarDrawerSlot = `sidebar-drawer:${SIDEBAR_ID}`
const POPOUT_SLOT: SidebarPopoutSlot = `sidebar-popout:${SIDEBAR_ID}`
const LIST_KEY = 'requests'
const POPOUT_KEY = 'popout'
const DRAWER_COLUMNS = 64
const POPOUT_MS = 15000
const NOTICE_MS = 10000
const RELAY_START_MS = 5000
const UNSEEN_PASTE = 'A paste of 3+ lines or 800+ characters went into the prompt, not the request.'
const WRITE_BACK = 'secrets: this would write [secret], a masked value, over the real one; edit around the masked span instead.'
const ROW_COMPONENTS = [
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'CommandOutput',
  'TurnDuration',
  'InfoNotice',
] as const satisfies readonly SidebarRowComponent[]

type Ask = { id: string; prompt: string; pid: number; cmdline: string }

type RelayEvent =
  | { ready: string }
  | { ask: Ask }
  | { gone: string }

type Request = Omit<RequestEntry, 'length'>

/** Replaced, never changed in place: render props freeze what they're handed. */
let requests: readonly Request[] = []
/** Bash calls in flight, for a request's source command. */
const running: { id: string; command: string }[] = []
let relaySocket: string | null = null
/** The `maskMinLength` option, read once the module registers. */
let maskMinLength = 0
let focusEpoch = 0
/** The value typed or pasted for each request; the lists only learn its length. */
const held = new Map<string, string>()
/** The last edit applied per list instance; replaced, never changed in place. */
let applied: Record<string, number> = {}
/** Set by any message from the list (a click gives it the keyboard); cleared by a key the prompt takes. */
let listFocused = false
/** The prompt's draft while the list holds the keyboard; a different draft at the prompt's next key or submit means a paste landed there unseen. */
let draftAtFocus: string | null = null
let listSelected: string | null = null
/** Made at session start, where the hooks first have `$` for its timers. */
let popouts: Popouts | null = null
/** Shown above the cards; a sticky one stays until its ✕, any other also goes on the next action or after `NOTICE_MS`. */
let notice: { text: string; sticky: boolean; timer: Timer | null } | null = null

function randomId(): string {
  return Math.random().toString(36).slice(2)
}

function clockTime(): string {
  return new Date().toTimeString().slice(0, 8)
}

function livePopouts(): Popouts {
  if (popouts === null) throw new Error('secrets: pop-outs used before session start')
  return popouts
}

/** Shows the pop-out area while a card or a notice is in it, hides it otherwise. */
function syncPopout($: EngineInterface) {
  $.ui.invalidate('ui.render')
  void $.sidebar.popout({ id: SIDEBAR_ID, isShown: livePopouts().shown().length > 0 || notice !== null })
}

function say($: EngineInterface, text: string, sticky: boolean) {
  notice?.timer?.cancel()
  notice = { text, sticky, timer: sticky ? null : $.clock.after(NOTICE_MS, () => unsay($, false)) }
  syncPopout($)
}

function unsay($: EngineInterface, evenSticky: boolean) {
  if (notice === null || (notice.sticky && !evenSticky)) return
  notice.timer?.cancel()
  notice = null
  syncPopout($)
}

export function register(on: On, options: PluginOptions) {
  if (typeof options.maskMinLength !== 'number') {
    throw new Error('secrets: the maskMinLength option is not a number')
  }
  maskMinLength = options.maskMinLength

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.sidebar.register({ id: SIDEBAR_ID, icon: '🔐', short: 'pass', drawerColumns: DRAWER_COLUMNS })
    popouts = new Popouts(POPOUT_MS, (ms, fn) => $.clock.after(ms, fn), () => syncPopout($))
    await $.command.register({ name: 'pass-demo', description: 'Show three sample password requests; no program waits on them' })
    // A reload starts with no requests and a new relay; the host still shows what the old module set.
    await $.sidebar.badge({ id: SIDEBAR_ID, count: 0, level: 'urgent' })
    await $.sidebar.popout({ id: SIDEBAR_ID, isShown: false })

    const runtimeDir = await $.env.get('XDG_RUNTIME_DIR')
    if (!runtimeDir) {
      throw new Error('secrets: XDG_RUNTIME_DIR is not set, so the relay socket has nowhere to live')
    }
    const socket = `${runtimeDir}/claude-secrets-${randomId()}.sock`
    relaySocket = socket
    // Commands see the relay only once it listens: before, mask-run would let their output through unmasked.
    await startRelay($, socket)
    const helper = $.plugin.root + '/bin/ask-secret'
    await $.env.set('SECRETS_RELAY', socket)
    await $.env.set('ASK_SECRET', helper)
    await $.env.set('SUDO_ASKPASS', helper)
    await $.env.set('SSH_ASKPASS', helper)
    await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
    await $.env.set('GIT_ASKPASS', helper)
    const maskRun = $.plugin.root + '/bin/mask-run'
    const prefix = await $.env.get('CLAUDE_CODE_SHELL_PREFIX')
    // On a reload the prefix is already ours; the one found first is the user's.
    if (prefix && prefix !== maskRun) await $.env.set('SECRETS_ORIG_PREFIX', prefix)
    await $.env.set('SECRETS_MASK_MIN', String(maskMinLength))
    await $.env.set('CLAUDE_CODE_SHELL_PREFIX', maskRun)
    return started
  })

  on('tool.call', async ($, e, next) => {
    const written =
      e.tool === 'Write' ? e.content : e.tool === 'Edit' ? e.new_string : e.tool === 'NotebookEdit' ? e.new_source : e.tool === 'Bash' ? e.command : null
    if (written !== null && masksValues() && holdsMask(written)) return { deny: WRITE_BACK }
    if (e.tool !== 'Bash') return maskStrings(await next(e))
    running.push({ id: e.tool_use_id, command: e.command })
    try {
      return maskStrings(await next(e))
    } finally {
      running.splice(running.findIndex(r => r.id === e.tool_use_id), 1)
    }
  }).catch(() => ({ deny: 'secrets: masking this tool call failed, so its result is withheld' }))

  on('ui.message', async ($, e, next) => {
    if (e.element !== LIST_KEY && e.element !== POPOUT_KEY) return next(e)
    const message = e.data as RequestsMessage
    unsay($, message.dismiss === true)
    if (!listFocused) draftAtFocus = (await $.prompt.read()).text
    listFocused = true
    listSelected = message.selected
    livePopouts().focus(message.selected)
    const last = applied[message.instance] ?? 0
    for (const edit of message.edits) {
      if (edit.seq <= last) continue
      applied = { ...applied, [message.instance]: edit.seq }
      if (!requests.some(r => r.id === edit.id)) continue
      const value = held.get(edit.id) ?? ''
      if (edit.kind === 'append') held.set(edit.id, value + edit.text)
      else if (edit.kind === 'back') held.set(edit.id, [...value].slice(0, -1).join(''))
      else if (edit.kind === 'clear') held.set(edit.id, '')
      else if (edit.kind === 'submit') await answerRequest($, edit.id, { secret: value })
      else await answerRequest($, edit.id, { cancel: true })
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    if (e.key !== undefined) {
      if (listFocused && e.text !== draftAtFocus) say($, UNSEEN_PASTE, false)
      listFocused = false
      draftAtFocus = null
      livePopouts().blur()
      if (requests.length > 0) {
        focusEpoch += 1
        $.ui.invalidate('ui.render')
      }
      return next(e)
    }
    // While the list holds the keyboard, keys go to it; a key-less edit reaching the prompt is a paste.
    const target = requests.find(r => r.id === listSelected)
    if (!listFocused || target === undefined || e.inputText === '') {
      const box = await next(e)
      if (listFocused) draftAtFocus = box.text
      return box
    }
    held.set(target.id, (held.get(target.id) ?? '') + e.inputText.replace(/\r?\n$/, ''))
    $.ui.invalidate('ui.render')
    return { text: e.text, cursor: e.cursor }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer') return next(e)
    if (!listFocused || draftAtFocus === null || e.text === draftAtFocus.trim()) {
      unsay($, false)
      return next(e)
    }
    // Dropped once: the next Enter sends it.
    listFocused = false
    draftAtFocus = null
    say($, UNSEEN_PASTE, false)
    return { drop: `Not sent. ${UNSEEN_PASTE} Enter again to send it.` }
  })

  on('command.run', { command: 'pass-demo' }, async $ => {
    const samples = [
      { prompt: '[sudo] password for alex', source: 'sudo -A systemctl restart nginx' },
      { prompt: "Password for 'https://alex@git.example.org'", source: 'git push origin main' },
      {
        prompt: 'deploy token',
        source: 'TOKEN=$($ASK_SECRET "deploy token") && curl -fsS -H "Authorization: Bearer $TOKEN" https://deploy.example.org/api/v1/releases --data @release.json',
      },
    ]
    for (const sample of samples) await addRequest($, { id: 'demo-' + randomId(), ...sample, since: clockTime() })
    await syncBadge($)
    return {}
  })

  on('sidebar.press', async ($, e, next) => {
    // Opening the list shows every request, so none stays popped out.
    if (e.element === 'tool:' + SIDEBAR_ID) livePopouts().clear()
    return next(e)
  })

  on('ui.render', { component: [...ROW_COMPONENTS] }, async ($, e, next) => {
    const tree = await next(e)
    if (e.surface !== 'terminal') return tree
    const inDrawer = hasSlot(tree, DRAWER_SLOT)
    const inPopout = hasSlot(tree, POPOUT_SLOT)
    if (!inDrawer && !inPopout) return tree
    const room = await $.sidebar.room({})
    if (room === null) return tree
    const { Client } = $.ui.resolve(e)
    const list = (key: string, shown: readonly Request[], columns: number, rows: number) => {
      const entries: RequestEntry[] = shown.map(r => ({ ...r, length: [...(held.get(r.id) ?? '')].length }))
      const message = notice === null ? null : notice.text
      const height = listHeight(entries, columns, message, rows)
      const props: RequestsProps = { entries, focusEpoch, applied, message, columns, rows: height }
      return Client({ key, module: './requests.ts', props, width: columns, height })
    }
    let filled = tree
    if (inDrawer) {
      filled = fillSlot(filled, DRAWER_SLOT, () => list(LIST_KEY, requests, DRAWER_COLUMNS - room.drawerFrameColumns, room.drawer)) as typeof tree
    }
    if (inPopout) {
      const ids = new Set(livePopouts().shown())
      filled = fillSlot(filled, POPOUT_SLOT, () => list(POPOUT_KEY, requests.filter(r => ids.has(r.id)), DRAWER_COLUMNS, room.popout)) as typeof tree
    }
    return filled
  })
}

/** Starts the relay; resolves once it listens. A later failure shows in the list. */
function startRelay($: EngineInterface, socket: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let isReady = false
    const timer = $.clock.after(RELAY_START_MS, () => reject(new Error(`secrets: the relay didn't start within ${RELAY_START_MS} ms`)))
    readRelay($, socket, () => {
      isReady = true
      timer.cancel()
      resolve()
    }).catch((error: Error) => {
      timer.cancel()
      if (isReady) say($, `Requests stopped: ${error.message}`, true)
      else reject(error)
    })
  })
}

async function readRelay($: EngineInterface, socket: string, ready: () => void) {
  const relay = $.process.spawn({ argv: ['python3', '-I', $.plugin.root + '/bin/relay.py', socket] })
  let buffered = ''
  for await (const chunk of relay) {
    if (chunk.stream === 'stderr') {
      $.ui.log('relay: ' + chunk.text.trimEnd(), { to: 'debug' })
      continue
    }
    buffered += chunk.text
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const event = JSON.parse(buffered.slice(0, newline)) as RelayEvent
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
      if ('ready' in event) {
        ready()
        continue
      }
      if ('ask' in event) {
        const { id, prompt, pid, cmdline } = event.ask
        const source = sourceOf(cmdline || `pid ${pid}`, running.map(r => r.command))
        await addRequest($, { id, prompt, source, since: clockTime() })
      } else dropRequest(event.gone)
      await syncBadge($)
      if ('ask' in event) await $.ui.notify(`Password needed: ${event.ask.prompt}`, { title: 'secrets' })
    }
  }
  throw new Error('the relay exited')
}

/** Lists the request; it pops out unless the list is open. */
async function addRequest($: EngineInterface, request: Request) {
  requests = [...requests, request]
  if ((await $.sidebar.selected({})) !== SIDEBAR_ID) livePopouts().add(request.id)
}

async function answerRequest($: EngineInterface, id: string, answer: { secret: string } | { cancel: true }) {
  if (relaySocket === null) throw new Error('secrets: answered a request before the relay started')
  let reply: Awaited<ReturnType<EngineInterface['http']['fetch']>>
  try {
    reply = await $.http.fetch('http://relay/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...answer }),
      socketPath: relaySocket,
    })
  } catch (error) {
    // The fetch error's text may carry the request, and with it the secret.
    const code = /\bE[A-Z]{2,}\b/.exec((error as Error).message)?.[0] ?? 'no error code'
    say($, `Not answered: the relay can't be reached (${code}).`, true)
    return
  }
  // 410: the asking program went away first.
  if (reply.status !== 204 && reply.status !== 410) {
    say($, `Not answered: the relay answered ${reply.status}.`, true)
    return
  }
  if (reply.status === 204 && 'secret' in answer) remember(answer.secret, maskMinLength)
  dropRequest(id)
  await syncBadge($)
}

function dropRequest(id: string) {
  requests = requests.filter(r => r.id !== id)
  held.delete(id)
  livePopouts().remove(id)
}

/** The badge shows the waiting requests; with none left, an open list closes. */
async function syncBadge($: EngineInterface) {
  $.ui.invalidate('ui.render')
  await $.sidebar.badge({ id: SIDEBAR_ID, count: requests.length, level: 'urgent' })
  if (requests.length === 0 && (await $.sidebar.selected({})) === SIDEBAR_ID) await $.sidebar.select({ id: null })
}
