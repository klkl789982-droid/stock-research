[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BackupDir)
$ErrorActionPreference='Stop'
$restoreRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$restoreSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$restoreName='TightBudget-Live-Executor-' + $restoreSid.Split('-')[-1]
[xml]$restoreBefore=[IO.File]::ReadAllText((Join-Path $BackupDir 'task-before.xml'))
[xml]$restoreCurrent=Export-ScheduledTask -TaskPath '\' -TaskName $restoreName
if($restoreBefore.Task.Principals.Principal.UserId -ne $restoreSid -or $restoreCurrent.Task.Principals.Principal.UserId -ne $restoreSid -or $restoreCurrent.Task.Actions.Exec.WorkingDirectory -ne $restoreRoot){throw 'RESTORE_TASK_OWNER_OR_ROOT_MISMATCH'}
Disable-ScheduledTask -TaskPath '\' -TaskName $restoreName|Out-Null
Stop-ScheduledTask -TaskPath '\' -TaskName $restoreName
$restoreProcesses=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'node.exe' -and $_.CommandLine -like ('*'+$restoreRoot+'\infra\live-executor\*')})
foreach($restoreProcess in $restoreProcesses){Stop-Process -Id $restoreProcess.ProcessId -ErrorAction SilentlyContinue}
Register-ScheduledTask -TaskPath '\' -TaskName $restoreName -Xml $restoreBefore.OuterXml -Force|Out-Null
Start-ScheduledTask -TaskPath '\' -TaskName $restoreName
Write-Output 'PREVIOUS_PC_TASK_RESTORED; private observation and outbox files were not changed. Coordinate external LIVE producers before re-enabling them.'
