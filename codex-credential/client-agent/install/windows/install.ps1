param(
  [Parameter(Mandatory=$true)][string]$Endpoint,
  [string]$Token,
  [string]$TokenFile,
  [Parameter(Mandatory=$true)][string]$CertPin,
  [string]$Profile,
  [string]$Dest = "$env:LOCALAPPDATA\claude-codex-gateway\client-agent"
)

# Install the Codex credential agent on Windows.
#
# Installs the agent, fetches a credential immediately, and registers a scheduled
# task so it stays fresh without further attention.
#
#   .\install.ps1 -Endpoint https://HOST:8443 -TokenFile .\token -CertPin <sha256>
#
# Run it from an OPEN PowerShell window. Double-clicking a .ps1 closes the window
# the instant it finishes, so you would never see the result.
#
# This file is deliberately ASCII-only: Windows PowerShell 5.1 decodes a .ps1
# without a BOM using the system ANSI code page, so non-ASCII characters in a
# BOM-less file break parsing outright on non-English systems.

$ErrorActionPreference = 'Stop'

function Read-SafeToken {
  param([string]$Path)

  if (-not $Path) { throw 'token file path is empty' }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or $item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'token file must be a regular non-reparse file'
  }
  if ($item.Length -le 0) { throw 'token file is empty' }
  $value = [System.IO.File]::ReadAllText($item.FullName)
  if (-not $value -or $value -match '[\r\n]' -or $value -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'token file must contain one base64url-safe token without a newline'
  }
  return $value
}

function Validate-SafeToken {
  param([string]$Value)
  if (-not $Value -or $Value -match '[\r\n]' -or $Value -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'credential token is empty or contains unsupported characters'
  }
}

function Normalize-HttpsOrigin {
  param([string]$Value)
  if (-not $Value -or $Value -match '[\r\n]' -or $Value.Contains([char]0)) {
    throw 'endpoint must be one HTTPS origin'
  }
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
    throw 'endpoint must be one HTTPS origin'
  }
  if ($uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.UserInfo -or
      $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
    throw 'endpoint must be HTTPS without credentials, query, fragment, or path'
  }
  return $uri.GetLeftPart([UriPartial]::Authority)
}

if ($TokenFile -and $Token) {
  throw 'choose -TokenFile or legacy -Token, not both'
}

# New installers pass a protected token file. Process environment is the second
# supported non-argv path; -Token remains only for existing hand-written installs.
if ($TokenFile) {
  $ResolvedToken = Read-SafeToken -Path $TokenFile
} elseif ($Token) {
  $ResolvedToken = $Token
} elseif ($env:CODEX_CRED_TOKEN) {
  $ResolvedToken = $env:CODEX_CRED_TOKEN
} else {
  throw 'provide -TokenFile, process CODEX_CRED_TOKEN, or legacy -Token'
}
Validate-SafeToken -Value $ResolvedToken
$Endpoint = Normalize-HttpsOrigin -Value $Endpoint
if ($CertPin -notmatch '^[A-Fa-f0-9]{64}$') {
  throw 'certificate pin must be a 64-character SHA-256 hex digest'
}
$CertPin = $CertPin.ToLowerInvariant()
if ($Profile -and $Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
  throw 'profile must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}'
}

# Deliberately NOT Start-Transcript: it records the invoking command line in its
# header, which would write this machine's bearer token in clear text into a
# long-lived file under %TEMP%. Verified experimentally. This logger writes only
# what it is given, and is never given a secret.
$LogFile = "$env:TEMP\codex-cred-install.log"
Set-Content -Path $LogFile -Value "[$(Get-Date -Format s)] codex-credential install started" -ErrorAction SilentlyContinue
function Write-Step {
  param([string]$Message, [string]$Color = 'Gray')
  Write-Host $Message -ForegroundColor $Color
  Add-Content -Path $LogFile -Value "[$(Get-Date -Format s)] $Message" -ErrorAction SilentlyContinue
}
trap {
  # Never serialize an exception or command line: either can contain a bearer
  # supplied by a provider/tooling layer. Keep the durable log credential-free.
  Write-Step "FAILED: installer aborted; credential details were omitted" 'Red'
  Write-Step "Full log: $LogFile" 'Yellow'
  Read-Host "`nPress Enter to close"
  exit 1
}

Write-Step "[1/5] Checking prerequisites" 'Cyan'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Step "  node not found. Install Node 20+ from https://nodejs.org, then reopen PowerShell." 'Red'
  Read-Host "`nPress Enter to close"
  exit 1
}
Write-Host "  node $(node -v)"

if (Get-Command codex -ErrorAction SilentlyContinue) {
  Write-Host "  codex $(codex --version)"
} else {
  Write-Step "  codex NOT INSTALLED. Install it first:" 'Yellow'
  Write-Step "      npm install -g @openai/codex" 'White'
  Write-Step "  Then re-run this script." 'Yellow'
  Write-Host ""
  Write-Step "  Do NOT run 'codex login' afterwards: it wipes the existing credential" 'Red'
  Write-Step "  BEFORE waiting for authorization, so an interrupted login destroys it" 'Red'
  Write-Step "  permanently. This script supplies the credential; you never log in." 'Red'
  Read-Host "`nPress Enter to close"
  exit 1
}

Write-Step "[2/5] Checking for config that would hijack codex" 'Cyan'
# A third-party API relay set through the environment or config.toml takes
# precedence over the subscription credential, so codex keeps talking to the
# relay and the credential installed here is never used. Seen in the wild.
$hijack = $false
foreach ($scope in @('Process','User','Machine')) {
  foreach ($name in @('OPENAI_BASE_URL','OPENAI_API_KEY')) {
    $v = [Environment]::GetEnvironmentVariable($name, $scope)
    if ($v) {
      Write-Step "  $name is set at $scope scope" 'Yellow'
      $hijack = $true
    }
  }
}
$cfg = "$env:USERPROFILE\.codex\config.toml"
if ((Test-Path $cfg) -and (Select-String -Path $cfg -Pattern '^\s*(base_url|model_provider)\s*=' -Quiet)) {
  Write-Step "  $cfg sets base_url/model_provider" 'Yellow'
  $hijack = $true
}
if ($hijack) {
  Write-Step "  WARNING: codex may bypass the credential installed here." 'Red'
  Write-Step "           Installation continues; run diagnose.ps1 afterwards." 'Red'
} else {
  Write-Host "  none found"
}

Write-Step "[3/5] Installing agent to $Dest" 'Cyan'
$src = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force "$src\pull.js" $Dest
Copy-Item -Force "$src\profiles.js" $Dest
Copy-Item -Force "$src\codex-gateway.js" $Dest
Copy-Item -Force "$src\package.json" $Dest
# Only if it exists: pull.js is self-contained today but may grow a lib/ later,
# and neither shape should break the installer.
if (Test-Path "$src\lib") { Copy-Item -Recurse -Force "$src\lib" $Dest }
New-Item -ItemType Directory -Force -Path "$Dest\install\windows" | Out-Null
Copy-Item -Force "$PSScriptRoot\diagnose.ps1" "$Dest\install\windows\diagnose.ps1"
Write-Host "  installed"

Write-Step "[4/5] Fetching a credential" 'Cyan'
$env:CODEX_CRED_ENDPOINT = $Endpoint
$env:CODEX_CRED_TOKEN    = $ResolvedToken
$env:CODEX_CRED_CERT_PIN = $CertPin
if ($Profile) {
  $profileRoot = Join-Path $env:LOCALAPPDATA 'claude-codex-gateway\codex-profiles'
  $env:CODEX_CRED_PROFILE_ROOT = $profileRoot
  node "$Dest\profiles.js" install --name $Profile
} else {
  node "$Dest\pull.js" --force
}
if ($LASTEXITCODE -ne 0) {
  throw "Could not fetch a credential. Check network reachability to $Endpoint, or run diagnose.ps1."
}

Write-Step "[5/5] Registering the scheduled task" 'Cyan'
if ($Profile) {
  $runner = Join-Path $Dest 'run-profiles.cmd'
  [IO.File]::WriteAllText($runner, "@echo off`r`nset `"CODEX_CRED_PROFILE_ROOT=$profileRoot`"`r`nset `"CODEX_HOME=`"`r`nnode `"$Dest\pull.js`" --all-profiles`r`n", [Text.UTF8Encoding]::new($false))
  $bin = Join-Path $env:LOCALAPPDATA 'claude-codex-gateway\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  [IO.File]::WriteAllText((Join-Path $bin 'codex-gateway.cmd'), "@echo off`r`nset `"CODEX_CRED_PROFILE_ROOT=$profileRoot`"`r`nnode `"$Dest\codex-gateway.js`" %*`r`n", [Text.UTF8Encoding]::new($false))
  $profileHome = Join-Path (Join-Path $profileRoot $Profile) 'codex-home'
  [IO.File]::WriteAllText((Join-Path $bin "codex-profile-$Profile.cmd"), "@echo off`r`nset `"CODEX_HOME=$profileHome`"`r`nset `"CODEX_CRED_TOKEN=`"`r`nset `"CODEX_CRED_ENDPOINT=`"`r`nset `"CODEX_CRED_CERT_PIN=`"`r`nset `"CODEX_CRED_ENROLLMENT_KEY=`"`r`nset `"CODEX_CRED_PROFILE_ROOT=`"`r`ncodex %*`r`n", [Text.UTF8Encoding]::new($false))
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$runner`""
  $taskName = 'Codex credential profiles refresh'
} else {
  # Legacy single-profile installs keep their existing user environment and task.
  [Environment]::SetEnvironmentVariable('CODEX_CRED_ENDPOINT', $Endpoint, 'User')
  [Environment]::SetEnvironmentVariable('CODEX_CRED_TOKEN', $ResolvedToken, 'User')
  [Environment]::SetEnvironmentVariable('CODEX_CRED_CERT_PIN', $CertPin, 'User')
  $action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$Dest\pull.js`""
  $taskName = 'Codex credential refresh'
}
# Twice daily, plus at logon so a machine that was off still catches up.
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At 6am),
  (New-ScheduledTaskTrigger -Daily -At 6pm),
  (New-ScheduledTaskTrigger -AtLogOn)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
Register-ScheduledTask -TaskName $taskName `
  -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
Write-Host "  registered '$taskName'"

Write-Host ""
Write-Step "Done. Verify with:" 'Green'
if ($Profile) {
  Write-Host "  node `"$Dest\profiles.js`" status"
  Write-Host "  Start a new session with $bin\codex-gateway.cmd or codex-profile-$Profile.cmd"
  Write-Host "  $Dest\install\windows\diagnose.ps1 -Profile $Profile -Endpoint $Endpoint"
} else {
  Write-Host "  $Dest\install\windows\diagnose.ps1 -Endpoint $Endpoint"
}
Write-Host ""
Write-Host "Do NOT verify with 'codex login status'. It reports 'Logged in using ChatGPT'"
Write-Host "for a garbage token, because it only parses the file."
Write-Host ""
Write-Host "If codex errors with a host other than chatgpt.com, a third-party relay is"
Write-Host "intercepting it - run the installed diagnose.ps1 shown above"

Write-Step "`nFull log: $LogFile" 'DarkGray'
Read-Host "`nPress Enter to close"
