import type { Access, EntryKind } from './vault-view-props'

/** The name the tool is registered under; the model calls it `mcp__secrets__vault`. */
export const VAULT_TOOL_NAME = 'vault'
export const VAULT_TOOL = 'mcp__secrets__vault'
export const SUBAGENT_REFUSED = 'secrets: subagents get nothing from the vault.'

export const VAULT_DESCRIPTION = [
  "Lists the user's secrets vault: each entry's tag, kind, name, and what this session lets you have of it; never a value.",
  'Access: ask, the user gets a card each time; allowed, given with no card; refused, never given.',
  'To use a secret, have the command that needs it ask for it: put `secrets ask --tag TAG "what it is for"` inside that Bash command, so the value goes straight in and you never see it, e.g. `PGPASSWORD="$(secrets ask --tag db \'Prod DB\')" psql -h db.internal app`.',
  'Without --tag, or with no entry for the tag, the user types the value or picks an entry on a card. sudo -A, ssh and git ask through the vault by themselves (tags sudo, ssh, git).',
  'A value goes only into the command that uses it, to the service it belongs to, or into the env or config file its program reads (.env, kubeconfig, .netrc). Never print it, write it anywhere else (notes, logs, scripts, temp files), or send it anywhere else.',
  'Output that carries a secret shows [secret], and a call that carries a vault value is stopped. Subagents get nothing from the vault.',
].join('\n')

/** Whether a call of the tool runs: the main loop's with no dialog, a subagent's or a teammate's (`agentId`) never. */
export function vaultVerdict(agentId: string | undefined): { decision: 'allow' } | { decision: 'deny'; reason: string } {
  return agentId === undefined ? { decision: 'allow' } : { decision: 'deny', reason: SUBAGENT_REFUSED }
}

const STILL_ASKS = '`secrets ask` still works: the user types the value.'

/** What the tool answers: the entries one a line, tab-separated under a header; else why there are none. */
export function vaultListing(state: 'absent' | 'locked' | 'open', entries: readonly { tag: string; kind: EntryKind; access: Access; name: string }[]): string {
  if (state === 'absent') return `No vault yet. ${STILL_ASKS}`
  if (state === 'locked') return `The vault is locked; the user unlocks it in the 🔐 Vault tab. ${STILL_ASKS}`
  if (entries.length === 0) return `The vault has no entries. ${STILL_ASKS}`
  return ['tag\tkind\taccess\tname', ...entries.map(e => `${e.tag}\t${e.kind}\t${e.access}\t${e.name}`)].join('\n')
}
