import type { Tabs } from './tabs'

export type EntryKind = 'password' | 'token' | 'ssh-key' | 'typed'
export type EntryUse = 'session' | 'each'

/** A vault entry as the view shows it: no value. */
export type ViewEntry = { id: string; name: string; tag: string; kind: EntryKind; use: EntryUse; allowed: boolean }

/** The add or edit form; `id` null adds. A typed entry edited here becomes a full entry. */
export type Form = { id: string | null; name: string; tag: string; kind: Exclude<EntryKind, 'typed'>; use: EntryUse }

/** One change to the form's value, numbered per view instance; the hooks hold the value. */
export type ValueEdit = { seq: number; kind: 'append'; text: string } | { seq: number; kind: 'back' | 'clear' }

export type VaultAction =
  | { kind: 'save'; form: Form }
  | { kind: 'delete'; id: string }
  | { kind: 'allow'; id: string; allowed: boolean }
  | { kind: 'unlock' }
  | { kind: 'forward'; on: boolean }

export type VaultProps = {
  state: 'absent' | 'locked' | 'open'
  entries: ViewEntry[]
  /** Whether the user's own ssh-agent keys are offered too; null when there is no agent of theirs. */
  forward: boolean | null
  tabs: Tabs
  columns: number
  rows: number
  /** The last value edit the hooks applied, per view instance. */
  applied: Record<string, number>
  /** The length of the value the hooks hold for the form. */
  valueLength: number
  /** A change closes the form: the hooks saved or deleted what it showed. */
  formEpoch: number
  /** Why the last save or delete failed, shown in the form. */
  error: string | null
}

export type VaultMessage = {
  instance: string
  edits: ValueEdit[]
  /** The form's value field has the keyboard, so a paste belongs in it. */
  valueFocused: boolean
  /** A form is open, which a turn to the Requests tab would drop. */
  formOpen: boolean
  action?: VaultAction
  tab?: 'requests'
}
