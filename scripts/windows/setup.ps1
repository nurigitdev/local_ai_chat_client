[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WailsVersion = 'v3.0.0-beta.11'

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name 이(가) 필요합니다. $InstallHint"
    }
}

Require-Command git 'winget install --id Git.Git -e --source winget'
Require-Command go 'winget install --id GoLang.Go -e --source winget'
Require-Command node 'winget install --id OpenJS.NodeJS.LTS -e --source winget'
Require-Command npm 'Node.js를 설치한 뒤 PowerShell을 새로 여세요.'

$GoBin = Join-Path ((go env GOPATH).Trim()) 'bin'
$Wails = Join-Path $GoBin 'wails3.exe'
if (-not (Test-Path $Wails) -or -not ((& $Wails version 2>&1) -match [regex]::Escape($WailsVersion))) {
    Write-Host "Wails $WailsVersion CLI를 준비합니다…"
    go install "github.com/wailsapp/wails/v3/cmd/wails3@$WailsVersion"
}

$env:Path = "$GoBin;$env:Path"
Write-Host '프런트엔드 의존성을 준비합니다…'
Push-Location (Join-Path $RootDir 'frontend')
try {
    npm install --no-audit --no-fund
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Wails 환경을 확인합니다…'
& $Wails doctor
Write-Host ''
Write-Host '준비가 완료되었습니다. 개발 실행: .\scripts\windows\dev.ps1'
