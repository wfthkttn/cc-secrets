# Usage: windows\install.ps1   (from anywhere; builds the checkout it lives in)
#
# Installs secrets for this user on Windows: the Claude Code plugin with its binaries in
# %USERPROFILE%\.local\lib\secrets\claude-code, and a logon task, claude-secrets, that runs the daemon on
# %LOCALAPPDATA%\secrets.sock with its log in %LOCALAPPDATA%\secrets\daemon.log. Run again to update; when the
# binaries changed, the running daemon stops, which locks the vault, and sessions attach again to the new one; an
# update of the plugin alone leaves the daemon, and the open vault, running. The plugin directory to load is
# %USERPROFILE%\.local\lib\secrets\claude-code.
$ErrorActionPreference = 'Stop'
# robocopy exits 1 to 7 on success; its exit code is checked instead
$PSNativeCommandUseErrorActionPreference = $false

$repo = Split-Path -Parent $PSScriptRoot
$plugin = "$env:USERPROFILE\.local\lib\secrets\claude-code"
$task = 'claude-secrets'
$log = "$env:LOCALAPPDATA\secrets\daemon.log"
$binaries = 'secrets-relay', 'secrets-mask-run', 'secrets', 'secrets-askpass', 'secrets-askpass-sudo', 'secrets-askpass-ssh', 'secrets-askpass-git'

cargo build --release --manifest-path "$repo\Cargo.toml"
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }

# Mirrored in place, not replaced: a running session may hold the plugin's folder. Without the binaries, the installed
# ones in bin stay as they are, running or not.
function Copy-Plugin([bool] $withBinaries) {
  $stage = Join-Path ([IO.Path]::GetTempPath()) "claude-secrets-install-$PID"
  try {
    # bin is a link to target\release in git, which a checkout on Windows makes a link or a file
    robocopy "$repo\claude-code" $stage /E /XD "$repo\claude-code\bin" /XF "$repo\claude-code\bin" /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "staging the plugin failed: robocopy exit code $LASTEXITCODE" }
    if ($withBinaries) {
      New-Item -ItemType Directory "$stage\bin" | Out-Null
      foreach ($binary in $binaries) { Copy-Item "$repo\target\release\$binary.exe" "$stage\bin\" }
      robocopy $stage $plugin /MIR /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    } else {
      robocopy $stage $plugin /MIR /XD "$plugin\bin" /R:3 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    }
    if ($LASTEXITCODE -ge 8) { throw "copying the plugin to $plugin failed: robocopy exit code $LASTEXITCODE" }
  } finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  }
}

$changed = @($binaries | Where-Object {
  $installed = "$plugin\bin\$_.exe"
  -not (Test-Path $installed) -or (Get-FileHash $installed).Hash -ne (Get-FileHash "$repo\target\release\$_.exe").Hash
})
# Only while the task's daemon runs (a daemon that can't serve ends): after a run that failed half-way, the full
# install below repairs the task and checks the daemon again.
$registered = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
# a task disabled while its daemon runs still reports Running
$serving = $registered -and $registered.Settings.Enabled -and $registered.State -eq 'Running'
if ($changed.Count -eq 0 -and $serving) {
  Copy-Plugin $false
  "updated the plugin in $plugin; the binaries are the same, so the daemon keeps running"
  exit 0
}

try {
  # Windows won't replace a running executable: the daemon and the sessions' attaches run the installed one. Disabled
  # first, so its minute trigger doesn't start the old daemon again meanwhile; registering enables it again.
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName $task | Out-Null
    Stop-ScheduledTask -TaskName $task
  }
  # also a daemon started by hand on the same socket, which would otherwise keep the vault beside the new one
  $running = @(Get-CimInstance Win32_Process -Filter "Name='secrets-relay.exe'" | Where-Object {
    $_.ExecutablePath -eq "$plugin\bin\secrets-relay.exe" -or ($_.CommandLine -match '\sdaemon(\s|$)' -and $_.CommandLine -notmatch '--socket')
  })
  # one that can't be stopped (an elevated session's attach) keeps its executable locked, which the copy reports
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Stop-Process returns before the process is gone, and with it the lock on its executable
  $running | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
  # a killed daemon leaves its socket file; gone, it shows when the new daemon listens
  Remove-Item "$env:LOCALAPPDATA\secrets.sock" -ErrorAction SilentlyContinue

  Copy-Plugin $true

  New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
  # not USERDOMAIN, which an ssh logon sets to the workgroup
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute "$plugin\bin\secrets-relay.exe" -Argument "daemon --log `"$log`"" -WorkingDirectory $env:USERPROFILE
  # Task Scheduler restarts a task only when it fails to start, not when the daemon dies later, and a logon trigger's
  # repetition starts only at a logon: a second trigger repeats every minute from now on, and a repeat while the
  # daemon runs, or while the user isn't logged on, does nothing (IgnoreNew, Interactive).
  $trigger = @(
    New-ScheduledTaskTrigger -AtLogOn -User $user
    New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
  )
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -Priority 5
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force `
    -Description 'The secrets vault daemon for Claude Code sessions' | Out-Null
  Start-ScheduledTask -TaskName $task
  $deadline = (Get-Date).AddSeconds(10)
  while (-not (Test-Path "$env:LOCALAPPDATA\secrets.sock")) {
    if ((Get-Date) -gt $deadline) { throw "the daemon didn't start listening on $env:LOCALAPPDATA\secrets.sock; its log is $log" }
    Start-Sleep -Milliseconds 250
  }
  # a daemon that finds another one, or can't pin its helpers, ends right after it starts
  Start-Sleep 2
  if ((Get-ScheduledTask -TaskName $task).State -ne 'Running') { throw "the daemon ended right after it started; its log is $log" }
} catch {
  # disabled, the task would start no daemon at the next logon either
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { Enable-ScheduledTask -TaskName $task | Out-Null }
  throw
}

"installed: plugin directory $plugin, daemon socket $env:LOCALAPPDATA\secrets.sock, log $log"
