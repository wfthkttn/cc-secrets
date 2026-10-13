import type { Tab, Tabs } from './tabs'

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
  | { seq: number; id: string; kind: 'append'; text: string }
  | { seq: number; id: string; kind: 'back' | 'clear' | 'submit' | 'cancel' | 'peek' }
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
}
