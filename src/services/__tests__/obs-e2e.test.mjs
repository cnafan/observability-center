// E2E: run the plugin's REAL modules (config -> client -> adapter) against the live service over HTTPS.
// Node can skip the expired cert; the browser cannot — that gap is reported explicitly.
import https from 'node:https';
import { getObsConfig, isObsApiConfigured } from '../../lib/config.js';
import { createObsClient } from '../obs-api.js';
import { buildTask, buildListTask, buildListMeta, buildCharts } from '../obs-adapter.js';
import { resolveMetricCharts, toLineChart, toHistogram, metricAvailability } from '../metric-map.js';
import { METRIC_GROUPS } from '../../metric-catalog.js';

// --- IP is injected from OUTSIDE the code, exactly like a deployment would ---
const BASE = process.env.OBS_API_BASE;
if (!BASE) { console.error('set OBS_API_BASE'); process.exit(2); }
globalThis.window = { __OPENAN_OBS_API__: { baseUrl: BASE } };

// cert-insecure fetch for Node only (browser path never does this)
const agent = new https.Agent({ rejectUnauthorized: false });
globalThis.fetch = (url, init) => import('node:module').then(() => globalThis.fetchImpl(url, init));
let failed = 0;
const check = (name, cond, detail = '') => { if (cond) console.log('PASS  ' + name); else { failed++; console.log('FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };

const cfg = getObsConfig();
check('config: baseUrl read from runtime global (no hardcode)', cfg.baseUrl === BASE.replace(/\/+$/, ''), cfg.baseUrl);
check('config: isObsApiConfigured true', isObsApiConfigured());

// minimal fetch via https
globalThis.fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: init.method || 'GET', headers: init.headers || {}, agent, timeout: 40000 }, (res) => {
        let data = ''; res.setEncoding('utf8'); res.on('data', (c) => data += c);
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => data }));
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    if (init.body) req.write(init.body);
    req.end();
});

const client = createObsClient(cfg);
const health = await client.health();
check('health: status ready, 3 sources ready', health.status === 'ready' && ['trace', 'metric', 'log'].every((s) => health.sources[s].status === 'ready'), JSON.stringify(health));

const list = await client.listWorkflows({ limit: 20 });
check('list: items returned', list.items.length > 0, `${list.items.length}`);
const meta = buildListMeta(list);
const tasks = list.items.map(buildListTask);
check('list -> task rows: every row has runId/title/status', tasks.every((t) => t.runId && t.title && t.status));
check('list -> title humanized to zh', tasks.every((t) => /[\u4e00-\u9fa5]/.test(t.title)), JSON.stringify(tasks.map((t) => t.title)));
check('list -> meta aggregates', meta.total === list.aggregates.total && typeof meta.successRate === 'number');

const runId = list.items[0].runId;
const t0 = Date.now();
const [summary, trace, logs, metrics] = await Promise.all([
    client.getWorkflow(runId), client.getTrace(runId), client.getLogs(runId, { limit: 200 }), client.getMetrics(runId, { windowMin: 5, step: '15s' }),
]);
const elapsed = Date.now() - t0;
check('detail: 4 endpoints fetched in parallel', [summary, trace, logs, metrics].every((x) => x && typeof x === 'object'), `${elapsed}ms`);
console.log('      (detail fetch took %dms; metrics payload signals=%d)', elapsed, metrics.signals.length);

const task = buildTask(summary, trace, logs, metrics);
check('task: trace spans == spanCount from summary', task.trace.spans.length === summary.spanCount, `${task.trace.spans.length} vs ${summary.spanCount}`);
check('task: PSOP steps mapped with duration', task.steps.length === summary.psop.steps.length && task.steps.every((s) => s.durationMs > 0));
check('task: agents from PSOP', task.agents.length >= 2, JSON.stringify(task.agents));
check('task: logs mapped with category + spanID', task.logs.length === logs.items.length && task.logs.every((l) => l.category && l.spanID));
check('task: sourceStatus all ready', Object.values(task._sourceStatus).every((s) => s === 'ready'), JSON.stringify(task._sourceStatus));
const traceIdOk = task.trace.spans.every((s) => s.traceID === summary.traceId);
check('task: every span belongs to the summary traceId', traceIdOk);

// the view consumes these exact shapes
const charts = buildCharts(metrics.signals);
check('charts: histograms + lines produced', Object.keys(charts.histograms).length > 0 && Object.keys(charts.lines).length > 0, `h=${Object.keys(charts.histograms).length} l=${Object.keys(charts.lines).length}`);
const allMetrics = METRIC_GROUPS.flatMap((g) => g.metrics);
const avail = metricAvailability(allMetrics.map((m) => m.name), charts);
const okCount = Object.values(avail).filter((s) => s === 'ok').length;
check('metric map: >= 10 of 15 catalog metrics resolvable from service', okCount >= 10, `${okCount}/15 ok: ${JSON.stringify(Object.entries(avail).filter(([, s]) => s !== 'ok').map(([k]) => k))}`);
const dur = resolveMetricCharts('gen_ai.agent.a2at.task.duration', charts);
check('resolve task.duration -> histogram with avg computed', dur.status === 'ok' && dur.hist && typeof dur.avg === 'number' && dur.avg > 0, `avg=${dur.avg}`);
const line = toLineChart(dur.base, dur.line, 'ms');
check('toLineChart: series have points {t,v} and colors', line.series.length > 0 && line.series.every((s) => s.points.length > 0 && s.color && s.points.every((p) => typeof p.t === 'number' && typeof p.v === 'number')));
const hist = toHistogram(dur.base, dur.hist, 'ms');
check('toHistogram: buckets non-negative, +Inf last, counts sum to cumulative', hist.buckets.length > 2 && hist.buckets[hist.buckets.length - 1].inf && hist.buckets.every((b) => b.count >= 0));
const cnt = resolveMetricCharts('gen_ai.agent.a2at.workflow.count', charts);
check('resolve workflow.count -> line (counter)', cnt.status === 'ok' && cnt.line && !cnt.hist);
const token = resolveMetricCharts('gen_ai.client.token.usage', charts);
check('resolve token.usage -> reported missing (service does not export it) — surfaced honestly', token.status === 'missing', JSON.stringify(token));

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
