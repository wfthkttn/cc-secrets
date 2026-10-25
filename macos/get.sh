#!/bin/bash
# Usage: curl -fsSL https://github.com/wfthkttn/cc-secrets/releases/latest/download/get.sh | bash
#        (or ... | bash -s -- <tag> for a given release)
#
# Downloads cc-secrets' release for this Mac, checks it against the release's SHA256SUMS and runs its
# macos/install.sh. A download by curl isn't quarantined, so Gatekeeper lets the daemon run; one through a browser is.
set -euo pipefail

tag=${1:-latest}
if [ "$tag" = latest ]; then
  base=https://github.com/wfthkttn/cc-secrets/releases/latest/download
else
  base=https://github.com/wfthkttn/cc-secrets/releases/download/$tag
fi
# uname -m says x86_64 in a shell running under Rosetta
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; else arch=x86_64; fi
asset=cc-secrets-macos-$arch.tar.gz

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$asset" "$base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
sum=$(grep " $asset\$" "$tmp/SHA256SUMS") || { echo "SHA256SUMS lists no $asset" >&2; exit 1; }
(cd "$tmp" && echo "$sum" | shasum -a 256 -c - >/dev/null) || { echo "$asset doesn't match its checksum" >&2; exit 1; }
tar -xzf "$tmp/$asset" -C "$tmp"
# bash reads this script from the pipe on stdin
"$tmp/cc-secrets/macos/install.sh" </dev/null
