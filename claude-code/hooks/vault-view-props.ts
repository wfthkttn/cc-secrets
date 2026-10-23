import type { TextEdit } from './controls'
import type { Tab, Tabs } from './tabs'
import type { ViewState } from './vault-view'

/** The view's state less its pending edits: what a new instance of the view starts from. */
export type VaultResume = Omit<ViewState, 'pending'>

export type EntryKind = 'password' | 'token' | 'ssh-key'

/** What this session lets its agent have of an entry: a card each time, no card, or nothing. */
export type Access = 'ask' | 'allowed' | 'refused'

/** A vault entry as the view shows it: no value; `access` is this session's, not the vault's. */
export type ViewEntry = { id: string; name: string; tag: string; kind: EntryKind; access: Access }

/** A tag the agent asks for, and what asks with it. */
export type TagChoice = { tag: string; what: string }

/** A value typed this session that the open vault offers to keep: no value. */
export type Suggestion = { id: string; prompt: string }

/** The add or edit form; `id` null adds. With `suggestion`, it saves that suggestion's value as the new entry. */
export type Form = { id: string | null; suggestion: string | null; name: string; tag: string; kind: EntryKind }

/** The fields whose text the hooks hold: an entry's value, the passphrase and its repeat. */
export type SecretField = 'value' | 'passphrase' | 'again'

/** The form's fields whose text the view holds. */
export type TextField = 'name' | 'tag'

/**
 * A paste the hooks took, numbered so the view takes each in once: for Name or Tag its text; for a held field, which
 * the hooks pasted into at the view's caret, only where and how long, so the caret moves past it.
 */
export type VaultPaste = { seq: number; field: TextField; text: string } | { seq: number; field: SecretField; at: number; length: number }

/**
 * One change, numbered per view instance and carried in every post until the hooks confirm it: a held field's edit,
 * an action (a button, Enter, an entry's access) or a click on another tab.
 */
export type ValueEdit =
  | ({ seq: number; field: SecretField } & TextEdit)
  /** `peek` shows the field's text, or hides it again. */
  | { seq: number; field: SecretField; kind: 'peek' }
  | { seq: number; kind: 'action'; action: VaultAction }
  | { seq: number; kind: 'tab'; tab: Tab }

/**
 * A plugin loaded after this one whose hooks see the calls that carry secrets (`carriers`): while one is not
 * allowed, nothing that would carry a secret through them runs. `refused`: it is refused from the next start.
 * `changed`: it was allowed before, with other code.
 */
export type Collision = { name: string; carriers: string[]; refused: boolean; changed: boolean }

export type VaultAction =
  | { kind: 'collision'; name: string; decision: 'allow' | 'refuse' }
  | { kind: 'save'; form: Form }
  | { kind: 'delete'; id: string }
  | { kind: 'dismiss'; id: string }
  | { kind: 'access'; id: string; access: Access }
  /** The entry goes to place `to` in the list. */
  | { kind: 'move'; id: string; to: number }
  /** Unlocks the vault, or creates it when there is none. */
  | { kind: 'open' }
  /** Seals the open vault under the passphrase typed twice. */
  | { kind: 'rekey' }
  /** Closes the vault for every session. */
  | { kind: 'lock' }
  /** The session's ssh-agent offers the user's own agent's keys too, with no card. */
  | { kind: 'forward'; on: boolean }

export type VaultProps = {
  state: 'absent' | 'locked' | 'open'
  /** Shown instead of the vault while any is there. */
  collisions: Collision[]
  entries: ViewEntry[]
  suggestions: Suggestion[]
  /** What the form's tag field offers before the person's own text; tags other entries hold are left out there. */
  tagChoices: TagChoice[]
  /** Whether this session's ssh-agent offers the user's own agent's keys too; null when there is no agent of theirs. */
  forward: boolean | null
  tabs: Tabs
  columns: number
  rows: number
  /** The last value edit the hooks applied, per view instance. */
  applied: Record<string, number>
  /** The length of each held field. */
  lengths: Record<SecretField, number>
  /** The text of each held field the person asked to see; the rest the view knows only by length. */
  peeked: Partial<Record<SecretField, string>>
  /** Pastes the view hasn't confirmed yet (`VaultResume.pasted`). */
  pastes: VaultPaste[]
  /** A change closes the form: the hooks saved or deleted what it showed, or changed the passphrase. */
  formEpoch: number
  /** Why the last save, delete or unlock failed. */
  error: string | null
  /**
   * The state the last instance posted. The sidebar draws the view over the bottom transcript row, so each new row
   * makes a new instance; it goes on from here.
   */
  resume: VaultResume | null
  /** This instance is the sidebar's copy over a held one: it draws `resume` until it gets a click or a key. */
  mirror: boolean
}

export type VaultMessage = {
  instance: string
  edits: ValueEdit[]
  /** The text field with the keyboard, where a paste belongs; null for none. */
  focused: SecretField | TextField | null
  /** The caret in that field, a character index; past the end counts as the end. */
  caret: number
  /** A form is open, which a turn to the Requests tab would drop. */
  formOpen: boolean
  /** The view's state for the next instance; every post from a drawn view carries it. */
  ui?: VaultResume
  /** Posted by a copy that got a click or a key: the keyboard is with it now. */
  claimed?: true
}
