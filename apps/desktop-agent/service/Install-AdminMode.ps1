[CmdletBinding()]
param(
  [string]$AgentExecutable = (Join-Path $PSScriptRoot 'Remote-Support-Agent-0.4.10-Windows-x64.exe')
)

$ErrorActionPreference = 'Stop'
$serviceName = 'OrganizationRemoteSupport'
$taskName = 'Organization Remote Support Admin Agent'
$installRoot = Join-Path $env:ProgramFiles 'Organization Remote Support'
$serviceSource = Join-Path $PSScriptRoot 'RemoteSupportService.exe'
$serviceTarget = Join-Path $installRoot 'RemoteSupportService.exe'
$agentTarget = Join-Path $installRoot 'Remote-Support-Agent-Admin.exe'
$uninstallSource = Join-Path $PSScriptRoot 'Uninstall-AdminMode.ps1'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'เปิด PowerShell ด้วย Run as administrator แล้วรันสคริปต์นี้อีกครั้ง'
}
if (-not (Test-Path -LiteralPath $AgentExecutable -PathType Leaf)) { throw "ไม่พบ Agent: $AgentExecutable" }
if (-not (Test-Path -LiteralPath $serviceSource -PathType Leaf)) { throw "ไม่พบ Service: $serviceSource" }

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Copy-Item -LiteralPath $AgentExecutable -Destination $agentTarget -Force
Copy-Item -LiteralPath $serviceSource -Destination $serviceTarget -Force
Copy-Item -LiteralPath $uninstallSource -Destination (Join-Path $installRoot 'Uninstall-AdminMode.ps1') -Force
Unblock-File -LiteralPath $agentTarget,$serviceTarget

$interactiveUser = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $interactiveUser) { throw 'ไม่พบผู้ใช้ Windows ที่กำลังเข้าสู่ระบบ' }

$action = New-ScheduledTaskAction -Execute $agentTarget
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $interactiveUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'Starts the consent-first Remote Support Agent with highest approved privileges.' -Force | Out-Null

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $serviceName | Out-Null
  Start-Sleep -Milliseconds 500
}
New-Service -Name $serviceName -BinaryPathName ('"' + $serviceTarget + '"') -DisplayName 'Organization Remote Support Service' -StartupType Automatic -Description 'Watchdog for the consent-first Organization Remote Support Admin Agent.' | Out-Null
& sc.exe config $serviceName start= delayed-auto | Out-Null
Start-Service -Name $serviceName
Start-ScheduledTask -TaskName $taskName

Write-Host 'ติดตั้ง Organization Remote Support Admin Mode สำเร็จ' -ForegroundColor Green
Write-Host "ผู้ใช้: $interactiveUser"
Write-Host "ตำแหน่ง: $installRoot"
Write-Host 'UAC ยังคงเปิดอยู่ และผู้ใช้ปลายทางต้องยืนยันก่อนเปิดไฟล์ติดตั้งทุกครั้ง'
