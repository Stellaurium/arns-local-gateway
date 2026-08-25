$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node .\src\server.js
