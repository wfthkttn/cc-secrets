import type { ClientKeyEvent } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { SUGGESTED } from '../hooks/auto-mode'
import ConfigView, { buttons, type ConfigState, confirm, initialState, layout, maskArrows, onClick, onKey, shownText, status, wrap } from '../hooks/config-view'
import type { ConfigProps } from '../hooks/config-view-props'
import { TAB_ROWS, tabSpans } from '../hooks/tabs'

const PROPS: ConfigProps = {
  tabs: { active: 'config', requests: 0, vaultMark: false },
  columns: 60,
  rows: 30,
  draft: 'mine',
  applied: null,
  confirmed: {},
  unlockAtStart: true,
  maskMinLength: 6,
  forward: false,
  error: null,
}
const START = initialState('c1')
const key = (k: string, mods: { ctrl?: true } = {}): ClientKeyEvent => ({ key: k, ...mods })
/** A click on the row `at` under the tabs. */
const click = (state: ConfigState, at: number, x: number, props = PROPS) => onClick(state, props, at + TAB_ROWS, x)
/** Rows under the tabs for a one-row text: head 0, text 1, buttons 2–4, gap 5, unlock 6, mask 7, forward 8. */
const ROW = { text: 1, buttons: 3, unlock: 6, mask: 7, forward: 8 }

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
  const text = (node: unknown): string =>
    typeof node === 'string' ? node : ((node as { children?: unknown[] }).children ?? []).map(text).join('')
  const view = ConfigView as unknown as (p: ConfigProps, s: typeof surface) => { children: unknown[] }
  return view(props, surface).children.map(text)
}

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

test('Enter in the text applies; the buttons apply or reset to the suggested text', async () => {
  expect(onKey(START, PROPS, key('return')).post?.action).toEqual({ kind: 'apply' })
  const [apply, suggest] = buttons()
  expect(click(START, ROW.buttons, apply!.start).post?.action).toEqual({ kind: 'apply' })
  expect(click(START, ROW.buttons, suggest!.start + 2).post?.action).toEqual({ kind: 'suggest' })
  expect(click(START, ROW.buttons, 0).post).toBe(undefined)
})

test('↑/↓ walk the text and the settings; the forward row only exists with an agent of the user', async () => {
  const down = (state: ConfigState, props = PROPS) => onKey(state, props, key('down')).state
  expect(down(down(down(down(START)))).focus).toBe('forward')
  const noAgent = { ...PROPS, forward: null }
  expect(down(down(down(down(START, noAgent), noAgent), noAgent), noAgent).focus).toBe('mask')
  expect(layout(noAgent, 'mine', true).map(r => r.kind)).not.toContain('forward')
  const up = onKey(START, PROPS, key('up'))
  expect(up.state.focus).toBe('text')
  expect(up.post?.textFocused).toBe(true)
  expect(onKey(START, PROPS, key('down')).post?.textFocused).toBe(false)
})

test('Space or Enter flips a toggle; ←/→ step the mask minimum, never below 1', async () => {
  const at = (focus: ConfigState['focus']) => ({ ...START, focus })
  expect(onKey(at('unlock'), PROPS, key('space')).post?.action).toEqual({ kind: 'unlockAtStart', on: false })
  expect(onKey(at('forward'), PROPS, key('return')).post?.action).toEqual({ kind: 'forward', on: true })
  expect(onKey(at('mask'), PROPS, key('right')).post?.action).toEqual({ kind: 'maskMinLength', value: 7 })
  expect(onKey(at('mask'), { ...PROPS, maskMinLength: 1 }, key('left')).post).toBe(undefined)
  expect(onKey(at('unlock'), PROPS, key('x')).post).toBe(undefined)
})

test('clicks: a toggle row flips, the mask arrows step, a tab turns the drawer', async () => {
  expect(click(START, ROW.unlock, 5).post?.action).toEqual({ kind: 'unlockAtStart', on: false })
  expect(click(START, ROW.forward, 5).post?.action).toEqual({ kind: 'forward', on: true })
  const arrows = maskArrows(6)
  expect(click(START, ROW.mask, arrows.less).post?.action).toEqual({ kind: 'maskMinLength', value: 5 })
  expect(click(START, ROW.mask, arrows.more).post?.action).toEqual({ kind: 'maskMinLength', value: 7 })
  expect(click(START, ROW.mask, 2).post?.action).toBe(undefined)
  expect(click(START, ROW.mask, 2).state.focus).toBe('mask')
  const vault = tabSpans(PROPS.tabs).find(s => s.tab === 'vault')!
  expect(onClick(START, PROPS, 0, vault.start).post?.tab).toBe('vault')
  const config = tabSpans(PROPS.tabs).find(s => s.tab === 'config')!
  expect(onClick(START, PROPS, 0, config.start).post).toBe(undefined)
})

test('a text longer than the room shows its end, where typing goes', async () => {
  const rows = layout({ ...PROPS, rows: TAB_ROWS + 10 + 2 }, 'a'.repeat(58 * 5), false)
  const text = rows.filter(r => r.kind === 'text')
  expect(text.length).toBe(2)
  expect(text.at(-1)).toEqual({ kind: 'text', text: 'a'.repeat(58), isLast: true })
})

test('rows break after a space; a word longer than a row is cut; a full last row puts the cursor on the next', async () => {
  expect(wrap('aaa bbb ccc', 9, false)).toEqual(['aaa bbb ', 'ccc'])
  expect(wrap('aaa bbbbbbbbbbb', 6, false)).toEqual(['aaa ', 'bbbbbb', 'bbbbb'])
  expect(wrap('aaa bbbbb ccc', 9, false)).toEqual(['aaa bbbbb', ' ccc'])
  expect(wrap('aaaaaa', 6, true)).toEqual(['aaaaaa', ''])
  expect(wrap('aaaaaa', 6, false)).toEqual(['aaaaaa'])
  expect(wrap('', 6, false)).toEqual([''])
  expect(wrap(SUGGESTED, 58, true).join('')).toBe(SUGGESTED)
})

test('the suggested text with the cursor draws every row at the view width, so clicks land where the layout says', async () => {
  for (const line of draw({ ...PROPS, draft: SUGGESTED })) expect([...line].length).toBe(PROPS.columns)
  for (const line of draw({ ...PROPS, draft: 'x'.repeat(58) })) expect([...line].length).toBe(PROPS.columns)
})

test('every drawn row is as wide as the view; the arrows sit where clicks find them', async () => {
  const lines = draw({ ...PROPS, error: 'Not applied: EACCES', draft: 'x'.repeat(130) })
  for (const line of lines) expect([...line].length).toBe(PROPS.columns)
  const mask = lines.find(l => l.includes('Mask values'))!
  const arrows = maskArrows(6)
  expect([...mask][arrows.less]).toBe('‹')
  expect([...mask][arrows.more]).toBe('›')
  expect(lines[TAB_ROWS]).toContain('not in settings')
})
