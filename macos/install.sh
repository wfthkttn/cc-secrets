#!/bin/bash
# Usage: macos/install.sh   (from anywhere; builds the checkout it lives in)
#
# Installs secrets for the logged-in user on macOS: the binaries and the Claude Code plugin under
# ~/.local/lib/secrets, the daemon signed with the hardened runtime (it refuses to run otherwise), and a launchd
# agent that holds the daemon's socket at $TMPDIR/secrets.sock and starts it on the first connection. Run again to
# update; the running daemon stops, and sessions attach again to the new one. The plugin directory to load is
# ~/.local/lib/secrets/claude-code.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
prefix="$HOME/.local/lib/secrets"
label=local.claude-secrets
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
socket="$(getconf DARWIN_USER_TEMP_DIR)secrets.sock"
binaries=(secrets-relay secrets-mask-run secrets secrets-askpass secrets-askpass-sudo secrets-askpass-ssh secrets-askpass-git)

cargo build --release --manifest-path "$repo/Cargo.toml"

if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain/$label"
fi

mkdir -p "$prefix/bin"
for binary in "${binaries[@]}"; do
  # A new file, not one overwritten in place: a running process keeps its pages, and macOS kills one whose signed
  # pages change under it.
  cp "$repo/target/release/$binary" "$prefix/bin/$binary.new"
  mv -f "$prefix/bin/$binary.new" "$prefix/bin/$binary"
done
codesign -f -s - -o runtime "$prefix/bin/secrets-relay"

rm -rf "$prefix/claude-code.new"
cp -R "$repo/claude-code" "$prefix/claude-code.new"
rm "$prefix/claude-code.new/bin"
ln -s ../bin "$prefix/claude-code.new/bin"
rm -rf "$prefix/claude-code"
mv "$prefix/claude-code.new" "$prefix/claude-code"

mkdir -p "$(dirname "$plist")" "$HOME/Library/Logs"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$prefix/bin/secrets-relay</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SECRETS_DAEMON</key>
    <string>$socket</string>
  </dict>
  <key>Sockets</key>
  <dict>
    <key>secrets</key>
    <dict>
      <key>SockPathName</key>
      <string>$socket</string>
      <key>SockPathMode</key>
      <integer>384</integer>
    </dict>
  </dict>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/claude-secrets.log</string>
</dict>
</plist>
EOF
plutil -lint "$plist"
launchctl bootstrap "$domain" "$plist"

echo "installed: plugin directory $prefix/claude-code, daemon socket $socket"
