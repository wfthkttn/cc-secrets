import type { ClientElements, RenderElement } from 'claude-code'

export type Tab = 'requests' | 'vault' | 'config'

/** What the drawer's tab row shows besides the names. */
export type Tabs = { active: Tab; requests: number; vaultMark: boolean }

/** The tab row and the rule under it. */
export const TAB_ROWS = 2

const LABELS: Record<Tab, (tabs: Tabs) => string> = {
  requests: tabs => ` Requests${tabs.requests > 0 ? ' ' + tabs.requests : ''} `,
  vault: tabs => ` Vault${tabs.vaultMark ? ' •' : ''} `,
  config: () => ' Config ',
}

/** Each tab's label and the columns it takes, left to right, a `│` between them. */
export function tabSpans(tabs: Tabs) {
  let start = 0
  return (['requests', 'vault', 'config'] as const).map(tab => {
    const label = LABELS[tab](tabs)
    const span = { tab, label, start, width: [...label].length }
    start += span.width + 1
    return span
  })
}

/** The tab under column `x` of the tab row, or null. */
export function tabAt(tabs: Tabs, x: number): Tab | null {
  return tabSpans(tabs).find(s => x >= s.start && x < s.start + s.width)?.tab ?? null
}

export function drawTabs({ Box, Text }: ClientElements, tabs: Tabs, columns: number): RenderElement[] {
  const spans = tabSpans(tabs)
  const used = spans.reduce((sum, s) => sum + s.width, 0) + spans.length - 1
  const labels = spans.flatMap((s, i) => [
    ...(i > 0 ? [Text({ dimColor: true, children: ['│'] })] : []),
    Text({ ...(s.tab === tabs.active ? { bold: true, color: 'claude' as const } : { dimColor: true }), children: [s.label] }),
  ])
  return [
    Box({ flexDirection: 'row', children: [...labels, Text({ children: [' '.repeat(Math.max(0, columns - used))] })] }),
    Text({ dimColor: true, children: ['─'.repeat(columns)] }),
  ]
}
