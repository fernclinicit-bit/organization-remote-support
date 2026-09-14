[CmdletBinding()]
param(
  [string]$Version = '0.5.0'
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path $PSScriptRoot -Parent
$releaseRoot = Join-Path $agentRoot 'release'
$agentExecutable = Join-Path $releaseRoot "Remote-Support-Agent-$Version-Windows-x64.exe"
$bundleName = "Remote-Support-Agent-AdminMode-$Version-Windows-x64"
$bundleRoot = Join-Path $releaseRoot $bundleName
$archive = Join-Path $releaseRoot "$bundleName.zip"

& (Join-Path $PSScriptRoot 'Build-Service.ps1')
& (Join-Path $agentRoot 'native\Build-InputHost.ps1')
if (-not (Test-Path -LiteralPath $agentExecutable -PathType Leaf)) {
  throw "ไม่พบ Agent build: $agentExecutable กรุณารัน npm run dist:win ก่อน"
}

if (Test-Path -LiteralPath $bundleRoot) { Remove-Item -LiteralPath $bundleRoot -Recurse -Force }
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
Copy-Item -LiteralPath $agentExecutable -Destination $bundleRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'RemoteSupportService.exe') -Destination $bundleRoot
Copy-Item -LiteralPath (Join-Path $agentRoot 'native\RemoteInputHost.exe') -Destination $bundleRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-AdminMode.ps1') -Destination $bundleRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall-AdminMode.ps1') -Destination $bundleRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ADMIN-MODE-README.txt') -Destination $bundleRoot
Compress-Archive -Path (Join-Path $bundleRoot '*') -DestinationPath $archive -CompressionLevel Optimal
Write-Host "สร้าง Admin Mode bundle สำเร็จ: $archive" -ForegroundColor Green
