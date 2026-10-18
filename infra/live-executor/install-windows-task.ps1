[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StateDir,
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
  [switch]$Register
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-NoReparsePoint([string]$Target) {
  $taskCurrent = [System.IO.Path]::GetFullPath($Target)
  while ($taskCurrent) {
    if (Test-Path -LiteralPath $taskCurrent) {
      $taskItem = Get-Item -LiteralPath $taskCurrent -Force
      if (($taskItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'TASK_REPARSE_POINT_REJECTED' }
    }
    $taskParent = [System.IO.Path]::GetDirectoryName($taskCurrent)
    if ($taskParent -eq $taskCurrent) { break }
    $taskCurrent = $taskParent
  }
}

$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not [System.IO.Path]::IsPathRooted($StateDir) -or -not [System.IO.Path]::IsPathRooted($NodePath)) { throw 'TASK_ABSOLUTE_PATH_REQUIRED' }
$taskState = [System.IO.Path]::GetFullPath($StateDir)
$taskNode = Get-Item -LiteralPath $NodePath -ErrorAction Stop
$taskPowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$taskSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskDate = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'Korea Standard Time').ToString('yyyy-MM-dd')
Assert-NoReparsePoint $taskRoot
Assert-NoReparsePoint $taskState
Assert-NoReparsePoint $taskNode.FullName
foreach ($taskRequired in @('host.mjs', 'run.mjs', 'launch-hidden.ps1', 'windows-task.mjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $taskRequired) -PathType Leaf)) { throw 'TASK_REQUIRED_FILE_UNAVAILABLE' }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.env.local') -PathType Leaf)) { throw 'TASK_ENVIRONMENT_FILE_UNAVAILABLE' }
if ($taskNode.PSIsContainer -or $taskNode.Name -ne 'node.exe') { throw 'TASK_NODE_INVALID' }
$taskNodeVersion = & $taskNode.FullName '--version'
if ($LASTEXITCODE -ne 0 -or $taskNodeVersion -notmatch '^v(2[2-9]|[3-9][0-9])\.') { throw 'TASK_NODE_22_OR_NEWER_REQUIRED' }
$taskGenerated = & $taskNode.FullName (Join-Path $PSScriptRoot 'windows-task.mjs') "--root=$taskRoot" "--node=$($taskNode.FullName)" "--powershell=$taskPowerShell" "--state-dir=$taskState" "--sid=$taskSid" "--date=$taskDate"
if ($LASTEXITCODE -ne 0) { throw 'TASK_MANIFEST_GENERATION_FAILED' }
$taskManifest = $taskGenerated | ConvertFrom-Json
[xml]$taskXml = $taskManifest.xml
if ($taskXml.Task.RegistrationInfo.Description -ne $taskManifest.marker -or $taskXml.Task.Principals.Principal.UserId -ne $taskSid) { throw 'TASK_MANIFEST_IDENTITY_INVALID' }

# Inspect exact registration before considering replacement. An unrelated task is never overwritten.
$taskExisting = $null
try { $taskExisting = Get-ScheduledTask -TaskPath $taskManifest.taskPath -TaskName $taskManifest.taskName -ErrorAction Stop }
catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw 'TASK_EXISTING_STATE_UNAVAILABLE' } }
if ($null -ne $taskExisting) {
  [xml]$taskExistingXml = Export-ScheduledTask -TaskPath $taskManifest.taskPath -TaskName $taskManifest.taskName
  if ($taskExistingXml.Task.RegistrationInfo.Description -ne $taskManifest.marker -or $taskExistingXml.Task.Principals.Principal.UserId -ne $taskSid) { throw 'TASK_EXISTING_NOT_OWNED' }
  if ($Register -and $taskExisting.State -eq 'Running') { throw 'TASK_EXISTING_RUNNING_PRESERVED' }
}

if (-not $Register) {
  [ordered]@{ status = 'INSPECTED_NOT_REGISTERED'; taskName = $taskManifest.taskName; scheduleKst = $taskManifest.scheduleKst; scheduledUtc = $taskManifest.scheduledUtc; principal = $taskSid; runLevel = 'LeastPrivilege'; publicationEnabled = $false; credentialFileExists = $true; existingManagedTask = ($null -ne $taskExisting); xml = $taskManifest.xml; limitations = $taskManifest.limitations } | ConvertTo-Json -Depth 5
  return
}

# This explicit switch is the sole mutation path. No execution-policy change or credential registration occurs.
Register-ScheduledTask -TaskPath $taskManifest.taskPath -TaskName $taskManifest.taskName -Xml $taskManifest.xml -Force | Out-Null
[xml]$taskRegisteredXml = Export-ScheduledTask -TaskPath $taskManifest.taskPath -TaskName $taskManifest.taskName
$taskRegistered = Get-ScheduledTask -TaskPath $taskManifest.taskPath -TaskName $taskManifest.taskName
$taskInfo = Get-ScheduledTaskInfo -TaskPath $taskManifest.taskPath -TaskName $taskManifest.taskName
if ($taskRegisteredXml.Task.RegistrationInfo.Description -ne $taskManifest.marker -or $taskRegisteredXml.Task.Principals.Principal.UserId -ne $taskSid -or $taskRegisteredXml.Task.Settings.MultipleInstancesPolicy -ne 'IgnoreNew' -or $taskRegisteredXml.Task.Settings.WakeToRun -ne 'true' -or $taskRegisteredXml.Task.Settings.Priority -ne '4') { throw 'TASK_REGISTRATION_VERIFICATION_FAILED' }
[ordered]@{ status = 'REGISTERED'; explicitStartRequested = $false; taskName = $taskManifest.taskName; taskState = [string]$taskRegistered.State; scheduleKst = $taskManifest.scheduleKst; scheduledUtc = $taskManifest.scheduledUtc; principal = $taskSid; runLevel = 'LeastPrivilege'; publicationEnabled = $false; nextRunTime = $taskInfo.NextRunTime.ToString('o'); limitations = $taskManifest.limitations } | ConvertTo-Json -Depth 5
