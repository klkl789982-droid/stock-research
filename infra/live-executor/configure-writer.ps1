[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$writerPath = Join-Path $env:LOCALAPPDATA 'TightBudget/site-relay-writer.env'
if (Test-Path -LiteralPath $writerPath) { throw 'WRITER_FILE_EXISTS_PRESERVED' }
$writerSecure = Read-Host 'Private data repository Contents read/write token (hidden input)' -AsSecureString
$writerPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($writerSecure)
try {
  $writerValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($writerPointer)
  if ($writerValue -notmatch '^[A-Za-z0-9_]{20,500}$') { throw 'WRITER_TOKEN_FORMAT_INVALID' }
  $writerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $writerAcl = [Security.AccessControl.FileSecurity]::new()
  $writerAcl.SetAccessRuleProtection($true, $false)
  $writerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($writerSid, 'FullControl', 'Allow'))
  $writerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', 'Allow'))
  $writerStream = [IO.File]::Open($writerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $writerStream.Dispose()
  Set-Acl -LiteralPath $writerPath -AclObject $writerAcl
  $writerStream = [IO.File]::Open($writerPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $writerBytes = [Text.UTF8Encoding]::new($false).GetBytes('PRIVATE_LIVE_DELIVERY_WRITE_TOKEN=' + $writerValue + "`n"); $writerStream.Write($writerBytes, 0, $writerBytes.Length) } finally { $writerStream.Dispose() }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($writerPointer)
  $writerValue = $null; $writerBytes = $null; $writerSecure = $null
}
Write-Output 'WRITER_SAVED_PRIVATELY; run the isolated verification before restarting the managed executor.'
& (Get-Command node.exe).Source (Join-Path $PSScriptRoot 'verify-writer.mjs')
if ($LASTEXITCODE -ne 0) { throw 'WRITER_VERIFICATION_FAILED_FILE_PRESERVED' }
Write-Output 'WRITER_VERIFIED; the independent daemon reloads the dedicated file outside the observation window.'
