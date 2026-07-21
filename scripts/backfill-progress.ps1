$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\Users\ragha\Projects\personal_projects\vantage'
$chainLog = Join-Path $root 'logs\backfill-chain.log'

# Known totals at chain-start (snapshot before kickoff).
$baselineMcap     = 18      # rows with marketCapUsd populated before backfillProfiles
$targetMcap       = 7147    # USD non-lottery rows that backfillProfiles will visit
$targetFundamentals = 1000  # top-1000 by mcap that pollFundamentals will write
$baselineDiscovery = 40     # distinct tickers in DiscoveryScore before discover.compute
$targetDiscovery   = 1000   # universe size after expansion

function Get-Counts {
  $script = @'
const { PrismaClient } = require('./packages/db/node_modules/@prisma/client');
const p = new PrismaClient();
(async () => {
  const mcap = await p.tickerUniverse.count({ where: { marketCapUsd: { not: null } } });
  const metrics = await p.tickerMetrics.count();
  const latestComputedAt = (await p.discoveryScore.aggregate({ _max: { computedAt: true } }))._max.computedAt;
  const distinctScored = latestComputedAt
    ? await p.discoveryScore.count({ where: { computedAt: latestComputedAt } })
    : 0;
  console.log(JSON.stringify({ mcap, metrics, distinctScored }));
  await p.$disconnect();
})();
'@
  $tmp = Join-Path $env:TEMP 'backfill_progress_query.cjs'
  Set-Content -Path $tmp -Value $script -Encoding utf8
  $out = & node --env-file="$root\.env" $tmp 2>$null
  Remove-Item $tmp -ErrorAction SilentlyContinue
  if ($out) { try { return ($out | ConvertFrom-Json) } catch { return $null } }
  return $null
}

function Get-CurrentPhase {
  if (-not (Test-Path $chainLog)) { return 'pending' }
  $lines = Get-Content $chainLog -Tail 25 -ErrorAction SilentlyContinue
  if ($lines -match '=== chain done ===') { return 'done' }
  $last = ($lines | Where-Object { $_ -match 'POST /jobs/' } | Select-Object -Last 1)
  if (-not $last) { return 'pending' }
  if ($last -match 'backfill/profiles') { return 'backfillProfiles' }
  if ($last -match 'poll/fundamentals') { return 'pollFundamentals' }
  if ($last -match 'discover/compute')  { return 'discover.compute' }
  return 'pending'
}

function Bar([int]$pct) {
  $width = 30
  $filled = [math]::Min($width, [math]::Floor($pct * $width / 100))
  '[' + ('#' * $filled) + ('.' * ($width - $filled)) + ']'
}

Clear-Host
Write-Host "watching backfill chain — Ctrl+C to stop`n"

while ($true) {
  $phase = Get-CurrentPhase
  if ($phase -eq 'done') {
    Write-Host "`n=== chain finished ==="
    break
  }
  $c = Get-Counts
  $ts = Get-Date -Format 'HH:mm:ss'

  if (-not $c) {
    Write-Host -NoNewline "`r[$ts] $phase  (db query failed, retry in 15s)            "
  } else {
    $line = switch ($phase) {
      'backfillProfiles' {
        $done = [math]::Max(0, $c.mcap - $baselineMcap)
        $tot  = $targetMcap - $baselineMcap
        $pct  = if ($tot -gt 0) { [int](100 * $done / $tot) } else { 0 }
        '[{0}] backfillProfiles  {1} {2}pct  ({3} / {4} mcaps)' -f $ts, (Bar $pct), $pct, $done, $tot
      }
      'pollFundamentals' {
        $pct = if ($targetFundamentals -gt 0) { [int](100 * $c.metrics / $targetFundamentals) } else { 0 }
        if ($pct -gt 100) { $pct = 100 }
        '[{0}] pollFundamentals  {1} {2}pct  ({3} / {4} metrics rows)' -f $ts, (Bar $pct), $pct, $c.metrics, $targetFundamentals
      }
      'discover.compute' {
        $pct = if ($targetDiscovery -gt 0) { [int](100 * $c.distinctScored / $targetDiscovery) } else { 0 }
        if ($pct -gt 100) { $pct = 100 }
        '[{0}] discover.compute  {1} {2}pct  ({3} / {4} scored)' -f $ts, (Bar $pct), $pct, $c.distinctScored, $targetDiscovery
      }
      default {
        '[{0}] {1}  (waiting...)' -f $ts, $phase
      }
    }
    Write-Host -NoNewline ("`r" + $line + '          ')
  }

  Start-Sleep -Seconds 15
}
