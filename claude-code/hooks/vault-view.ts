import type { ClientKeyEvent, ClientModule } from 'claude-code'

import {
  buttonRows,
  type ButtonSpec,
  checkbox,
  drawLine,
  dropdown,
  field,
  fieldRoom,
  fit,
  FOCUSED,
  heading,
  hitAt,
  type Line,
  listHeight,
  listRows as optionRows,
  type Look,
  moveFocus,
  type Option,
  radios,
  seg,
  showButton,
  textLine,
} from './controls'
import { cells, clip, displayed, pad } from './display'
import { drawTabs, type Tab, TAB_ROWS, tabAt } from './tabs'
import type { Access, Collision, EntryKind, Form, SecretField, TagChoice, ValueEdit, VaultAction, VaultMessage, VaultProps } from './vault-view-props'

/** A Lock or a Delete waiting for the person to confirm it. */
type Confirming = { kind: 'lock' } | { kind: 'delete'; id: string; name: string }

export type ViewState = {
  instance: string
  seq: number
  /** Value edits sent but not yet confirmed by the hooks. */
  pending: ValueEdit[]
  form: Form | null
  /** The open vault's new passphrase is being typed: keys go to it as to a closed vault's. */
  rekeying: boolean
  confirming: Confirming | null
  /** The control with the keyboard; on a list row it stays on its entry when another session's change moves the rows. */
  focus: string
  /** The dropdown whose list is open, and the option highlighted in it. */
  open: string | null
  cursor: number
  /** The vault is closed: keys go to its passphrase. */
  isClosed: boolean
  /** The form's tag as typed, kept while the tag field shows one of the offered tags. */
  ownTag: string
  formEpoch: number
}

export type Page = 'collision' | 'closed' | 'confirm' | 'rekey' | 'form' | 'list'

/** What the view draws under its tabs, and its controls in reading order, a group per line of them. */
export type Drawn = { lines: Line[]; groups: string[][] }

type Result = { state: ViewState; post?: VaultMessage }

const LABEL_COLUMNS = 9
const DOOR_LABEL_COLUMNS = 13
const TAG_COLUMNS = 8
const KIND_COLUMNS = 8
const ACCESS_WIDTH = 13
const DOOR_LABELS: Record<'passphrase' | 'again', string> = { passphrase: 'Passphrase', again: 'Again' }
const KIND_NAMES: Record<EntryKind, string> = { password: 'Password', token: 'Token', 'ssh-key': 'SSH key' }
const KINDS: readonly EntryKind[] = ['password', 'token', 'ssh-key']
const ACCESSES: readonly Access[] = ['ask', 'allowed', 'refused']
const ACCESS_OPTIONS: readonly Option[] = [
  { label: 'Ask', what: 'a card each time it is asked for' },
  { label: 'Allowed', what: 'given with no card' },
  { label: 'Refused', what: 'never given' },
]
const OWN_TAG: Option = { label: 'Your own tag…', what: 'type it in the field' }
const NO_TAG = 'none: one is made up'
const FORWARD_LABEL = "Use my own ssh-agent's keys in this session (no card)"
const NEW_FORM: Form = { id: null, suggestion: null, name: '', tag: '', kind: 'password' }
const SPECIAL_KEYS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab', 'backspace', 'delete'])

export function initialState(formEpoch: number, instance: string, isClosed = false): ViewState {
  return {
    instance,
    seq: 0,
    pending: [],
    form: null,
    rekeying: false,
    confirming: null,
    focus: isClosed ? 'passphrase' : 'add',
    open: null,
    cursor: 0,
    isClosed,
    ownTag: '',
    formEpoch,
  }
}

export function pageOf(props: Pick<VaultProps, 'collisions' | 'state'>, state: Pick<ViewState, 'confirming' | 'rekeying' | 'form'>): Page {
  if (props.collisions.length > 0) return 'collision'
  if (props.state !== 'open') return 'closed'
  if (state.confirming !== null) return 'confirm'
  if (state.rekeying) return 'rekey'
  return state.form !== null ? 'form' : 'list'
}

export function accessLabel(access: Access): string {
  return ACCESS_OPTIONS[ACCESSES.indexOf(access)]!.label
}

/** The tags the form's tag field offers: none for an ssh key, which no ask names; not those other entries hold. */
export function tagOptions(props: Pick<VaultProps, 'tagChoices' | 'entries'>, form: Form): TagChoice[] {
  if (form.kind === 'ssh-key') return []
  return props.tagChoices.filter(c => !props.entries.some(e => e.tag === c.tag && e.id !== form.id))
}

/** The tag field's list: the offered tags, then the person's own. */
function tagList(options: readonly TagChoice[]): Option[] {
  return [...options.map(o => ({ label: o.tag, what: o.what })), OWN_TAG]
}

export function shownLength(length: number, field: SecretField, pending: ValueEdit[]): number {
  for (const edit of pending) {
    if (!('field' in edit) || edit.field !== field) continue
    if (edit.kind === 'append') length += [...edit.text].length
    else if (edit.kind === 'back') length = Math.max(0, length - 1)
    else if (edit.kind === 'clear') length = 0
  }
  return length
}

/** A peeked field's text as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownText(text: string, field: SecretField, pending: ValueEdit[]): string {
  for (const edit of pending) {
    if (!('field' in edit) || edit.field !== field) continue
    if (edit.kind === 'append') text += edit.text
    else if (edit.kind === 'back') text = [...text].slice(0, -1).join('')
    else if (edit.kind === 'clear') text = ''
  }
  return text
}

/** A held field: dots, or its text while peeked, with its Show button; the end of a long value stays in view. */
function heldField(props: VaultProps, state: ViewState, name: SecretField, width: number, empty: string): Line {
  const focused = state.focus === name
  const length = shownLength(props.lengths[name], name, state.pending)
  const peeked = props.peeked[name]
  const show = showButton(peeked !== undefined, 'show:' + name)
  const tail = state.focus === 'show:' + name ? { ...show, look: { ...show.look, ...FOCUSED, inverse: true } } : show
  const room = fieldRoom(width, tail) - (focused ? 1 : 0)
  const text = peeked === undefined ? '•'.repeat(length) : displayed(shownText(peeked, name, state.pending))
  const fitted = cells(text) <= room ? text : '…' + [...text].slice(-(room - 1)).join('')
  return field((length > 0 ? fitted : empty) + (focused ? '▏' : ''), width, name, focused, { dim: length === 0, tail })
}

function labelled(label: string, columns: number, control: Line, focused: boolean): Line {
  return [seg(pad(' ' + label, columns), focused ? FOCUSED : { dimColor: true }), ...control]
}

function errorLines(error: string | null): Line[] {
  return error === null ? [] : [textLine(' ' + displayed(error), { color: 'error' })]
}

function collisionPage(collisions: readonly Collision[]): Drawn {
  const lines: Line[] = []
  for (const c of collisions) {
    lines.push(textLine(` ⚠ ${displayed(c.name)} hooks ${c.carriers.join(', ')}`, { color: 'error' }))
    lines.push(textLine(c.refused ? '   Refused from the next start; off until then.' : '   It could read secrets sent there: vault and typing off.', { dimColor: true }))
    if (!c.refused) {
      const buttons: ButtonSpec[] = [
        { hit: 'allow:' + c.name, label: 'Allow' },
        { hit: 'refuse:' + c.name, label: 'Refuse', tone: 'danger' },
      ]
      lines.push(...buttonRows(buttons, null, 3))
    }
    lines.push([])
  }
  return { lines, groups: [] }
}

/** The passphrase fields (twice for a new vault or a new passphrase) and their buttons. */
function doorPage(props: VaultProps, state: ViewState, title: string, doors: readonly ('passphrase' | 'again')[], buttons: ButtonSpec[]): Drawn {
  const width = props.columns - DOOR_LABEL_COLUMNS - 1
  const lines: Line[] = [heading(title)]
  for (const door of doors) {
    const focused = state.focus === door || state.focus === 'show:' + door
    lines.push(labelled(DOOR_LABELS[door], DOOR_LABEL_COLUMNS, heldField(props, state, door, width, ''), focused))
  }
  lines.push([], ...buttonRows(buttons, state.focus), ...errorLines(props.error))
  return { lines, groups: [...doors.map(door => [door, 'show:' + door]), buttons.map(b => b.hit)] }
}

function closedPage(props: VaultProps, state: ViewState): Drawn {
  const isNew = props.state === 'absent'
  return doorPage(props, state, isNew ? 'No vault yet' : 'Vault locked', isNew ? ['passphrase', 'again'] : ['passphrase'], [
    { hit: 'open', label: isNew ? 'Create' : 'Unlock' },
  ])
}

function rekeyPage(props: VaultProps, state: ViewState): Drawn {
  return doorPage(props, state, 'New passphrase', ['passphrase', 'again'], [
    { hit: 'change', label: 'Change' },
    { hit: 'cancel', label: 'Cancel' },
  ])
}

function confirmPage(state: ViewState, confirming: Confirming): Drawn {
  const [question, note, verb] =
    confirming.kind === 'lock'
      ? ['Lock the vault for every session?', 'Every session loses its entries until the vault is unlocked again.', 'Lock']
      : [`Delete ${displayed(confirming.name)}?`, "It goes from the vault for every session; this can't be undone.", 'Delete']
  const buttons: ButtonSpec[] = [
    { hit: 'confirm', label: verb, tone: 'danger' },
    { hit: 'cancel', label: 'Cancel' },
  ]
  return { lines: [heading(question), textLine('   ' + note, { dimColor: true }), [], ...buttonRows(buttons, state.focus)], groups: [buttons.map(b => b.hit)] }
}

function formPage(props: VaultProps, state: ViewState, form: Form): Drawn {
  const width = props.columns - LABEL_COLUMNS - 1
  const at = (hit: string) => state.focus === hit
  const title = form.suggestion !== null ? 'Keep a typed value' : form.id === null ? 'New entry' : 'Entry'
  const lines: Line[] = [heading(title)]
  lines.push(labelled('Name', LABEL_COLUMNS, field(displayed(form.name) + (at('name') ? '▏' : ''), width, 'name', at('name')), at('name')))

  const options = tagOptions(props, form)
  const choice = options.find(o => o.tag === form.tag)
  const cursor = at('tag') && choice === undefined ? '▏' : ''
  const tagText = choice !== undefined ? `${choice.tag} · ${choice.what}` : form.tag !== '' ? displayed(form.tag) + cursor : cursor + NO_TAG
  const isBare = choice === undefined && form.tag === ''
  const tag = options.length === 0 ? field(tagText, width, 'tag', at('tag'), { dim: isBare }) : dropdown(tagText, width, 'tag', at('tag'), { dim: isBare })
  lines.push(labelled('Tag', LABEL_COLUMNS, tag, at('tag')))
  if (state.open === 'tag') lines.push(...optionRows(tagList(options), state.cursor, LABEL_COLUMNS, width, 'pick'))

  // A suggestion is a typed value: it can't become an ssh key.
  const kinds = form.suggestion === null ? KINDS : KINDS.filter(k => k !== 'ssh-key')
  const kind = radios(kinds.map(k => ({ value: k, label: KIND_NAMES[k] })), form.kind, 'kind', at('kind'))
  lines.push(labelled('Kind', LABEL_COLUMNS, kind, at('kind')))

  const valueLabel = form.kind === 'ssh-key' ? 'File' : 'Value'
  if (form.suggestion !== null) lines.push(labelled(valueLabel, LABEL_COLUMNS, textLine('typed this session', { dimColor: true }), false))
  else lines.push(labelled(valueLabel, LABEL_COLUMNS, heldField(props, state, 'value', width, form.id === null ? '' : 'unchanged'), at('value') || at('show:value')))

  const buttons: ButtonSpec[] = [
    { hit: 'save', label: 'Save' },
    ...(form.id !== null ? [{ hit: 'delete', label: 'Delete', tone: 'danger' } as const] : []),
    ...(form.suggestion !== null ? [{ hit: 'dismiss', label: 'Dismiss', tone: 'danger' } as const] : []),
    { hit: 'cancel', label: 'Cancel' },
  ]
  lines.push([], ...buttonRows(buttons, state.focus), ...errorLines(props.error))
  const value = form.suggestion === null ? [['value', 'show:value']] : []
  return { lines, groups: [['name'], ['tag'], ['kind'], ...value, buttons.map(b => b.hit)] }
}

function listPage(props: VaultProps, state: ViewState): Drawn {
  const { columns } = props
  const buttons: ButtonSpec[] = [
    { hit: 'add', label: '+ Add entry' },
    { hit: 'rekey', label: 'Change passphrase' },
    { hit: 'lock', label: 'Lock vault', tone: 'danger' },
  ]
  const lines: Line[] = [...buttonRows(buttons, state.focus), [], heading('Entries')]
  const groups: string[][] = [buttons.map(b => b.hit)]
  const nameColumns = Math.max(6, columns - 34)
  const columnsOf = (name: string, tag: string, kind: string) =>
    ' ' + pad(clip(name, nameColumns), nameColumns) + ' ' + pad(clip(tag, TAG_COLUMNS), TAG_COLUMNS) + ' ' + pad(kind, KIND_COLUMNS) + ' '
  if (props.entries.length === 0) lines.push(textLine('   No entries yet.', { dimColor: true }))
  else lines.push(textLine(columnsOf('Name', 'Tag', 'Kind') + 'This session', { dimColor: true }))
  for (const e of props.entries) {
    const row = 'row:' + e.id
    const access = 'access:' + e.id
    const look: Look | undefined = e.access === 'allowed' ? { color: 'success' } : e.access === 'refused' ? { color: 'error' } : undefined
    const text = columnsOf(displayed(e.name), displayed(e.tag), KIND_NAMES[e.kind])
    lines.push([seg(text, state.focus === row ? FOCUSED : undefined, row), ...dropdown(accessLabel(e.access), ACCESS_WIDTH, access, state.focus === access, look === undefined ? {} : { look })])
    if (state.open === access) lines.push(...optionRows(ACCESS_OPTIONS, state.cursor, 1, columns - 2, 'pick'))
    groups.push([row, access])
  }
  if (props.suggestions.length > 0) lines.push([], heading('Typed this session, not kept'))
  for (const s of props.suggestions) {
    const hit = 'sugg:' + s.id
    lines.push([seg('   ' + displayed(s.prompt), state.focus === hit ? FOCUSED : undefined, hit)])
    groups.push([hit])
  }
  if (props.forward !== null) {
    lines.push([], heading('SSH agent'), checkbox(FORWARD_LABEL, props.forward, 'forward', state.focus === 'forward'))
    groups.push(['forward'])
  }
  lines.push(...errorLines(props.error))
  return { lines, groups }
}

export function drawPage(props: VaultProps, state: ViewState): Drawn {
  switch (pageOf(props, state)) {
    case 'collision':
      return collisionPage(props.collisions)
    case 'closed':
      return closedPage(props, state)
    case 'confirm':
      return confirmPage(state, state.confirming!)
    case 'rekey':
      return rekeyPage(props, state)
    case 'form':
      return formPage(props, state, state.form!)
    case 'list':
      return listPage(props, state)
  }
}

/**
 * The rows the view draws under its tabs: as many as its tallest page with its longest list open, so a form or a
 * list opens without waiting for the view to grow.
 */
export function contentRows(props: VaultProps): number {
  const base = initialState(0, '')
  if (pageOf(props, base) !== 'list') return drawPage(props, base).lines.length
  const list = listPage(props, base).lines.length + (props.entries.length > 0 ? listHeight(ACCESS_OPTIONS.length) : 0)
  const form = formPage(props, base, NEW_FORM).lines.length + listHeight(props.tagChoices.length + 1)
  const confirm = confirmPage(base, { kind: 'lock' }).lines.length
  return Math.max(list, form, rekeyPage(props, base).lines.length, confirm)
}

/** The line a list should keep in view: an open list's highlighted option, else the focused control's last line. */
function targetLine(lines: readonly Line[], state: ViewState): number {
  const hit = state.open === null ? state.focus : `pick:${state.cursor}`
  let target = 0
  lines.forEach((line, i) => {
    if (line.some(s => s.hit === hit || s.hit?.startsWith(hit + '='))) target = i
  })
  return target
}

/** The page's lines that fit in the view, scrolled so the focus shows. */
export function shownPage(props: VaultProps, state: ViewState): Drawn {
  const drawn = drawPage(props, state)
  const room = props.rows - TAB_ROWS
  if (drawn.lines.length <= room) return drawn
  const top = Math.max(0, Math.min(drawn.lines.length - room, targetLine(drawn.lines, state) - room + 1))
  return { lines: drawn.lines.slice(top, top + room), groups: drawn.groups }
}

/** The held field a paste goes to: the one with the keyboard, or whose Show button has it. */
function focusedOf(state: ViewState): SecretField | null {
  const name = state.focus.startsWith('show:') ? state.focus.slice('show:'.length) : state.focus
  return name === 'value' || name === 'passphrase' || name === 'again' ? name : null
}

function postOf(state: ViewState, edits = state.pending): VaultMessage {
  return { instance: state.instance, edits, focused: focusedOf(state), formOpen: state.form !== null }
}

/** Moves the keyboard; the hooks learn which held field a paste now goes to. */
function moved(state: ViewState): Result {
  return { state, post: postOf(state) }
}

function focusOn(state: ViewState, focus: string): Result {
  return moved({ ...state, focus, open: null })
}

type EditBody = ValueEdit extends infer E ? (E extends ValueEdit ? Omit<E, 'seq'> : never) : never

function withEdit(state: ViewState, edit: EditBody): Result {
  const seq = state.seq + 1
  const pending = [...state.pending, { ...edit, seq } as ValueEdit]
  return { state: { ...state, seq, pending }, post: postOf(state, pending) }
}

export function confirm(state: ViewState, applied: number | undefined): ViewState | null {
  if (applied === undefined || !state.pending.some(e => e.seq <= applied)) return null
  return { ...state, pending: state.pending.filter(e => e.seq > applied) }
}

function act(state: ViewState, action: VaultAction): Result {
  return withEdit(state, { kind: 'action', action })
}

function peek(state: ViewState, name: SecretField): Result {
  return withEdit({ ...state, focus: name, open: null }, { field: name, kind: 'peek' })
}

function startRekey(state: ViewState): Result {
  const cleared = withEdit({ ...state, rekeying: true, focus: 'passphrase', open: null }, { field: 'passphrase', kind: 'clear' })
  return withEdit(cleared.state, { field: 'again', kind: 'clear' })
}

/** Leaves the new passphrase; the hooks drop what was typed. */
function stopRekey(state: ViewState): Result {
  const cleared = withEdit({ ...state, rekeying: false, focus: 'rekey' }, { field: 'passphrase', kind: 'clear' })
  return withEdit(cleared.state, { field: 'again', kind: 'clear' })
}

/** Opens the form; the hooks drop any value left from an earlier form. */
function openForm(state: ViewState, form: Form, choices: readonly TagChoice[]): Result {
  const ownTag = choices.some(c => c.tag === form.tag) ? '' : form.tag
  return withEdit({ ...state, form, focus: 'name', open: null, ownTag }, { field: 'value', kind: 'clear' })
}

function closeForm(state: ViewState, form: Form): Result {
  return withEdit({ ...state, form: null, focus: form.id === null ? 'add' : 'row:' + form.id, open: null }, { field: 'value', kind: 'clear' })
}

/** To or from an ssh key, the value field turns between a secret and a file path: what was typed for one isn't the other. */
function setKind(state: ViewState, form: Form, kind: EntryKind): Result {
  const next = { ...state, form: { ...form, kind }, focus: 'kind', open: null }
  return (kind === 'ssh-key') !== (form.kind === 'ssh-key') ? withEdit(next, { field: 'value', kind: 'clear' }) : moved(next)
}

/** Opens the dropdown's list on its current option, or shuts it when it is open. */
function toggleList(state: ViewState, hit: string, cursor: number): Result {
  return moved(state.open === hit ? { ...state, open: null } : { ...state, focus: hit, open: hit, cursor })
}

function listCount(props: VaultProps, state: ViewState): number {
  return state.open === 'tag' ? tagOptions(props, state.form!).length + 1 : ACCESS_OPTIONS.length
}

/** The open list's option `index` goes into its dropdown. */
function choose(state: ViewState, props: VaultProps, index: number): Result {
  const shut = { ...state, open: null }
  if (state.open === 'tag' && state.form !== null) {
    const picked = tagOptions(props, state.form)[index]
    return moved({ ...shut, form: { ...state.form, tag: picked?.tag ?? state.ownTag } })
  }
  if (state.open?.startsWith('access:')) {
    const access = ACCESSES[index]
    return access === undefined ? moved(shut) : act(shut, { kind: 'access', id: state.open.slice('access:'.length), access })
  }
  return moved(shut)
}

/** What a click on a control, or Enter or Space on the focused one, does. */
function onHit(state: ViewState, props: VaultProps, hit: string | null): Result {
  if (hit === null) return moved(state)
  if (hit.startsWith('pick:')) return choose(state, props, Number(hit.slice('pick:'.length)))
  const page = pageOf(props, state)
  if (page === 'collision') {
    if (hit.startsWith('allow:')) return act(state, { kind: 'collision', name: hit.slice('allow:'.length), decision: 'allow' })
    if (hit.startsWith('refuse:')) return act(state, { kind: 'collision', name: hit.slice('refuse:'.length), decision: 'refuse' })
    return { state }
  }
  if (hit === 'passphrase' || hit === 'again' || hit === 'name' || hit === 'value') return focusOn(state, hit)
  if (hit === 'show:passphrase' || hit === 'show:again' || hit === 'show:value') return peek(state, hit.slice('show:'.length) as SecretField)
  if (page === 'closed') return hit === 'open' ? act(state, { kind: 'open' }) : moved(state)
  if (page === 'rekey') {
    if (hit === 'change') return act(state, { kind: 'rekey' })
    return hit === 'cancel' ? stopRekey(state) : moved(state)
  }
  if (page === 'confirm') {
    const confirming = state.confirming!
    const back = { ...state, confirming: null }
    if (hit === 'cancel') return moved({ ...back, focus: confirming.kind === 'lock' ? 'lock' : 'delete' })
    if (hit !== 'confirm') return moved(state)
    return confirming.kind === 'lock' ? act({ ...back, focus: 'add' }, { kind: 'lock' }) : act({ ...back, focus: 'delete' }, { kind: 'delete', id: confirming.id })
  }
  if (page === 'form') {
    const form = state.form!
    if (hit === 'tag') {
      const options = tagOptions(props, form)
      if (options.length === 0) return focusOn(state, 'tag')
      const at = options.findIndex(o => o.tag === form.tag)
      return toggleList(state, 'tag', at < 0 ? options.length : at)
    }
    if (hit.startsWith('kind=')) return setKind(state, form, hit.slice('kind='.length) as EntryKind)
    if (hit === 'save') return act({ ...state, focus: 'save' }, { kind: 'save', form })
    if (hit === 'delete' && form.id !== null) return moved({ ...state, confirming: { kind: 'delete', id: form.id, name: form.name }, focus: 'cancel', open: null })
    if (hit === 'dismiss' && form.suggestion !== null) return act(state, { kind: 'dismiss', id: form.suggestion })
    if (hit === 'cancel') return closeForm(state, form)
    return moved(state)
  }
  if (hit === 'add') return openForm(state, NEW_FORM, props.tagChoices)
  if (hit === 'rekey') return startRekey(state)
  if (hit === 'lock') return moved({ ...state, confirming: { kind: 'lock' }, focus: 'cancel', open: null })
  if (hit === 'forward' && props.forward !== null) return act({ ...state, focus: 'forward' }, { kind: 'forward', on: !props.forward })
  const entry = props.entries.find(e => hit === 'row:' + e.id || hit === 'access:' + e.id)
  if (entry !== undefined && hit.startsWith('row:')) {
    return openForm({ ...state, focus: hit }, { id: entry.id, suggestion: null, name: entry.name, tag: entry.tag, kind: entry.kind }, props.tagChoices)
  }
  if (entry !== undefined) return toggleList(state, hit, ACCESSES.indexOf(entry.access))
  const suggestion = props.suggestions.find(s => hit === 'sugg:' + s.id)
  if (suggestion !== undefined) return openForm(state, { ...NEW_FORM, suggestion: suggestion.id, name: suggestion.prompt }, props.tagChoices)
  return moved(state)
}

function typedText(k: ClientKeyEvent): string | null {
  if (k.ctrl || k.meta) return null
  if (k.key === 'space') return ' '
  if (SPECIAL_KEYS.has(k.key) || /[\x00-\x1f\x7f]/.test(k.key)) return null
  return k.key
}

/** A key on a text the view holds: the text after it, or null for a key that edits nothing. */
function textAfter(text: string, k: ClientKeyEvent): string | null {
  if (k.key === 'backspace' || k.key === 'delete') return [...text].slice(0, -1).join('')
  if (k.ctrl && k.key === 'u') return ''
  const typed = typedText(k)
  return typed === null ? null : text + typed
}

/** A key on a held field: an edit the hooks apply; null for a key that edits nothing. */
function heldEdit(name: SecretField, k: ClientKeyEvent): EditBody | null {
  if (k.key === 'backspace' || k.key === 'delete') return { field: name, kind: 'back' }
  if (k.ctrl && k.key === 'u') return { field: name, kind: 'clear' }
  const text = typedText(k)
  return text === null ? null : { field: name, kind: 'append', text }
}

export function onKey(state: ViewState, props: VaultProps, k: ClientKeyEvent): Result {
  const page = pageOf(props, state)
  if (page === 'collision') return { state }
  const isEnter = k.key === 'return' || k.key === '\n'
  if (state.open !== null) {
    const count = listCount(props, state)
    if (k.key === 'up' || k.key === 'down') return { state: { ...state, cursor: Math.max(0, Math.min(count - 1, state.cursor + (k.key === 'up' ? -1 : 1))) } }
    if (isEnter || k.key === 'space') return choose(state, props, state.cursor)
    if (k.key === 'tab') return { state: { ...state, open: null } }
    return { state }
  }
  const form = state.form
  if (form !== null && state.focus === 'kind' && (k.key === 'left' || k.key === 'right' || k.key === 'space')) {
    const kinds = form.suggestion === null ? KINDS : KINDS.filter(kind => kind !== 'ssh-key')
    const at = kinds.indexOf(form.kind)
    return setKind(state, form, kinds[(at + (k.key === 'left' ? -1 : 1) + kinds.length) % kinds.length]!)
  }
  const { groups } = drawPage(props, state)
  const to = moveFocus(groups, state.focus, k.key, k.shift === true)
  if (to !== null) return focusOn(state, to)
  // A control no longer drawn (its entry went) takes no key but the moves above.
  if (!groups.some(g => g.includes(state.focus))) return { state }
  const held = focusedOf(state)
  if (k.ctrl && k.key === 'r' && held !== null) return peek(state, held)
  const f = state.focus
  if (held !== null && f === held) {
    if (isEnter) return page === 'form' ? act(state, { kind: 'save', form: form! }) : act(state, { kind: page === 'rekey' ? 'rekey' : 'open' })
    const edit = heldEdit(held, k)
    return edit === null ? { state } : withEdit(state, edit)
  }
  if (form !== null && page === 'form' && (f === 'name' || f === 'kind' || f === 'tag')) {
    const options = tagOptions(props, form)
    if (f === 'tag' && options.length > 0 && (isEnter || k.key === 'space')) return onHit(state, props, 'tag')
    if (isEnter) return act(state, { kind: 'save', form })
    if (f === 'kind') return { state }
    // Typing on the tag writes the person's own, in place of an offered one.
    const before = f === 'name' ? form.name : options.some(o => o.tag === form.tag) ? '' : form.tag
    const after = textAfter(before, k)
    if (after === null) return { state }
    return f === 'name' ? { state: { ...state, form: { ...form, name: after } } } : { state: { ...state, form: { ...form, tag: after }, ownTag: after } }
  }
  return isEnter || k.key === 'space' ? onHit(state, props, f) : { state }
}

/** `y` and `x` count from the view's top left, the tab rows included. */
export function onClick(state: ViewState, props: VaultProps, y: number, x: number): Result {
  if (y < TAB_ROWS) {
    const tab: Tab | null = y === 0 ? tabAt(props.tabs, x) : null
    return tab !== null && tab !== 'vault' ? withEdit(state, { kind: 'tab', tab }) : { state }
  }
  const hit = hitAt(shownPage(props, state).lines[y - TAB_ROWS], x)
  // A click outside an open list shuts it and goes on to what it hit.
  if (state.open !== null && !hit?.startsWith('pick:')) {
    if (hit === state.open) return moved({ ...state, open: null })
    state = { ...state, open: null }
  }
  return onHit(state, props, hit)
}

const VaultView: ClientModule<VaultProps, ViewState> = (props, surface) => {
  const { columns } = props
  surface.onPointer(p => {
    if (p.type !== 'down') return
    const result = onClick(surface.state as ViewState, props, p.y, p.x)
    surface.setState(result.state)
    if (result.post) surface.post(result.post)
  })
  surface.onKey(k => {
    const result = onKey(surface.state as ViewState, props, k)
    surface.setState(result.state)
    if (result.post) surface.post(result.post)
  })
  const isClosed = props.state !== 'open'
  let state = surface.state ?? initialState(props.formEpoch, Math.random().toString(36).slice(2), isClosed)
  const confirmed = confirm(state, props.applied[state.instance])
  if (confirmed !== null) state = confirmed
  if (state.formEpoch !== props.formEpoch) state = { ...state, form: null, rekeying: false, open: null, formEpoch: props.formEpoch }
  if (state.isClosed !== isClosed) state = { ...state, isClosed, focus: isClosed ? 'passphrase' : 'add', confirming: null, open: null }
  if (state !== surface.state) surface.setState(state)

  const lines = shownPage(props, state).lines
  // Blank lines to the view's height, so nothing a longer page drew stays.
  const height = Math.min(props.rows - TAB_ROWS, contentRows(props))
  while (lines.length < height) lines.push([])
  return surface.elements.Box({
    flexDirection: 'column',
    width: columns,
    children: [...drawTabs(surface.elements, props.tabs, columns), ...lines.map(line => drawLine(surface.elements, fit(line, columns)))],
  })
}

export default VaultView
