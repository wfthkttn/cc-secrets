import type { Tab, Tabs } from './tabs'

/**
 * One change, numbered per view instance and carried in every post until the hooks confirm it: an edit of the
 * auto-mode text, which the hooks hold, an action, or a click on another tab.
 */
export type TextEdit =
  | { seq: number; kind: 'append'; text: string }
  | { seq: number; kind: 'back' | 'clear' }
  | { seq: number; kind: 'action'; action: ConfigAction }
  | { seq: number; kind: 'tab'; tab: Tab }

export type ConfigAction =
  | { kind: 'apply' }
  | { kind: 'suggest' }
  | { kind: 'unlockAtStart'; on: boolean }
  | { kind: 'maskMinLength'; value: number }
  | { kind: 'forward'; on: boolean }
  | { kind: 'forwardAtStart'; on: boolean }

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
  /** Whether a session starts with them offered. */
  forwardAtStart: boolean
  /** Why the last apply or change failed. */
  error: string | null
}

export type ConfigMessage = {
  instance: string
  edits: TextEdit[]
  /** The text field has the keyboard, so a paste belongs in it. */
  textFocused: boolean
}
