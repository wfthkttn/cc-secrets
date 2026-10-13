import type { Tab, Tabs } from './tabs'

export type EntryKind = 'password' | 'token' | 'ssh-key'
export type EntryUse = 'session' | 'each'

/** What this session lets its agent have of an entry: a card each time, no card, or nothing. */
export type Access = 'ask' | 'allowed' | 'refused'

/** A vault entry as the view shows it: no value; `access` is this session's, not the vault's. */
export type ViewEntry = { id: string; name: string; tag: string; kind: EntryKind; use: EntryUse; access: Access }

/** A tag the agent asks for, and what asks with it. */
export type TagChoice = { tag: string; what: string }

/** A value typed this session that the open vault offers to keep: no value. */
export type Suggestion = { id: string; prompt: string }

/** The add or edit form; `id` null adds. With `suggestion`, it saves that suggestion's value as the new entry. */
export type Form = { id: string | null; suggestion: string | null; name: string; tag: string; kind: EntryKind; use: EntryUse }

/** The fields whose text the hooks hold: an entry's value, the passphrase and its repeat. */
export type SecretField = 'value' | 'passphrase' | 'again'

/**
 * One change, numbered per view instance and carried in every post until the hooks confirm it: a held field's edit,
 * an action (a button, Enter, an entry's access) or a click on another tab.
 */
export type ValueEdit =
  | { seq: number; field: SecretField; kind: 'append'; text: string }
  /** `peek` shows the field's text, or hides it again. */
  | { seq: number; field: SecretField; kind: 'back' | 'clear' | 'peek' }
  | { seq: number; kind: 'action'; action: VaultAction }
  | { seq: number; kind: 'tab'; tab: Tab }

/**
 * A plugin loaded after this one whose hooks see the calls that carry secrets (`carriers`): while one is not
 * allowed, nothing that would carry a secret through them runs. `refused`: it is refused from the next start.
 */
export type Collision = { name: string; carriers: string[]; refused: boolean }

export type VaultAction =
  | { kind: 'collision'; name: string; decision: 'allow' | 'refuse' }
  | { kind: 'save'; form: Form }
  | { kind: 'delete'; id: string }
  | { kind: 'dismiss'; id: string }
  | { kind: 'access'; id: string; access: Access }
  /** Unlocks the vault, or creates it when there is none. */
  | { kind: 'open' }
  /** Seals the open vault under the passphrase typed twice. */
  | { kind: 'rekey' }

export type VaultProps = {
  state: 'absent' | 'locked' | 'open'
  /** Shown instead of the vault while any is there. */
  collisions: Collision[]
  entries: ViewEntry[]
  suggestions: Suggestion[]
  /** What the form's tag field offers before the person's own text; tags other entries hold are left out there. */
  tagChoices: TagChoice[]
  tabs: Tabs
  columns: number
  rows: number
  /** The last value edit the hooks applied, per view instance. */
  applied: Record<string, number>
  /** The length of each held field. */
  lengths: Record<SecretField, number>
  /** The text of each held field the person asked to see; the rest the view knows only by length. */
  peeked: Partial<Record<SecretField, string>>
  /** A change closes the form: the hooks saved or deleted what it showed, or changed the passphrase. */
  formEpoch: number
  /** Why the last save, delete or unlock failed. */
  error: string | null
}

export type VaultMessage = {
  instance: string
  edits: ValueEdit[]
  /** The held field with the keyboard, where a paste belongs; null for none. */
  focused: SecretField | null
  /** A form is open, which a turn to the Requests tab would drop. */
  formOpen: boolean
}
