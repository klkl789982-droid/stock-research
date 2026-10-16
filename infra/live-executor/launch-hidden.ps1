[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
  if (-not [System.IO.Path]::IsPathRooted($NodePath) -or -not [System.IO.Path]::IsPathRooted($StateDir)) { throw 'HOST_ABSOLUTE_PATH_REQUIRED' }
  $taskNode = Get-Item -LiteralPath $NodePath -ErrorAction Stop
  if ($taskNode.PSIsContainer -or $taskNode.Name -ne 'node.exe') { throw 'HOST_NODE_INVALID' }
  $taskHost = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'host.mjs'))
  if (-not (Test-Path -LiteralPath $taskHost -PathType Leaf)) { throw 'HOST_SCRIPT_UNAVAILABLE' }
  $taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  $taskState = [System.IO.Path]::GetFullPath($StateDir).TrimEnd('\')
  if ($taskState.Contains('"') -or $taskState.Contains("`r") -or $taskState.Contains("`n")) { throw 'HOST_STATE_PATH_INVALID' }
  $taskArguments = @(('"' + $taskHost + '"'), ('"--state-dir=' + $taskState + '"'))
  $taskProcess = Start-Process -FilePath $taskNode.FullName -ArgumentList $taskArguments -WorkingDirectory $taskRoot -WindowStyle Hidden -Wait -PassThru
  exit $taskProcess.ExitCode
} catch {
  # No exception details: credential helpers and process output may contain secrets.
  Write-Error 'LIVE_HOST_LAUNCH_FAILED'
  exit 1
}
