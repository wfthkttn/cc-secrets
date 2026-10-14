import { expect, test } from 'claude-code/testing'

import { pathWith } from '../hooks/session-path'

test("a restart on a new build puts its bin first in place of the old one's, so the bins don't pile up", async () => {
  expect(pathWith('/usr/bin:/bin', '/nix/store/a-secrets/bin', null)).toBe('/nix/store/a-secrets/bin:/usr/bin:/bin')
  expect(pathWith('/nix/store/a-secrets/bin:/usr/bin', '/nix/store/b-secrets/bin', '/nix/store/a-secrets/bin')).toBe('/nix/store/b-secrets/bin:/usr/bin')
})

test('a reload on the same bin leaves PATH as it is, and an empty PATH gains no empty entry', async () => {
  expect(pathWith('/nix/store/a-secrets/bin:/usr/bin', '/nix/store/a-secrets/bin', '/nix/store/a-secrets/bin')).toBe('/nix/store/a-secrets/bin:/usr/bin')
  expect(pathWith('/usr/bin:/nix/store/a-secrets/bin', '/nix/store/a-secrets/bin', null)).toBe('/nix/store/a-secrets/bin:/usr/bin')
  expect(pathWith('', '/nix/store/a-secrets/bin', null)).toBe('/nix/store/a-secrets/bin')
})
