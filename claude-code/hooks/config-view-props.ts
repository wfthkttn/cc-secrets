import type { Tab, Tabs } from './tabs'

/** One change to the auto-mode text, numbered per view instance; the hooks hold the text. */
export type TextEdit = { seq: number; kind: 'append'; text: string } | { seq: number; kind: 'back' | 'clear' }

export type ConfigAction =
  | { kind: 'apply' }
  | { kind: 'suggest' }
  | { kind: 'unlockAtStart'; on: boolean }
  | { kind: 'maskMinLength'; value: number }
  | { kind: 'forward'; on: boolean }

export type ConfigProps = {
  tabs: Tabs
  columns: number
  rows: number
  /** The auto-mode text being edited, after the fixed label. */
  draft: string
  /** The text in the user's settings now; null when they hold no such line. */
  applied: string | null
  /** The last text edit the hooks applied, per view instance. */
  confirmed: Record<string, number>
  unlockAtStart: boolean
  maskMinLength: number
  /** Whether the user's own ssh-agent keys are offered too this session; null when there is no agent of theirs. */
  forward: boolean | null
  /** Why the last apply or change failed. */
  error: string | null
}

export type ConfigMessage = {
  instance: string
  edits: TextEdit[]
  /** The text field has the keyboard, so a paste belongs in it. */
  textFocused: boolean
  action?: ConfigAction
  tab?: Tab
}
