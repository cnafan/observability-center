import { useCallback, useEffect, useRef, useState } from 'react';
import { getObsConfig, isObsApiConfigured, loadRuntimeConfig } from '../lib/config';
import { createObsClient } from '../services/obs-api';
import { buildCharts, buildListMeta, buildListTask, buildTask } from '../services/obs-adapter';

/**
 * 数据源 Hook。
 *
 * 已配置查询服务（见 lib/config.js）时走真实接口：列表用 listWorkflows，
 * 选中某个 run 后再并行拉 detail / trace / logs / metrics 四个接口组装成 task。
 * 未配置时回退到内置模拟数据（静态 JSON），行为与之前一致。
 *
 * 是否"已配置"取决于部署期配置文件 runtime-config.json（异步加载），
 * 所以首次 reload 会先等配置加载完成，再决定走哪条路径。
 */
export function useCollabTasks() {
    // 先按"未配置"渲染，等配置文件加载完再定数据源——避免把本该走 API 的环境闪一下 mock 数据
    const [state, setState] = useState({ loading: true, error: null, dataset: null, source: null });
    const [detail, setDetail] = useState({ loading: false, error: null, task: null, runId: null });
    const seq = useRef(0);

    const reload = useCallback(async () => {
        const my = ++seq.current;
        setState((s) => ({ ...s, loading: true, error: null }));
        try {
            await loadRuntimeConfig();                 // 404 = 未接入，内部已静默处理
            if (my !== seq.current) return;
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
            // 先标记数据源：即使请求失败，UI 也能如实显示「查询服务 · 连接失败」，而不是误报成模拟数据
            setState((s) => ({ ...s, source: 'api' }));
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
