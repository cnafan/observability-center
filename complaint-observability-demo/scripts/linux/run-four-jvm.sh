#!/usr/bin/env bash
# Copyright (c) 2026 Huawei Technologies Co., Ltd.
# All Rights Reserved.
#
# SPDX-License-Identifier: Apache-2.0
#
#    Licensed under the Apache License, Version 2.0 (the "License"); you may
#    not use this file except in compliance with the License. You may obtain
#    a copy of the License at
#
#         http://www.apache.org/licenses/LICENSE-2.0
#
#    Unless required by applicable law or agreed to in writing, software
#    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
#    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
#    License for the specific language governing permissions and limitations
#    under the License.

set -euo pipefail
case_name=${1:-success}
run_id=${2:-four-jvm-$(date +%s%3N)}
timeout_seconds=${TIMEOUT_SECONDS:-180}
telemetry=${ENABLE_TELEMETRY:-false}
otel_endpoint=${OTEL_ENDPOINT:-http://127.0.0.1:14317}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
demo_root=$(cd "$script_dir/../.." && pwd)
artifact_root="$demo_root/artifacts"
log_root="$demo_root/target/four-jvm-logs"
[[ "$case_name" == success || "$case_name" == authorization-denied ]] || { echo 'case must be success or authorization-denied' >&2; exit 2; }
for command in java mvn curl python3; do command -v "$command" >/dev/null || { echo "Required command not found: $command" >&2; exit 1; }; done
mkdir -p "$artifact_root" "$log_root"
cd "$demo_root"
mvn -B -ntp package -DskipTests
mvn -B -ntp dependency:build-classpath -Dmdep.outputFile="$demo_root/target/classpath.txt" -Dmdep.includeScope=runtime
classpath="$demo_root/target/classes:$(tr -d '\r\n' < "$demo_root/target/classpath.txt")"

roles=("west:9101:complaint-west" "east:9102:complaint-east" "transport:9103:complaint-transport" "waimo:9104:complaint-waimo")
pids=()
cleanup() {
  for entry in "${roles[@]}"; do IFS=: read -r _ port _ <<< "$entry"; curl -fsS --max-time 2 -X POST "http://127.0.0.1:$port/admin/shutdown" >/dev/null || true; done
  for pid in "${pids[@]}"; do for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep .25; done; kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
for entry in "${roles[@]}"; do
  IFS=: read -r role port service <<< "$entry"; url="http://127.0.0.1:$port"; log="$log_root/$run_id.$role.out.log"
  OTEL_EXPORTER_OTLP_PROTOCOL=grpc OTEL_EXPORTER_OTLP_ENDPOINT="$otel_endpoint" java -cp "$classpath" \
    -Ddemo.role="$role" -Ddemo.case="$case_name" -Ddemo.run.id="$run_id" -Ddemo.port="$port" \
    -Ddemo.public.url="$url" -Ddemo.service.name="$service" -Ddemo.otel.enabled="$telemetry" \
    -Ddemo.west.url=http://127.0.0.1:9101 -Ddemo.east.url=http://127.0.0.1:9102 \
    -Ddemo.transport.url=http://127.0.0.1:9103 net.openan.demo.complaint.RoleMain >"$log" 2>&1 &
  pids+=("$!")
  ready=false; for _ in {1..180}; do curl -fsS --max-time 2 "$url/.well-known/agent-card.json" | grep -q '"name"' && { ready=true; break; }; sleep .25; done
  $ready || { echo "AgentCard did not become ready: $url" >&2; exit 1; }
done
for _ in $(seq 1 $((timeout_seconds * 2))); do [[ -f "$artifact_root/$run_id.json" ]] && break; sleep .5; done
[[ -f "$artifact_root/$run_id.json" ]] || { echo "Workflow report timed out: $run_id" >&2; exit 1; }
# Each role writes its report as part of its orderly shutdown.  Stop and join
# all role processes before reading those reports so a completed workflow is
# not reported as a false validation failure.
cleanup
python3 - "$artifact_root" "$case_name" "$run_id" <<'PY'
import json, pathlib, sys
root, case, run = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
report = json.loads((root / f'{run}.json').read_text(encoding='utf-8'))
failures = []
roles = {}

if report.get('transportMode') != 'multi-http':
    failures.append('expected multi-http')
if report.get('workflowId') != '1d4c367d-9f0c-4400-85d2-caaf21ee37af-waimo':
    failures.append('workflowId mismatch')

for name in ('west', 'east', 'transport', 'waimo'):
    path = root / f'{run}.{name}.json'
    if not path.exists():
        failures.append(f'missing role report: {name}')
        continue
    value = json.loads(path.read_text(encoding='utf-8'))
    roles[name] = value
    if value.get('role') != name or not value.get('roleUrl'):
        failures.append(f'invalid role report: {name}')

records = [record for role in roles.values() for record in role.get('agentRecords', [])]
transport = roles.get('transport', {}).get('agentRecords', [])
west = roles.get('west', {}).get('agentRecords', [])
east = roles.get('east', {}).get('agentRecords', [])
history = report.get('history', [])
steps = [item.get('step') for item in history]

if case == 'success':
    if not report.get('success') or len(steps) != 6 or '投诉报结' not in steps:
        failures.append('success workflow did not complete six WAIMO steps')
    for step in ('投诉受理', '投诉识别', '定界定位', '检索传输智能体', '投诉报结'):
        if sum(item.get('step') == step and item.get('agent') == 'WAIMO Complaint Agent'
               and item.get('status') == 'success' for item in history) != 1:
            failures.append(f'WAIMO local PSOP substep did not complete: {step}')
    if transport:
        failures.append('Transport-owned PSOP subtasks were sent through A2A instead of running locally')

    west_diagnosis = [item for item in west if item.get('step') == '双侧根因定位'
                      and item.get('status') == 'completed']
    east_diagnosis = [item for item in east if item.get('step') == '双侧根因定位'
                      and item.get('status') == 'completed']
    if len(west_diagnosis) != 1:
        failures.append('West OMC diagnosis record is missing')
    if len(east_diagnosis) != 1:
        failures.append('East OMC diagnosis record is missing')
    for step in ('授权校验', '动网操作授权', '抢通执行'):
        if sum(item.get('step') == step and item.get('status') == 'completed'
               for item in west) != 1:
            failures.append(f'Selected OMC step did not complete: {step}')
    if len(west_diagnosis) == 1 and len(east_diagnosis) == 1:
        diagnosis = west_diagnosis + east_diagnosis
        if max(int(item['startedNanos']) for item in diagnosis) >= min(
                int(item['finishedNanos']) for item in diagnosis):
            failures.append('regional diagnosis did not overlap')
else:
    if report.get('success') or len(steps) != 5 or '投诉诊断处置' not in steps \
            or '投诉报结' in steps or '人工修复' in steps:
        failures.append('authorization-denied workflow state invalid')
    denied = [item for item in west if item.get('step') == '动网操作授权'
              and item.get('status') == 'failed'
              and item.get('errorCode') == 'authorization.denied']
    if len(denied) != 1:
        failures.append('Selected OMC authorization denial record is missing')
    if transport:
        failures.append('Transport-owned PSOP subtasks were sent through A2A after authorization denial')

print(json.dumps({
    'runId': run,
    'case': case,
    'success': bool(report.get('success')),
    'historyCount': len(steps),
    'roleCount': len(roles),
    'recordCount': len(records),
    'failureCount': len(failures),
    'report': str(root / f'{run}.json'),
}, ensure_ascii=False))
if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
PY
