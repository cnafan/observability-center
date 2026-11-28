// Adapter unit tests against a REAL captured API snapshot. Run: node src/services/__tests__/obs-adapter.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    buildTask, buildSignals, buildCharts, buildListMeta, flattenSpans, buildSpanTreeFromFlat,
    categorizeLog, inferMetricType, parsePoints, humanizeWorkflowType,
} from '../obs-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(path.join(here, '..', '__fixtures__', 'obs-api-sample.json'), 'utf-8'));

let failed = 0;
function check(name, cond, detail = '') {
    if (cond) console.log('PASS  ' + name);
    else { failed += 1; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- primitives ---------- */
check('parsePoints: [ts,"1.5"] -> {ts,value}, drops junk', eq(parsePoints([[1, '1.5'], [2, 'NaN'], [3], 'x']), [{ ts: 1, value: 1.5 }, { ts: 2, value: NaN }].filter((p) => Number.isFinite(p.value))));
check('inferMetricType: _bucket -> histogram', inferMetricType('x_duration_bucket') === 'histogram');
check('inferMetricType: _sum -> histogram', inferMetricType('x_duration_sum') === 'histogram');
check('inferMetricType: _count -> counter', inferMetricType('x_rounds_count') === 'counter');
check('inferMetricType: _total -> counter', inferMetricType('x_count_total') === 'counter');
check('inferMetricType: plain -> gauge', inferMetricType('x_temperature') === 'gauge');
check('categorizeLog: step+agent -> workflow', categorizeLog({ step: 'step1', agent: 'A' }) === 'workflow');
check('categorizeLog: skill+agent no step -> agent', categorizeLog({ skill: 'S', agent: 'A' }) === 'agent');
check('categorizeLog: nothing -> message', categorizeLog({}) === 'message');
check('humanizeWorkflowType: WAIMO package -> zh (WAIMO)', humanizeWorkflowType('IG1504D_AN_L4_Enterprise_Private_Line_Complaint_Handling_WAIMO_Package') === '企业专线投诉处理（WAIMO）');
check('humanizeWorkflowType: Transport package -> zh (Transport), longest key wins', humanizeWorkflowType('IG1504D_AN_L4_Enterprise_Private_Line_Complaint_Handling_Transport_Package') === '企业专线投诉处理（传输）');

/* ---------- trace: hierarchy derived WITHOUT parentSpanId (two-level nesting) ---------- */
const spans = flattenSpans(fx.trace.resourceSpans);
check('flattenSpans: all spans flattened', spans.length === fx.detail.spanCount, `${spans.length} vs ${fx.detail.spanCount}`);
check('flattenSpans: no parentSpanId in source, derived later', spans.every((s) => s.parentSpanID === undefined));
check('flattenSpans: sorted by start time', spans.every((s, i) => i === 0 || s.startNs >= spans[i - 1].startNs));
const KINDS = ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
check('flattenSpans: numeric kind -> name', spans.every((s) => KINDS.includes(s.kind)), JSON.stringify([...new Set(spans.map((s) => s.kind))]));
check('flattenSpans: attributes decoded to plain object', spans.every((s) => typeof s.tags === 'object' && !Array.isArray(s.tags)));

const root = buildSpanTreeFromFlat(spans, spans[0].startNs);
const wfRoots = spans.filter((s) => s._isWorkflowRoot);
check('tree: 3 workflow spans = outer orchestration + inner PSOP (same service) + delegated transport', wfRoots.length === 3, `${wfRoots.length}`);
const byService = {};
for (const w of wfRoots) (byService[w.service] = byService[w.service] || []).push(w);
check('tree: complaint-waimo has 2 nested workflows, transport has 1', (byService['complaint-waimo'] || []).length === 2 && (byService['complaint-transport'] || []).length === 1, JSON.stringify(Object.fromEntries(Object.entries(byService).map(([k, v]) => [k, v.length]))));
const outer = byService['complaint-waimo'].sort((a, b) => (b.endNs - b.startNs) - (a.endNs - a.startNs))[0];
const inner = byService['complaint-waimo'].find((w) => w !== outer);
const delegated = byService['complaint-transport'][0];
check('tree: outer orchestration is the trace root child', outer.parentSpanID === '__root__');
check('tree: outer status=running, inner status=completed (distinct workflow.id)', outer.tags['gen_ai.agent.a2at.workflow.status'] === 'running' && inner.tags['gen_ai.agent.a2at.workflow.status'] === 'completed' && outer._workflowId !== inner._workflowId);
check('tree: inner PSOP workflow nested INSIDE outer (time-contained)', inner.parentSpanID === outer.spanID);
const mainSteps = inner.children.filter((c) => /^a2at\.step\./.test(c.operationName));
check('tree: inner PSOP workflow directly holds exactly the PSOP steps', mainSteps.length === fx.detail.psop.steps.length, `${mainSteps.length} vs ${fx.detail.psop.steps.length}`);
const delegating = spans.find((s) => s.spanID === delegated.parentSpanID);
check('tree: delegated transport workflow is nested under a MAIN step', !!delegating && delegating.service === 'complaint-waimo' && /^a2at\.step\./.test(delegating.operationName), 'parent=' + JSON.stringify(delegating && delegating.operationName));
check('tree: delegation happens at step5 (PSOP step owned by Transport agent)', delegating?._step === 'step5' && fx.detail.psop.steps[4].subtasks[0].agent === 'Transport Complaint Agent', `${delegating?._step} / ${fx.detail.psop.steps[4].subtasks[0].agent}`);
check('tree: step5 time range fully contains the delegated workflow', delegating.startNs <= delegated.startNs && delegating.endNs >= delegated.endNs);
const delegatedSteps = delegated.children.filter((c) => /^a2at\.step\./.test(c.operationName));
check('tree: delegated workflow holds its own steps (separate numbering)', delegatedSteps.length > 0 && delegatedSteps.every((s) => s.service === 'complaint-transport'), `${delegatedSteps.length}`);
check('tree: every span has a parent (no orphans)', spans.every((s) => s.parentSpanID));
check('tree: every SendMessage is under a step', spans.filter((s) => s.operationName === 'SendMessage').every((s) => /^a2at\.step\./.test(spans.find((p) => p.spanID === s.parentSpanID)?.operationName || '')));
const childCounts = spans.map((s) => (s.children || []).length).reduce((a, b) => a + b, 0);
check('tree: child links consistent with parent links (each span parented exactly once)', childCounts === spans.length - 1, `${childCounts} vs ${spans.length - 1}`);
check('tree: acyclic (no span is its own ancestor)', spans.every((s) => !isAncestor(s, s)));
function isAncestor(node, target) { let p = node; while (p) { const pp = spans.find((x) => x.spanID === p.parentSpanID); if (pp && pp.spanID === target.spanID && target.spanID !== node.spanID) return true; if (!pp || pp.spanID === '__root__') return false; p = pp; } return false; }

/* ---------- task assembly ---------- */
const task = buildTask(fx.detail, fx.trace, fx.logs, fx.metrics);
check('task: identity mapped', task.runId === fx.runId && !!task.trace.traceID && task.trace.traceID.length === 32);
check('task: status success -> ok', task.status === 'ok');
check('task: startedAt passthrough', task.startedAt === fx.detail.startedAt);
check('task: agents from PSOP, ordered, unique', task.agents.length >= 2 && new Set(task.agents).size === task.agents.length, JSON.stringify(task.agents));
check('task: steps built from PSOP with status completed', task.steps.length === 6 && task.steps.every((s) => s.status === 'completed'), JSON.stringify(task.steps.map((s) => [s.name, s.status])));
check('task: step durations positive', task.steps.every((s) => s.durationMs > 0), JSON.stringify(task.steps.map((s) => s.durationMs)));
check('task: spans have startOffsetMs relative to first span', task.trace.spans[0].startOffsetMs === 0 && task.trace.spans.every((s) => s.startOffsetMs >= 0));
check('task: logs categorized, all carry spanID', task.logs.length === fx.logs.total && task.logs.every((l) => l.spanID), `${task.logs.length} vs ${fx.logs.total}`);
const cats = {};
for (const l of task.logs) cats[l.category] = (cats[l.category] || 0) + 1;
check('task: log categories derived (has workflow)', (cats.workflow || 0) > 0, JSON.stringify(cats));
check('task: log severity from severityNumber 9 -> INFO', task.logs.every((l) => l.severity === 'INFO'));
check('task: log body extracted from stringValue', task.logs.every((l) => typeof l.body === 'string' && l.body.length > 0));
check('task: sourceStatus captured', task._sourceStatus.trace === 'ready' && task._sourceStatus.log === 'ready' && task._sourceStatus.metric === 'ready');
check('task: partial flags captured', task._partial.trace === false && task._partial.metric === false);

/* ---------- metrics ---------- */
const sigs = buildSignals(fx.metrics.signals);
check('signals: built for every input signal', sigs.length === fx.metrics.signals.length);
check('signals: each has samples with attributes', sigs.every((s) => s.samples.length > 0 && s.samples.every((x) => x.attributes && typeof x.value === 'number')));
check('signals: __name__ stripped from attributes', sigs.every((s) => s.samples.every((x) => !('__name__' in x.attributes))));
check('signals: histogram type inferred for _bucket', sigs.filter((s) => /_bucket$/.test(s.metric)).every((s) => s.type === 'histogram'));
const charts = buildCharts(fx.metrics.signals);
check('charts: histograms keyed by base name', Object.keys(charts.histograms).length > 0 && Object.keys(charts.histograms).every((k) => !/_bucket$/.test(k)), JSON.stringify(Object.keys(charts.histograms)));
check('charts: histogram le sorted ascending ending +Inf', Object.values(charts.histograms).every((h) => h[h.length - 1].le === '+Inf'));
check('charts: lines keyed by base name', Object.keys(charts.lines).length > 0, JSON.stringify(Object.keys(charts.lines)));
check('charts: points parsed to numbers', Object.values(charts.lines).flat().every((s) => s.points.every((p) => Number.isFinite(p.ts) && Number.isFinite(p.value))));

/* ---------- list meta ---------- */
const meta = buildListMeta(fx.list);
check('listMeta: aggregates mapped', meta.total === fx.list.aggregates.total && meta.success === fx.list.aggregates.success);
check('listMeta: facets mapped', meta.workflowTypes.length === fx.list.facets.workflowTypes.length);

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
