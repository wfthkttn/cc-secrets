import type { ClientKeyEvent } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SUGGESTED } from '../hooks/auto-mode'
import ConfigView, { type ConfigState, confirm, drawPage, initialState, onClick, onKey, shownText, status, withPastes, wrap } from '../hooks/config-view'
import type { ConfigProps, TextEdit } from '../hooks/config-view-props'
import { hitAt, type Line, textPieces } from '../hooks/controls'
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
  pastes: [],
  unlockAtStart: true,
  maskMinLength: 6,
  error: null,
  resume: null,
  mirror: false,
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

test('two sections: Vault with a checkbox and a stepper, then Auto mode with its status, the text box, Save and Reset to default', async () => {
  const rows = draw(PROPS, START)
  for (const row of rows) expect([...row].length).toBe(PROPS.columns)
  expect(rows[0]).toContain(' Settings ')
  const under = rows.slice(TAB_ROWS)
  expect(under[0]).toMatch(/^ Vault +$/)
  expect(under[1]).toMatch(/^ \[x\] Ask to unlock at session start +$/)
  expect(under[2]).toMatch(/^ Mask values of at least \[ - \] {2}6 {2}\[ \+ \] characters +$/)
  expect(under[4]).toMatch(/^ Auto mode rule +not set $/)
  expect(under[5]).toMatch(/^┌─+┐$/)
  expect(under[6]).toMatch(/^│ mine▏ +│$/)
  expect(under[7]).toMatch(/^└─+┘$/)
  expect(under[9]).toMatch(/^ │ Save │ │ Reset to default │ +$/)
  expect(draw({ ...PROPS, unlockAtStart: false }, START)[TAB_ROWS + 1]).toMatch(/^ \[ \] Ask to unlock/)
})

test('the status compares the shown text with the line in the settings', async () => {
  expect(status('mine', null)).toBe('not set')
  expect(status('mine', 'mine')).toBe('saved')
  expect(status('mine!', 'mine')).toBe('unsaved changes')
})

test("typing shows at once as unconfirmed edits; the hooks' confirmation drops them", async () => {
  const typed = onKey(START, PROPS, key('!'))
  expect(typed.post).toEqual({ instance: 'c1', edits: [{ kind: 'insert', at: 4, text: '!', seq: 1 }], textFocused: true, caret: 5 })
  const back = onKey(typed.state, PROPS, key('backspace'))
  expect(shownText(PROPS.draft, back.state.pending)).toBe('mine')
  expect(shownText(PROPS.draft, onKey(back.state, PROPS, key('u', { ctrl: true })).state.pending)).toBe('')
  expect(onKey(START, PROPS, key('space')).post?.edits).toEqual([{ kind: 'insert', at: 4, text: ' ', seq: 1 }])
  expect(confirm(back.state, 1)?.pending).toEqual([{ kind: 'back', at: 5, seq: 2 }])
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

/** The text box's rows as drawn: each row's text, the caret included. */
const boxRows = (lines: Line[]) => lines.filter(l => l.some(s => s.hit?.startsWith('text@'))).map(l => l.slice(1, -2).map(s => s.text).join(''))

test('a text longer than the room shows its end, or from the caret when it is above that', async () => {
  const props = { ...PROPS, rows: TAB_ROWS + 11 + 2, draft: 'a'.repeat(56 * 4) + 'b'.repeat(56) }
  expect(boxRows(drawPage(props, { focus: 'apply', pending: [], caret: 0 }))).toEqual(['a'.repeat(56), 'b'.repeat(56)])
  expect(boxRows(drawPage(props, { focus: 'text', pending: [], caret: 0 }))).toEqual(['▏' + 'a'.repeat(55), 'a'.repeat(56)])
  expect(boxRows(drawPage(props, { focus: 'text', pending: [], caret: 56 * 5 })).at(-1)).toBe('▏')
})

test('rows break after a space; a word longer than a row is cut; a caret past a full row takes the next', async () => {
  const rows = (text: string, width: number, caret: number | null = null) => wrap(textPieces(text, caret), width).map(r => r.map(p => p.text).join(''))
  expect(rows('aaa bbb ccc', 9)).toEqual(['aaa bbb ', 'ccc'])
  expect(rows('aaa bbbbbbbbbbb', 6)).toEqual(['aaa ', 'bbbbbb', 'bbbbb'])
  expect(rows('aaa bbbbb ccc', 9)).toEqual(['aaa bbbbb', ' ccc'])
  expect(rows('aaaaaa', 6, 6)).toEqual(['aaaaaa', '▏'])
  expect(rows('aaaaaa', 6)).toEqual(['aaaaaa'])
  expect(rows('', 6)).toEqual([''])
  expect(rows(SUGGESTED, 56).join('')).toBe(SUGGESTED)
})

test("the text edits at a caret: a click on a character places it, the keys move it, the hooks' paste moves it past", async () => {
  const placed = click(START, 'text@2')
  expect([placed.state.focus, placed.state.caret, placed.post?.caret]).toEqual(['text', 2, 2])
  expect(onKey(placed.state, PROPS, key('X')).post?.edits).toEqual([{ kind: 'insert', at: 2, text: 'X', seq: 1 }])
  expect(onKey(placed.state, PROPS, key('delete')).post?.edits).toEqual([{ kind: 'del', at: 2, seq: 1 }])
  expect(onKey(placed.state, PROPS, key('home')).state.caret).toBe(0)
  expect(boxRows(drawPage(PROPS, placed.state))).toEqual(['mi▏ne'])
  const pasted = withPastes(placed.state, { pastes: [{ seq: 5, at: 2, length: 4 }] })
  expect([pasted.caret, pasted.pasted]).toEqual([6, 5])
  expect(withPastes({ ...placed.state, focus: 'apply' }, { pastes: [{ seq: 5, at: 2, length: 4 }] }).caret).toBe(2)
})

test('every drawn row is as wide as the view, the suggested text and an error included', async () => {
  for (const line of draw({ ...PROPS, draft: SUGGESTED }, START)) expect([...line].length).toBe(PROPS.columns)
  for (const line of draw({ ...PROPS, draft: 'x'.repeat(56) }, START)) expect([...line].length).toBe(PROPS.columns)
  const lines = draw({ ...PROPS, error: 'Not applied: EACCES', draft: 'x'.repeat(130) }, START)
  for (const line of lines) expect([...line].length).toBe(PROPS.columns)
  expect(lines.at(-1)).toMatch(/^ Not applied: EACCES/)
})
