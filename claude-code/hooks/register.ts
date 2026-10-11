import type { EngineInterface, On, PluginOptions, Timer } from 'claude-code'
import type { SidebarDrawerSlot, SidebarPopoutSlot, SidebarRowComponent } from 'sidebar'

import { carried, holdsMask, masksValues, maskStrings, remember, stringsIn } from './mask'
import { Popouts } from './popouts'
import { listHeight } from './requests'
import type { RequestEntry, RequestsMessage, RequestsProps } from './requests-props'
import { fillSlot, hasSlot } from './slot'
import { callOf, sourceOf, vaultDecision } from './source'
import { type Tab, TAB_ROWS, type Tabs } from './tabs'
import type { VaultMessage, VaultProps, ViewEntry } from './vault-view-props'

const SIDEBAR_ID = 'pass'
const DRAWER_SLOT: SidebarDrawerSlot = `sidebar-drawer:${SIDEBAR_ID}`
const POPOUT_SLOT: SidebarPopoutSlot = `sidebar-popout:${SIDEBAR_ID}`
const LIST_KEY = 'requests'
const POPOUT_KEY = 'popout'
const VAULT_KEY = 'vault'
/** Rows the vault view leaves at the room's bottom, which may be off screen or under the engine's pill. */
const VAULT_SPARE_ROWS = 3
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

type Ask = { id: string; prompt: string; pid: number; cmdline: string; kind: 'secret' | 'unlock' }
type VaultState = 'absent' | 'locked' | 'open'
type VaultGet = { id: string; tag: string; name: string; use: 'session' | 'each'; allowed: boolean; pid: number; cmdline: string }
type VaultList = { id: string; pid: number; cmdline: string }
type VaultEntry = ViewEntry & { created: number }
type Decision = 'give' | 'session' | 'refuse'

type RelayEvent =
  | { ready: string; vault: VaultState }
  | { ask: Ask }
  | { gone: string }
  | { get: VaultGet }
  | { list: VaultList }
  | { vault: 'open' }
  | { trouble: string }

type Request = Omit<RequestEntry, 'length'>

/** Replaced, never changed in place: render props freeze what they're handed. */
let requests: readonly Request[] = []
/** Bash calls in flight, for a request's source command and the loop that made it. */
const running: { id: string; command: string; agentId: string | undefined }[] = []
/** What the relay last said of the vault; entries carry no values. */
let vault: { state: VaultState; entries: readonly VaultEntry[]; forward: boolean | null } = { state: 'absent', entries: [], forward: null }
let drawerTab: Tab = 'requests'
/** The vault form's value, typed or pasted; the view only learns its length. */
let formValue = ''
/** The last value edit applied per vault view instance; replaced, never changed in place. */
let vaultApplied: Record<string, number> = {}
/** Bumped when a save or delete went through, which closes the form. */
let formEpoch = 0
let vaultError: string | null = null
let vaultValueFocused = false
let vaultFormOpen = false
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
    const agent = await $.env.get('SSH_AUTH_SOCK')
    // On a reload the agent is the old relay's; the one found first is the user's.
    if (agent && !agent.startsWith(`${runtimeDir}/claude-secrets-`)) await $.env.set('SECRETS_ORIG_SSH_AUTH_SOCK', agent)
    const upstream = (await $.env.get('SECRETS_ORIG_SSH_AUTH_SOCK')) ?? ''
    // Commands see the relay only once it listens: before, secrets-mask-run would let their output through unmasked.
    vault = { state: await startRelay($, socket, upstream), entries: [], forward: upstream === '' ? null : false }
    await $.env.set('SSH_AUTH_SOCK', socket + '.agent')
    const helper = $.plugin.root + '/bin/secrets-ask'
    await $.env.set('SECRETS_RELAY', socket)
    await $.env.set('ASK_SECRET', helper)
    await $.env.set('SECRETS_VAULT', $.plugin.root + '/bin/secrets-vault')
    await $.env.set('SUDO_ASKPASS', helper)
    await $.env.set('SSH_ASKPASS', helper)
    await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
    await $.env.set('GIT_ASKPASS', helper)
    const maskRun = $.plugin.root + '/bin/secrets-mask-run'
    const prefix = await $.env.get('CLAUDE_CODE_SHELL_PREFIX')
    // On a reload the prefix is already ours; the one found first is the user's.
    if (prefix && prefix !== maskRun) await $.env.set('SECRETS_ORIG_PREFIX', prefix)
    await $.env.set('SECRETS_MASK_MIN', String(maskMinLength))
    await $.env.set('CLAUDE_CODE_SHELL_PREFIX', maskRun)
    // Unlocked from the start, the vault's values are masked and watched in every call of the session.
    if (vault.state === 'locked') await callRelay($, 'POST', '/unlock', {})
    return started
  })

  on('tool.call', async ($, e, next) => {
    const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = e
    const label = stringsIn(input).map(carried).find(l => l !== null)
    if (label !== undefined) {
      say($, `Stopped a ${e.tool} call carrying ${label}. If the agent got it outside the vault, rotate it.`, true)
      return { deny: `secrets: this call carries the value of ${label}, so it did not run. Use secrets through $SECRETS_VAULT or $ASK_SECRET; never write a value.` }
    }
    const written =
      e.tool === 'Write' ? e.content : e.tool === 'Edit' ? e.new_string : e.tool === 'NotebookEdit' ? e.new_source : e.tool === 'Bash' ? e.command : null
    if (written !== null && masksValues() && holdsMask(written)) return { deny: WRITE_BACK }
    if (e.tool !== 'Bash') return maskStrings(await next(e))
    running.push({ id: e.tool_use_id, command: e.command, agentId: e.agentId })
    try {
      return maskStrings(await next(e))
    } finally {
      running.splice(running.findIndex(r => r.id === e.tool_use_id), 1)
    }
  }).catch(() => ({ deny: 'secrets: masking this tool call failed, so its result is withheld' }))

  on('ui.message', async ($, e, next) => {
    if (e.element === VAULT_KEY) {
      if (!listFocused) draftAtFocus = (await $.prompt.read()).text
      listFocused = true
      await onVaultMessage($, e.data as VaultMessage)
      $.ui.invalidate('ui.render')
      return next(e)
    }
    if (e.element !== LIST_KEY && e.element !== POPOUT_KEY) return next(e)
    const message = e.data as RequestsMessage
    if (message.tab === 'vault') drawerTab = 'vault'
    unsay($, message.dismiss === true)
    if (!listFocused) draftAtFocus = (await $.prompt.read()).text
    listFocused = true
    vaultValueFocused = false
    listSelected = message.selected
    livePopouts().focus(message.selected)
    const last = applied[message.instance] ?? 0
    for (const edit of message.edits) {
      if (edit.seq <= last) continue
      applied = { ...applied, [message.instance]: edit.seq }
      const request = requests.find(r => r.id === edit.id)
      if (request === undefined) continue
      if (request.kind === 'grant') {
        const decisions: Partial<Record<typeof edit.kind, Decision>> = { session: 'session', once: 'give', cancel: 'refuse' }
        const decision = decisions[edit.kind]
        if (decision !== undefined) await decideRequest($, edit.id, decision)
        continue
      }
      const value = held.get(edit.id) ?? ''
      if (edit.kind === 'append') held.set(edit.id, value + edit.text)
      else if (edit.kind === 'back') held.set(edit.id, [...value].slice(0, -1).join(''))
      else if (edit.kind === 'clear') held.set(edit.id, '')
      else if (edit.kind === 'submit') await answerRequest($, request, { secret: value })
      else if (edit.kind === 'cancel') await answerRequest($, request, { cancel: true })
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
    if (listFocused && vaultValueFocused && e.inputText !== '') {
      formValue += e.inputText.replace(/\r?\n$/, '')
      $.ui.invalidate('ui.render')
      return { text: e.text, cursor: e.cursor }
    }
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
    for (const sample of samples) await addRequest($, { id: 'demo-' + randomId(), kind: 'secret', ...sample, since: clockTime() })
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
    const list = (key: string, shown: readonly Request[], columns: number, rows: number, tabs: Tabs | null) => {
      const entries: RequestEntry[] = shown.map(r => ({ ...r, length: [...(held.get(r.id) ?? '')].length }))
      const message = notice === null ? null : notice.text
      const tabRows = tabs === null ? 0 : TAB_ROWS
      const height = listHeight(entries, columns, message, rows - tabRows)
      const props: RequestsProps = { entries, tabs, focusEpoch, applied, message, columns, rows: height }
      return Client({ key, module: './requests.ts', props, width: columns, height: height + tabRows })
    }
    const vaultView = (columns: number, rows: number, tabs: Tabs) => {
      const height = rows - VAULT_SPARE_ROWS
      const props: VaultProps = {
        state: vault.state,
        entries: vault.entries.map(({ created: _created, ...entry }) => entry),
        forward: vault.forward,
        tabs,
        columns,
        rows: height,
        applied: vaultApplied,
        valueLength: [...formValue].length,
        formEpoch,
        error: vaultError,
      }
      return Client({ key: VAULT_KEY, module: './vault-view.ts', props, width: columns, height })
    }
    let filled = tree
    if (inDrawer) {
      const columns = DRAWER_COLUMNS - room.drawerFrameColumns
      const tabs: Tabs = { active: drawerTab, requests: requests.length, vaultMark: vault.entries.some(e => e.kind === 'typed') }
      const drawn = () => (drawerTab === 'vault' ? vaultView(columns, room.drawer, tabs) : list(LIST_KEY, requests, columns, room.drawer, tabs))
      filled = fillSlot(filled, DRAWER_SLOT, drawn) as typeof tree
    }
    if (inPopout) {
      const ids = new Set(livePopouts().shown())
      filled = fillSlot(filled, POPOUT_SLOT, () => list(POPOUT_KEY, requests.filter(r => ids.has(r.id)), DRAWER_COLUMNS, room.popout, null)) as typeof tree
    }
    return filled
  })
}

/** Starts the relay; resolves with the vault's state once it listens. A later failure shows in the list. */
function startRelay($: EngineInterface, socket: string, upstream: string): Promise<VaultState> {
  return new Promise((resolve, reject) => {
    let isReady = false
    const timer = $.clock.after(RELAY_START_MS, () => reject(new Error(`secrets: the relay didn't start within ${RELAY_START_MS} ms`)))
    readRelay($, socket, upstream, state => {
      isReady = true
      timer.cancel()
      resolve(state)
    }).catch((error: Error) => {
      timer.cancel()
      if (isReady) say($, `Requests stopped: ${error.message}`, true)
      else reject(error)
    })
  })
}

async function readRelay($: EngineInterface, socket: string, upstream: string, ready: (state: VaultState) => void) {
  const relay = $.process.spawn({ argv: [$.plugin.root + '/bin/secrets-relay', socket], env: { SECRETS_UPSTREAM_AGENT: upstream } })
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
      if ('ready' in event) ready(event.vault)
      else if ('ask' in event) await onAsk($, event.ask)
      else if ('gone' in event) dropRequest(event.gone)
      else if ('get' in event) await onVaultGet($, event.get)
      else if ('list' in event) await decideRequest($, event.list.id, callOf(event.list.cmdline, running)?.agentId === undefined ? 'give' : 'refuse')
      else if ('vault' in event) await refreshVault($)
      else say($, event.trouble, true)
      await syncBadge($)
    }
  }
  throw new Error('the relay exited')
}

async function onAsk($: EngineInterface, ask: Ask) {
  const source = ask.kind === 'unlock' ? '' : sourceOf(ask.cmdline || `pid ${ask.pid}`, running.map(r => r.command))
  await addRequest($, { id: ask.id, kind: ask.kind, prompt: ask.prompt, source, since: clockTime() })
  await $.ui.notify(ask.kind === 'unlock' ? ask.prompt : `Password needed: ${ask.prompt}`, { title: 'secrets' })
}

async function onVaultGet($: EngineInterface, get: VaultGet) {
  const decision = vaultDecision(get, running)
  if (decision !== 'ask') return decideRequest($, get.id, decision)
  const source = sourceOf(get.cmdline || `pid ${get.pid}`, running.map(r => r.command))
  await addRequest($, { id: get.id, kind: 'grant', prompt: `${get.name} · ${get.tag}`, source, since: clockTime() })
  await $.ui.notify(`Vault entry wanted: ${get.name}`, { title: 'secrets' })
}

/** Takes in the vault's entries and remembers every value for masking and the tripwire. */
async function refreshVault($: EngineInterface) {
  const reply = await callRelay($, 'GET', '/vault', null)
  if (reply === null) return
  const shown = JSON.parse(reply.text) as { state: VaultState; entries: VaultEntry[]; values: string[]; forward: boolean; upstream: boolean }
  shown.entries.forEach((entry, i) => remember(shown.values[i]!, maskMinLength, `${entry.name} (${entry.tag})`))
  vault = { state: shown.state, entries: shown.entries, forward: shown.upstream ? shown.forward : null }
}

/** Lists the request; it pops out unless the drawer is open, which turns to it unless a vault form is open there. */
async function addRequest($: EngineInterface, request: Request) {
  requests = [...requests, request]
  if ((await $.sidebar.selected({})) !== SIDEBAR_ID) livePopouts().add(request.id)
  else if (drawerTab === 'vault' && !vaultFormOpen) drawerTab = 'requests'
}

/** The relay's reply, or null after saying why there is none. */
async function callRelay($: EngineInterface, method: 'GET' | 'POST', path: string, body: object | null) {
  if (relaySocket === null) throw new Error('secrets: called the relay before it started')
  try {
    const init = body === null ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    return await $.http.fetch('http://relay' + path, { method, socketPath: relaySocket, ...init })
  } catch (error) {
    // The fetch error's text may carry the request, and with it the secret.
    const code = /\bE[A-Z]{2,}\b/.exec((error as Error).message)?.[0] ?? 'no error code'
    say($, `Not sent: the relay can't be reached (${code}).`, true)
    return null
  }
}

async function answerRequest($: EngineInterface, request: Request, answer: { secret: string } | { cancel: true }) {
  const reply = await callRelay($, 'POST', '/answer', { id: request.id, ...answer })
  if (reply === null) return
  // 410: the asking program went away first.
  if (reply.status !== 204 && reply.status !== 410) {
    say($, `Not answered: the relay answered ${reply.status}.`, true)
    return
  }
  if (reply.status === 204 && 'secret' in answer) {
    remember(answer.secret, maskMinLength, request.prompt)
    if (request.kind === 'secret' && vault.state === 'open') say($, `Kept for masking: ${request.prompt}. Vault ▸ Typed makes it an entry.`, false)
  }
  dropRequest(request.id)
  await syncBadge($)
}

async function onVaultMessage($: EngineInterface, message: VaultMessage) {
  vaultValueFocused = message.valueFocused && message.tab === undefined
  vaultFormOpen = message.formOpen && message.tab === undefined
  if (message.tab === 'requests') drawerTab = 'requests'
  const last = vaultApplied[message.instance] ?? 0
  for (const edit of message.edits) {
    if (edit.seq <= last) continue
    vaultApplied = { ...vaultApplied, [message.instance]: edit.seq }
    if (edit.kind === 'append') formValue += edit.text
    else if (edit.kind === 'back') formValue = [...formValue].slice(0, -1).join('')
    else {
      formValue = ''
      vaultError = null
    }
  }
  const action = message.action
  if (action === undefined) return
  if (action.kind === 'unlock') {
    // The passphrase card waits in the requests.
    drawerTab = 'requests'
    await callRelay($, 'POST', '/unlock', {})
  } else if (action.kind === 'allow') await changeVault($, { op: 'allow', id: action.id, allowed: action.allowed })
  else if (action.kind === 'forward') await changeVault($, { op: 'forward', on: action.on })
  else if (action.kind === 'delete') {
    if (await changeVault($, { op: 'delete', id: action.id })) closeForm()
  } else {
    const { id, name, tag, kind, use } = action.form
    if (name.trim() === '') vaultError = 'Name it.'
    else if (id === null && formValue === '') vaultError = 'A new entry needs a value.'
    else {
      const change =
        id === null
          ? { op: 'add', name, tag, kind, use, value: formValue }
          : { op: 'edit', id, name, kind, use, ...(tag === '' ? {} : { tag }), ...(formValue === '' ? {} : { value: formValue }) }
      if (await changeVault($, change)) closeForm()
    }
  }
}

/** True once the relay saved it; otherwise its reason shows in the form. */
async function changeVault($: EngineInterface, change: object): Promise<boolean> {
  const reply = await callRelay($, 'POST', '/vault', change)
  if (reply === null) return false
  vaultError = reply.status === 200 ? null : reply.text || `The relay answered ${reply.status}.`
  return reply.status === 200
}

function closeForm() {
  formValue = ''
  formEpoch += 1
  vaultError = null
  vaultValueFocused = false
  vaultFormOpen = false
}

async function decideRequest($: EngineInterface, id: string, decision: Decision) {
  const reply = await callRelay($, 'POST', '/decide', { id, decision })
  if (reply === null) return
  if (reply.status !== 204 && reply.status !== 410) {
    say($, `Not decided: the relay answered ${reply.status}.`, true)
    return
  }
  dropRequest(id)
  await syncBadge($)
}

function dropRequest(id: string) {
  requests = requests.filter(r => r.id !== id)
  held.delete(id)
  livePopouts().remove(id)
}

/** The badge shows the waiting requests; with none left, an open list closes, the vault view stays. */
async function syncBadge($: EngineInterface) {
  $.ui.invalidate('ui.render')
  await $.sidebar.badge({ id: SIDEBAR_ID, count: requests.length, level: 'urgent' })
  if (requests.length === 0 && drawerTab === 'requests' && (await $.sidebar.selected({})) === SIDEBAR_ID) await $.sidebar.select({ id: null })
}
