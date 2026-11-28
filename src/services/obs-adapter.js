/**
 * 适配器：把查询服务的真实响应（OTLP / Prometheus 形态）映射为视图已消费的 task 模型。
 *
 * 纯函数、无 IO，便于单测。输入形状以实测为准：
 *   - Trace 的 span 没有 parentSpanId，层级按名称顺序推导：`a2at.step.stepN` 之后紧跟的
 *     `SendMessage` / 其它 span 归属于该步骤。
 *   - Log 没有 category / 可用的时间戳 / 级别文本：timeUnixNano 为 "0"、severityText 为 ""，
 *     只有 severityNumber。类别由 attributes.step / agent / skill 推导，时间按 span 对齐。
 *   - Metric 的 signals[].series[].values 是 Prometheus range 形态 [ts, "字符串值"]，
 *     且 type 为 null，需从指标名后缀推导 histogram / counter。
 *   - charts 为 null，图表数据由 series 在前端生成。
 */
import { attrsToObject } from './obs-api.js';

/* ---------------------------------- 基础工具 ---------------------------------- */

/** Prometheus range 值：[ts, "1.5"] → { ts, value }，非法点丢弃。 */
export function parsePoints(values) {
    const out = [];
    for (const p of values || []) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const ts = Number(p[0]);
        const value = Number(p[1]);
        if (Number.isFinite(ts) && Number.isFinite(value)) out.push({ ts, value });
    }
    return out;
}

/** 指标类型：从 Prometheus 名称后缀推导（服务端 type 字段为 null）。 */
export function inferMetricType(promName) {
    const n = String(promName || '');
    if (/(^|_)(bucket|sum|count)$/.test(n) || /_(bucket|sum|count)$/.test(n)) {
        return /_bucket$/.test(n) ? 'histogram' : /_sum$/.test(n) ? 'histogram' : 'counter';
    }
    if (/_total$/.test(n)) return 'counter';
    return 'gauge';
}

/** 把一组同前缀的 histogram 分片（_bucket/_sum/_count）归并成一个逻辑直方图。 */
function baseMetricName(promName) {
    return String(promName || '').replace(/_(bucket|sum|count)$/, '');
}

const STATUS_MAP = { success: 'ok', completed: 'ok', error: 'error', failed: 'error', running: 'running' };

function toIso(nano) {
    const n = Number(nano);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n / 1e6).toISOString();
}

/* ---------------------------------- Trace ---------------------------------- */

const STEP_NAME_RE = /^a2at\.step\.(.+)$/;

/**
 * 推导 span 层级：根 = a2at.workflow；每个 a2at.step.X 开启一个步骤节点，
 * 其后的非步骤 span 归到当前步骤下（直到下一个 a2at.step 或 workflow）。
 */
export function flattenSpans(resourceSpans) {
    const spans = [];
    for (const rs of resourceSpans || []) {
        const resource = attrsToObject(rs?.resource?.attributes);
        for (const ss of rs?.scopeSpans || []) {
            for (const s of ss?.spans || []) {
                const attrs = attrsToObject(s.attributes);
                const startNs = Number(s.startTimeUnixNano);
                const endNs = Number(s.endTimeUnixNano);
                spans.push({
                    spanID: s.spanId,
                    traceID: s.traceId,
                    operationName: s.name,
                    kind: spanKindName(s.kind),
                    service: resource.service_name || resource['service.name'] || '',
                    startOffsetMs: 0,
                    durationMs: Number.isFinite(startNs) && Number.isFinite(endNs) ? Math.max(0, (endNs - startNs) / 1e6) : 0,
                    startNs,
                    endNs,
                    tags: attrs,
                    status: s.status && s.status.code >= 2 ? 'error' : 'ok',
                    _step: null,
                });
            }
        }
    }
    spans.sort((a, b) => a.startNs - b.startNs);
    return spans;
}

function spanKindName(kind) {
    switch (Number(kind)) {
        case 1: return 'INTERNAL';
        case 2: return 'SERVER';
        case 3: return 'CLIENT';
        case 4: return 'PRODUCER';
        case 5: return 'CONSUMER';
        default: return 'INTERNAL';
    }
}

/**
 * 为扁平 span 列表建立父子关系（服务端未提供 parentSpanId）。
 *
 * 真实结构（以实测数据为准）：
 *
 *   complaint-waimo      a2at.workflow (外层编排, status=running) ──────────────────────────┐
 *   complaint-waimo        a2at.workflow (PSOP 执行, status=completed)                       │
 *   complaint-waimo          step1 … step4                                                   │
 *   complaint-waimo          step5 (委托) ────────────────┐                                  │
 *   complaint-transport        a2at.workflow (子流程)        │ ← 时间上被 step5 完整包住     │
 *   complaint-transport          step1 … step13            │                                  │
 *   complaint-waimo          step6                        │                                  │
 *
 * 同一个 service 可以有两个 a2at.workflow（外层编排 + 内层 PSOP），靠 workflow.id 区分实例。
 *
 * 规则：
 *   1. `a2at.workflow` 之间按时间区间嵌套：被另一个 workflow 完整包含的，成为它的子节点。
 *   2. 步骤 span 归属到「时间上覆盖它、且已存在」的最内层 workflow。
 *   3. 被委托方（另一 service）的 workflow，挂到主流程中时间上覆盖它的那个步骤下。
 *   4. 步骤内的消息 span 挂到它前面最近的步骤。
 */
export function buildSpanTreeFromFlat(spans, workflowStartNs) {
    const root = { spanID: '__root__', operationName: 'trace', children: [], startNs: workflowStartNs, endNs: workflowStartNs, _step: null };
    const byId = new Map();

    const workflows = [];           // 已出现的 workflow 根（按出现顺序）
    let currentStep = root;         // 当前 workflow 内最近的一个步骤

    const attach = (child, parent) => {
        child.parentSpanID = parent.spanID;
        parent.children.push(child);
    };

    for (const s of spans) {
        s.children = [];
        byId.set(s.spanID, s);

        if (s.operationName === 'a2at.workflow') {
            s._step = null;
            s._isWorkflowRoot = true;
            s._workflowId = s.tags['gen_ai.agent.a2at.workflow.id'] || '';
            // 跨 service 的 workflow = 被委托的子流程：挂到发起委托的步骤下（优先于"被 workflow 包含"，
            // 因为外层编排 workflow 在时间上也会把它包住）。
            const delegatingStep = findDelegatingStep(workflows, currentStep, s);
            if (delegatingStep) {
                attach(s, delegatingStep);
            } else {
                // 同 service：被另一个 workflow 完整包含 → 成为它的子节点（外层编排 ⊃ 内层 PSOP）
                const enclosingWf = workflows
                    .filter((w) => w.startNs <= s.startNs && w.endNs >= s.endNs && w.spanID !== s.spanID)
                    .sort((a, b) => (a.endNs - a.startNs) - (b.endNs - b.startNs))[0];          // 最内层
                attach(s, enclosingWf || root);
            }
            workflows.push(s);
            currentStep = s;
            continue;
        }

        const m = STEP_NAME_RE.exec(s.operationName);
        if (m) {
            s._step = m[1];
            const wf = innermostWorkflowAt(workflows, s.startNs);
            attach(s, wf || root);
            currentStep = s;
            continue;
        }

        // 普通消息 span：挂到当前步骤；当前没有步骤则挂到所在 workflow
        const inStep = currentStep !== root && !currentStep._isWorkflowRoot;
        const parent = inStep ? currentStep : (innermostWorkflowAt(workflows, s.startNs) || root);
        s._step = parent._step ?? null;
        attach(s, parent);
    }
    return root;
}

/** 时间上覆盖 t 的最内层 workflow。 */
function innermostWorkflowAt(workflows, t) {
    let best = null;
    for (const w of workflows) {
        if (w.startNs <= t && w.endNs >= t) {
            if (!best || (w.endNs - w.startNs) < (best.endNs - best.startNs)) best = w;
        }
    }
    return best;
}

/** 发起委托的步骤：时间上覆盖 wfSpan 起点、且不属于 wfSpan 所在 service 的步骤。 */
function findDelegatingStep(workflows, currentStep, wfSpan) {
    if (currentStep && currentStep._step && !currentStep._isWorkflowRoot
        && currentStep.service !== wfSpan.service
        && currentStep.startNs <= wfSpan.startNs && currentStep.endNs >= wfSpan.startNs) {
        return currentStep;
    }
    // 回退：在所有步骤里找覆盖者（排除同 service），取最内层
    const candidates = [];
    for (const w of workflows) {
        for (const c of w.children || []) {
            if (c._step && !c._isWorkflowRoot && c.service !== wfSpan.service
                && c.startNs <= wfSpan.startNs && c.endNs >= wfSpan.startNs) candidates.push(c);
        }
    }
    candidates.sort((a, b) => (a.endNs - a.startNs) - (b.endNs - b.startNs));
    return candidates[0] || null;
}

/* ---------------------------------- Log ---------------------------------- */

/**
 * 日志类别：按 attributes 推导（服务端日志无 category 字段）。
 *   有 step 且有 agent        → workflow（步骤执行记录）
 *   含 skill                  → agent（智能体技能调用）
 *   其它                      → message
 */
export function categorizeLog(attrs) {
    if (attrs.skill && attrs.agent && !attrs.step) return 'agent';
    if (attrs.step) return 'workflow';
    return 'message';
}

/* ---------------------------------- Task 模型 ---------------------------------- */

const AGENT_KEYS = ['gen_ai.agent.name', 'gen_ai.agent.a2at.agent.name', 'agent', 'gen_ai.agent'];

function pickAgentName(attrs) {
    for (const k of AGENT_KEYS) {
        const v = attrs[k];
        if (typeof v === 'string' && v) return v;
    }
    return null;
}

/**
 * 组装一个完整的 task（视图模型）。
 * @param summary  列表项或详情响应（含 runId / status / startedAt / durationMs / spanCount / workflowType / psop）
 * @param trace    getTrace 响应
 * @param logs     getLogs 响应
 * @param metrics  getMetrics 响应
 */
export function buildTask(summary, trace, logs, metrics) {
    const startNs = Date.parse(summary.startedAt);
    const spans = flattenSpans(trace?.resourceSpans);
    const startNsBase = spans.length ? spans[0].startNs : (Number.isFinite(startNs) ? startNs * 1e6 : 0);
    for (const s of spans) s.startOffsetMs = Math.max(0, (s.startNs - startNsBase) / 1e6);
    const root = buildSpanTreeFromFlat(spans, startNsBase);

    // 日志：对齐到所属 span，推导类别与可显示的时间
    const spanById = new Map(spans.map((s) => [s.spanID, s]));
    const logRows = (logs?.items || []).map((l, i) => {
        const attrs = attrsToObject(l.attributes);
        const span = l.spanId ? spanById.get(l.spanId) : null;
        return {
            offsetMs: span ? span.startOffsetMs : 0,
            severity: severityName(l.severityNumber),
            severityNumber: l.severityNumber,
            name: attrs.skill || attrs.step || 'log',
            category: categorizeLog(attrs),
            body: typeof l.body?.stringValue === 'string' ? l.body.stringValue : (l.body?.stringValue ?? ''),
            service: attrs.agent || span?.service || '',
            spanID: l.spanId || span?.spanID || '',
            attributes: attrs,
            _index: i,
        };
    });
    // 服务端未给时间戳：保持原始顺序（即产生顺序），同 span 内按出现顺序
    logRows.sort((a, b) => (a.offsetMs - b.offsetMs) || (a._index - b._index));

    // PSOP → 步骤。PSOP 描述的是主流程，其步骤对应主流程 service 下的 step span。
    // 被委托的子流程（如 transport）有自己同名的 step1/step2…，必须按 service 区分。
    const mainService = primaryWorkflowService(root);
    const steps = ((summary.psop?.steps) || []).map((st, i) => ({
        index: i,
        name: st.name,
        description: st.subtasks?.[0]?.description || '',
        owner: st.subtasks?.[0]?.agent || '',
        skill: st.subtasks?.[0]?.skill || '',
        type: st.type,
        status: stepStatus(spans, st.name, mainService),
        startOffsetMs: stepOffset(spans, st.name, mainService),
        durationMs: stepDuration(spans, st.name, mainService),
    }));

    // 智能体：PSOP 子任务里的 agent（去重，保持顺序）
    const agents = [];
    for (const st of summary.psop?.steps || []) {
        for (const sub of st.subtasks || []) {
            if (sub.agent && !agents.includes(sub.agent)) agents.push(sub.agent);
        }
    }
    if (agents.length === 0) {
        for (const s of spans) { const a = pickAgentName(s.tags); if (a && !agents.includes(a)) agents.push(a); }
    }

    // Token：从 gen_ai token 指标（如有）取；当前数据集没有则留空
    const tokens = extractTokens(metrics?.signals);

    const agentsStats = {};
    for (const s of spans) {
        const a = pickAgentName(s.tags) || s.service;
        if (!a) continue;
        agentsStats[a] = agentsStats[a] || { spans: 0, durationMs: 0 };
        agentsStats[a].spans += 1;
        agentsStats[a].durationMs += s.durationMs;
    }

    return {
        taskId: summary.workflowId || summary.runId,
        runId: summary.runId,
        taskType: summary.workflowType || '',
        title: humanizeWorkflowType(summary.workflowType),
        extension: summary.name || '',
        status: STATUS_MAP[summary.status] || summary.status || 'ok',
        startedAt: summary.startedAt,
        durationMs: summary.durationMs ?? 0,
        agents,
        serviceName: spans[0]?.service || '',
        workflow: {
            id: summary.workflowId,
            type: summary.workflowType,
            status: summary.status,
            sessionId: summary.psop?.sessionId || '',
            name: summary.psop?.name || '',
            description: summary.psop?.description || '',
        },
        negotiation: null,
        notification: null,
        steps,
        substeps: [],
        tokens,
        spanCount: summary.spanCount ?? spans.length,
        trace: {
            traceID: summary.traceId || spans[0]?.traceID || '',
            spans,
            _root: root,
        },
        metrics: {},
        signals: buildSignals(metrics?.signals),
        logs: logRows,
        _partial: { trace: trace?.partial, log: logs?.partial, metric: metrics?.partial },
        _sourceStatus: {
            trace: trace?.sourceStatus?.trace?.status,
            log: logs?.sourceStatus?.log?.status,
            metric: metrics?.sourceStatus?.metric?.status,
        },
    };
}

function severityName(n) {
    switch (Number(n)) {
        case 5: case 6: return 'TRACE';
        case 7: case 8: return 'DEBUG';
        case 9: return 'INFO';
        case 10: case 11: case 12: return 'WARN';
        case 13: case 14: return 'ERROR';
        case 15: case 16: case 17: case 18: case 19: return 'FATAL';
        default: return 'INFO';
    }
}

/**
 * PSOP 所属的 service。PSOP 描述的是主流程，其步骤 span 落在主流程 service 下。
 * 取根下最早的那个 workflow（外层编排）的 service 即可——它与内层 PSOP workflow 同 service。
 */
function primaryWorkflowService(root) {
    const first = (root.children || []).find((c) => c._isWorkflowRoot);
    return first ? first.service : null;
}

/** 找到指定 service 下的步骤 span。 */
function stepNode(spans, stepName, service) {
    return spans.find((s) => s._step === stepName && STEP_NAME_RE.test(s.operationName) && (!service || s.service === service)) || null;
}
function stepStatus(spans, stepName, service) {
    const n = stepNode(spans, stepName, service);
    if (!n) return 'unknown';
    const anyErr = [n, ...(n.children || [])].some((s) => s.status === 'error');
    return anyErr ? 'error' : 'completed';
}
function stepOffset(spans, stepName, service) {
    const n = stepNode(spans, stepName, service);
    return n ? n.startOffsetMs : 0;
}
function stepDuration(spans, stepName, service) {
    const n = stepNode(spans, stepName, service);
    if (!n) return 0;
    const all = [n, ...(n.children || [])];
    const start = Math.min(...all.map((s) => s.startNs));
    const end = Math.max(...all.map((s) => s.endNs));
    return Math.max(0, (end - start) / 1e6);
}

/** `IG1504D_AN_L4_Enterprise_Private_Line_Complaint_Handling_WAIMO_Package` → 可读标题。 */
export function humanizeWorkflowType(t) {
    if (!t) return '未命名工作流';
    // 长键优先，避免 "…_Transport_Package" 被 "…_WAIMO_Package" 之前的短键抢先命中
    const known = [
        ['Enterprise_Private_Line_Complaint_Handling_Transport_Package', '企业专线投诉处理（传输）'],
        ['Enterprise_Private_Line_Complaint_Handling_WAIMO_Package', '企业专线投诉处理（WAIMO）'],
        ['Enterprise_Private_Line_Complaint_Handling', '企业专线投诉处理'],
    ];
    for (const [k, v] of known) if (t.includes(k)) return v;
    return t.replace(/_/g, ' ');
}

/* ---------------------------------- Metric ---------------------------------- */

/**
 * 把 signals[] 归并为视图期望的形状：
 *   { metric, prom, type, unit, samples:[{ value, attributes }] }
 * histogram 只保留 _bucket（带 le）；另给出 _sum/_count 供计算 avg/last。
 */
export function buildSignals(signals) {
    const out = [];
    for (const sg of signals || []) {
        const prom = sg.metric;
        const type = inferMetricType(prom);
        const samples = [];
        for (const ser of sg.series || []) {
            const { __name__, ...labels } = ser.metric || {};
            const pts = parsePoints(ser.values);
            if (!pts.length) continue;
            const last = pts[pts.length - 1];
            samples.push({ value: last.value, attributes: labels, _points: pts });
        }
        if (!samples.length) continue;
        out.push({ name: sg.name, metric: prom, type, unit: sg.unit, samples });
    }
    return out;
}

/** 把 signals 拆成 lines（counter/gauge）与 histograms（_bucket 系列），供图表直接使用。 */
/**
 * 把 signals[] 整理为图表可直接使用的结构：
 *   {
 *     lines:      { <base>: [{ labels, points }] }            counter / gauge（每条 series 一组点）
 *     histograms: { <base>: [{ le, labels, points }] }        histogram 的 _bucket，按 le 升序
 *     sums:       { <base>: [{ labels, points }] }            histogram 的 _sum（用于算 avg = sum/count）
 *     counts:     { <base>: [{ labels, points }] }            histogram 的 _count
 *   }
 * histogram 的 _sum/_count 不进 lines（不单独画折线），但必须保留——均值要从它们算。
 */
export function buildCharts(signals) {
    const lines = {};
    const histograms = {};
    const sums = {};
    const counts = {};
    const histogramBases = new Set((signals || []).filter((sg) => /_bucket$/.test(sg.metric || '')).map((sg) => baseMetricName(sg.metric)));

    const stripName = (m) => Object.fromEntries(Object.entries(m || {}).filter(([k]) => k !== '__name__'));
    const seriesOf = (sg, keepLe) => (sg.series || []).map((ser) => ({
        le: keepLe ? String(ser.metric?.le ?? '+Inf') : undefined,
        labels: stripName(keepLe ? Object.fromEntries(Object.entries(ser.metric || {}).filter(([k]) => k !== 'le')) : ser.metric),
        points: parsePoints(ser.values),
    }));

    for (const sg of signals || []) {
        const prom = sg.metric || '';
        const base = baseMetricName(prom);
        if (/_bucket$/.test(prom)) {
            histograms[base] = seriesOf(sg, true).sort((a, b) => leNumber(a.le) - leNumber(b.le));
        } else if (/_sum$/.test(prom) && histogramBases.has(base)) {
            sums[base] = seriesOf(sg, false);
        } else if (/_count$/.test(prom) && histogramBases.has(base)) {
            counts[base] = seriesOf(sg, false);
        } else {
            // counter / gauge：折线。注意非 histogram 的 *_count（如 negotiation_rounds_count）也走这里
            lines[base] = seriesOf(sg, false);
        }
    }
    return { lines, histograms, sums, counts };
}

function leNumber(le) {
    return le === '+Inf' || le === 'Inf' ? Infinity : Number(le);
}

/* ---------------------------------- Token ---------------------------------- */

function extractTokens(signals) {
    const out = [];
    for (const sg of signals || []) {
        if (!/token/.test(sg.metric || '')) continue;
        const tokenType = /input/.test(sg.metric) ? 'input' : /output/.test(sg.metric) ? 'output' : 'total';
        for (const ser of sg.series || []) {
            const pts = parsePoints(ser.values);
            if (!pts.length) continue;
            const last = pts[pts.length - 1].value;
            const m = ser.metric || {};
            out.push({
                agent: m['gen_ai.agent.name'] || m.agent || m.service_name || '',
                model: m['gen_ai.request.model'] || m.model || '',
                tokenType,
                tokens: Math.round(last),
            });
        }
    }
    return out;
}

/** 列表页用：把列表项映射为行摘要（不拉详情，保证列表快速）。 */
export function buildListTask(it) {
    return {
        taskId: it.workflowId || it.runId,
        runId: it.runId,
        taskType: it.workflowType || '',
        title: humanizeWorkflowType(it.workflowType),
        status: STATUS_MAP[it.status] || it.status || 'ok',
        startedAt: it.startedAt,
        durationMs: it.durationMs ?? 0,
        spanCount: it.spanCount ?? 0,
        traceId: it.traceId || '',
        name: it.name || '',
        agents: [],       // 列表接口不返回参与智能体；详情里从 PSOP 取
        _summary: true,
    };
}

/** 列表页用：aggregates + facets 映射为视图的汇总信息。 */
export function buildListMeta(list) {
    return {
        total: list?.aggregates?.total ?? (list?.items || []).length,
        success: list?.aggregates?.success ?? 0,
        error: list?.aggregates?.error ?? 0,
        successRate: list?.aggregates?.successRate ?? null,
        avgDurationMs: list?.aggregates?.avgDurationMs ?? null,
        workflowTypes: (list?.facets?.workflowTypes || []).map((f) => ({ value: f.value, count: f.count })),
        partial: !!list?.partial,
        sourceStatus: list?.sourceStatus || {},
        nextCursor: list?.nextCursor ?? null,
    };
}
