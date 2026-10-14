import type { ClientKeyEvent } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SUGGESTED } from '../hooks/auto-mode'
import ConfigView, { type ConfigState, confirm, drawPage, initialState, onClick, onKey, shownText, status, wrap } from '../hooks/config-view'
import type { ConfigProps, TextEdit } from '../hooks/config-view-props'
import { hitAt } from '../hooks/controls'
import { TAB_ROWS, tabSpans } from '../hooks/tabs'

const isTab = (e: TextEdit): e is Extract<TextEdit, { kind: 'tab' }> => e.kind === 'tab'
const actionOf = (r: { post?: { edits: TextEdit[] } }) => r.post?.edits.findLast((e): e is Extract<TextEdit, { kind: 'action' }> => e.kind === 'action')?.action

const PROPS: ConfigProps = {
  tabs: { active: 'config', requests: 0, vaultMark: false },
  columns: 60,
  rows: 30,
  draft: 'mine',
  applied: null,
  confirmed: {},
  unlockAtStart: true,
  maskMinLength: 6,
  error: null,
  resume: null,
}
const START = initialState('c1')
const key = (k: string, mods: { ctrl?: true; shift?: true } = {}): ClientKeyEvent => ({ key: k, ...mods })

/** A click on the first cell the control `hit` takes. */
function click(state: ConfigState, hit: string, props = PROPS) {
  const lines = drawPage(props, state)
  for (let y = 0; y < lines.length; y++) {
    for (let x = 0; x < props.columns; x++) if (hitAt(lines[y], x) === hit) return onClick(state, props, y + TAB_ROWS, x)
  }
  throw new Error(`no ${hit} drawn`)
}

function draw(props: ConfigProps, state?: ConfigState) {
  let current: unknown = state
  const surface = {
    elements: { Box: (p: object) => ({ type: 'Box', ...p }), Text: (p: object) => ({ type: 'Text', ...p }) },
    get state() {
      return current
    },
    setState: (next: unknown) => {
      current = next
    },
    columns: 0,
    rows: 0,
    every: () => () => {},
    onPointer: () => () => {},
    onKey: () => () => {},
    post: () => {},
  }
  const text = (node: unknown): string => (typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join(''))
  const view = ConfigView as unknown as (p: ConfigProps, s: typeof surface) => { children: unknown[] }
  return view(props, surface).children.map(text)
}

test('two sections: Vault with a checkbox and a stepper, then Auto mode with its status, the text box, Apply and Suggested', async () => {
  const rows = draw(PROPS, START)
  for (const row of rows) expect([...row].length).toBe(PROPS.columns)
  const under = rows.slice(TAB_ROWS)
  expect(under[0]).toMatch(/^ Vault +$/)
  expect(under[1]).toMatch(/^ \[x\] Unlock the vault at session start +$/)
  expect(under[2]).toMatch(/^ Mask values of at least \[ - \] {2}6 {2}\[ \+ \] characters +$/)
  expect(under[4]).toMatch(/^ Auto mode · Secrets management +not in settings $/)
  expect(under[5]).toMatch(/^┌─+┐$/)
  expect(under[6]).toMatch(/^│ mine▏ +│$/)
  expect(under[7]).toMatch(/^└─+┘$/)
  expect(under[9]).toMatch(/^ │ Apply │ │ Suggested │ +$/)
  expect(draw({ ...PROPS, unlockAtStart: false }, START)[TAB_ROWS + 1]).toMatch(/^ \[ \] Unlock/)
})

test('the status compares the shown text with the line in the settings', async () => {
  expect(status('mine', null)).toBe('not in settings')
  expect(status('mine', 'mine')).toBe('applied')
  expect(status('mine!', 'mine')).toBe('changed, not applied')
})

test("typing shows at once as unconfirmed edits; the hooks' confirmation drops them", async () => {
  const typed = onKey(START, PROPS, key('!'))
  expect(typed.post).toEqual({ instance: 'c1', edits: [{ kind: 'append', text: '!', seq: 1 }], textFocused: true })
  const back = onKey(typed.state, PROPS, key('backspace'))
  expect(shownText(PROPS.draft, back.state.pending)).toBe('mine')
  expect(shownText(PROPS.draft, onKey(back.state, PROPS, key('u', { ctrl: true })).state.pending)).toBe('')
  expect(onKey(START, PROPS, key('space')).post?.edits).toEqual([{ kind: 'append', text: ' ', seq: 1 }])
  expect(confirm(back.state, 1)?.pending).toEqual([{ kind: 'back', seq: 2 }])
  expect(confirm(back.state, 2)?.pending).toEqual([])
  expect(confirm(START, 3)).toBe(null)
})

test('Enter in the text applies; Apply and Suggested press from any cell of their boxes', async () => {
  expect(actionOf(onKey(START, PROPS, key('return')))).toEqual({ kind: 'apply' })
  expect(actionOf(click(START, 'apply'))).toEqual({ kind: 'apply' })
  expect(actionOf(click(START, 'suggest'))).toEqual({ kind: 'suggest' })
  expect(click(START, 'text').state.focus).toBe('text')
})

test('the keyboard walks the controls in reading order: ↑/↓ by line, ←/→ along the buttons, Tab through all', async () => {
  const at = (keys: ClientKeyEvent[]) => keys.reduce((state, k) => onKey(state, PROPS, k).state, START).focus
  expect(at([key('up')])).toBe('mask')
  expect(at([key('up'), key('up')])).toBe('unlock')
  expect(at([key('down')])).toBe('apply')
  expect(at([key('down'), key('right')])).toBe('suggest')
  expect(at([key('tab')])).toBe('apply')
  expect(at([key('tab', { shift: true })])).toBe('mask')
  expect(onKey(START, PROPS, key('up')).post?.textFocused).toBe(false)
  expect(onKey({ ...START, focus: 'mask' }, PROPS, key('down')).post?.textFocused).toBe(true)
})

test('Space or Enter flips the checkbox; ←/→ or -/+ step the mask minimum, never below 1', async () => {
  const at = (focus: ConfigState['focus']) => ({ ...START, focus })
  expect(actionOf(onKey(at('unlock'), PROPS, key('space')))).toEqual({ kind: 'unlockAtStart', on: false })
  expect(actionOf(onKey(at('unlock'), PROPS, key('return')))).toEqual({ kind: 'unlockAtStart', on: false })
  expect(actionOf(onKey(at('mask'), PROPS, key('right')))).toEqual({ kind: 'maskMinLength', value: 7 })
  expect(actionOf(onKey(at('mask'), PROPS, key('-')))).toEqual({ kind: 'maskMinLength', value: 5 })
  expect(onKey(at('mask'), { ...PROPS, maskMinLength: 1 }, key('left')).post?.edits).toEqual([])
  expect(onKey(at('unlock'), PROPS, key('x')).post).toBe(undefined)
  expect(actionOf(onKey(at('apply'), PROPS, key('space')))).toEqual({ kind: 'apply' })
})

test('clicks: the checkbox toggles, the stepper buttons step, the text around them does nothing, a tab turns the drawer', async () => {
  expect(actionOf(click(START, 'unlock'))).toEqual({ kind: 'unlockAtStart', on: false })
  expect(actionOf(click(START, 'mask-'))).toEqual({ kind: 'maskMinLength', value: 5 })
  expect(actionOf(click(START, 'mask+'))).toEqual({ kind: 'maskMinLength', value: 7 })
  expect(onClick(START, PROPS, TAB_ROWS + 2, 3).post).toBe(undefined)
  expect(onClick(START, PROPS, TAB_ROWS + 3, 3).post).toBe(undefined)
  const vault = tabSpans(PROPS.tabs).find(s => s.tab === 'vault')!
  expect(onClick(START, PROPS, 0, vault.start).post?.edits.find(isTab)?.tab).toBe('vault')
  const config = tabSpans(PROPS.tabs).find(s => s.tab === 'config')!
  expect(onClick(START, PROPS, 0, config.start).post).toBe(undefined)
})

test('a text longer than the room shows its end, where typing goes', async () => {
  const lines = drawPage({ ...PROPS, rows: TAB_ROWS + 11 + 2, draft: 'a'.repeat(56 * 5) }, { focus: 'apply', pending: [] })
  const text = lines.filter(l => l.some(s => s.hit === 'text') && l.length === 3)
  expect(text.length).toBe(2)
  expect(text.at(-1)![1]!.text).toBe('a'.repeat(56))
})

test('rows break after a space; a word longer than a row is cut; a full last row puts the cursor on the next', async () => {
  expect(wrap('aaa bbb ccc', 9, false)).toEqual(['aaa bbb ', 'ccc'])
  expect(wrap('aaa bbbbbbbbbbb', 6, false)).toEqual(['aaa ', 'bbbbbb', 'bbbbb'])
  expect(wrap('aaa bbbbb ccc', 9, false)).toEqual(['aaa bbbbb', ' ccc'])
  expect(wrap('aaaaaa', 6, true)).toEqual(['aaaaaa', ''])
  expect(wrap('aaaaaa', 6, false)).toEqual(['aaaaaa'])
  expect(wrap('', 6, false)).toEqual([''])
  expect(wrap(SUGGESTED, 56, true).join('')).toBe(SUGGESTED)
})

test('every drawn row is as wide as the view, the suggested text and an error included', async () => {
  for (const line of draw({ ...PROPS, draft: SUGGESTED }, START)) expect([...line].length).toBe(PROPS.columns)
  for (const line of draw({ ...PROPS, draft: 'x'.repeat(56) }, START)) expect([...line].length).toBe(PROPS.columns)
  const lines = draw({ ...PROPS, error: 'Not applied: EACCES', draft: 'x'.repeat(130) }, START)
  for (const line of lines) expect([...line].length).toBe(PROPS.columns)
  expect(lines.at(-1)).toMatch(/^ Not applied: EACCES/)
})
