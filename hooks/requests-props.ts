export type RequestEntry = {
  id: string
  prompt: string
  /** The command the request came from, as far as the hooks could tell. */
  source: string
  /** Local time it arrived, `HH:MM:SS`. */
  since: string
  /** The length of the value the hooks hold for it so far. */
  length: number
}

/** One change to a request's value, numbered per list instance. */
export type Edit =
  | { seq: number; id: string; kind: 'append'; text: string }
  | { seq: number; id: string; kind: 'back' | 'clear' | 'submit' | 'cancel' }

export type RequestsProps = {
  entries: RequestEntry[]
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
}
