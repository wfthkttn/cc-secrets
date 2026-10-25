#!/bin/bash
# Usage: macos/package.sh <aarch64-apple-darwin|x86_64-apple-darwin> <out dir>
#
# Builds the checkout it lives in for the target and writes <out dir>/cc-secrets-macos-<arm64|x86_64>.tar.gz: the
# binaries in bin/, the plugin in claude-code/ and macos/install.sh, which installs them from there and signs the
# daemon.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
target=$1
out=$2
case $target in
  aarch64-apple-darwin) arch=arm64 ;;
  x86_64-apple-darwin) arch=x86_64 ;;
  *) echo "no macOS release for $target" >&2; exit 1 ;;
esac
binaries=(secrets-relay secrets-mask-run secrets secrets-askpass secrets-askpass-sudo secrets-askpass-ssh secrets-askpass-git)

cargo build --release --locked --target "$target" --manifest-path "$repo/Cargo.toml"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
root="$stage/cc-secrets"
mkdir -p "$root/bin" "$root/macos"
for binary in "${binaries[@]}"; do
  cp "${CARGO_TARGET_DIR:-$repo/target}/$target/release/$binary" "$root/bin/"
done
cp -R "$repo/claude-code" "$root/claude-code"
rm -rf "$root/claude-code/tests" "$root/claude-code/.claude-plugin/types"
cp "$repo/macos/install.sh" "$root/macos/"
cp "$repo/LICENSE" "$root/"

mkdir -p "$out"
tar -czf "$out/cc-secrets-macos-$arch.tar.gz" -C "$stage" cc-secrets
echo "$out/cc-secrets-macos-$arch.tar.gz"
