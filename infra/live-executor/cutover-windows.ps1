[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$StateDir, [Parameter(Mandatory=$true)][string]$BackupDir, [switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$cutRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$cutOldRoot = 'C:\Users\user\Desktop\stock-research'
$cutNode = (Get-Command node.exe).Source
$cutPs = (Get-Command powershell.exe).Source
$cutSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($cutPath in @($StateDir, $BackupDir)) { if (-not [IO.Path]::IsPathRooted($cutPath)) { throw 'CUTOVER_ABSOLUTE_PATH_REQUIRED' } }
$cutState = [IO.Path]::GetFullPath($StateDir)
$cutBackup = [IO.Path]::GetFullPath($BackupDir)
if ($cutBackup.StartsWith($cutRoot, [StringComparison]::OrdinalIgnoreCase) -or $cutBackup.StartsWith($cutState, [StringComparison]::OrdinalIgnoreCase)) { throw 'CUTOVER_BACKUP_MUST_BE_EXTERNAL' }
$cutDate = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow,'Korea Standard Time').ToString('yyyy-MM-dd')
$cutManifest = (& $cutNode (Join-Path $PSScriptRoot 'windows-task.mjs') "--root=$cutRoot" "--node=$cutNode" "--powershell=$cutPs" "--state-dir=$cutState" "--sid=$cutSid" "--date=$cutDate") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'CUTOVER_NEW_MANIFEST_INVALID' }
$cutOldManifest = (& $cutNode (Join-Path $PSScriptRoot 'windows-task.mjs') "--root=$cutOldRoot" "--node=$cutNode" "--powershell=$cutPs" "--state-dir=$cutState" "--sid=$cutSid" "--date=$cutDate") | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'CUTOVER_OLD_MANIFEST_INVALID' }
$cutTask = Get-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName
[xml]$cutXml = Export-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName
if ($cutXml.Task.RegistrationInfo.Description -ne $cutOldManifest.marker -or $cutXml.Task.Principals.Principal.UserId -ne $cutSid -or $cutXml.Task.Actions.Exec.WorkingDirectory -ne $cutOldRoot) { throw 'CUTOVER_EXISTING_OWNER_OR_ROOT_MISMATCH' }
$cutProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $cutOldRoot + '\infra\live-executor\*') })
if (-not $Apply) { [ordered]@{status='INSPECTED'; task=$cutManifest.taskName;oldRoot=$cutOldRoot;newRoot=$cutRoot;schedule=$cutManifest.scheduleKst;processIds=@($cutProcesses.ProcessId);backup=$cutBackup} | ConvertTo-Json; return }
if (Test-Path -LiteralPath $cutBackup) { throw 'CUTOVER_BACKUP_ALREADY_EXISTS_PRESERVED' }
New-Item -ItemType Directory -Path $cutBackup | Out-Null
$cutAcl = [Security.AccessControl.DirectorySecurity]::new()
$cutAcl.SetAccessRuleProtection($true,$false)
$cutAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($cutSid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
$cutAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $cutBackup -AclObject $cutAcl
[IO.File]::WriteAllText((Join-Path $cutBackup 'task-before.xml'), $cutXml.OuterXml, [Text.Encoding]::Unicode)
Copy-Item -LiteralPath (Join-Path $cutOldRoot '.env.local') -Destination (Join-Path $cutBackup 'environment-before.private')
Copy-Item -LiteralPath (Join-Path $cutOldRoot 'infra/live-executor') -Destination (Join-Path $cutBackup 'executor-before') -Recurse
$cutPatch = Join-Path $cutBackup 'desktop-before.patch'
& git -c core.bare=false -c "safe.directory=$cutOldRoot" -C $cutOldRoot diff --binary "--output=$cutPatch" HEAD
if ($LASTEXITCODE -ne 0) { throw 'CUTOVER_OLD_DIFF_BACKUP_FAILED' }
$cutHead = & git -c core.bare=false -c "safe.directory=$cutOldRoot" -C $cutOldRoot rev-parse HEAD
[IO.File]::WriteAllText((Join-Path $cutBackup 'code-before.txt'), [string]$cutHead)
$cutEnvironment = Join-Path $cutRoot '.env.local'
if (Test-Path -LiteralPath $cutEnvironment) { throw 'CUTOVER_NEW_ENV_ALREADY_EXISTS_PRESERVED' }
$cutCredentials = @(Get-Content -LiteralPath (Join-Path $cutOldRoot '.env.local') | Where-Object { $_ -match '^\s*KIS_APP_(KEY|SECRET)=' })
if ($cutCredentials.Count -ne 2) { throw 'CUTOVER_KIS_KEYS_UNAVAILABLE' }
[IO.File]::WriteAllLines($cutEnvironment, $cutCredentials, [Text.UTF8Encoding]::new($false))
$cutCredentials = $null
Disable-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName | Out-Null
try {
  Stop-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName
  foreach ($cutProcess in $cutProcesses) {
    $cutCurrent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cutProcess.ProcessId)
    if ($null -ne $cutCurrent -and $cutCurrent.CommandLine -eq $cutProcess.CommandLine) { Stop-Process -Id $cutCurrent.ProcessId -ErrorAction Stop }
  }
  $cutRemaining = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $cutOldRoot + '\infra\live-executor\*') })
  if ($cutRemaining.Count) { throw 'CUTOVER_OLD_PROCESS_REMAINS' }
  Copy-Item -LiteralPath $cutState -Destination (Join-Path $cutBackup 'state-before') -Recurse
  Register-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName -Xml $cutManifest.xml -Force | Out-Null
  [xml]$cutAfter = Export-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName
  if ($cutAfter.Task.RegistrationInfo.Description -ne $cutManifest.marker -or $cutAfter.Task.Actions.Exec.WorkingDirectory -ne $cutRoot) { throw 'CUTOVER_AFTER_VERIFY_FAILED' }
  [IO.File]::WriteAllText((Join-Path $cutBackup 'task-after.xml'), $cutAfter.OuterXml, [Text.Encoding]::Unicode)
  Start-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName
  [ordered]@{status='REGISTERED_STARTED';task=$cutManifest.taskName;root=$cutRoot;backup=$cutBackup;schedule=$cutManifest.scheduleKst;privateSendingConfigured=(Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'TightBudget/site-relay-writer.env'));publicPublicationEnabled=$false}|ConvertTo-Json
} catch {
  Register-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName -Xml $cutXml.OuterXml -Force | Out-Null
  Start-ScheduledTask -TaskPath '\' -TaskName $cutManifest.taskName
  throw 'CUTOVER_FAILED_OLD_TASK_RESTORED'
}
