[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serviceName = 'OrganizationRemoteSupport'
$taskName = 'Organization Remote Support Admin Agent'
$brokerTaskName = 'Organization Remote Support Elevated Input Broker'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'เปิด PowerShell ด้วย Run as administrator แล้วรันสคริปต์นี้อีกครั้ง'
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $brokerTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $brokerTaskName -Confirm:$false -ErrorAction SilentlyContinue
Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  & sc.exe delete $serviceName | Out-Null
}

Write-Host 'ถอนการลงทะเบียน Service และ Scheduled Task แล้ว' -ForegroundColor Green
Write-Host 'สามารถลบโฟลเดอร์ Program Files\Organization Remote Support หลังปิด Agent ได้'
