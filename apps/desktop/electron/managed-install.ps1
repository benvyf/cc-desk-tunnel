# Keep this script ASCII: Windows PowerShell 5.1 reads scripts without a BOM using the system code page.
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [Parameter(Mandatory)][string]$ExpectedHash,
    [Parameter(Mandatory)][long]$ExpectedSize,
    [Parameter(Mandatory)][int]$ParentPid,
    [Parameter(Mandatory)][string]$Pending
)
$ErrorActionPreference = 'Stop'
function Write-Stage([string]$Text) {
    [IO.File]::AppendAllText("$Pending.helper.log", "$([DateTime]::UtcNow.ToString('o')) $Text`r`n")
}
try {
    Write-Stage "Waiting for client $ParentPid"
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Client exit timed out; installer was not started.' }
        Start-Sleep -Milliseconds 100
    }
    $item = Get-Item -LiteralPath $Installer
    $cache = Get-Item -LiteralPath $item.DirectoryName
    if ($cache.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update cache cannot be a reparse point.' }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer cannot be a reparse point.' }
    if ($item.Length -ne $ExpectedSize -or (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {
        throw 'Final artifact verification failed.'
    }
    $remaining = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and [IO.Path]::GetDirectoryName($_.ExecutablePath).Equals($InstallDirectory, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type='
    })
    if ($remaining.Count) { throw 'Client processes remain in the install directory; installer was not started.' }
    Write-Stage "Verified installer; target directory: $InstallDirectory"
    # NSIS /D must be the final argument; the installer remains interactive.
    $child = Start-Process -FilePath $Installer -ArgumentList "/D=$InstallDirectory" -PassThru
    Write-Stage "Installer process: $($child.Id)"
    $child.WaitForExit()
    Write-Stage "Installer exited: $($child.ExitCode)"
    if ($child.ExitCode -ne 0) { throw "Installer exit code: $($child.ExitCode)" }
} catch {
    Write-Stage "Failed: $($_.Exception.Message)"
    # The application confirms success only from the target build on its next launch.
    [IO.File]::WriteAllText("$Pending.failure.txt", $_.Exception.Message)
    exit 1
}
