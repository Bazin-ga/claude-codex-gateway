param(
  [Parameter(Mandatory=$true)][string]$Endpoint,
  [Parameter(Mandatory=$true)][string]$Token,
  [Parameter(Mandatory=$true)][string]$CertPin,
  [string]$Dest = "$env:LOCALAPPDATA\claude-codex-gateway\client-agent"
)

# Install the Codex credential agent on Windows.
#
# Installs the agent, fetches a credential immediately, and registers a scheduled
# task so it stays fresh without further attention.
#
#   .\install.ps1 -Endpoint https://HOST:8443 -Token <token> -CertPin <sha256>
#
# Run it from an OPEN PowerShell window. Double-clicking a .ps1 closes the window
# the instant it finishes, so you would never see the result.
#
# This file is deliberately ASCII-only: Windows PowerShell 5.1 decodes a .ps1
# without a BOM using the system ANSI code page, so non-ASCII characters in a
# BOM-less file break parsing outright on non-English systems.

$ErrorActionPreference = 'Stop'

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
  Write-Step "FAILED: $_" 'Red'
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
Copy-Item -Force "$src\package.json" $Dest
# Only if it exists: pull.js is self-contained today but may grow a lib/ later,
# and neither shape should break the installer.
if (Test-Path "$src\lib") { Copy-Item -Recurse -Force "$src\lib" $Dest }
Write-Host "  installed"

Write-Step "[4/5] Fetching a credential" 'Cyan'
$env:CODEX_CRED_ENDPOINT = $Endpoint
$env:CODEX_CRED_TOKEN    = $Token
$env:CODEX_CRED_CERT_PIN = $CertPin
node "$Dest\pull.js" --force
if ($LASTEXITCODE -ne 0) {
  throw "Could not fetch a credential. Check network reachability to $Endpoint, or run diagnose.ps1."
}

Write-Step "[5/5] Registering the scheduled task" 'Cyan'
# Stored at user scope so the task inherits them without embedding secrets in the
# task definition itself.
[Environment]::SetEnvironmentVariable('CODEX_CRED_ENDPOINT', $Endpoint, 'User')
[Environment]::SetEnvironmentVariable('CODEX_CRED_TOKEN',    $Token,    'User')
[Environment]::SetEnvironmentVariable('CODEX_CRED_CERT_PIN', $CertPin,  'User')

$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$Dest\pull.js`""
# Twice daily, plus at logon so a machine that was off still catches up.
$triggers = @(
  (New-ScheduledTaskTrigger -Daily -At 6am),
  (New-ScheduledTaskTrigger -Daily -At 6pm),
  (New-ScheduledTaskTrigger -AtLogOn)
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
Register-ScheduledTask -TaskName 'Codex credential refresh' `
  -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
Write-Host "  registered 'Codex credential refresh'"

Write-Host ""
Write-Step "Done. Verify with:" 'Green'
Write-Host "  .\diagnose.ps1 -Endpoint $Endpoint"
Write-Host ""
Write-Host "Do NOT verify with 'codex login status'. It reports 'Logged in using ChatGPT'"
Write-Host "for a garbage token, because it only parses the file."
Write-Host ""
Write-Host "If codex errors with a host other than chatgpt.com, a third-party relay is"
Write-Host "intercepting it - run .\diagnose.ps1"

Write-Step "`nFull log: $LogFile" 'DarkGray'
Read-Host "`nPress Enter to close"
