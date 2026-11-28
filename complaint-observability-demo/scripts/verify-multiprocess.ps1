<#
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 *    Licensed under the Apache License, Version 2.0 (the "License"); you may
 *    not use this file except in compliance with the License. You may obtain
 *    a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an AS IS BASIS, WITHOUT
 *    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 *    License for the specific language governing permissions and limitations
 *    under the License.
 #>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RunId,
    [ValidateSet('success', 'authorization-denied')]
    [string]$Case = 'success'
)

$ErrorActionPreference = 'Stop'
$demoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$reportPath = Join-Path $demoRoot "artifacts\$RunId.json"
$failures = [System.Collections.Generic.List[string]]::new()
if (-not (Test-Path -LiteralPath $reportPath)) {
    throw "Report not found: $reportPath"
}
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$history = @($report.history)
$rootUrls = @($report.agentUrls)
$roleNames = @('west', 'east', 'transport', 'waimo')
$roleReports = @()
$allRecords = @()

if ([string]$report.transportMode -ne 'multi-http') { $failures.Add("expected multi-http, got $($report.transportMode)") }
if ([string]$report.workflowId -ne '1d4c367d-9f0c-4400-85d2-caaf21ee37af-waimo') { $failures.Add('workflowId does not match the PR #39 WAIMO PSOP') }
if ($rootUrls.Count -ne 4) { $failures.Add("expected four root AgentCard URLs, got $($rootUrls.Count)") }

foreach ($role in $roleNames) {
    $path = Join-Path $demoRoot "artifacts\$RunId.$role.json"
    if (-not (Test-Path -LiteralPath $path)) {
        $failures.Add("missing role report: $path")
        continue
    }
    $roleReport = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $roleReports += $roleReport
    if ([string]$roleReport.role -ne $role) { $failures.Add("role report mismatch: expected $role") }
    if ([string]::IsNullOrWhiteSpace([string]$roleReport.roleUrl)) { $failures.Add("$role did not record roleUrl") }
    $allRecords += @($roleReport.agentRecords)
}

$transportRecords = @($roleReports | Where-Object { $_.role -eq 'transport' } | ForEach-Object { $_.agentRecords })
$westRecords = @($roleReports | Where-Object { $_.role -eq 'west' } | ForEach-Object { $_.agentRecords })
$eastRecords = @($roleReports | Where-Object { $_.role -eq 'east' } | ForEach-Object { $_.agentRecords })

if ($Case -eq 'success') {
    if (-not $report.success) { $failures.Add('success case did not complete') }
    if ($history.Count -ne 6) { $failures.Add("expected 6 WAIMO history entries, got $($history.Count)") }
    foreach ($step in @('投诉受理', '投诉识别', '定界定位', '检索传输智能体', '投诉报结')) {
        if (@($history | Where-Object { $_.step -eq $step -and $_.agent -eq 'WAIMO Complaint Agent' -and $_.status -eq 'success' }).Count -ne 1) {
            $failures.Add("WAIMO local PSOP substep did not complete: $step")
        }
    }
    if (-not ($history.step -contains '投诉报结')) { $failures.Add('WAIMO closure step is missing') }
    if (@($transportRecords).Count -ne 0) { $failures.Add('Transport-owned PSOP subtasks were sent through A2A instead of running locally') }
    if (@($westRecords | Where-Object { $_.step -eq '双侧根因定位' -and $_.status -eq 'completed' }).Count -ne 1) {
        $failures.Add('West OMC diagnosis record is missing')
    }
    if (@($eastRecords | Where-Object { $_.step -eq '双侧根因定位' -and $_.status -eq 'completed' }).Count -ne 1) {
        $failures.Add('East OMC diagnosis record is missing')
    }
    foreach ($step in @('授权校验', '动网操作授权', '抢通执行')) {
        if (@($westRecords | Where-Object { $_.step -eq $step -and $_.status -eq 'completed' }).Count -ne 1) {
            $failures.Add("Selected OMC step did not complete: $step")
        }
    }
} else {
    if ($report.success) { $failures.Add('authorization-denied case unexpectedly succeeded') }
    if ($history.Count -ne 5) { $failures.Add("expected 5 history entries, got $($history.Count)") }
    if (-not ($history.step -contains '投诉诊断处置')) { $failures.Add('failed dispatch step is missing') }
    if ($history.step -contains '投诉报结' -or $history.step -contains '人工修复') { $failures.Add('downstream steps ran after authorization denial') }
    if (@($westRecords | Where-Object { $_.step -eq '动网操作授权' -and $_.status -eq 'failed' -and $_.errorCode -eq 'authorization.denied' }).Count -ne 1) {
        $failures.Add('Selected OMC authorization denial record is missing')
    }
    if (@($transportRecords).Count -ne 0) { $failures.Add('Transport-owned PSOP subtasks were sent through A2A after authorization denial') }
}

$summary = [ordered]@{
    runId = $RunId
    case = $Case
    success = [bool]$report.success
    historyCount = $history.Count
    roleCount = $roleReports.Count
    recordCount = $allRecords.Count
    failureCount = $failures.Count
    report = $reportPath
}
$summary | ConvertTo-Json
if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}
