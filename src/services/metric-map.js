/**
 * 指标目录（metric-catalog.js）与查询服务 signals 的对应关系。
 *
 * 目录里的 *.duration 项用的是 `_avg` 后缀（录制时导出的聚合值），查询服务不直接返回它，
 * 而是返回 OTLP histogram 三件套 `<base>_count / <base>_sum / <base>_bucket`。
 * 对 histogram：avg = sum / count，可在前端算出；直方图用 _bucket。
 *
 * 这里只做「名称 → 名称」的纯映射，不含任何环境信息。
 */

/** 目录指标名 → 查询服务里的基名（不含 _count/_sum/_bucket 后缀）。 */
const NAME_TO_BASE = {
    'gen_ai.agent.a2at.workflow.duration': 'gen_ai_agent_a2at_workflow_duration_milliseconds',
    'gen_ai.agent.a2at.workflow.count': 'gen_ai_agent_a2at_workflow_count_total',
    'gen_ai.agent.a2at.task.duration': 'gen_ai_agent_a2at_task_duration_milliseconds',
    'gen_ai.agent.a2at.task.count': 'gen_ai_agent_a2at_task_count_total',
    'gen_ai.agent.a2at.step.duration': 'gen_ai_agent_a2at_step_duration_milliseconds',
    'gen_ai.agent.a2at.substep.duration': 'gen_ai_agent_a2at_substep_duration_milliseconds',
    'gen_ai.agent.a2at.authorization.preauthorize.count': 'gen_ai_agent_a2at_authorization_preauthorize_count_total',
    'gen_ai.agent.a2at.authorization.preauthorize.duration': 'gen_ai_agent_a2at_authorization_preauthorize_duration_milliseconds',
    'gen_ai.agent.a2at.notification.count': 'gen_ai_agent_a2at_notification_count_total',
    'gen_ai.agent.a2at.negotiation.count': 'gen_ai_agent_a2at_negotiation_count_total',
    'gen_ai.agent.a2at.negotiation.rounds': 'gen_ai_agent_a2at_negotiation_rounds',
    'gen_ai.agent.a2a.streaming.duration': 'gen_ai_agent_a2a_streaming_duration_milliseconds',
    'gen_ai.client.operation.duration': 'gen_ai_client_operation_duration_seconds',
};

/**
 * 目录指标 → 查询服务图表数据。
 * @param charts  buildCharts() 的输出 { lines, histograms, sums, counts }
 * @returns { status: 'ok'|'missing', line, hist, avg, count, base }
 *   - histogram 型：hist = 桶数组；avg = Σsum末值 / Σcount末值（按标签对齐后求和）
 *   - counter 型：line = 折线
 */
export function resolveMetricCharts(metricName, charts) {
    const base = NAME_TO_BASE[metricName];
    if (!base) return { status: 'missing', base: null, reason: '目录中无此指标的查询服务映射' };
    const hist = charts?.histograms?.[base] || null;
    // histogram 型指标：时序折线画 _count（采样次数随时间变化），直方图展示分布；
    // counter/gauge 型：直接画其本身。
    const line = hist ? (charts?.counts?.[base] || null) : (charts?.lines?.[base] || null);
    if (!hist && !line) return { status: 'missing', base, reason: '查询服务未返回该指标的数据' };

    let avg = null;
    let count = null;
    if (hist) {
        // 同一组标签的 _sum 与 _count 相除得到该序列的均值，再按序列求和
        const labelKey = (labels) => JSON.stringify(Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b)));
        const lastOf = (s) => (s.points && s.points.length ? s.points[s.points.length - 1].value : 0);
        const sumByLabel = new Map((charts?.sums?.[base] || []).map((s) => [labelKey(s.labels), lastOf(s)]));
        const countByLabel = new Map((charts?.counts?.[base] || []).map((s) => [labelKey(s.labels), lastOf(s)]));
        let sumTotal = 0;
        let countTotal = 0;
        for (const [k, c] of countByLabel) {
            const s = sumByLabel.get(k);
            if (s != null && c > 0) { sumTotal += s; countTotal += c; }
        }
        if (countTotal > 0) { avg = sumTotal / countTotal; count = countTotal; }
    }
    return { status: 'ok', base, line, hist, avg, count };
}

/** 该指标在查询服务里是直方图型（可画 le 累计桶）。 */
export function isHistogramMetric(metricName) {
    const base = NAME_TO_BASE[metricName];
    return !!base && /_duration_(milliseconds|seconds)$/.test(base);
}

/** 查询服务是否提供目录中的这一项（用于在 UI 上标注「未提供」而非显示空图）。 */
export function metricAvailability(metricNames, charts) {
    const out = {};
    for (const n of metricNames) out[n] = resolveMetricCharts(n, charts).status;
    return out;
}

/* ------------------------- 转换为图表组件（ui/charts.jsx）所需的形状 ------------------------- */

const COLORS = ['#2563eb', '#059669', '#f46800', '#7c3aed', '#ec4899', '#0ea5e9', '#ca8a04', '#14b8a6'];

/** `{a:"x",b:"y"}` → `a="x",b="y"`（Prom 序列名风格，供 legend 显示）。 */
function promLabel(name, labels) {
    const pairs = Object.entries(labels || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}="${v}"`);
    return pairs.length ? `${name}{${pairs.join(',')}}` : name;
}

/**
 * API charts（buildCharts 输出）→ PromGraph 需要的 line。
 * 每条 series 一个点集，points 为 [{ t(ms), v }]。
 */
export function toLineChart(base, series, unit) {
    return {
        label: base,
        unit: unit || '',
        series: (series || []).map((s, i) => ({
            prom: promLabel(base, s.labels),
            name: promLabel(base, s.labels),
            color: COLORS[i % COLORS.length],
            points: (s.points || []).map((p) => ({ t: p.ts * 1000, v: p.value })),
        })).filter((s) => s.points.length > 0),
    };
}

/**
 * API histogram（按 le 排序的累计桶）→ PromHistogram 需要的 buckets。
 * 取每个桶的末值；相邻桶相减得到该区间的计数（le 桶是累计值）。
 */
export function toHistogram(base, leBuckets, unit) {
    const lastOf = (b) => (b.points && b.points.length ? b.points[b.points.length - 1].value : 0);
    const cumulative = (leBuckets || []).map((b) => ({ le: b.le, count: lastOf(b), inf: b.le === '+Inf' || b.le === 'Inf' }));
    // 相邻相减 → 区间计数；+Inf 桶保留自身累计值减去前一桶
    const buckets = cumulative.map((b, i) => {
        const prev = i > 0 ? cumulative[i - 1].count : 0;
        return { le: b.le, count: Math.max(0, b.count - prev), inf: b.inf };
    });
    return { label: base, unit: unit || '', buckets };
}
