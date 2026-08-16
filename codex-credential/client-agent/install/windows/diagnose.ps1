param(
  [string]$Endpoint = $env:CODEX_CRED_ENDPOINT
)

# Diagnose why codex is not using the credential it was given (Windows).
#
# Read-only: it inspects and reports, and changes nothing.
#
#   .\diagnose.ps1 [-Endpoint https://HOST:8443]
#
# ASCII-only on purpose - see the note in install.ps1.

$ErrorActionPreference = 'Continue'   # every probe must run even if one fails

Write-Host "===== codex credential diagnosis ====="
Write-Host ""

Write-Host "[1] Environment variables that would hijack requests" -ForegroundColor Cyan
$found = $false
foreach ($scope in @('Process','User','Machine')) {
  foreach ($name in @('OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_API_BASE','CODEX_BASE_URL')) {
    $v = [Environment]::GetEnvironmentVariable($name, $scope)
    if ($v) {
      # May be a secret; show only the ends.
      $show = if ($v.Length -gt 24) { $v.Substring(0,12) + "..." + $v.Substring($v.Length-6) } else { $v }
      Write-Host "  [$scope] $name = $show" -ForegroundColor Yellow
      $found = $true
    }
  }
}
if (-not $found) { Write-Host "  (none - clean)" -ForegroundColor Green }
Write-Host ""

Write-Host "[2] codex config" -ForegroundColor Cyan
$cfg = "$env:USERPROFILE\.codex\config.toml"
if (Test-Path $cfg) {
  $hits = Select-String -Path $cfg -Pattern 'base_url|model_provider|\[model_providers|wire_api|env_key'
  if ($hits) { $hits | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow } }
  else { Write-Host "  (no custom provider/base_url - clean)" -ForegroundColor Green }
} else {
  Write-Host "  (no config.toml)" -ForegroundColor Green
}
Write-Host ""

Write-Host "[3] Which credential is installed" -ForegroundColor Cyan
$auth = "$env:USERPROFILE\.codex\auth.json"
if (Test-Path $auth) {
  try {
    $j = Get-Content $auth -Raw | ConvertFrom-Json
    Write-Host "  auth_mode      = $($j.auth_mode)"
    $keyState = if ($j.OPENAI_API_KEY) { 'set  <- API-key mode, not a subscription' } else { 'null (expected)' }
    Write-Host "  OPENAI_API_KEY = $keyState"

    $hasRt = $j.tokens.PSObject.Properties.Name -contains 'refresh_token'
    if (-not $hasRt) {
      Write-Host "  refresh_token  = ABSENT   <- not from this system" -ForegroundColor Yellow
    } elseif ($j.tokens.refresh_token -eq '') {
      Write-Host "  refresh_token  = empty    <- issued by this system (correct)" -ForegroundColor Green
    } else {
      Write-Host "  refresh_token  = present  <- left by a manual codex login, not this system" -ForegroundColor Yellow
    }

    $at = $j.tokens.access_token
    if ($at -and $at.Split('.').Count -ge 2) {
      $p = $at.Split('.')[1].Replace('-','+').Replace('_','/')
      while ($p.Length % 4) { $p += '=' }
      $exp = ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json).exp
      $left = [math]::Round((([DateTimeOffset]::FromUnixTimeSeconds($exp)) - [DateTimeOffset]::UtcNow).TotalDays, 2)
      $note = if ($left -le 0) { ' <- EXPIRED' } else { '' }
      Write-Host "  access_token   = $left days remaining$note"
    } else {
      Write-Host "  access_token   = absent or not a JWT" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  could not parse auth.json: $_" -ForegroundColor Red
  }
} else {
  Write-Host "  (no auth.json - no credential installed)" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "[4] Network reachability from this shell" -ForegroundColor Cyan
# curl.exe ships with Windows 10 1803 and later. If it is missing, say so rather
# than substituting an untested probe whose result could mislead the diagnosis.
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  $urls = @('https://chatgpt.com/backend-api/codex/responses')
  if ($Endpoint) { $urls += ($Endpoint.TrimEnd('/') + '/health') }
  foreach ($u in $urls) {
    $code = (curl.exe -s -k -o NUL -w "%{http_code}" --max-time 15 $u)
    # 405 means a GET reached a POST-only route, i.e. the request arrived.
    $verdict = switch ("$code") {
      '405'   { 'reachable (405 = wrong method, so the request arrived)' }
      '200'   { 'reachable' }
      '000'   { 'UNREACHABLE - this shell has no proxy, or it is blocked' }
      default { "returned $code" }
    }
    Write-Host ("  {0,-52} {1}" -f $u, $verdict)
  }
} else {
  Write-Host "  curl.exe not found (Windows older than 10 1803)." -ForegroundColor Yellow
  Write-Host "  Open https://chatgpt.com in a browser instead and report what happens." -ForegroundColor Yellow
}
Write-Host ""

Write-Host "[5] Versions" -ForegroundColor Cyan
$nodeV  = if (Get-Command node  -ErrorAction SilentlyContinue) { node -v }        else { 'not installed' }
$codexV = if (Get-Command codex -ErrorAction SilentlyContinue) { codex --version } else { 'not installed' }
Write-Host "  node  = $nodeV"
Write-Host "  codex = $codexV"
Write-Host ""

Write-Host "[6] Scheduled task" -ForegroundColor Cyan
# Guard the cmdlet's existence so this section degrades quietly instead of
# emitting a red error when the script is run somewhere without it.
$task = $null
if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
  $task = Get-ScheduledTask -TaskName 'Codex credential refresh' -ErrorAction SilentlyContinue
} else {
  Write-Host "  (scheduled-task cmdlets unavailable on this host)" -ForegroundColor Yellow
}
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName 'Codex credential refresh' -ErrorAction SilentlyContinue
  Write-Host "  state    = $($task.State)"
  Write-Host "  last run = $($info.LastRunTime)  result = $($info.LastTaskResult)"
  Write-Host "  next run = $($info.NextRunTime)"
} else {
  Write-Host "  not registered" -ForegroundColor Yellow
}
Write-Host ""

Read-Host "Copy the output above. Press Enter to close"
