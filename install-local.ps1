$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '未找到 Node.js。请先安装 Node.js 20 或更新版本，然后重新打开 PowerShell。'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw '未找到 npm。请使用包含 npm 的 Node.js 安装包。'
}

$nodeVersion = (& node --version).Trim()
$nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 版本过低：$nodeVersion。需要 Node.js 20 或更新版本。"
}

$cacheDirectory = Join-Path $PSScriptRoot '.npm-cache'
npm ci --cache $cacheDirectory --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    throw "npm ci 执行失败，退出码：$LASTEXITCODE"
}

Write-Host "Node.js 版本：$nodeVersion"
Write-Host "依赖已安装到：$(Join-Path $PSScriptRoot 'node_modules')"
Write-Host "npm 缓存位于：$cacheDirectory"
