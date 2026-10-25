# Run in an administrator PowerShell. Electron stays in the ordinary Codex process.
param(
    [Parameter(Mandatory = $true)][string]$RunDirectory,
    [ValidateRange(30, 180)][int]$MaxSeconds = 180
)
$ErrorActionPreference = 'Stop'
$captureDirectory = [IO.Path]::GetFullPath($RunDirectory)
$runFile = Join-Path $captureDirectory 'run.json'
$run = Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json
if ($run.schema -ne 1 -or $run.nonce -notmatch '^[a-f0-9]{24}$') { throw 'Invalid capture run.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator PowerShell is required only for packet capture.'
}
$pktmon = Join-Path $env:SystemRoot 'System32\PktMon.exe'
$utf8 = New-Object Text.UTF8Encoding($false)
# PktMon emits UTF-8 to redirected stdout. Windows PowerShell 5 otherwise
# decodes it using the administrator console's legacy code page.
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
function Write-PrivateJson([string]$Name, $Value) {
    [IO.File]::WriteAllText((Join-Path $captureDirectory $Name), ($Value | ConvertTo-Json -Depth 8), $utf8)
}
function Invoke-PacketMonitor([string[]]$Arguments) {
    $output = & $pktmon @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "PktMon failed: $($output -join ' ')" }
    return ($output -join "`n")
}
$status = Invoke-PacketMonitor -Arguments @('status')
[IO.File]::WriteAllText((Join-Path $captureDirectory 'capture-preflight-status.txt'), $status, $utf8)
if ($status -notmatch '\u6ca1\u6709\u8fd0\u884c|not running') { throw "Unrecognized/active packet monitor; refusing to interfere. Status: $status" }
$filters = Invoke-PacketMonitor -Arguments @('filter', 'list')
if ($filters -notmatch '(?s)(\u7b5b\u9009\u5668:\s*\u65e0|filters:\s*(none|no filters)\.?)\s*$') {
    throw 'Existing or unrecognized filters; refusing to change them.'
}
foreach ($name in @('capture.etl', 'capture.pcapng', 'capture-ready.json', 'capture-stopped.json', 'capture-failed.json', 'capture-complete.json', 'test-finished.json')) {
    if (Test-Path -LiteralPath (Join-Path $captureDirectory $name)) { throw "Existing run file: $name" }
}
$etl = Join-Path $captureDirectory 'capture.etl'
$pcap = Join-Path $captureDirectory 'capture.pcapng'
$started = $false
try {
    # No filters are added or removed. Keep only short packet prefixes locally;
    # DNS ETW supplies query names even when a packet prefix truncates a name.
    $start = Invoke-PacketMonitor -Arguments @('start', '--capture', '--comp', 'all', '--pkt-size', '128',
        '--trace', '--provider', 'Microsoft-Windows-DNS-Client', '--level', '5',
        '--file-name', $etl, '--file-size', '64', '--log-mode', 'circular')
    $started = $true
    [IO.File]::WriteAllText((Join-Path $captureDirectory 'capture-start.txt'), $start, $utf8)
    $initialStatus = Invoke-PacketMonitor -Arguments @('status')
    [IO.File]::WriteAllText((Join-Path $captureDirectory 'capture-active.txt'), $initialStatus, $utf8)
    if ($initialStatus.IndexOf($etl, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Cannot confirm the new capture filename. Check pktmon status manually.'
    }
    $startedAt = [DateTime]::UtcNow
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Write-PrivateJson 'capture-ready.json' @{ nonce = $run.nonce; startedAt = $startedAt.ToString('o'); maxSeconds = $MaxSeconds }
    Write-Host "CAPTURE_READY - keep this window open. Stop requested within $MaxSeconds seconds while session ownership remains confirmed."
    while ($timer.Elapsed.TotalSeconds -lt $MaxSeconds) {
        if (Test-Path -LiteralPath (Join-Path $captureDirectory 'test-finished.json')) { break }
        Start-Sleep -Milliseconds 500
    }
} finally {
    if ($started) {
      try {
        $activeStatus = Invoke-PacketMonitor -Arguments @('status')
        if ($activeStatus.IndexOf($etl, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw 'Capture identity is no longer confirmed; refusing to stop another session. Check pktmon status manually.'
        }
        $stopped = Invoke-PacketMonitor -Arguments @('stop')
        $stoppedAt = [DateTime]::UtcNow
        Write-PrivateJson 'capture-stopped.json' @{ nonce = $run.nonce; endedAt = $stoppedAt.ToString('o'); elapsedSeconds = $timer.Elapsed.TotalSeconds }
        [IO.File]::WriteAllText((Join-Path $captureDirectory 'capture-stop.txt'), $stopped, $utf8)
      } catch {
        Write-PrivateJson 'capture-failed.json' @{ nonce = $run.nonce; error = $_.Exception.Message; captureMayStillBeRunning = $true }
        $readyFile = Join-Path $captureDirectory 'capture-ready.json'
        if (Test-Path -LiteralPath $readyFile) { Remove-Item -LiteralPath $readyFile }
        throw 'Capture ownership/stop failed. Capture may still be running: inspect pktmon status in this administrator terminal before taking further action.'
      }
    }
}
$conversion = Invoke-PacketMonitor -Arguments @('etl2pcap', $etl, '--out', $pcap)
[IO.File]::WriteAllText((Join-Path $captureDirectory 'capture-convert.txt'), $conversion, $utf8)
$statistics = Invoke-PacketMonitor -Arguments @('etl2txt', $etl, '--stats')
[IO.File]::WriteAllText((Join-Path $captureDirectory 'capture-statistics.txt'), $statistics, $utf8)
$dnsFile = Join-Path $captureDirectory 'dns-events.jsonl'
$writer = New-Object IO.StreamWriter($dnsFile, $false, $utf8)
$dnsError = $null
try {
    Get-WinEvent -FilterHashtable @{ Path = $etl; ProviderName = 'Microsoft-Windows-DNS-Client' } -Oldest -ErrorAction Stop |
        ForEach-Object { $writer.WriteLine((@{ xml = $_.ToXml() } | ConvertTo-Json -Compress)) }
} catch {
    $dnsError = $_.Exception.Message
} finally { $writer.Dispose() }
$endStatus = Invoke-PacketMonitor -Arguments @('status')
Write-PrivateJson 'capture-complete.json' @{ nonce = $run.nonce; endedAt = $stoppedAt.ToString('o'); exportedAt = [DateTime]::UtcNow.ToString('o');
    bytes = (Get-Item -LiteralPath $pcap).Length; dnsExtractionError = $dnsError; status = $endStatus }
Write-Host 'CAPTURE_FINISHED - files remain in the private local run directory. No upload was performed.'
