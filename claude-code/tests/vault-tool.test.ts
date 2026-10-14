import { expect, test } from 'claude-code/testing'

import { SUBAGENT_REFUSED, VAULT_DESCRIPTION, VAULT_TOOL, vaultListing, vaultVerdict } from '../hooks/vault-tool'

test('the listing: one entry a line under a header, never a value; a closed or empty vault says secrets ask still works', async () => {
  const entries = [
    { tag: 'db', kind: 'password' as const, access: 'allowed' as const, name: 'Prod DB' },
    { tag: 'deploy', kind: 'token' as const, access: 'refused' as const, name: 'Deploy' },
  ]
  expect(vaultListing('open', entries)).toBe(
    ['tag     kind      access   name', 'db      password  allowed  Prod DB', 'deploy  token     refused  Deploy'].join('\n'),
  )
  for (const state of ['absent', 'locked'] as const) expect(vaultListing(state, entries)).toContain('`secrets ask` still works')
  expect(vaultListing('locked', entries)).toContain('Vault tab')
  expect(vaultListing('open', [])).toBe('The vault has no entries. `secrets ask` still works: the user types the value.')
})

test('the description teaches the ask inside the command, where a value may go, and that subagents get nothing', async () => {
  expect(VAULT_DESCRIPTION).toContain('secrets ask --tag TAG')
  expect(VAULT_DESCRIPTION).toContain('ask, the user gets a card each time; allowed, given with no card; refused, never given')
  expect(VAULT_DESCRIPTION).toContain('Never print it')
  expect(VAULT_DESCRIPTION).toContain('Subagents get nothing')
})

test('the main loop calls the vault tool with no dialog; a subagent or a teammate is refused', async () => {
  expect(vaultVerdict(undefined)).toEqual({ decision: 'allow' })
  expect(vaultVerdict('a-1')).toEqual({ decision: 'deny', reason: SUBAGENT_REFUSED })
  expect(VAULT_TOOL).toBe('mcp__secrets__vault')
})
