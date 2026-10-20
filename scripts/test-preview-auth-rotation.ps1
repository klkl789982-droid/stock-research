# Windows PowerShell 5.1 regression test. Synthetic files and mocked clipboard /
# registry reads only: never change Windows settings or the user's clipboard.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'prepare-preview-auth-rotation.ps1'
$fixtureRoot = Join-Path $env:LOCALAPPDATA 'TightBudget'
$fixture = Join-Path $fixtureRoot ('preview-copy-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$hashFile = Join-Path $fixture 'TB_ADMIN_PASSWORD_HASH.secret'
$sessionFile = Join-Path $fixture 'TB_SESSION_SECRET.secret'
$syntheticHash = 'scrypt$131072$8$1$' + ('a' * 32) + '$' + ('b' * 64)
$syntheticSession = 'x' * 43
[IO.File]::WriteAllText($hashFile, $syntheticHash)
[IO.File]::WriteAllText($sessionFile, $syntheticSession)
$beforeHash = (Get-FileHash -LiteralPath $hashFile).Hash
$beforeSession = (Get-FileHash -LiteralPath $sessionFile).Hash
$global:TbPreviewCopyFixture = @{ Case = ''; CopiedValue = $null; CopyCount = 0 }

function Get-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath)
  if ($LiteralPath -ne 'HKCU:\Software\Microsoft\Clipboard') { throw 'UNEXPECTED_REGISTRY_PATH' }
  switch ($global:TbPreviewCopyFixture.Case) {
    'missing-key' { throw [System.Management.Automation.ItemNotFoundException]::new('Synthetic missing key') }
    'missing-properties' { return [pscustomobject]@{} }
    'one-property-missing' { return [pscustomobject]@{ EnableClipboardHistory = 0 } }
    'disabled' { return [pscustomobject]@{ EnableClipboardHistory = 0; EnableCloudClipboard = 0 } }
    'history-on' { return [pscustomobject]@{ EnableClipboardHistory = 1 } }
    'sync-on' { return [pscustomobject]@{ EnableCloudClipboard = 1 } }
    'permission-denied' { throw [UnauthorizedAccessException]::new('Synthetic access denied') }
    'unknown-value' { return [pscustomobject]@{ EnableCloudClipboard = 2 } }
    'unknown-type' { return [pscustomobject]@{ EnableClipboardHistory = '0' } }
    'copy-failed' { return [pscustomobject]@{} }
    default { throw 'UNEXPECTED_TEST_CASE' }
  }
}
function Set-Clipboard {
  [CmdletBinding()] param([AllowEmptyString()][string]$Value)
  if ($global:TbPreviewCopyFixture.Case -eq 'copy-failed') { throw 'Synthetic clipboard unavailable' }
  $global:TbPreviewCopyFixture.CopiedValue = $Value; $global:TbPreviewCopyFixture.CopyCount++
}
function Assert-Case([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw ('REGRESSION_FAILED: ' + $Message) }
}
$passed = 0
try {
  foreach ($case in @('missing-key', 'missing-properties', 'one-property-missing', 'disabled')) {
    foreach ($kind in @('PasswordHash', 'SessionSecret')) {
      $global:TbPreviewCopyFixture.Case = $case; $global:TbPreviewCopyFixture.CopiedValue = $null; $global:TbPreviewCopyFixture.CopyCount = 0
      $messages = (& $launcher -Directory $fixture -Copy $kind 6>&1 | Out-String)
      $expected = if ($kind -eq 'PasswordHash') { $syntheticHash } else { $syntheticSession }
      Assert-Case ($global:TbPreviewCopyFixture.CopyCount -eq 1 -and $global:TbPreviewCopyFixture.CopiedValue -ceq $expected) ($case + ': copied correctly')
      Assert-Case ($messages.Contains('COPY_SUCCEEDED:')) ($case + ': safe success marker')
      Assert-Case (-not $messages.Contains($syntheticHash) -and -not $messages.Contains($syntheticSession)) ($case + ': no secret output')
      $passed++
    }
  }
  foreach ($case in @('history-on', 'sync-on', 'permission-denied', 'unknown-value', 'unknown-type', 'copy-failed')) {
    $global:TbPreviewCopyFixture.Case = $case; $global:TbPreviewCopyFixture.CopiedValue = $null; $global:TbPreviewCopyFixture.CopyCount = 0
    $failed = $false; $messages = ''
    try { $messages = (& $launcher -Directory $fixture -Copy PasswordHash 6>&1 | Out-String) } catch { $failed = $true }
    Assert-Case ($failed -and $global:TbPreviewCopyFixture.CopyCount -eq 0) ($case + ': copy blocked')
    Assert-Case (-not $messages.Contains('COPY_SUCCEEDED:')) ($case + ': no false success')
    $passed++
  }
  Assert-Case ((Get-FileHash -LiteralPath $hashFile).Hash -eq $beforeHash) 'hash fixture preserved'
  Assert-Case ((Get-FileHash -LiteralPath $sessionFile).Hash -eq $beforeSession) 'session fixture preserved'
  $global:TbPreviewCopyFixture.CopiedValue = $null
  Write-Host ('PASS: ' + $passed + ' Windows PowerShell ' + $PSVersionTable.PSVersion.ToString() + ' cases. No real secrets, registry writes or clipboard changes.')
} finally {
  Remove-Variable -Name TbPreviewCopyFixture -Scope Global
  # Exact generated test files only; never recurse through a computed directory.
  Remove-Item -LiteralPath $hashFile, $sessionFile -Force
  [IO.Directory]::Delete($fixture, $false)
}
