# Usage: windows\package.ps1 <x86_64-pc-windows-msvc> <out dir>
#
# Builds the checkout it lives in for the target and writes <out dir>\cc-secrets-windows-x86_64.zip: the binaries in
# bin\, the plugin in claude-code\ and windows\install.ps1, which installs them from there.
param([Parameter(Mandatory)] [string] $Target, [Parameter(Mandatory)] [string] $Out)
$ErrorActionPreference = 'Stop'
# robocopy exits 1 to 7 on success; its exit code is checked instead
$PSNativeCommandUseErrorActionPreference = $false

$repo = Split-Path -Parent $PSScriptRoot
$arch = switch ($Target) {
  'x86_64-pc-windows-msvc' { 'x86_64' }
  default { throw "no Windows release for $Target" }
}
$binaries = 'secrets-relay', 'secrets-mask-run', 'secrets', 'secrets-askpass', 'secrets-askpass-sudo', 'secrets-askpass-ssh', 'secrets-askpass-git'

cargo build --release --locked --target $Target --manifest-path "$repo\Cargo.toml"
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "$repo\target" }

$stage = Join-Path ([IO.Path]::GetTempPath()) "cc-secrets-package-$PID"
try {
  $root = "$stage\cc-secrets"
  New-Item -ItemType Directory "$root\bin", "$root\windows" | Out-Null
  foreach ($binary in $binaries) { Copy-Item "$targetDir\$Target\release\$binary.exe" "$root\bin\" }
  # bin is a link to target\release in git, which a checkout on Windows makes a link or a file
  robocopy "$repo\claude-code" "$root\claude-code" /E /XD "$repo\claude-code\bin" "$repo\claude-code\tests" "$repo\claude-code\.claude-plugin\types" `
    /XF "$repo\claude-code\bin" /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "staging the plugin failed: robocopy exit code $LASTEXITCODE" }
  Copy-Item "$repo\windows\install.ps1" "$root\windows\"
  Copy-Item "$repo\LICENSE" "$root\"
  New-Item -ItemType Directory -Force $Out | Out-Null
  $zip = Join-Path (Resolve-Path $Out) "cc-secrets-windows-$arch.zip"
  Compress-Archive -Path $root -DestinationPath $zip -Force
  $zip
} finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
