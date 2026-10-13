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
  /** The open vault's entries to pick from; null when the vault is closed or the asker may not have them. */
  offer: Offered[] | null
  /** The entry the request named by its tag, shown ready to give; null when it named none or the vault has no such entry. */
  preset: string | null
}

/** One change to a request's value, numbered per list instance; `session` and `once` answer with an entry. */
export type Edit =
  | { seq: number; id: string; kind: 'append'; text: string }
  | { seq: number; id: string; kind: 'back' | 'clear' | 'submit' | 'cancel' }
  | { seq: number; id: string; kind: 'session' | 'once'; entry: string | null }

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
  /** The message's ✕ was clicked. */
  dismiss?: true
  /** Another tab was clicked. */
  tab?: Tab
}
