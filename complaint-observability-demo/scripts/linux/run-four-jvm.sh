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
python3 - "$artifact_root" "$case_name" "$run_id" <<'PY'
import json, pathlib, sys
root, case, run = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
report=json.load(open(root/(run+'.json'))); failures=[]; roles=[]
if report.get('transportMode') != 'multi-http': failures.append('expected multi-http')
if report.get('workflowId') != '1d4c367d-9f0c-4400-85d2-caaf21ee37af': failures.append('workflowId mismatch')
for name in ('west','east','transport','waimo'):
 path=root/f'{run}.{name}.json'
 if not path.exists(): failures.append(f'missing role report: {name}'); continue
 value=json.load(open(path)); roles.append(value)
 if value.get('role') != name or not value.get('roleUrl'): failures.append(f'invalid role report: {name}')
records=[x for r in roles for x in r.get('agentRecords',[])]; transport=[x for r in roles if r.get('role')=='transport' for x in r.get('agentRecords',[])]; steps=[x.get('step') for x in report.get('history',[])]
if case == 'success':
 if not report.get('success') or len(steps)!=6 or '投诉报结' not in steps: failures.append('success workflow did not complete six WAIMO steps')
 for op in ('diagnosis-east','diagnosis-west','authorization','restoration'):
  if sum(x.get('kind')=='nested-task-http' and x.get('operation')==op and x.get('status')=='completed' for x in transport)!=1: failures.append(f'missing completed {op}')
 diag=[x for x in transport if x.get('operation') in ('diagnosis-east','diagnosis-west') and x.get('status')=='completed']
 if len(diag)!=2 or max(x['startedNanos'] for x in diag)>=min(x['finishedNanos'] for x in diag): failures.append('regional diagnosis did not overlap')
else:
 if report.get('success') or len(steps)!=5 or '投诉诊断处置' not in steps or '投诉报结' in steps or '人工修复' in steps: failures.append('authorization-denied workflow state invalid')
 if sum(x.get('errorCode')=='authorization.denied' for x in report.get('history',[]))!=1: failures.append('authorization denial missing')
 if sum(x.get('operation')=='authorization' and x.get('status')=='failed' for x in transport)!=1: failures.append('authorization failure record missing')
 if any(x.get('operation')=='restoration' for x in transport): failures.append('restoration ran after denial')
print(json.dumps({'runId':run,'case':case,'success':bool(report.get('success')),'historyCount':len(steps),'roleCount':len(roles),'recordCount':len(records),'failureCount':len(failures),'report':str(root/(run+'.json'))},ensure_ascii=False))
if failures: print('\n'.join(failures),file=sys.stderr); sys.exit(1)
PY
