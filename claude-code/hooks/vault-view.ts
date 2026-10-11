import type { ClientKeyEvent, ClientModule } from 'claude-code'

import { drawTabs, TAB_ROWS, tabAt } from './tabs'
import type { EntryKind, EntryUse, Form, ValueEdit, VaultAction, VaultMessage, VaultProps, ViewEntry } from './vault-view-props'

type Field = 'name' | 'tag' | 'kind' | 'use' | 'value'

export type ViewState = {
  instance: string
  seq: number
  /** Value edits sent but not yet confirmed by the hooks. */
  pending: ValueEdit[]
  form: Form | null
  field: Field
  /** The selected row among the list's selectable ones. */
  selected: number
  formEpoch: number
}

/** One row under the tabs: the list's, or the form's. */
export type Row =
  | { kind: 'add' }
  | { kind: 'entry' | 'typed'; entry: ViewEntry }
  | { kind: 'typedHead' | 'none' }
  | { kind: 'closed'; text: string; button: string }
  | { kind: 'forward'; on: boolean }
  | { kind: 'field'; field: Field }
  | { kind: 'gap' | 'buttonsTop' | 'buttons' | 'buttonsBottom' }
  | { kind: 'error'; text: string }

type Result = { state: ViewState; post?: VaultMessage }

const FIELDS: readonly Field[] = ['name', 'tag', 'kind', 'use', 'value']
const LABELS: Record<Field, string> = { name: 'Name', tag: 'Tag', kind: 'Kind', use: 'Use', value: 'Value' }
const LABEL_COLUMNS = 7
const KINDS: readonly Form['kind'][] = ['password', 'token', 'ssh-key']
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

export function initialState(formEpoch: number, instance: string): ViewState {
  return { instance, seq: 0, pending: [], form: null, field: 'name', selected: 0, formEpoch }
}

export function listRows(props: Pick<VaultProps, 'state' | 'entries' | 'forward'>): Row[] {
  const forward: Row[] = props.forward === null ? [] : [{ kind: 'forward', on: props.forward }]
  if (props.state === 'absent') return [{ kind: 'closed', text: 'No vault yet.', button: ' Create ' }, ...forward]
  if (props.state === 'locked') return [{ kind: 'closed', text: 'Vault locked.', button: ' Unlock ' }, ...forward]
  const full = props.entries.filter(e => e.kind !== 'typed')
  const typed = props.entries.filter(e => e.kind === 'typed')
  const rows: Row[] = [{ kind: 'add' }]
  if (full.length === 0 && typed.length === 0) rows.push({ kind: 'none' })
  for (const entry of full) rows.push({ kind: 'entry', entry })
  rows.push(...forward)
  if (typed.length > 0) rows.push({ kind: 'typedHead' })
  for (const entry of typed) rows.push({ kind: 'typed', entry })
  return rows
}

export function formRows(error: string | null): Row[] {
  const rows: Row[] = FIELDS.map(field => ({ kind: 'field', field }))
  rows.push({ kind: 'gap' }, { kind: 'buttonsTop' }, { kind: 'buttons' }, { kind: 'buttonsBottom' })
  if (error !== null) rows.push({ kind: 'error', text: error })
  return rows
}

function isSelectable(row: Row): boolean {
  return row.kind === 'add' || row.kind === 'entry' || row.kind === 'typed' || row.kind === 'closed' || row.kind === 'forward'
}

/** The form's buttons from the left, each boxed, a column apart; Delete only on an entry that exists. */
export function formButtons(form: Form) {
  const labels = [
    { kind: 'save', label: ' Save ' },
    ...(form.id === null ? [] : [{ kind: 'delete', label: ' Delete ' }]),
    { kind: 'cancel', label: ' ✕ ' },
  ] as const
  let start = 1
  return labels.map(b => {
    const button = { ...b, start, width: [...b.label].length + 2 }
    start += button.width + 1
    return button
  })
}

/** The row's button under the closed vault's text: where it starts. */
function closedButtonStart(text: string): number {
  return 1 + [...text].length + 2
}

function postOf(state: ViewState, edits = state.pending, action?: VaultAction): VaultMessage {
  const valueFocused = state.form !== null && state.field === 'value'
  return { instance: state.instance, edits, valueFocused, formOpen: state.form !== null, ...(action === undefined ? {} : { action }) }
}

/** Moves the form's keyboard to `field`; the hooks learn whether a paste now goes to the value. */
function focusField(state: ViewState, field: Field): Result {
  const moved = { ...state, field }
  return { state: moved, post: postOf(moved) }
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

export function shownLength(length: number, pending: ValueEdit[]): number {
  for (const edit of pending) {
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
      ? { id: null, name: '', tag: '', kind: 'password', use: 'session' }
      : row.kind === 'entry'
        ? { id: row.entry.id, name: row.entry.name, tag: row.entry.tag, kind: row.entry.kind === 'typed' ? 'password' : row.entry.kind, use: row.entry.use }
        : row.kind === 'typed'
          ? { id: row.entry.id, name: row.entry.name, tag: '', kind: 'password', use: 'session' }
          : null
  if (form === null) return { state }
  return withEdit({ ...state, form, field: 'name' }, { kind: 'clear' })
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

function onFormKey(state: ViewState, form: Form, k: ClientKeyEvent): Result {
  const at = FIELDS.indexOf(state.field)
  if (k.key === 'up' || k.key === 'down' || k.key === 'tab') {
    const step = k.key === 'up' || (k.key === 'tab' && k.shift) ? -1 : 1
    return focusField(state, FIELDS[Math.max(0, Math.min(FIELDS.length - 1, at + step))]!)
  }
  if (k.key === 'return' || k.key === '\n') return act(state, { kind: 'save', form })
  if (state.field === 'kind' || state.field === 'use') {
    const step = k.key === 'left' ? -1 : k.key === 'right' || k.key === 'space' ? 1 : 0
    if (step === 0) return { state }
    const next = state.field === 'kind' ? { ...form, kind: cycle(KINDS, form.kind, step) } : { ...form, use: cycle(USES, form.use, step) }
    return { state: { ...state, form: next } }
  }
  if (state.field === 'value') {
    if (k.key === 'backspace' || k.key === 'delete') return withEdit(state, { kind: 'back' })
    if (k.ctrl && k.key === 'u') return withEdit(state, { kind: 'clear' })
    const text = typedText(k)
    return text === null ? { state } : withEdit(state, { kind: 'append', text })
  }
  const key = state.field
  const value = form[key]
  if (k.key === 'backspace' || k.key === 'delete') return { state: { ...state, form: { ...form, [key]: [...value].slice(0, -1).join('') } } }
  if (k.ctrl && k.key === 'u') return { state: { ...state, form: { ...form, [key]: '' } } }
  const text = typedText(k)
  return text === null ? { state } : { state: { ...state, form: { ...form, [key]: value + text } } }
}

export function onKey(state: ViewState, props: Pick<VaultProps, 'state' | 'entries' | 'forward'>, k: ClientKeyEvent): Result {
  if (state.form !== null) return onFormKey(state, state.form, k)
  const rows = listRows(props).filter(isSelectable)
  const selected = Math.min(state.selected, rows.length - 1)
  if (k.key === 'up' || k.key === 'down') return { state: { ...state, selected: Math.max(0, Math.min(rows.length - 1, selected + (k.key === 'up' ? -1 : 1))) } }
  const row = rows[selected]
  if (row === undefined) return { state }
  if (row.kind === 'entry' && k.key === 'space') return act(state, { kind: 'allow', id: row.entry.id, allowed: !row.entry.allowed })
  if (k.key !== 'return' && k.key !== '\n' && !(row.kind === 'forward' && k.key === 'space')) return { state }
  if (row.kind === 'forward') return act(state, { kind: 'forward', on: !row.on })
  return row.kind === 'closed' ? act(state, { kind: 'unlock' }) : open(state, row)
}

/** `y` and `x` count from the view's top left, the tab rows included. */
export function onClick(state: ViewState, props: VaultProps, y: number, x: number): Result {
  if (y < TAB_ROWS) {
    return y === 0 && tabAt(props.tabs, x) === 'requests' ? { state, post: { ...postOf(state), tab: 'requests' } } : { state }
  }
  const at = y - TAB_ROWS
  if (state.form !== null) {
    const row = formRows(props.error)[at]
    if (row?.kind === 'field') return focusField(state, row.field)
    if (row?.kind === 'buttonsTop' || row?.kind === 'buttons' || row?.kind === 'buttonsBottom') {
      const button = formButtons(state.form).find(b => x >= b.start && x < b.start + b.width)
      if (button?.kind === 'save') return act(state, { kind: 'save', form: state.form })
      if (button?.kind === 'delete' && state.form.id !== null) return act(state, { kind: 'delete', id: state.form.id })
      if (button?.kind === 'cancel') return withEdit({ ...state, form: null }, { kind: 'clear' })
    }
    return { state }
  }
  const all = listRows(props)
  const row = window(all, props.rows - TAB_ROWS, state.selected)[at]
  if (row === undefined || !isSelectable(row)) return { state }
  const selected = all.filter(isSelectable).indexOf(row)
  const moved = { ...state, selected }
  if (row.kind === 'closed') return x >= closedButtonStart(row.text) ? act(moved, { kind: 'unlock' }) : { state: moved }
  if (row.kind === 'forward') return act(moved, { kind: 'forward', on: !row.on })
  // The dot at the row's start allows or revokes; the rest opens the entry.
  if (row.kind === 'entry' && x <= 2) return act(moved, { kind: 'allow', id: row.entry.id, allowed: !row.entry.allowed })
  return open(moved, row)
}

/** The list rows that fit in `room`, scrolled so the selected one shows. */
export function window(rows: Row[], room: number, selected: number): Row[] {
  if (rows.length <= room) return rows
  const target = rows.indexOf(rows.filter(isSelectable)[selected] ?? rows[0]!)
  const top = Math.max(0, Math.min(rows.length - room, target - room + 1))
  return rows.slice(top, top + room)
}

const KIND_NAMES: Record<EntryKind, string> = { password: 'password', token: 'token', 'ssh-key': 'ssh key', typed: 'typed' }

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
  let state = surface.state ?? initialState(props.formEpoch, Math.random().toString(36).slice(2))
  const confirmed = confirm(state, props.applied[state.instance])
  if (confirmed !== null) state = confirmed
  if (state.formEpoch !== props.formEpoch) state = { ...state, form: null, formEpoch: props.formEpoch }
  if (state !== surface.state) surface.setState(state)

  const line = (text: string, look: object = {}) => Text({ ...look, children: [pad(clip(text, columns), columns)] })
  const form = state.form
  let rows
  if (form === null) {
    const all = listRows(props)
    const chosen = all.filter(isSelectable)[Math.min(state.selected, all.filter(isSelectable).length - 1)]
    rows = window(all, props.rows - TAB_ROWS, state.selected).map(row => {
      const look = row === chosen ? { color: 'claude' as const, bold: true } : {}
      switch (row.kind) {
        case 'closed': {
          const lead = ' ' + row.text + '  '
          return Box({ flexDirection: 'row', children: [Text({ children: [lead] }), Text({ ...look, children: ['[' + row.button + ']'] }), Text({ children: [' '.repeat(Math.max(0, columns - [...lead].length - [...row.button].length - 2))] })] })
        }
        case 'add':
          return line(' + Add', look)
        case 'none':
          return line(' No entries', { dimColor: true })
        case 'typedHead':
          return line(' Typed, masking only; Enter saves one as an entry', { dimColor: true })
        case 'forward':
          return line(` ${row.on ? '✓' : '·'} Your ssh-agent's keys too`, look)
        case 'entry':
        case 'typed': {
          const e = row.entry
          const dot = row.kind === 'typed' ? '  ' : e.allowed ? '✓ ' : '· '
          const tail = row.kind === 'typed' ? '' : ` ${pad(e.tag, 14)} ${pad(KIND_NAMES[e.kind], 8)} ${e.use === 'each' ? 'each' : ''}`
          const name = clip(e.name, Math.max(4, columns - 1 - 2 - [...tail].length))
          return line(' ' + dot + pad(name, columns - 3 - [...tail].length) + tail, look)
        }
        default:
          return line('')
      }
    })
  } else {
    const valueLength = shownLength(props.valueLength, state.pending)
    rows = formRows(props.error).map(row => {
      switch (row.kind) {
        case 'field': {
          const isActive = row.field === state.field
          const room = columns - LABEL_COLUMNS - 2
          const shown =
            row.field === 'value'
              ? valueLength > 0
                ? '•'.repeat(Math.min(valueLength, room - 1))
                : form.id === null
                  ? ''
                  : 'unchanged'
              : row.field === 'kind'
                ? `‹ ${KIND_NAMES[form.kind]} ›`
                : row.field === 'use'
                  ? `‹ ${form.use === 'each' ? 'ask every use' : 'session once allowed'} ›`
                  : clip(form[row.field], room - 1)
          return Box({
            flexDirection: 'row',
            children: [
              Text({
                ...(isActive ? { color: 'claude' as const, bold: true } : { dimColor: true }),
                children: [pad(' ' + (row.field === 'value' && form.kind === 'ssh-key' ? 'File' : LABELS[row.field]), LABEL_COLUMNS)],
              }),
              Text({ backgroundColor: FIELD_BACKGROUND, bold: isActive, children: [pad(shown + (isActive && row.field !== 'kind' && row.field !== 'use' ? '▏' : ''), room)] }),
              Text({ children: ['  '] }),
            ],
          })
        }
        case 'buttonsTop':
        case 'buttons':
        case 'buttonsBottom': {
          const faces = formButtons(form).map(b =>
            Text({
              ...(b.kind === 'cancel' || b.kind === 'delete' ? { color: 'error' as const } : { color: 'claude' as const }),
              children: [' ' + (row.kind === 'buttonsTop' ? edge('top', b.width) : row.kind === 'buttonsBottom' ? edge('bottom', b.width) : '│' + b.label + '│')],
            }),
          )
          const used = formButtons(form).reduce((sum, b) => sum + b.width + 1, 0)
          return Box({ flexDirection: 'row', children: [...faces, Text({ children: [' '.repeat(Math.max(0, columns - used))] })] })
        }
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
