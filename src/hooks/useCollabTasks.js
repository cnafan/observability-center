import { useCallback, useEffect, useRef, useState } from 'react';
import { getObsConfig, isObsApiConfigured } from '../lib/config';
import { createObsClient } from '../services/obs-api';
import { buildCharts, buildListMeta, buildListTask, buildTask } from '../services/obs-adapter';

/**
 * 数据源 Hook。
 *
 * 已配置查询服务（见 lib/config.js）时走真实接口：列表用 listWorkflows，
 * 选中某个 run 后再并行拉 detail / trace / logs / metrics 四个接口组装成 task。
 * 未配置时回退到内置模拟数据（静态 JSON），行为与之前一致。
 */
export function useCollabTasks() {
    const usingApi = isObsApiConfigured();
    const [state, setState] = useState({ loading: true, error: null, dataset: null, source: usingApi ? 'api' : 'mock' });
    const [detail, setDetail] = useState({ loading: false, error: null, task: null, runId: null });
    const seq = useRef(0);

    const reload = useCallback(async () => {
        const my = ++seq.current;
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
            if (!isObsApiConfigured()) {
                const { resolveDataUrl } = await import('../lib/urls');
                const r = await fetch(resolveDataUrl(), { cache: 'no-store' });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const dataset = await r.json();
                if (my !== seq.current) return;
                setState({ loading: false, error: null, dataset, source: 'mock' });
                return;
            }
            const cfg = getObsConfig();
            const client = createObsClient(cfg);
            const list = await client.listWorkflows({ limit: cfg.listLimit });
            if (my !== seq.current) return;
            const meta = buildListMeta(list);
            // 列表页只需要摘要；详情在用户选中后再拉
            const tasks = (list.items || []).map(buildListTask);
            setState({
                loading: false, error: null, source: 'api',
                dataset: { tasks, ...meta, meta: list.meta || {}, nextCursor: list.nextCursor ?? null },
            });
        } catch (e) {
            if (my !== seq.current) return;
            setState((s) => ({ ...s, loading: false, error: e?.message || String(e) }));
        }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    /** 拉取某个 run 的详情（trace / logs / metrics 并行）。 */
    const loadDetail = useCallback(async (runId) => {
        const my = ++seq.current;
        setDetail({ loading: true, error: null, task: null, runId });
        if (!isObsApiConfigured()) {
            // 模拟数据：task 已整体在 dataset 里，由调用方直接取用
            setDetail({ loading: false, error: null, task: null, runId });
            return;
        }
        try {
            const cfg = getObsConfig();
            const client = createObsClient(cfg);
            const [summary, trace, logs, metrics] = await Promise.all([
                client.getWorkflow(runId),
                client.getTrace(runId),
                client.getLogs(runId, { limit: 200 }),
                client.getMetrics(runId, { windowMin: 5, step: '15s' }),
            ]);
            if (my !== seq.current) return;
            const task = buildTask(summary, trace, logs, metrics);
            const charts = buildCharts(metrics?.signals);
            setDetail({ loading: false, error: null, task, runId, charts, metricsMeta: {
                collection: metrics?.collection, summary: metrics?.summary,
                partial: metrics?.partial, sourceStatus: metrics?.sourceStatus,
            } });
        } catch (e) {
            if (my !== seq.current) return;
            setDetail({ loading: false, error: e?.message || String(e), task: null, runId });
        }
    }, []);

    return { ...state, reload, detail, loadDetail };
}
