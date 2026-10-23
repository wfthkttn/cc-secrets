import type { PasteMark, TextEdit } from './controls'
import type { ListState } from './requests'
import type { Tab, Tabs } from './tabs'

/** A paste the hooks made into a request's value at the list's caret. */
export type RequestPaste = PasteMark & { id: string }

/** The list's state less its pending edits, which hold typed characters: what a new instance starts from. */
export type ListResume = Omit<ListState, 'pending'>

/** A vault entry a request can be answered with: no value. */
export type Offered = { id: string; label: string }

export type RequestEntry = {
  id: string
  /** `secret` takes a typed value or, with `offer`, a vault entry; `sign` asks whether a command signs with a vault key. */
  kind: 'secret' | 'sign'
  prompt: string
  /** The command the request came from, as far as the hooks could tell. */
  source: string
  /** Local time it arrived, `HH:MM:SS`. */
  since: string
  /** The length of the value the hooks hold for it so far. */
  length: number
  /** That value itself while the person asked to see it; null otherwise. */
  text: string | null
  /** The open vault's entries to pick from; null when the vault is closed or the asker may not have them. */
  offer: Offered[] | null
  /** The entry the field holds, as chosen in its menu or else named by the request's tag; null while it takes typing. */
  chosen: string | null
}

/**
 * One change, numbered per list instance and carried in every post until the hooks confirm it, so a post replaced
 * before delivery loses none: a request's value (`peek` shows or hides it), its answer (`session` and `once` with an
 * entry), its menu choice (`choose`, null for typing), and the list's own clicks (`dismiss` the message, `tab`).
 */
export type Edit =
  | ({ seq: number; id: string } & TextEdit)
  | { seq: number; id: string; kind: 'submit' | 'cancel' | 'peek' }
  | { seq: number; id: string; kind: 'session' | 'once'; entry: string | null }
  | { seq: number; id: string; kind: 'choose'; entry: string | null }
  | { seq: number; kind: 'dismiss' }
  | { seq: number; kind: 'tab'; tab: Tab }

export type RequestsProps = {
  entries: RequestEntry[]
  /** The drawer's tab row above the cards; null in the pop-out. */
  tabs: Tabs | null
  /** A change drops the list's focused look. */
  focusEpoch: number
  /** The last edit number the hooks applied, per list instance. */
  applied: Record<string, number>
  /** Shown above the cards with a ✕ that dismisses it. */
  message: string | null
  /** Why a typed value can't be sent now (a plugin could read it); null when it can. A vault entry still can. */
  typingOff: string | null
  /** The list's width. */
  columns: number
  /** The list's height; cards past it scroll. */
  rows: number
  /** Pastes into the shown requests' values that a list may not have taken in yet (`ListResume.pasted`). */
  pastes: RequestPaste[]
  /** The state the last instance posted; a new instance (each new transcript row makes one) goes on from here. */
  resume: ListResume | null
  /** This instance is the sidebar's copy over a held one: it draws `resume` until it gets a click or a key. */
  mirror: boolean
}

/**
 * Sent when the list takes the focus, its selection changes, or it has edits
 * the hooks haven't confirmed; carries every one of those, so a post replaced
 * before delivery loses nothing.
 */
export type RequestsMessage = {
  instance: string
  selected: string | null
  edits: Edit[]
  /** The caret in the selected request's value, where a paste goes; past the end counts as the end. */
  caret: number
  /** The list's state for the next instance; every post from a drawn list carries it. */
  ui?: ListResume
  /** Posted by a copy that got a click or a key: the keyboard is with it now. */
  claimed?: true
}
