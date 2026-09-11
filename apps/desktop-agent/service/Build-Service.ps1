[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'RemoteSupportService.cs'
$output = Join-Path $PSScriptRoot 'RemoteSupportService.exe'
$compiler = Get-ChildItem "$env:WINDIR\Microsoft.NET\Framework64" -Filter csc.exe -Recurse |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $compiler) { throw 'ไม่พบ .NET Framework C# compiler' }

& $compiler /nologo /target:exe /optimize+ /out:$output /reference:System.ServiceProcess.dll $source
if ($LASTEXITCODE -ne 0) { throw "คอมไพล์ Service ไม่สำเร็จ: $LASTEXITCODE" }
& $output --check
if ($LASTEXITCODE -ne 0) { throw 'Service self-check ไม่ผ่าน' }
Write-Host "สร้าง Service สำเร็จ: $output" -ForegroundColor Green
