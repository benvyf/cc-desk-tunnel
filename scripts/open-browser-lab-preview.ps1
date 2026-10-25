# Starts the local source preview with its own profile. Does not connect to any service automatically.
$ErrorActionPreference = 'Stop'
$labSource = Split-Path -Parent $PSScriptRoot
$labElectron = Join-Path $labSource 'node_modules/electron/dist/electron.exe'
$labApp = Join-Path $labSource 'apps/desktop'
$labProfile = Join-Path $labSource '.local/browser-lab-client-profile'
if (-not (Test-Path -LiteralPath $labElectron -PathType Leaf)) {
    throw 'Bundled Electron is missing; use the prepared development workspace.'
}
if (-not (Test-Path -LiteralPath (Join-Path $labApp 'dist/index.html') -PathType Leaf)) {
    throw 'Build the desktop UI before starting this preview.'
}
$labProcess = [Diagnostics.ProcessStartInfo]::new()
$labProcess.FileName = $labElectron
$labProcess.WorkingDirectory = $labSource
$labProcess.UseShellExecute = $false
$labProcess.Arguments = '"{0}" "--user-data-dir={1}"' -f $labApp, $labProfile
$labProcess.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$labChild = [Diagnostics.Process]::Start($labProcess)
Write-Output "Local preview started (PID=$($labChild.Id)); profile=$labProfile"
Write-Output 'Use only the synthetic lab address, temporary credential and verified certificate fingerprint.'
