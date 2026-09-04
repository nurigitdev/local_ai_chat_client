[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$AppBinary = Join-Path $RootDir 'bin\agent-chat-desktop.exe'

if (-not (Test-Path $AppBinary)) {
    & (Join-Path $PSScriptRoot 'build.ps1')
}

& $AppBinary
exit $LASTEXITCODE
