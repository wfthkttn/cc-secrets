# Usage, in PowerShell: irm https://github.com/wfthkttn/cc-secrets/releases/latest/download/get.ps1 | iex
#
# Downloads cc-secrets' release for Windows, checks it against the release's SHA256SUMS and runs its
# windows\install.ps1. A script's download carries no Mark of the Web, so SmartScreen doesn't stop the daemon.
$ErrorActionPreference = 'Stop'

$tag = if ($env:CC_SECRETS_RELEASE) { $env:CC_SECRETS_RELEASE } else { 'latest' }
$base = if ($tag -eq 'latest') { 'https://github.com/wfthkttn/cc-secrets/releases/latest/download' } else { "https://github.com/wfthkttn/cc-secrets/releases/download/$tag" }
# Windows on Arm runs the x86_64 build emulated
$asset = 'cc-secrets-windows-x86_64.zip'

$tmp = Join-Path ([IO.Path]::GetTempPath()) "cc-secrets-get-$PID"
New-Item -ItemType Directory $tmp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile "$tmp\$asset"
  Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS"
  $line = Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match "\s\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $line) { throw "SHA256SUMS lists no $asset" }
  $expected = ($line -split '\s+')[0]
  if ((Get-FileHash -Algorithm SHA256 "$tmp\$asset").Hash -ne $expected) { throw "$asset doesn't match its checksum" }
  Expand-Archive "$tmp\$asset" -DestinationPath $tmp
  # a .ps1 file, unlike this piped script, is held to the execution policy
  powershell -NoProfile -ExecutionPolicy Bypass -File "$tmp\cc-secrets\windows\install.ps1"
  if ($LASTEXITCODE -ne 0) { throw "windows\install.ps1 failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
