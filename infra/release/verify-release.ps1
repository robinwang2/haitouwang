[CmdletBinding()]
param(
  [ValidateSet('Candidate', 'Production')]
  [string]$Mode = 'Candidate'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifestPath = Join-Path $PSScriptRoot 'release-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Invoke-ReleaseGate {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  Write-Host "[release] $Name"
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Release gate '$Name' failed with exit code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}

Invoke-ReleaseGate -Name 'api-build' -WorkingDirectory (Join-Path $repoRoot 'services\api') -Executable 'npm.cmd' -Arguments @('run', 'build')
Invoke-ReleaseGate -Name 'typecheck' -WorkingDirectory (Join-Path $repoRoot 'tooling') -Executable 'npm.cmd' -Arguments @('run', 'typecheck')
Invoke-ReleaseGate -Name 'unit' -WorkingDirectory (Join-Path $repoRoot 'tooling') -Executable 'npm.cmd' -Arguments @('run', 'unit')
Invoke-ReleaseGate -Name 'contracts' -WorkingDirectory (Join-Path $repoRoot 'tooling') -Executable 'npm.cmd' -Arguments @('run', 'contract')
Invoke-ReleaseGate -Name 'mvp-e2e' -WorkingDirectory $repoRoot -Executable 'node' -Arguments @(
  '--test',
  'tests/e2e/m1/m1.e2e.test.cjs',
  'tests/e2e/m2/m2.e2e.test.cjs',
  'tests/e2e/mvp/mvp.e2e.test.cjs'
)
Invoke-ReleaseGate -Name 'browser-agent' -WorkingDirectory (Join-Path $repoRoot 'apps\agent') -Executable 'npm.cmd' -Arguments @('run', 'test:browser')
Invoke-ReleaseGate -Name 'security' -WorkingDirectory (Join-Path $repoRoot 'tooling') -Executable 'npm.cmd' -Arguments @('run', 'security')

if ($Mode -eq 'Production') {
  if (-not $manifest.production_authorized -or $manifest.blockers.Count -gt 0) {
    $blockerIds = ($manifest.blockers | ForEach-Object { $_.id }) -join ', '
    throw "Production release is not authorized. Unresolved blockers: $blockerIds"
  }
}

Write-Host "[release] $Mode verification passed for $($manifest.release_id)."
if (-not $manifest.production_authorized) {
  Write-Host '[release] Candidate is restricted to non-production validation.'
}
