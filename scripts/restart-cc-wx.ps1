param(
  [ValidateSet("dev", "start")]
  [string]$Mode = "dev"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$rootPattern = [regex]::Escape($projectRoot.TrimEnd("\"))

function Get-ChildProcessIds {
  param([int[]]$ParentIds)

  $allProcesses = @(Get-CimInstance Win32_Process)
  $pending = [System.Collections.Generic.Queue[int]]::new()
  $result = [System.Collections.Generic.HashSet[int]]::new()

  foreach ($parentId in $ParentIds) {
    $pending.Enqueue($parentId)
  }

  while ($pending.Count -gt 0) {
    $parentId = $pending.Dequeue()
    foreach ($process in $allProcesses | Where-Object { $_.ParentProcessId -eq $parentId }) {
      if ($result.Add([int]$process.ProcessId)) {
        $pending.Enqueue([int]$process.ProcessId)
      }
    }
  }

  return @($result)
}

$serverProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $commandLine = [string]$_.CommandLine
  $commandLine -and
    $commandLine -match $rootPattern -and
    $commandLine -match "server[\\/]+index\.(ts|js)"
})

$serverIds = @($serverProcesses | ForEach-Object { [int]$_.ProcessId })
$processIds = @($serverIds + (Get-ChildProcessIds -ParentIds $serverIds) | Sort-Object -Unique)

foreach ($processId in $processIds) {
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}

if ($processIds.Count -gt 0) {
  Start-Sleep -Milliseconds 500
  Write-Host "Stopped cc-wx process(es): $($processIds -join ', ')"
}

$npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
Start-Process `
  -FilePath $npmPath `
  -ArgumentList @("run", $Mode) `
  -WorkingDirectory $projectRoot

Write-Host "Started cc-wx with 'npm run $Mode'."
