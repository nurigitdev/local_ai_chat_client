[CmdletBinding()]
param(
    [switch]$Package
)

$ErrorActionPreference = 'Stop'
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$SetupScript = Join-Path $PSScriptRoot 'setup.ps1'

if (-not (Get-Command go -ErrorAction SilentlyContinue) -or -not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    & $SetupScript
}

$GoBin = Join-Path ((go env GOPATH).Trim()) 'bin'
$Wails = Join-Path $GoBin 'wails3.exe'
if (-not (Test-Path (Join-Path $RootDir 'frontend\node_modules')) -or -not (Test-Path $Wails)) {
    & $SetupScript
}

$env:Path = "$GoBin;$env:Path"
if ($Package) {
    & $Wails task package
} else {
    & $Wails build
}
exit $LASTEXITCODE
