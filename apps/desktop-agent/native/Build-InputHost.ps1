[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'RemoteInputHost.cs'
$output = Join-Path $PSScriptRoot 'RemoteInputHost.exe'
$compiler = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64" -Filter csc.exe -Recurse |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $compiler) { throw 'ไม่พบ .NET Framework C# compiler' }

& $compiler /nologo /target:winexe /optimize+ /out:$output /reference:System.Core.dll /reference:System.Security.dll $source
if ($LASTEXITCODE -ne 0) { throw "คอมไพล์ Input Broker ไม่สำเร็จ: $LASTEXITCODE" }
& $output --check
if ($LASTEXITCODE -ne 0) { throw 'Input Broker self-check ไม่ผ่าน' }
Write-Host "สร้าง Input Broker สำเร็จ: $output" -ForegroundColor Green
