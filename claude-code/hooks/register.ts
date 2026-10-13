import type { EngineInterface, On, Timer } from 'claude-code'
import type { SidebarDrawerSlot, SidebarPopoutSlot, SidebarRowComponent } from 'sidebar'

import { appliedText, SUGGESTED, withText } from './auto-mode'
import type { ConfigAction, ConfigMessage, ConfigProps } from './config-view-props'
import { holdsMask, stringsIn, withStrings } from './mask'
import { Popouts } from './popouts'
import { listHeight } from './requests'
import type { Offered, RequestEntry, RequestsMessage, RequestsProps } from './requests-props'
import { fillSlot, hasSlot } from './slot'
import { askDecision, listDecision, requestSource, signDecision } from './source'
import { type Tab, TAB_ROWS, type Tabs } from './tabs'
import type { SecretField, Suggestion, VaultAction, VaultMessage, VaultProps, ViewEntry } from './vault-view-props'

const SIDEBAR_ID = 'pass'
const DRAWER_SLOT: SidebarDrawerSlot = `sidebar-drawer:${SIDEBAR_ID}`
const POPOUT_SLOT: SidebarPopoutSlot = `sidebar-popout:${SIDEBAR_ID}`
const LIST_KEY = 'requests'
const POPOUT_KEY = 'popout'
const VAULT_KEY = 'vault'
const CONFIG_KEY = 'config'
/** Rows the vault and config views leave at the room's bottom, which may be off screen or under the engine's pill. */
const VAULT_SPARE_ROWS = 3
const DRAWER_COLUMNS = 64
const POPOUT_MS = 15000
const NOTICE_MS = 10000
const RELAY_START_MS = 5000
const DEFAULT_MASK_MIN = 6
const UNSEEN_PASTE = 'A paste of 3+ lines or 800+ characters went into the prompt, not the request.'
const UNTARGETED_PASTE = 'The paste went into the prompt: no request was selected. Click a request first.'
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

type Granted = { id: string; name: string; tag: string; kind: string; use: 'session' | 'each'; allowed: boolean }
type Asked = { id: string; prompt: string; tag: string | null; entry: Granted | null; pid: number; cmdline: string; inside: boolean }
type Sign = Omit<Granted, 'id'> & { id: string; pid: number; cmdline: string; inside: boolean }
type VaultList = { id: string; pid: number; cmdline: string; inside: boolean }
type VaultState = 'absent' | 'locked' | 'open'
type VaultEntry = ViewEntry & { created: number }
type Decision = 'give' | 'session' | 'refuse'

type RelayEvent =
  | { ready: string; vault: VaultState; bin: string }
  | { ask: Asked }
  | { gone: string }
  | { sign: Sign }
  | { list: VaultList }
  | { vault: VaultState }
  | { masked: true }
  | { trouble: string }

/** A vault entry a card may be answered with, and its tag, which a request may name. */
type Pickable = Offered & { tag: string }

/**
 * A waiting request. What its card offers is worked out each time the list is drawn: `pick` says whether its asker
 * may have vault entries (`vault`: the open vault's, as they are then) and `tag` which one it named.
 */
type Request = Omit<RequestEntry, 'length' | 'offer' | 'chosen'> & { pick: 'vault' | Pickable[] | null; tag: string | null }

/** Replaced, never changed in place: render props freeze what they're handed. */
let requests: readonly Request[] = []
/** Each request's menu choice, an entry's id or null for typing; unset, its field holds the entry its tag names. */
const choices = new Map<string, string | null>()
/** Bash calls in flight, for a request's source command and the loop that made it. */
const running: { id: string; command: string; agentId: string | undefined }[] = []
/** What the relay last said of the vault; entries and suggestions carry no values. */
let vault: { state: VaultState; entries: readonly VaultEntry[]; suggestions: readonly Suggestion[]; forward: boolean | null } = {
  state: 'absent',
  entries: [],
  suggestions: [],
  forward: null,
}
let drawerTab: Tab = 'requests'
/** The Vault tab's held fields, typed or pasted: an entry's value, the passphrase and its repeat; the view only learns their lengths. */
let fields: Record<SecretField, string> = { value: '', passphrase: '', again: '' }
/** The last field edit applied per vault view instance; replaced, never changed in place. */
let vaultApplied: Record<string, number> = {}
/** Bumped when a save or delete went through, which closes the form. */
let formEpoch = 0
let vaultError: string | null = null
let vaultFocused: SecretField | null = null
let vaultFormOpen = false
let relaySocket: string | null = null
/** Masking replaced something this session, so `[secret]` in content may be a masked read; kept across reloads in `$.state`. */
let hasMasked = false
/** The Config tab's options, in the plugin's store: changing them doesn't reload the module and its relay. */
let maskMinLength = DEFAULT_MASK_MIN
let unlockAtStart = true
let forwardAtStart = true
/** The user's settings file, where the auto-mode line lives. */
let settingsPath: string | null = null
/** The auto-mode text being edited, typed or pasted; the line in the settings now, null when there is none. */
let configDraft = ''
let configApplied: string | null = null
/** The last text edit applied per config view instance; replaced, never changed in place. */
let configConfirmed: Record<string, number> = {}
let configError: string | null = null
let configTextFocused = false
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

/** An option from the plugin's store, its default when never set; a stored value of the wrong type is an error. */
async function option<T extends number | boolean>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const stored = await $.store.get(key)
  if (stored === undefined) return fallback
  if (typeof stored !== typeof fallback) throw new Error(`secrets: the stored ${key} is not a ${typeof fallback}`)
  return stored as T
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.sidebar.register({ id: SIDEBAR_ID, icon: '🔐', short: 'pass', drawerColumns: DRAWER_COLUMNS })
    popouts = new Popouts(POPOUT_MS, (ms, fn) => $.clock.after(ms, fn), () => syncPopout($))
    await $.command.register({ name: 'pass-demo', description: 'Show one sample request of each kind; no program waits on them' })
    // A reload starts with no requests and a new relay; the host still shows what the old module set.
    await $.sidebar.badge({ id: SIDEBAR_ID, count: 0, level: 'urgent' })
    await $.sidebar.popout({ id: SIDEBAR_ID, isShown: false })
    maskMinLength = await option($, 'maskMinLength', DEFAULT_MASK_MIN)
    unlockAtStart = await option($, 'unlockAtStart', true)
    forwardAtStart = await option($, 'forwardAtStart', true)
    hasMasked = (await $.state.get({ plugin: 'secrets', key: 'hasMasked' })).value ?? false

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
    const relay = await startRelay($, socket, upstream)
    vault = { state: relay.state, entries: [], suggestions: [], forward: upstream === '' ? null : false }
    await sendSettings($)
    if (upstream !== '' && forwardAtStart) {
      const refused = await relayChange($, { op: 'forward', on: true })
      if (refused !== null) throw new Error(`secrets: the relay didn't forward to your ssh-agent: ${refused}`)
      vault = { ...vault, forward: true }
    }
    await $.env.set('SSH_AUTH_SOCK', socket + '.agent')
    // The relay's own resolved directory, not the plugin's: a rebuild moves the plugin's path to new binaries,
    // while this session's relay serves only the mask-run beside it.
    const bin = relay.bin
    const askpass = bin + '/secrets-askpass'
    await $.env.set('SECRETS_RELAY', socket)
    await $.env.set('SUDO_ASKPASS', askpass)
    await $.env.set('SSH_ASKPASS', askpass)
    await $.env.set('SSH_ASKPASS_REQUIRE', 'force')
    await $.env.set('GIT_ASKPASS', askpass)
    const path = (await $.env.get('PATH')) ?? ''
    // On a reload the plugin's bin leads PATH already.
    if (!path.startsWith(bin + ':')) await $.env.set('PATH', `${bin}:${path}`)
    const maskRun = bin + '/secrets-mask-run'
    const prefix = await $.env.get('CLAUDE_CODE_SHELL_PREFIX')
    // On a reload the prefix is a mask-run of ours, maybe from an older build; the one found first is the user's.
    if (prefix && !prefix.endsWith('/secrets-mask-run')) await $.env.set('SECRETS_ORIG_PREFIX', prefix)
    await $.env.set('CLAUDE_CODE_SHELL_PREFIX', maskRun)
    if (unlockAtStart && vault.state === 'locked') {
      drawerTab = 'vault'
      await $.sidebar.select({ id: SIDEBAR_ID })
    }
    const home = await $.env.get('HOME')
    if (!home) throw new Error('secrets: HOME is not set, so the settings file for the auto-mode line is unknown')
    settingsPath = `${home}/.claude/settings.json`
    await readAutoMode($)
    configDraft = configApplied ?? SUGGESTED
    return started
  })

  on('tool.call', async ($, e, next) => {
    const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = e
    if (vault.state === 'open') {
      const { label } = (await relayJson($, '/check', { texts: stringsIn(input) })) as { label: string | null }
      if (label !== null) {
        say($, `Stopped a ${e.tool} call carrying ${label}. If the agent got it outside the vault, rotate it.`, true)
        return { deny: `secrets: this call carries the value of ${label}, so it did not run. Use secrets through \`secrets ask\`; never write a value.` }
      }
    }
    const written =
      e.tool === 'Write' ? e.content : e.tool === 'Edit' ? e.new_string : e.tool === 'NotebookEdit' ? e.new_source : e.tool === 'Bash' ? e.command : null
    if (written !== null && hasMasked && holdsMask(written)) return { deny: WRITE_BACK }
    if (e.tool !== 'Bash') return maskResult($, await next(e))
    running.push({ id: e.tool_use_id, command: e.command, agentId: e.agentId })
    try {
      return maskResult($, await next(e))
    } finally {
      running.splice(running.findIndex(r => r.id === e.tool_use_id), 1)
    }
  }).catch(() => ({ deny: 'secrets: masking this tool call failed, so its result is withheld' }))

  on('ui.message', async ($, e, next) => {
    if (e.element === VAULT_KEY || e.element === CONFIG_KEY) {
      if (!listFocused) draftAtFocus = (await $.prompt.read()).text
      listFocused = true
      // The keyboard is on another tab now: a paste is no request's.
      listSelected = null
      if (e.element === VAULT_KEY) await onVaultMessage($, e.data as VaultMessage)
      else await onConfigMessage($, e.data as ConfigMessage)
      $.ui.invalidate('ui.render')
      return next(e)
    }
    if (e.element !== LIST_KEY && e.element !== POPOUT_KEY) return next(e)
    const message = e.data as RequestsMessage
    unsay($, false)
    if (!listFocused) draftAtFocus = (await $.prompt.read()).text
    listFocused = true
    vaultFocused = null
    configTextFocused = false
    listSelected = message.selected
    livePopouts().focus(message.selected)
    for (const edit of message.edits) {
      // Read for each edit: an await below may let another post of this list apply later edits first.
      if (edit.seq <= (applied[message.instance] ?? 0)) continue
      applied = { ...applied, [message.instance]: edit.seq }
      if (edit.kind === 'dismiss') {
        unsay($, true)
        continue
      }
      if (edit.kind === 'tab') {
        await turnTo($, edit.tab)
        continue
      }
      if (edit.kind === 'choose') {
        choices.set(edit.id, edit.entry)
        continue
      }
      const request = requests.find(r => r.id === edit.id)
      if (request === undefined) continue
      if (request.kind === 'sign') {
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
      else if ((edit.kind === 'session' || edit.kind === 'once') && edit.entry !== null) {
        await answerRequest($, request, { entry: edit.entry, session: edit.kind === 'session' })
      }
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
    if (listFocused && (vaultFocused !== null || configTextFocused) && e.inputText !== '') {
      const pasted = e.inputText.replace(/\r?\n$/, '')
      if (vaultFocused !== null) fields = { ...fields, [vaultFocused]: fields[vaultFocused] + pasted }
      else configDraft += pasted.replace(/\r?\n/g, ' ')
      $.ui.invalidate('ui.render')
      return { text: e.text, cursor: e.cursor }
    }
    const target = requests.find(r => r.id === listSelected)
    if (!listFocused || target === undefined || e.inputText === '') {
      const box = await next(e)
      if (listFocused && e.inputText !== '') say($, UNTARGETED_PASTE, false)
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
    const names = [
      ['Prod DB', 'db'],
      ['Deploy API', 'deploy-api'],
      ['Staging DB', 'db-staging'],
      ['GitHub token', 'gh'],
      ['SMTP', 'smtp'],
      ['S3 backup', 's3'],
      ['Grafana', 'grafana'],
      ['Sentry', 'sentry'],
    ] as const
    const offer: Pickable[] = names.map(([name, tag], i) => ({ id: `demo-${i}`, label: `${name} · ${tag}`, tag }))
    const samples: Omit<Request, 'id' | 'since'>[] = [
      { kind: 'secret', prompt: '[sudo] password for alex', source: 'sudo -A systemctl restart nginx', pick: null, tag: null },
      {
        kind: 'secret',
        prompt: 'Prod DB password',
        source: 'psql "postgres://app:$(secrets ask --tag db "Prod DB password")@db.internal/app"',
        pick: offer,
        tag: 'db',
      },
      {
        kind: 'secret',
        prompt: 'deploy token',
        source: 'TOKEN=$(secrets ask "deploy token") && curl -fsS -H "Authorization: Bearer $TOKEN" https://deploy.example.org/api/v1/releases --data @release.json',
        pick: offer,
        tag: null,
      },
      { kind: 'sign', prompt: 'Deploy key · deploy', source: 'git add -A\ngit commit -m "Release"\ngit push origin main', pick: null, tag: null },
    ]
    for (const sample of samples) await addRequest($, { ...sample, id: 'demo-' + randomId(), since: clockTime() })
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
      const entries: RequestEntry[] = shown.map(({ pick, tag, ...r }) => {
        const offer = pick === 'vault' ? (vault.state === 'open' ? vaultOffer() : null) : pick
        const named = offer?.find(o => o.tag === tag)?.id ?? null
        const chosen = choices.has(r.id) ? choices.get(r.id)! : named
        return { ...r, length: [...(held.get(r.id) ?? '')].length, offer: offer?.map(({ id, label }) => ({ id, label })) ?? null, chosen }
      })
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
        suggestions: [...vault.suggestions],
        tabs,
        columns,
        rows: height,
        applied: vaultApplied,
        lengths: { value: [...fields.value].length, passphrase: [...fields.passphrase].length, again: [...fields.again].length },
        formEpoch,
        error: vaultError,
      }
      return Client({ key: VAULT_KEY, module: './vault-view.ts', props, width: columns, height })
    }
    const configView = (columns: number, rows: number, tabs: Tabs) => {
      const height = rows - VAULT_SPARE_ROWS
      const props: ConfigProps = {
        tabs,
        columns,
        rows: height,
        draft: configDraft,
        applied: configApplied,
        confirmed: configConfirmed,
        unlockAtStart,
        maskMinLength,
        forward: vault.forward,
        forwardAtStart,
        error: configError,
      }
      return Client({ key: CONFIG_KEY, module: './config-view.ts', props, width: columns, height })
    }
    let filled = tree
    if (inDrawer) {
      const columns = DRAWER_COLUMNS - room.drawerFrameColumns
      const tabs: Tabs = { active: drawerTab, requests: requests.length, vaultMark: vault.suggestions.length > 0 }
      const drawn = () =>
        drawerTab === 'vault'
          ? vaultView(columns, room.drawer, tabs)
          : drawerTab === 'config'
            ? configView(columns, room.drawer, tabs)
            : list(LIST_KEY, requests, columns, room.drawer, tabs)
      filled = fillSlot(filled, DRAWER_SLOT, drawn) as typeof tree
    }
    if (inPopout) {
      const ids = new Set(livePopouts().shown())
      filled = fillSlot(filled, POPOUT_SLOT, () => list(POPOUT_KEY, requests.filter(r => ids.has(r.id)), DRAWER_COLUMNS, room.popout, null)) as typeof tree
    }
    return filled
  })
}

/**
 * Starts the relay; resolves once it listens with the vault's state and the relay's resolved helper directory. A
 * later failure shows in the list.
 */
function startRelay($: EngineInterface, socket: string, upstream: string): Promise<{ state: VaultState; bin: string }> {
  return new Promise((resolve, reject) => {
    let isReady = false
    const timer = $.clock.after(RELAY_START_MS, () => reject(new Error(`secrets: the relay didn't start within ${RELAY_START_MS} ms`)))
    readRelay($, socket, upstream, started => {
      isReady = true
      timer.cancel()
      resolve(started)
    }).catch((error: Error) => {
      timer.cancel()
      if (isReady) say($, `Requests stopped: ${error.message}`, true)
      else reject(error)
    })
  })
}

async function readRelay($: EngineInterface, socket: string, upstream: string, ready: (started: { state: VaultState; bin: string }) => void) {
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
      if ('ready' in event) ready({ state: event.vault, bin: event.bin })
      else if ('ask' in event) await onAsk($, event.ask)
      else if ('gone' in event) dropRequest(event.gone)
      else if ('sign' in event) await onSign($, event.sign)
      else if ('list' in event) await decideRequest($, event.list.id, listDecision(event.list, running))
      else if ('vault' in event) await refreshVault($)
      else if ('masked' in event) {
        hasMasked = true
        await $.state.set({ plugin: 'secrets', key: 'hasMasked' }, true)
      } else say($, event.trouble, true)
      await syncBadge($)
    }
  }
  throw new Error('the relay exited')
}

/** The open vault's entries a request may be answered with; ssh keys answer signatures, not asks. */
function vaultOffer(): Pickable[] {
  return vault.entries.filter(e => e.kind !== 'ssh-key').map(e => ({ id: e.id, label: `${e.name} · ${e.tag}`, tag: e.tag }))
}

async function onAsk($: EngineInterface, ask: Asked) {
  const decision = askDecision(ask, running)
  const request: Request = {
    id: ask.id,
    kind: 'secret',
    prompt: ask.prompt,
    source: requestSource(ask, running.map(r => r.command)),
    since: clockTime(),
    pick: decision === 'typed card' ? null : 'vault',
    tag: ask.tag,
  }
  // A give that fails leaves the program waiting: it gets the card instead.
  if (decision === 'give' && ask.entry !== null && (await answerRequest($, request, { entry: ask.entry.id, session: false }))) return
  await addRequest($, request)
  await $.ui.notify(`Password needed: ${ask.prompt}`, { title: 'secrets' })
}

async function onSign($: EngineInterface, sign: Sign) {
  const decision = signDecision(sign, running)
  // A decision that fails leaves the program waiting: it gets the card instead.
  if (decision !== 'ask' && (await decideRequest($, sign.id, decision))) return
  const source = requestSource(sign, running.map(r => r.command))
  await addRequest($, { id: sign.id, kind: 'sign', prompt: `${sign.name} · ${sign.tag}`, source, since: clockTime(), pick: null, tag: null })
  await $.ui.notify(`Vault key wanted: ${sign.name}`, { title: 'secrets' })
}

/** Takes in what the vault shows: entries and suggestions, never a value. */
async function refreshVault($: EngineInterface) {
  const shown = (await relayJson($, '/vault', null)) as {
    state: VaultState
    entries: VaultEntry[]
    suggestions: Suggestion[]
    forward: boolean
    upstream: boolean
  }
  vault = { state: shown.state, entries: shown.entries, suggestions: shown.suggestions, forward: shown.upstream ? shown.forward : null }
}

/** Lists the request; it pops out unless the drawer is open, which turns to it unless the user is typing into another tab. */
async function addRequest($: EngineInterface, request: Request) {
  requests = [...requests, request]
  if ((await $.sidebar.selected({})) !== SIDEBAR_ID) livePopouts().add(request.id)
  else if ((drawerTab === 'vault' && !vaultFormOpen && !(listFocused && vaultFocused !== null)) || (drawerTab === 'config' && !(listFocused && configTextFocused))) {
    drawerTab = 'requests'
  }
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

/** A JSON reply the hooks can't go on without: GET with no body, else POST; throws naming the path when there is none. */
async function relayJson($: EngineInterface, path: string, body: object | null): Promise<unknown> {
  const reply = await callRelay($, body === null ? 'GET' : 'POST', path, body)
  if (reply === null || reply.status !== 200) throw new Error(`secrets: the relay's ${path} answered ${reply?.status ?? 'nothing'}`)
  return JSON.parse(reply.text)
}

/** The tool's result with the open vault's values masked; as it is while the vault is closed. */
async function maskResult<T>($: EngineInterface, result: T): Promise<T> {
  if (vault.state !== 'open') return result
  const texts = stringsIn(result)
  if (texts.length === 0) return result
  const masked = (await relayJson($, '/mask', { texts })) as { texts: string[] }
  return withStrings(result, masked.texts)
}

async function sendSettings($: EngineInterface) {
  const reply = await callRelay($, 'POST', '/settings', { maskMinLength })
  if (reply !== null && reply.status !== 204) throw new Error(`secrets: the relay refused the mask minimum ${maskMinLength} (${reply.status})`)
}

type Answer = { secret: string } | { cancel: true } | { entry: string; session: boolean }

/** True once the relay took the answer, or the asking program had gone; otherwise the reason shows. */
async function answerRequest($: EngineInterface, request: Request, answer: Answer): Promise<boolean> {
  const reply = await callRelay($, 'POST', '/answer', { id: request.id, ...answer })
  if (reply === null) return false
  // 410: the asking program went away first.
  if (reply.status !== 204 && reply.status !== 410) {
    say($, `Not answered: ${reply.status === 409 ? reply.text : `the relay answered ${reply.status}`}.`, true)
    return false
  }
  dropRequest(request.id)
  await syncBadge($)
  return true
}

/** The drawer turns to `tab`; the Config tab shows the settings as they are now. */
async function turnTo($: EngineInterface, tab: Tab) {
  drawerTab = tab
  if (tab !== 'requests') listSelected = null
  if (tab === 'config') await readAutoMode($)
}

async function onVaultMessage($: EngineInterface, message: VaultMessage) {
  vaultFocused = message.focused
  vaultFormOpen = message.formOpen
  configTextFocused = false
  for (const edit of message.edits) {
    if (edit.seq <= (vaultApplied[message.instance] ?? 0)) continue
    vaultApplied = { ...vaultApplied, [message.instance]: edit.seq }
    if (edit.kind === 'tab') {
      vaultFocused = null
      vaultFormOpen = false
      await turnTo($, edit.tab)
    } else if (edit.kind === 'action') await onVaultAction($, edit.action)
    else {
      const text = fields[edit.field]
      const next = edit.kind === 'append' ? text + edit.text : edit.kind === 'back' ? [...text].slice(0, -1).join('') : ''
      fields = { ...fields, [edit.field]: next }
      if (edit.kind === 'clear') vaultError = null
    }
  }
}

async function onVaultAction($: EngineInterface, action: VaultAction) {
  if (action.kind === 'open') await openVault($)
  else if (action.kind === 'allow') await changeVault($, { op: 'allow', id: action.id, allowed: action.allowed })
  else if (action.kind === 'delete') {
    if (await changeVault($, { op: 'delete', id: action.id })) closeForm()
  } else if (action.kind === 'dismiss') {
    if (await changeVault($, { op: 'dismiss', id: action.id })) closeForm()
  } else {
    const { id, suggestion, name, tag, kind, use } = action.form
    if (name.trim() === '') vaultError = 'Name it.'
    else if (suggestion !== null) {
      if (await changeVault($, { op: 'save', id: suggestion, name, tag, kind, use })) closeForm()
    } else if (id === null && fields.value === '') vaultError = 'A new entry needs a value.'
    else {
      const value = fields.value
      const change =
        id === null
          ? { op: 'add', name, tag, kind, use, value }
          : { op: 'edit', id, name, kind, use, ...(tag === '' ? {} : { tag }), ...(value === '' ? {} : { value }) }
      if (await changeVault($, change)) closeForm()
    }
  }
}

/** Unlocks the vault with the typed passphrase, or creates it when there is none; the passphrase fields empty either way. */
async function openVault($: EngineInterface) {
  const create = vault.state === 'absent'
  if (fields.passphrase === '') {
    vaultError = 'Type the passphrase.'
    return
  }
  if (create && fields.passphrase !== fields.again) {
    vaultError = 'The two differ.'
    fields = { ...fields, again: '' }
    return
  }
  const reply = await callRelay($, 'POST', create ? '/create' : '/unlock', { passphrase: fields.passphrase })
  fields = { ...fields, passphrase: '', again: '' }
  if (reply === null) return
  vaultError = reply.status === 204 ? null : reply.status === 403 ? 'Wrong passphrase.' : reply.text || `The relay answered ${reply.status}.`
}

/** True once the relay saved it; otherwise its reason shows in the form. */
async function changeVault($: EngineInterface, change: object): Promise<boolean> {
  vaultError = await relayChange($, change)
  return vaultError === null
}

/** Null once the relay took the change, else why not; an unreachable relay says so itself. */
async function relayChange($: EngineInterface, change: object): Promise<string | null> {
  const reply = await callRelay($, 'POST', '/vault', change)
  if (reply === null) return 'Not sent.'
  return reply.status === 200 ? null : reply.text || `The relay answered ${reply.status}.`
}

async function onConfigMessage($: EngineInterface, message: ConfigMessage) {
  configTextFocused = message.textFocused
  vaultFocused = null
  for (const edit of message.edits) {
    if (edit.seq <= (configConfirmed[message.instance] ?? 0)) continue
    configConfirmed = { ...configConfirmed, [message.instance]: edit.seq }
    if (edit.kind === 'append') configDraft += edit.text
    else if (edit.kind === 'back') configDraft = [...configDraft].slice(0, -1).join('')
    else if (edit.kind === 'clear') configDraft = ''
    else if (edit.kind === 'tab') {
      configTextFocused = false
      await turnTo($, edit.tab)
    } else if (edit.kind === 'action') await onConfigAction($, edit.action)
  }
}

async function onConfigAction($: EngineInterface, action: ConfigAction) {
  configError = null
  if (action.kind === 'apply') await applyAutoMode($)
  else if (action.kind === 'suggest') configDraft = SUGGESTED
  else if (action.kind === 'forward') configError = await relayChange($, { op: 'forward', on: action.on })
  else if (action.kind === 'unlockAtStart') {
    await $.store.set('unlockAtStart', action.on)
    unlockAtStart = action.on
  } else if (action.kind === 'forwardAtStart') {
    await $.store.set('forwardAtStart', action.on)
    forwardAtStart = action.on
  } else {
    await $.store.set('maskMinLength', action.value)
    maskMinLength = action.value
    await sendSettings($)
  }
}

function liveSettingsPath(): string {
  if (settingsPath === null) throw new Error('secrets: the settings file is used before session start')
  return settingsPath
}

/** Takes in the line the settings hold now; a file that can't be read shows its reason. */
async function readAutoMode($: EngineInterface) {
  const path = liveSettingsPath()
  try {
    configApplied = (await $.fs.exists(path)) ? appliedText(await $.fs.read(path)) : null
  } catch (error) {
    configError = (error as Error).message
  }
}

/** Writes the draft as the line into the user's settings, the rest of the file kept. */
async function applyAutoMode($: EngineInterface) {
  const path = liveSettingsPath()
  try {
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : '{}'
    await $.fs.write(path, withText(before, configDraft))
  } catch (error) {
    configError = `Not applied: ${(error as Error).message}`
    return
  }
  await readAutoMode($)
}

function closeForm() {
  fields = { ...fields, value: '' }
  formEpoch += 1
  vaultError = null
  vaultFocused = null
  vaultFormOpen = false
}

/** True once the relay took the decision, or the asking program had gone; otherwise the reason shows. */
async function decideRequest($: EngineInterface, id: string, decision: Decision): Promise<boolean> {
  const reply = await callRelay($, 'POST', '/decide', { id, decision })
  if (reply === null) return false
  if (reply.status !== 204 && reply.status !== 410) {
    say($, `Not decided: the relay answered ${reply.status}.`, true)
    return false
  }
  dropRequest(id)
  await syncBadge($)
  return true
}

function dropRequest(id: string) {
  requests = requests.filter(r => r.id !== id)
  held.delete(id)
  choices.delete(id)
  if (listSelected === id) listSelected = null
  livePopouts().remove(id)
}

/** The badge shows the waiting requests; with none left, an open list closes, the vault view stays. */
async function syncBadge($: EngineInterface) {
  $.ui.invalidate('ui.render')
  await $.sidebar.badge({ id: SIDEBAR_ID, count: requests.length, level: 'urgent' })
  if (requests.length === 0 && drawerTab === 'requests' && (await $.sidebar.selected({})) === SIDEBAR_ID) await $.sidebar.select({ id: null })
}
