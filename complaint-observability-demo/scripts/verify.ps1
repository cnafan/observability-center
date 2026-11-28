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
 *    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 *    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 *    License for the specific language governing permissions and limitations
 *    under the License.
 #>

[CmdletBinding()]
param(
    [string]$RunId,
    [ValidateSet('success', 'authorization-denied')]
    [string]$Case = 'success',
    [ValidateSet('memory', 'http')]
    [string]$Transport = 'memory'
)

$ErrorActionPreference = 'Stop'
$demoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($RunId)) {
    $RunId = "verify-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())"
    & (Join-Path $PSScriptRoot 'run.ps1') -Case $Case -RunId $RunId -Transport $Transport
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$reportPath = Join-Path $demoRoot "artifacts/$RunId.json"
if (-not (Test-Path -LiteralPath $reportPath)) {
    throw "Report not found: $reportPath"
}
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
$history = @($report.history)
$records = @($report.agentRecords)
$agentUrls = @($report.agentUrls)
$failures = [System.Collections.Generic.List[string]]::new()

if ($report.workflowId -ne '1d4c367d-9f0c-4400-85d2-caaf21ee37af') {
    $failures.Add('workflowId does not match PR #29')
}
if ([string]$report.transportMode -ne $Transport) {
    $failures.Add("expected transport $Transport, got $($report.transportMode)")
}
if ($Transport -eq 'http') {
    if ($agentUrls.Count -ne 4) { $failures.Add("expected four HTTP AgentCard URLs, got $($agentUrls.Count)") }
    if (@($records | Where-Object { $_.kind -eq 'nested-task-http' }).Count -lt 2) {
        $failures.Add('HTTP mode did not record nested HTTP agent calls')
    }
}

if ($Case -eq 'success') {
    if (-not $report.success) { $failures.Add('success case did not complete') }
    if ($history.Count -ne 7) { $failures.Add("expected 7 history entries, got $($history.Count)") }
    $nested = @($records | Where-Object {
            ($_.kind -eq 'nested-task-t' -and @('east', 'west') -contains [string]$_.result) -or
            ($_.kind -eq 'nested-task-http' -and [string]$_.operation -in @('diagnosis-east', 'diagnosis-west'))
        })
    if ($nested.Count -lt 2) { $failures.Add('diagnosis did not produce two nested agent records') }
    else {
        $latestStart = ($nested | Measure-Object -Property startedNanos -Maximum).Maximum
        $earliestFinish = ($nested | Measure-Object -Property finishedNanos -Minimum).Minimum
        if ([long]$latestStart -ge [long]$earliestFinish) {
            $failures.Add('West/East diagnosis windows did not overlap')
        }
    }
    if (-not ($history.step -contains '投诉报结')) { $failures.Add('closure step is missing') }
}
else {
    if ($report.success) { $failures.Add('authorization-denied case unexpectedly succeeded') }
    if ($history.Count -ne 5) { $failures.Add("expected 5 history entries, got $($history.Count)") }
    if (-not ($history.step -contains '投诉诊断处置')) { $failures.Add('failed dispatch step is missing') }
    if ($history.step -contains '投诉报结' -or $history.step -contains '人工修复') {
        $failures.Add('downstream validation or closure ran after authorization denial')
    }
    $dispatchFailure = @($history | Where-Object { $_.errorCode -eq 'authorization.denied' })
    if ($dispatchFailure.Count -ne 1) { $failures.Add('authorization.denied was not recorded exactly once') }
}

$summary = [ordered]@{
    runId = $RunId
    case = $Case
    success = [bool]$report.success
    historyCount = $history.Count
    failureCount = $failures.Count
    report = $reportPath
}
$summary | ConvertTo-Json
if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}
