param(
  [ValidateSet('PasswordHash', 'SessionSecret')][string]$Copy,
  [switch]$ClearClipboard,
  [switch]$Check,
  [string]$Directory
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'TightBudget'
if (-not $Directory) {
  $kst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'Korea Standard Time')
  $Directory = Join-Path $root ('preview-auth-rotation-' + $kst.ToString('yyyyMMdd'))
}
$Directory = [IO.Path]::GetFullPath($Directory)
if (-not $Directory.StartsWith(([IO.Path]::GetFullPath($root) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Use a private directory under LocalAppData/TightBudget, never the repository.'
}
if ($ClearClipboard) { Set-Clipboard -Value ''; Write-Host 'Current clipboard cleared. No secret was printed.'; return }
if ($Copy) {
  $clipboardSettings = $null
  try {
    # Read the key once, then inspect optional properties without asking the
    # registry provider for a missing value (which throws in Windows PS 5.1).
    $clipboardSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Clipboard' -ErrorAction Stop
  } catch [System.Management.Automation.ItemNotFoundException] {
    # A missing key, like an absent property, has no explicit enabled setting.
  } catch {
    throw 'Cannot verify clipboard privacy settings. No secret was copied.'
  }
  foreach ($name in @('EnableClipboardHistory', 'EnableCloudClipboard')) {
    $property = if ($null -ne $clipboardSettings) { $clipboardSettings.PSObject.Properties[$name] } else { $null }
    if ($null -eq $property) { continue }
    if ($property.Value -isnot [int] -or $property.Value -notin @(0, 1)) {
      throw 'Clipboard privacy setting is invalid or unknown. No secret was copied.'
    }
    if ($property.Value -eq 1) { throw 'Turn off Windows clipboard history/cloud sync before copying a secret, then retry. No secret was copied.' }
  }
  $key = if ($Copy -eq 'PasswordHash') { 'TB_ADMIN_PASSWORD_HASH' } else { 'TB_SESSION_SECRET' }
  $file = Join-Path $Directory ($key + '.secret')
  if (((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked secret paths are not allowed.' }
  $value = [IO.File]::ReadAllText($file)
  $pattern = if ($Copy -eq 'PasswordHash') { '^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$' } else { '^[A-Za-z0-9_-]{43}$' }
  if ($value -cnotmatch $pattern) { throw 'Secret file format is invalid; nothing was copied.' }
  try { Set-Clipboard -Value $value -ErrorAction Stop } finally { $value = $null }
  Write-Host ('COPY_SUCCEEDED: ' + $key + '. No secret was printed. Paste ONLY into the two named Preview Secret entries; not Production or common Preview. Clear clipboard afterward.')
  return
}
if (Test-Path -LiteralPath $Directory) {
  if (((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      @(Get-ChildItem -LiteralPath $Directory -Force).Count -ne 0) { throw 'Bundle already exists. Reuse -Copy; do not overwrite preserved values.' }
} else { $null = New-Item -ItemType Directory -Path $Directory }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
foreach ($principal in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
}
Set-Acl -LiteralPath $Directory -AclObject $acl
$actualAcl = Get-Acl -LiteralPath $Directory
$allowed = @($sid.Value, 'S-1-5-18')
$rules = @($actualAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actualAcl.AreAccessRulesProtected -or $rules.Count -ne 2 -or
    @($rules | Where-Object { $_.IdentityReference.Value -notin $allowed -or $_.AccessControlType -ne 'Allow' }).Count) {
  throw 'Private directory ACL verification failed. No credentials were generated.'
}
if ($Check) { Write-Host 'PRIVATE_DIRECTORY_READY. Current user + SYSTEM only. No credentials generated.'; return }
$plain = $null; $confirm = $null; $json = $null
try {
  $first = Read-Host 'New PREVIEW test password (8+ characters, English letter + digit; hidden)' -AsSecureString
  $second = Read-Host 'Confirm PREVIEW test password (hidden)' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($first)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($second)
  try { $confirm = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  $json = @{ password = $plain; confirmation = $confirm } | ConvertTo-Json -Compress
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = (Get-Command node -CommandType Application).Source
  $start.Arguments = '"' + (Join-Path $PSScriptRoot 'prepare-preview-auth-rotation.mjs') + '" --directory "' + $Directory + '"'
  $start.WorkingDirectory = $PSScriptRoot
  $start.UseShellExecute = $false
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($start)
  $process.StandardInput.Write($json); $process.StandardInput.Close()
  $output = $process.StandardOutput.ReadToEnd(); $null = $process.StandardError.ReadToEnd(); $process.WaitForExit()
  if ($process.ExitCode -ne 0 -or $output.Trim() -ne 'PREVIEW_ROTATION_READY') { throw 'Generation failed. Check the password policy/confirmation. Preserved partial files are not overwritten.' }
  Write-Host 'PREVIEW_ROTATION_READY. No password, hash or session secret was printed.'
  Write-Host ('Private bundle: ' + $Directory)
  Write-Host 'No Vercel, Redis, Production or PAT settings have been changed. Keep this terminal private; do not send secret values in chat.'
} finally {
  $plain = $null; $confirm = $null; $json = $null
  if ($first) { $first.Dispose() }; if ($second) { $second.Dispose() }
}
