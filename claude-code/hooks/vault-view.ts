import type { ClientKeyEvent, ClientModule } from 'claude-code'

import { drawTabs, TAB_ROWS, tabAt } from './tabs'
import type { EntryKind, EntryUse, Form, SecretField, Suggestion, ValueEdit, VaultAction, VaultMessage, VaultProps, ViewEntry } from './vault-view-props'

type Field = 'name' | 'tag' | 'kind' | 'use' | 'value'
type Door = 'passphrase' | 'again'

export type ViewState = {
  instance: string
  seq: number
  /** Value edits sent but not yet confirmed by the hooks. */
  pending: ValueEdit[]
  form: Form | null
  field: Field
  /** The closed vault's field with the keyboard. */
  door: Door
  /** The vault is closed: keys go to its passphrase. */
  isClosed: boolean
  /** The selected row among the list's selectable ones. */
  selected: number
  formEpoch: number
}

/** One row under the tabs: the closed vault's, the list's, or the form's. */
export type Row =
  | { kind: 'closed'; text: string }
  | { kind: 'door'; field: Door }
  | { kind: 'add' }
  | { kind: 'entry'; entry: ViewEntry }
  | { kind: 'suggestion'; suggestion: Suggestion }
  | { kind: 'suggestHead' | 'none' }
  | { kind: 'field'; field: Field }
  | { kind: 'gap' | 'buttonsTop' | 'buttons' | 'buttonsBottom' }
  | { kind: 'error'; text: string }

type Result = { state: ViewState; post?: VaultMessage }

const FIELDS: readonly Field[] = ['name', 'tag', 'kind', 'use', 'value']
const LABELS: Record<Field, string> = { name: 'Name', tag: 'Tag', kind: 'Kind', use: 'Use', value: 'Value' }
const DOOR_LABELS: Record<Door, string> = { passphrase: 'Passphrase', again: 'Again' }
const LABEL_COLUMNS = 7
const DOOR_LABEL_COLUMNS = 12
const KINDS: readonly EntryKind[] = ['password', 'token', 'ssh-key']
const USES: readonly EntryUse[] = ['session', 'each']
const FIELD_BACKGROUND = '#1f2a3a'
const SPECIAL_KEYS = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab', 'backspace', 'delete'])

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - [...text].length))
}

function clip(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : chars.slice(0, width - 1).join('') + '…'
}

function edge(side: 'top' | 'bottom', width: number): string {
  const [left, right] = side === 'top' ? ['╭', '╮'] : ['╰', '╯']
  return left + '─'.repeat(width - 2) + right
}

export function initialState(formEpoch: number, instance: string, isClosed = false): ViewState {
  return { instance, seq: 0, pending: [], form: null, field: 'name', door: 'passphrase', isClosed, selected: 0, formEpoch }
}

function doors(state: VaultProps['state']): Door[] {
  return state === 'absent' ? ['passphrase', 'again'] : ['passphrase']
}

/** The closed vault's rows: what it is, its passphrase field (twice for a new one), its button, why the last try failed. */
export function closedRows(props: Pick<VaultProps, 'state' | 'error'>): Row[] {
  const rows: Row[] = [{ kind: 'closed', text: props.state === 'absent' ? 'No vault yet.' : 'Vault locked.' }]
  for (const field of doors(props.state)) rows.push({ kind: 'door', field })
  rows.push({ kind: 'gap' }, { kind: 'buttonsTop' }, { kind: 'buttons' }, { kind: 'buttonsBottom' })
  if (props.error !== null) rows.push({ kind: 'error', text: props.error })
  return rows
}

export function listRows(props: Pick<VaultProps, 'entries' | 'suggestions'>): Row[] {
  const rows: Row[] = [{ kind: 'add' }]
  if (props.entries.length === 0) rows.push({ kind: 'none' })
  for (const entry of props.entries) rows.push({ kind: 'entry', entry })
  if (props.suggestions.length > 0) rows.push({ kind: 'suggestHead' })
  for (const suggestion of props.suggestions) rows.push({ kind: 'suggestion', suggestion })
  return rows
}

export function formRows(error: string | null): Row[] {
  const rows: Row[] = FIELDS.map(field => ({ kind: 'field', field }))
  rows.push({ kind: 'gap' }, { kind: 'buttonsTop' }, { kind: 'buttons' }, { kind: 'buttonsBottom' })
  if (error !== null) rows.push({ kind: 'error', text: error })
  return rows
}

function isSelectable(row: Row): boolean {
  return row.kind === 'add' || row.kind === 'entry' || row.kind === 'suggestion'
}

type Button = { kind: 'save' | 'delete' | 'dismiss' | 'cancel' | 'open'; label: string }

function laidOut(labels: readonly Button[]) {
  let start = 1
  return labels.map(b => {
    const button = { ...b, start, width: [...b.label].length + 2 }
    start += button.width + 1
    return button
  })
}

/** The form's buttons from the left, each boxed, a column apart; Delete on an entry that exists, Dismiss on a suggestion. */
export function formButtons(form: Form) {
  return laidOut([
    { kind: 'save', label: ' Save ' },
    ...(form.id !== null ? [{ kind: 'delete', label: ' Delete ' } as const] : []),
    ...(form.suggestion !== null ? [{ kind: 'dismiss', label: ' Dismiss ' } as const] : []),
    { kind: 'cancel', label: ' ✕ ' },
  ])
}

export function doorButtons(state: VaultProps['state']) {
  return laidOut([{ kind: 'open', label: state === 'absent' ? ' Create ' : ' Unlock ' }])
}

function focusedOf(state: ViewState): SecretField | null {
  if (state.isClosed) return state.door
  return state.form !== null && state.form.suggestion === null && state.field === 'value' ? 'value' : null
}

function postOf(state: ViewState, edits = state.pending, action?: VaultAction): VaultMessage {
  return { instance: state.instance, edits, focused: focusedOf(state), formOpen: state.form !== null, ...(action === undefined ? {} : { action }) }
}

/** Moves the keyboard; the hooks learn which held field a paste now goes to. */
function moved(state: ViewState): Result {
  return { state, post: postOf(state) }
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

export function shownLength(length: number, field: SecretField, pending: ValueEdit[]): number {
  for (const edit of pending) {
    if (edit.field !== field) continue
    if (edit.kind === 'append') length += [...edit.text].length
    else if (edit.kind === 'back') length = Math.max(0, length - 1)
    else length = 0
  }
  return length
}

/** Opens the form on a list row; the hooks drop any value left from an earlier form. */
function open(state: ViewState, row: Row): Result {
  const form: Form | null =
    row.kind === 'add'
      ? { id: null, suggestion: null, name: '', tag: '', kind: 'password', use: 'session' }
      : row.kind === 'entry'
        ? { id: row.entry.id, suggestion: null, name: row.entry.name, tag: row.entry.tag, kind: row.entry.kind, use: row.entry.use }
        : row.kind === 'suggestion'
          ? { id: null, suggestion: row.suggestion.id, name: row.suggestion.prompt, tag: '', kind: 'password', use: 'session' }
          : null
  if (form === null) return { state }
  return withEdit({ ...state, form, field: 'name' }, { field: 'value', kind: 'clear' })
}

function act(state: ViewState, action: VaultAction): Result {
  return { state, post: postOf(state, state.pending, action) }
}

function cycle<T>(list: readonly T[], at: T, step: number): T {
  return list[(list.indexOf(at) + step + list.length) % list.length]!
}

function typedText(k: ClientKeyEvent): string | null {
  if (k.ctrl || k.meta) return null
  if (k.key === 'space') return ' '
  if (SPECIAL_KEYS.has(k.key) || /[\x00-\x1f\x7f]/.test(k.key)) return null
  return k.key
}

/** A key on a held field: an edit the hooks apply; null for a key that edits nothing. */
function heldEdit(field: SecretField, k: ClientKeyEvent): EditBody | null {
  if (k.key === 'backspace' || k.key === 'delete') return { field, kind: 'back' }
  if (k.ctrl && k.key === 'u') return { field, kind: 'clear' }
  const text = typedText(k)
  return text === null ? null : { field, kind: 'append', text }
}

function onDoorKey(state: ViewState, props: Pick<VaultProps, 'state'>, k: ClientKeyEvent): Result {
  const fields = doors(props.state)
  if (k.key === 'up' || k.key === 'down' || k.key === 'tab') {
    const step = k.key === 'up' || (k.key === 'tab' && k.shift) ? -1 : 1
    const at = Math.max(0, fields.indexOf(state.door))
    return moved({ ...state, door: fields[Math.max(0, Math.min(fields.length - 1, at + step))]! })
  }
  if (k.key === 'return' || k.key === '\n') return act(state, { kind: 'open' })
  const edit = heldEdit(state.door, k)
  return edit === null ? { state } : withEdit(state, edit)
}

function onFormKey(state: ViewState, form: Form, k: ClientKeyEvent): Result {
  const at = FIELDS.indexOf(state.field)
  if (k.key === 'up' || k.key === 'down' || k.key === 'tab') {
    const step = k.key === 'up' || (k.key === 'tab' && k.shift) ? -1 : 1
    return moved({ ...state, field: FIELDS[Math.max(0, Math.min(FIELDS.length - 1, at + step))]! })
  }
  if (k.key === 'return' || k.key === '\n') return act(state, { kind: 'save', form })
  if (state.field === 'kind' || state.field === 'use') {
    const step = k.key === 'left' ? -1 : k.key === 'right' || k.key === 'space' ? 1 : 0
    if (step === 0) return { state }
    // A suggestion is a typed value: it can't become an ssh key.
    const kinds = form.suggestion === null ? KINDS : KINDS.filter(kind => kind !== 'ssh-key')
    const next = state.field === 'kind' ? { ...form, kind: cycle(kinds, form.kind, step) } : { ...form, use: cycle(USES, form.use, step) }
    return { state: { ...state, form: next } }
  }
  if (state.field === 'value') {
    const edit = form.suggestion === null ? heldEdit('value', k) : null
    return edit === null ? { state } : withEdit(state, edit)
  }
  const key = state.field
  const value = form[key]
  if (k.key === 'backspace' || k.key === 'delete') return { state: { ...state, form: { ...form, [key]: [...value].slice(0, -1).join('') } } }
  if (k.ctrl && k.key === 'u') return { state: { ...state, form: { ...form, [key]: '' } } }
  const text = typedText(k)
  return text === null ? { state } : { state: { ...state, form: { ...form, [key]: value + text } } }
}

export function onKey(state: ViewState, props: Pick<VaultProps, 'state' | 'entries' | 'suggestions'>, k: ClientKeyEvent): Result {
  if (props.state !== 'open') return onDoorKey(state, props, k)
  if (state.form !== null) return onFormKey(state, state.form, k)
  const rows = listRows(props).filter(isSelectable)
  const selected = Math.min(state.selected, rows.length - 1)
  if (k.key === 'up' || k.key === 'down') return { state: { ...state, selected: Math.max(0, Math.min(rows.length - 1, selected + (k.key === 'up' ? -1 : 1))) } }
  const row = rows[selected]
  if (row === undefined) return { state }
  if (row.kind === 'entry' && k.key === 'space') return act(state, { kind: 'allow', id: row.entry.id, allowed: !row.entry.allowed })
  if (k.key !== 'return' && k.key !== '\n') return { state }
  return open(state, row)
}

function buttonAt<B extends { start: number; width: number }>(buttons: B[], x: number): B | undefined {
  return buttons.find(b => x >= b.start && x < b.start + b.width)
}

/** `y` and `x` count from the view's top left, the tab rows included. */
export function onClick(state: ViewState, props: VaultProps, y: number, x: number): Result {
  if (y < TAB_ROWS) {
    const tab = y === 0 ? tabAt(props.tabs, x) : null
    return tab !== null && tab !== 'vault' ? { state, post: { ...postOf(state), tab } } : { state }
  }
  const at = y - TAB_ROWS
  const onButtons = (row: Row | undefined) => row?.kind === 'buttonsTop' || row?.kind === 'buttons' || row?.kind === 'buttonsBottom'
  if (props.state !== 'open') {
    const row = closedRows(props)[at]
    if (row?.kind === 'door') return moved({ ...state, door: row.field })
    if (onButtons(row) && buttonAt(doorButtons(props.state), x) !== undefined) return act(state, { kind: 'open' })
    return moved(state)
  }
  if (state.form !== null) {
    const form = state.form
    const row = formRows(props.error)[at]
    if (row?.kind === 'field') return moved({ ...state, field: row.field })
    if (onButtons(row)) {
      const button = buttonAt(formButtons(form), x)
      if (button?.kind === 'save') return act(state, { kind: 'save', form })
      if (button?.kind === 'delete' && form.id !== null) return act(state, { kind: 'delete', id: form.id })
      if (button?.kind === 'dismiss' && form.suggestion !== null) return act(state, { kind: 'dismiss', id: form.suggestion })
      if (button?.kind === 'cancel') return withEdit({ ...state, form: null }, { field: 'value', kind: 'clear' })
    }
    return { state }
  }
  const all = listRows(props)
  const row = window(all, props.rows - TAB_ROWS, state.selected)[at]
  if (row === undefined || !isSelectable(row)) return { state }
  const selected = all.filter(isSelectable).indexOf(row)
  const chosen = { ...state, selected }
  // The dot at the row's start allows or revokes; the rest opens the entry.
  if (row.kind === 'entry' && x <= 2) return act(chosen, { kind: 'allow', id: row.entry.id, allowed: !row.entry.allowed })
  return open(chosen, row)
}

/** The list rows that fit in `room`, scrolled so the selected one shows. */
export function window(rows: Row[], room: number, selected: number): Row[] {
  if (rows.length <= room) return rows
  const target = rows.indexOf(rows.filter(isSelectable)[selected] ?? rows[0]!)
  const top = Math.max(0, Math.min(rows.length - room, target - room + 1))
  return rows.slice(top, top + room)
}

const KIND_NAMES: Record<EntryKind, string> = { password: 'password', token: 'token', 'ssh-key': 'ssh key' }

const VaultView: ClientModule<VaultProps, ViewState> = (props, surface) => {
  const { Box, Text } = surface.elements
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
  if (state.formEpoch !== props.formEpoch) state = { ...state, form: null, formEpoch: props.formEpoch }
  if (state.isClosed !== isClosed) state = { ...state, isClosed, door: 'passphrase' }
  if (state !== surface.state) surface.setState(state)

  const line = (text: string, look: object = {}) => Text({ ...look, children: [pad(clip(text, columns), columns)] })
  const active = { color: 'claude' as const, bold: true }
  const held = (field: SecretField, isActive: boolean, room: number, empty: string) => {
    const length = shownLength(props.lengths[field], field, state.pending)
    const shown = length > 0 ? '•'.repeat(Math.min(length, room - 1)) : empty
    return Text({ backgroundColor: FIELD_BACKGROUND, bold: isActive, dimColor: length === 0 && !isActive, children: [pad(shown + (isActive ? '▏' : ''), room)] })
  }
  const buttonRow = (kind: 'buttonsTop' | 'buttons' | 'buttonsBottom', buttons: ReturnType<typeof laidOut>) => {
    const faces = buttons.map(b =>
      Text({
        ...(b.kind === 'cancel' || b.kind === 'delete' || b.kind === 'dismiss' ? { color: 'error' as const } : { color: 'claude' as const }),
        children: [' ' + (kind === 'buttonsTop' ? edge('top', b.width) : kind === 'buttonsBottom' ? edge('bottom', b.width) : '│' + b.label + '│')],
      }),
    )
    const used = buttons.reduce((sum, b) => sum + b.width + 1, 0)
    return Box({ flexDirection: 'row', children: [...faces, Text({ children: [' '.repeat(Math.max(0, columns - used))] })] })
  }
  const form = state.form
  let rows
  if (isClosed) {
    rows = closedRows(props).map(row => {
      switch (row.kind) {
        case 'closed':
          return line(' ' + row.text)
        case 'door': {
          const isActive = row.field === state.door
          const room = columns - DOOR_LABEL_COLUMNS - 2
          return Box({
            flexDirection: 'row',
            children: [
              Text({ ...(isActive ? active : { dimColor: true }), children: [pad(' ' + DOOR_LABELS[row.field], DOOR_LABEL_COLUMNS)] }),
              held(row.field, isActive, room, ''),
              Text({ children: ['  '] }),
            ],
          })
        }
        case 'buttonsTop':
        case 'buttons':
        case 'buttonsBottom':
          return buttonRow(row.kind, doorButtons(props.state))
        case 'error':
          return line(' ' + row.text, { color: 'error' })
        default:
          return line('')
      }
    })
  } else if (form === null) {
    const all = listRows(props)
    const chosen = all.filter(isSelectable)[Math.min(state.selected, all.filter(isSelectable).length - 1)]
    rows = window(all, props.rows - TAB_ROWS, state.selected).map(row => {
      const look = row === chosen ? active : {}
      switch (row.kind) {
        case 'add':
          return line(' + Add', look)
        case 'none':
          return line(' No entries', { dimColor: true })
        case 'suggestHead':
          return line(' Typed this session; Enter keeps one', { dimColor: true })
        case 'suggestion':
          return line('   ' + row.suggestion.prompt, look)
        case 'entry': {
          const e = row.entry
          const dot = e.allowed ? '✓ ' : '· '
          const tail = ` ${pad(e.tag, 14)} ${pad(KIND_NAMES[e.kind], 8)} ${e.use === 'each' ? 'each' : ''}`
          const name = clip(e.name, Math.max(4, columns - 1 - 2 - [...tail].length))
          return line(' ' + dot + pad(name, columns - 3 - [...tail].length) + tail, look)
        }
        default:
          return line('')
      }
    })
  } else {
    rows = formRows(props.error).map(row => {
      switch (row.kind) {
        case 'field': {
          const isActive = row.field === state.field
          const room = columns - LABEL_COLUMNS - 2
          const label = Text({
            ...(isActive ? active : { dimColor: true }),
            children: [pad(' ' + (row.field === 'value' && form.kind === 'ssh-key' ? 'File' : LABELS[row.field]), LABEL_COLUMNS)],
          })
          if (row.field === 'value') {
            const value =
              form.suggestion !== null
                ? Text({ backgroundColor: FIELD_BACKGROUND, dimColor: true, children: [pad('typed this session', room)] })
                : held('value', isActive, room, form.id === null ? '' : 'unchanged')
            return Box({ flexDirection: 'row', children: [label, value, Text({ children: ['  '] })] })
          }
          const shown =
            row.field === 'kind'
              ? `‹ ${KIND_NAMES[form.kind]} ›`
              : row.field === 'use'
                ? `‹ ${form.use === 'each' ? 'ask every use' : 'session once allowed'} ›`
                : clip(form[row.field], room - 1)
          const cursor = isActive && row.field !== 'kind' && row.field !== 'use' ? '▏' : ''
          return Box({
            flexDirection: 'row',
            children: [label, Text({ backgroundColor: FIELD_BACKGROUND, bold: isActive, children: [pad(shown + cursor, room)] }), Text({ children: ['  '] })],
          })
        }
        case 'buttonsTop':
        case 'buttons':
        case 'buttonsBottom':
          return buttonRow(row.kind, formButtons(form))
        case 'error':
          return line(' ' + row.text, { color: 'error' })
        default:
          return line('')
      }
    })
  }
  return Box({ flexDirection: 'column', width: columns, children: [...drawTabs(surface.elements, props.tabs, columns), ...rows] })
}

export default VaultView
