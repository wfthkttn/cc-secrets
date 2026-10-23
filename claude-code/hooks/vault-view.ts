import type { ClientKeyEvent, ClientModule } from 'claude-code'

import {
  buttonRows,
  type ButtonSpec,
  caretAfter,
  caretText,
  checkbox,
  drawLine,
  dropdown,
  dropdownRoom,
  editText,
  END_CARET,
  fit,
  FOCUSED,
  heading,
  hitAt,
  lengthAfter,
  type Line,
  listHeight,
  listRows as optionRows,
  type Look,
  moveFocus,
  type Option,
  radios,
  seg,
  showButton,
  type TextEdit,
  textField,
  textKey,
  textLine,
} from './controls'
import { clip, displayed, pad } from './display'
import { drawTabs, type Tab, TAB_ROWS, tabAt } from './tabs'
import type {
  Access,
  Collision,
  EntryKind,
  Form,
  SecretField,
  TagChoice,
  TextField,
  ValueEdit,
  VaultAction,
  VaultMessage,
  VaultProps,
  ViewEntry,
} from './vault-view-props'

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
  /** Where typing goes in the focused Name or Tag: a character index, past the end counting as the end. */
  caret: number
  /** The last of the hooks' pastes (`VaultProps.pastes`) this view took in. */
  pasted: number
  /** A list row held by the pointer: its entry, and the place in the list it goes to when let go. */
  drag: { id: string; to: number } | null
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
const DOOR_LABELS: Record<'passphrase' | 'again', string> = { passphrase: 'Passphrase', again: 'Repeat' }
const KIND_NAMES: Record<EntryKind, string> = { password: 'Password', token: 'Token', 'ssh-key': 'SSH key' }
const KINDS: readonly EntryKind[] = ['password', 'token', 'ssh-key']
const ACCESSES: readonly Access[] = ['ask', 'allowed', 'refused']
const ACCESS_OPTIONS: readonly Option[] = [
  { label: 'Ask', what: 'confirm each use' },
  { label: 'Allow', what: 'use without asking' },
  { label: 'Deny', what: 'never hand it out' },
]
const OWN_TAG: Option = { label: 'Custom tag…', what: 'type it in the field' }
const NO_TAG = 'none (one is generated)'
const FORWARD_LABEL = 'Forward my SSH agent to this session'
const NEW_FORM: Form = { id: null, suggestion: null, name: '', tag: '', kind: 'password' }
const REORDER_HINT = '   Drag a row or press Shift+↑/↓ to reorder'

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
    caret: END_CARET,
    pasted: 0,
    drag: null,
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

/** The list with the entry `id` taken out and put back at place `to`, as the daemon's move does. */
function movedTo(entries: readonly ViewEntry[], id: string, to: number): ViewEntry[] {
  const entry = entries.find(e => e.id === id)
  if (entry === undefined) return [...entries]
  const rest = entries.filter(e => e.id !== id)
  rest.splice(Math.min(to, rest.length), 0, entry)
  return rest
}

/** The entries in the order the list shows: this instance's unconfirmed moves applied, then a dragged row at its place. */
export function shownEntries(entries: readonly ViewEntry[], state: Pick<ViewState, 'pending' | 'drag'>): ViewEntry[] {
  let order = [...entries]
  for (const edit of state.pending) if (edit.kind === 'action' && edit.action.kind === 'move') order = movedTo(order, edit.action.id, edit.action.to)
  return state.drag === null ? order : movedTo(order, state.drag.id, state.drag.to)
}

/** This instance's unconfirmed edits of the held field `field`. */
function editsOf(field: SecretField, pending: ValueEdit[]): TextEdit[] {
  return pending.flatMap(edit => ('field' in edit && edit.field === field && edit.kind !== 'peek' ? [edit] : []))
}

export function shownLength(length: number, field: SecretField, pending: ValueEdit[]): number {
  return editsOf(field, pending).reduce(lengthAfter, length)
}

/** A peeked field's text as shown: what the hooks hold, with this instance's unconfirmed edits on top. */
export function shownText(text: string, field: SecretField, pending: ValueEdit[]): string {
  return editsOf(field, pending).reduce(editText, text)
}

/** A held field: dots, or its text while peeked, with the caret while focused and its Show button. */
function heldField(props: VaultProps, state: ViewState, name: SecretField, width: number, empty: string): Line {
  const length = shownLength(props.lengths[name], name, state.pending)
  const peeked = props.peeked[name]
  const show = showButton(peeked !== undefined, 'show:' + name)
  const tail = state.focus === 'show:' + name ? { ...show, look: { ...show.look, ...FOCUSED, inverse: true } } : show
  const text = peeked === undefined ? '•'.repeat(length) : shownText(peeked, name, state.pending)
  return textField(text, state.caret, width, name, state.focus === name, { placeholder: empty, tail })
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
    lines.push(textLine(` ⚠ ${displayed(c.name)} sees secrets in ${c.carriers.join(', ')}`, { color: 'error' }))
    if (c.changed && !c.refused) lines.push(textLine('   Its code changed since you allowed it.', { bold: true }))
    const notes = c.refused ? ['Blocked from the next session start.', 'The vault and typing stay off until then.'] : ['The vault and typing are off until you decide.']
    lines.push(...notes.map(note => textLine('   ' + note, { dimColor: true })))
    if (!c.refused) {
      const buttons: ButtonSpec[] = [
        { hit: 'allow:' + c.name, label: 'Allow' },
        { hit: 'refuse:' + c.name, label: 'Block', tone: 'danger' },
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
  return doorPage(props, state, isNew ? 'Create a vault' : 'Vault locked', isNew ? ['passphrase', 'again'] : ['passphrase'], [
    { hit: 'open', label: isNew ? 'Create' : 'Unlock' },
  ])
}

function rekeyPage(props: VaultProps, state: ViewState): Drawn {
  return doorPage(props, state, 'Change passphrase', ['passphrase', 'again'], [
    { hit: 'change', label: 'Change' },
    { hit: 'cancel', label: 'Cancel' },
  ])
}

function confirmPage(state: ViewState, confirming: Confirming): Drawn {
  const [question, note, verb] =
    confirming.kind === 'lock'
      ? ['Lock the vault?', 'Every session loses access until it is unlocked.', 'Lock']
      : [`Delete ${displayed(confirming.name)}?`, "It is removed for all sessions. This can't be undone.", 'Delete']
  const buttons: ButtonSpec[] = [
    { hit: 'confirm', label: verb, tone: 'danger' },
    { hit: 'cancel', label: 'Cancel' },
  ]
  return { lines: [heading(question), textLine('   ' + note, { dimColor: true }), [], ...buttonRows(buttons, state.focus)], groups: [buttons.map(b => b.hit)] }
}

function formPage(props: VaultProps, state: ViewState, form: Form): Drawn {
  const width = props.columns - LABEL_COLUMNS - 1
  const at = (hit: string) => state.focus === hit
  const title = form.suggestion !== null ? 'Save typed value' : form.id === null ? 'New entry' : 'Edit entry'
  const lines: Line[] = [heading(title)]
  lines.push(labelled('Name', LABEL_COLUMNS, textField(form.name, state.caret, width, 'name', at('name')), at('name')))

  const options = tagOptions(props, form)
  const choice = options.find(o => o.tag === form.tag)
  let tag: Line
  if (options.length === 0) tag = textField(form.tag, state.caret, width, 'tag', at('tag'), { placeholder: NO_TAG })
  else {
    // A click on a dropdown's text opens its list, so its text takes no click for the caret.
    const typed = at('tag') ? caretText(form.tag, state.caret, dropdownRoom(width)) : displayed(form.tag)
    const tagText = choice !== undefined ? `${choice.tag} · ${choice.what}` : form.tag === '' ? (at('tag') ? typed : '') + NO_TAG : typed
    tag = dropdown(tagText, width, 'tag', at('tag'), { dim: choice === undefined && form.tag === '' })
  }
  lines.push(labelled('Tag', LABEL_COLUMNS, tag, at('tag')))
  if (state.open === 'tag') lines.push(...optionRows(tagList(options), state.cursor, LABEL_COLUMNS, width, 'pick'))

  // A suggestion is a typed value: it can't become an ssh key.
  const kinds = form.suggestion === null ? KINDS : KINDS.filter(k => k !== 'ssh-key')
  const kind = radios(kinds.map(k => ({ value: k, label: KIND_NAMES[k] })), form.kind, 'kind', at('kind'))
  lines.push(labelled('Type', LABEL_COLUMNS, kind, at('kind')))

  const valueLabel = form.kind === 'ssh-key' ? 'File' : 'Value'
  if (form.suggestion !== null) lines.push(labelled(valueLabel, LABEL_COLUMNS, textLine('the value you typed', { dimColor: true }), false))
  else lines.push(labelled(valueLabel, LABEL_COLUMNS, heldField(props, state, 'value', width, form.id === null ? '' : 'leave empty to keep'), at('value') || at('show:value')))

  const buttons: ButtonSpec[] = [
    { hit: 'save', label: 'Save' },
    ...(form.id !== null ? [{ hit: 'delete', label: 'Delete', tone: 'danger' } as const] : []),
    ...(form.suggestion !== null ? [{ hit: 'dismiss', label: 'Discard', tone: 'danger' } as const] : []),
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
  else lines.push(textLine(columnsOf('Name', 'Tag', 'Type') + 'Access', { dimColor: true }))
  for (const e of shownEntries(props.entries, state)) {
    const row = 'row:' + e.id
    const access = 'access:' + e.id
    const look: Look | undefined = e.access === 'allowed' ? { color: 'success' } : e.access === 'refused' ? { color: 'error' } : undefined
    const text = columnsOf(displayed(e.name), displayed(e.tag), KIND_NAMES[e.kind])
    const rowLook = state.drag?.id === e.id ? { ...FOCUSED, inverse: true } : state.focus === row ? FOCUSED : undefined
    lines.push([seg(text, rowLook, row), ...dropdown(accessLabel(e.access), ACCESS_WIDTH, access, state.focus === access, look === undefined ? {} : { look })])
    if (state.open === access) lines.push(...optionRows(ACCESS_OPTIONS, state.cursor, 1, columns - 2, 'pick'))
    groups.push([row, access])
  }
  if (props.entries.length > 1) lines.push(textLine(REORDER_HINT, { dimColor: true }))
  if (props.suggestions.length > 0) lines.push([], heading('Unsaved values'))
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

/** The text field a paste goes to: a held one, or the form's Name or Tag. */
function pasteFieldOf(state: ViewState): SecretField | TextField | null {
  const isForm = state.form !== null && !state.rekeying && state.confirming === null && !state.isClosed
  if (isForm && (state.focus === 'name' || state.focus === 'tag')) return state.focus
  return focusedOf(state)
}

function postOf(state: ViewState, edits = state.pending): VaultMessage {
  return { instance: state.instance, edits, focused: pasteFieldOf(state), caret: state.caret, formOpen: state.form !== null }
}

/** Moves the keyboard; the hooks learn which text field a paste now goes to. */
function moved(state: ViewState): Result {
  return { state, post: postOf(state) }
}

/** The keyboard goes to `focus`; in a text field, the caret to its end. */
function focusOn(state: ViewState, focus: string): Result {
  return moved({ ...state, focus, open: null, caret: END_CARET })
}

/** The text Name or Tag holds for editing: the tag's own, none while it shows an offered tag. */
function textOf(options: readonly TagChoice[], form: Form, name: TextField): string {
  if (name === 'name') return form.name
  return options.some(o => o.tag === form.tag) ? '' : form.tag
}

/** Name or Tag holding `text`; on the tag, the person's own. */
function withText(state: ViewState, form: Form, name: TextField, text: string, caret: number): ViewState {
  if (name === 'name') return { ...state, form: { ...form, name: text }, caret }
  return { ...state, form: { ...form, tag: text }, ownTag: text, caret }
}

/**
 * Takes in the hooks' pastes this instance hasn't. Name's or Tag's goes in at the caret while the field has the
 * keyboard, else at its end; past a held field's, which the hooks made at this view's caret, the caret moves.
 */
export function withPastes(state: ViewState, props: Pick<VaultProps, 'pastes' | 'tagChoices' | 'entries'>): ViewState {
  let next = state
  for (const paste of props.pastes) {
    if (paste.seq <= next.pasted) continue
    next = { ...next, pasted: paste.seq }
    if ('at' in paste) {
      if (next.focus === paste.field) next = { ...next, caret: paste.at + paste.length }
      continue
    }
    const form = next.form
    // A paste for a form closed since has nowhere to go.
    if (form === null) continue
    const text = textOf(tagOptions(props, form), form, paste.field)
    const isFocused = next.focus === paste.field
    const edit = { kind: 'insert' as const, at: Math.min(isFocused ? next.caret : END_CARET, [...text].length), text: paste.text }
    next = withText(next, form, paste.field, editText(text, edit), isFocused ? caretAfter(edit) : next.caret)
  }
  return next
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
  return withEdit({ ...state, form, focus: 'name', open: null, ownTag, caret: END_CARET }, { field: 'value', kind: 'clear' })
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
    return moved({ ...shut, form: { ...state.form, tag: picked?.tag ?? state.ownTag }, caret: END_CARET })
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
  const place = /^(name|tag|value|passphrase|again)@(\d+)$/.exec(hit)
  if (place !== null) return moved({ ...state, focus: place[1]!, open: null, caret: Number(place[2]) })
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

export function onKey(state: ViewState, props: VaultProps, k: ClientKeyEvent): Result {
  const page = pageOf(props, state)
  if (page === 'collision') return { state }
  const isEnter = k.key === 'return' || k.key === '\n'
  if (state.open !== null) {
    const count = listCount(props, state)
    if (k.key === 'up' || k.key === 'down') return { state: { ...state, cursor: Math.max(0, Math.min(count - 1, state.cursor + (k.key === 'up' ? -1 : 1))) } }
    if (isEnter || k.key === 'space') return choose(state, props, state.cursor)
    if (k.key === 'tab') return { state: { ...state, open: null } }
    // Typing over the open tag list writes the person's own tag, as on the shut field, and the list stays open.
    if (state.open === 'tag' && state.focus === 'tag' && textKey(k, state.caret, 0) !== null) {
      const typed = onKey({ ...state, open: null }, props, k)
      return { ...typed, state: { ...typed.state, open: 'tag' } }
    }
    return { state }
  }
  const form = state.form
  if (form !== null && state.focus === 'kind' && (k.key === 'left' || k.key === 'right' || k.key === 'space')) {
    const kinds = form.suggestion === null ? KINDS : KINDS.filter(kind => kind !== 'ssh-key')
    const at = kinds.indexOf(form.kind)
    return setKind(state, form, kinds[(at + (k.key === 'left' ? -1 : 1) + kinds.length) % kinds.length]!)
  }
  const f = state.focus
  if (form !== null && page === 'form' && (f === 'name' || f === 'tag')) {
    const options = tagOptions(props, form)
    if (f === 'tag' && options.length > 0 && (isEnter || k.key === 'space')) return onHit(state, props, 'tag')
    if (isEnter) return act(state, { kind: 'save', form })
    // Typing on the tag writes the person's own, in place of an offered one, which Backspace or Delete takes out.
    const before = textOf(options, form, f)
    const isOffered = f === 'tag' && before === '' && form.tag !== ''
    if (isOffered && (k.key === 'backspace' || k.key === 'delete')) return { state: withText(state, form, f, '', 0) }
    const change = textKey(k, state.caret, [...before].length)
    if (change?.kind === 'move') return { state: { ...state, caret: change.caret } }
    if (change !== null) return { state: withText(state, form, f, editText(before, change), caretAfter(change)) }
  }
  const held = focusedOf(state)
  if (k.ctrl && k.key === 'r' && held !== null) return peek(state, held)
  if (held !== null && f === held) {
    if (isEnter) return page === 'form' ? act(state, { kind: 'save', form: form! }) : act(state, { kind: page === 'rekey' ? 'rekey' : 'open' })
    const change = textKey(k, state.caret, shownLength(props.lengths[held], held, state.pending))
    if (change?.kind === 'move') return { state: { ...state, caret: change.caret } }
    if (change !== null) return withEdit({ ...state, caret: caretAfter(change) }, { field: held, ...change })
  }
  if (page === 'list' && k.shift === true && (k.key === 'up' || k.key === 'down') && f.startsWith('row:')) {
    const id = f.slice('row:'.length)
    const order = shownEntries(props.entries, state)
    const from = order.findIndex(e => e.id === id)
    const to = from + (k.key === 'up' ? -1 : 1)
    return from < 0 || to < 0 || to >= order.length ? { state } : act(state, { kind: 'move', id, to })
  }
  const { groups } = drawPage(props, state)
  const to = moveFocus(groups, state.focus, k.key, k.shift === true)
  if (to !== null) return focusOn(state, to)
  // A control no longer drawn (its entry went) takes no key but the moves above.
  if (!groups.some(g => g.includes(state.focus))) return { state }
  if (form !== null && page === 'form' && f === 'kind') return isEnter ? act(state, { kind: 'save', form }) : { state }
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

/** The pointer went down: on a list row it holds the row, which a release opens or a drag moves; elsewhere a click. */
export function onPress(state: ViewState, props: VaultProps, y: number, x: number): Result {
  if (y >= TAB_ROWS && state.open === null && pageOf(props, state) === 'list') {
    const hit = hitAt(shownPage(props, state).lines[y - TAB_ROWS], x)
    if (hit?.startsWith('row:')) {
      const id = hit.slice('row:'.length)
      return moved({ ...state, focus: hit, drag: { id, to: shownEntries(props.entries, state).findIndex(e => e.id === id) } })
    }
  }
  return onClick(state, props, y, x)
}

/** The pointer moved while a row is held: the row's place follows it; null when nothing changes. */
export function onDrag(state: ViewState, props: VaultProps, y: number): Result | null {
  if (state.drag === null) return null
  const order = shownEntries(props.entries, state)
  const lines = shownPage(props, state).lines
  // The rows stand one a line, so the place under the pointer counts from any row on screen.
  const line = lines.findIndex(l => l.some(s => s.hit?.startsWith('row:')))
  if (line < 0) return null
  const hit = lines[line]!.find(s => s.hit?.startsWith('row:'))!.hit!
  const at = order.findIndex(e => 'row:' + e.id === hit)
  const to = Math.max(0, Math.min(order.length - 1, at + y - TAB_ROWS - line))
  return to === state.drag.to ? null : { state: { ...state, drag: { ...state.drag, to } } }
}

/** The pointer let go of a held row: back at its place it opens, elsewhere it moves there. */
export function onRelease(state: ViewState, props: VaultProps): Result | null {
  if (state.drag === null) return null
  const { id, to } = state.drag
  const done = { ...state, drag: null }
  const from = shownEntries(props.entries, done).findIndex(e => e.id === id)
  if (from < 0) return moved(done)
  return to === from ? onHit(done, props, 'row:' + id) : act(done, { kind: 'move', id, to })
}

/** The state a new instance starts from: the last one posted, else a fresh one; a row held then stays with the old instance, which gets its release. */
export function startState(props: Pick<VaultProps, 'resume' | 'formEpoch' | 'state'>, instance: string): ViewState {
  return props.resume === null ? initialState(props.formEpoch, instance, props.state !== 'open') : { ...props.resume, pending: [], drag: null }
}

/** Every change posts, with the state the next instance resumes from. */
function sent(result: Result): VaultMessage {
  const { pending: _pending, ...ui } = result.state
  return { ...(result.post ?? postOf(result.state)), ui }
}

const VaultView: ClientModule<VaultProps, ViewState> = (props, surface) => {
  const { columns } = props
  // A copy over a held instance keeps no state of its own and posts nothing until a click or a key claims it.
  const isCopy = props.mirror && surface.state === undefined
  const begin = () => surface.state ?? startState(props, Math.random().toString(36).slice(2))
  const posted = (result: Result, claimed: boolean): VaultMessage => (claimed ? { ...sent(result), claimed: true } : sent(result))
  surface.onPointer(p => {
    if (isCopy && p.type !== 'down') return
    const current = begin()
    const result =
      p.type === 'down' ? onPress(current, props, p.y, p.x) : p.type === 'move' ? onDrag(current, props, p.y) : p.type === 'up' ? onRelease(current, props) : null
    if (result === null) return
    surface.setState(result.state)
    surface.post(posted(result, isCopy))
  })
  surface.onKey(k => {
    const result = onKey(begin(), props, k)
    surface.setState(result.state)
    surface.post(posted(result, isCopy))
  })
  const isClosed = props.state !== 'open'
  let state = begin()
  const confirmed = confirm(state, props.applied[state.instance])
  if (confirmed !== null) state = confirmed
  if (state.formEpoch !== props.formEpoch) state = { ...state, form: null, rekeying: false, open: null, formEpoch: props.formEpoch }
  if (state.isClosed !== isClosed) state = { ...state, isClosed, focus: isClosed ? 'passphrase' : 'add', confirming: null, open: null }
  if (!isCopy) {
    const pasted = withPastes(state, props)
    if (state !== surface.state || pasted !== state) surface.setState(pasted)
    // The hooks drop a paste once a post says it was taken in.
    if (pasted !== state) surface.post(sent({ state: pasted }))
    state = pasted
  }

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
