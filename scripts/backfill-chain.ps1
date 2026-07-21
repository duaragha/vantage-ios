$ErrorActionPreference = 'Stop'
$root = 'C:\Users\ragha\Projects\personal_projects\vantage'
$logFile = Join-Path $root 'logs\backfill-chain.log'

$envLine = (Get-Content (Join-Path $root '.env') | Where-Object { $_ -match '^WORKER_SECRET=' } | Select-Object -First 1)
$secret = $envLine -replace '^WORKER_SECRET=', ''
if (-not $secret) { throw 'WORKER_SECRET not found in .env' }

function Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')  $msg"
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

function Fire($path, $body) {
  Log "POST $path  body=$body"
  $headers = @{ 'x-worker-secret' = $secret }
  try {
    $r = Invoke-RestMethod -Method Post -Uri "http://localhost:3001$path" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 36000
    Log "  result: $($r | ConvertTo-Json -Compress -Depth 6)"
    return $r
  } catch {
    Log "  ERROR: $($_.Exception.Message)"
    throw
  }
}

Log '=== chain start ==='
Fire '/jobs/backfill/profiles'   '{}'
Fire '/jobs/poll/fundamentals'   '{"force":true}'
Fire '/jobs/discover/compute'    '{}'
Log '=== chain done ==='
