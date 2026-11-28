import React from 'react';
import './index.css';
import './i18n/menu-labels';
import { useState } from 'react';
import { useCollabTasks } from './hooks/useCollabTasks';
import { IconRefresh } from './ui/icons';
import { BusinessObservationView } from './views/business-view';
import { TaskDetailView } from './views/task-detail';
import { TaskListView } from './views/task-list';
import { ThirdPartyObservability } from './ui/third-party';

export default function ObservationCenterPlugin() {
    const tasks = useCollabTasks();
    const usingApi = tasks.source === 'api';
    // view: null = 列表；'raw' = 原始观测信号（Metric/Trace/Log）；'business' = 业务观测
    const [selected, setSelected] = useState(null);
    const [view, setView] = useState(null);
    const backToList = () => { setSelected(null); setView(null); };

    // 选中一个任务：API 模式下按需拉取详情（trace/logs/metrics），模拟模式直接用列表里的 task
    const openTask = (task, nextView) => {
        setSelected(task);
        setView(nextView);
        if (usingApi) tasks.loadDetail(task.runId);
    };

    // 详情就绪前先用列表摘要占位，避免空白；就绪后换成完整 task
    const detailTask = usingApi && tasks.detail.task && tasks.detail.runId === selected?.runId ? tasks.detail.task : selected;
    const detailLoading = usingApi && selected && tasks.detail.loading && tasks.detail.runId === selected?.runId;
    const detailError = usingApi && selected && !tasks.detail.loading && tasks.detail.error && tasks.detail.runId === selected?.runId
        ? tasks.detail.error : null;

    return (
        <div className="obs-plugin-root">
            <div className="obs-toolbar">
                <div className="obs-toolbar-left">
                    <div className="obs-heading">
                        <span className="obs-title">观测中心</span>
                        <span className="obs-subtitle">Collaboration Task Traces · Observation Center</span>
                    </div>
                </div>
                <div className="obs-toolbar-actions">
                    <span
                        className={`obs-source-badge ${usingApi ? 'obs-source-badge-api' : ''}`}
                        title={usingApi ? '数据来自 Observability Workflow Query Service（实时查询）' : '内置模拟数据（SDK 存储形态）'}
                    >
                        {usingApi ? '查询服务 · 实时' : '模拟数据 · SDK 存储形态'}
                    </span>
                    <button type="button" className="obs-btn" onClick={tasks.reload} title="重新拉取协作任务数据">
                        <IconRefresh />
                        <span>刷新数据</span>
                    </button>
                </div>
            </div>

            {selected && view === 'business' ? (
                <BusinessObservationView task={detailTask} onBack={backToList} loading={detailLoading} error={detailError} />
            ) : selected ? (
                <TaskDetailView
                    task={detailTask}
                    dataset={tasks.dataset}
                    onBack={backToList}
                    loading={detailLoading}
                    error={detailError}
                    charts={tasks.detail.charts}
                />
            ) : (
                <TaskListView
                    loading={tasks.loading}
                    error={tasks.error}
                    dataset={tasks.dataset}
                    onOpen={(task) => openTask(task, 'raw')}
                    onOpenBusiness={(task) => openTask(task, 'business')}
                    onReload={tasks.reload}
                />
            )}
        </div>
    );
}

/* ==========================================================================
 * Route 2 — /observation/third-party 三方可观测
 *
 * 三张组件大卡片（开源组件名称）。菜单点击为门户内正常跳转；**点击卡片在
 * 新标签页打开对应组件页面**：
 *   · Langfuse     — 已接入：新页面打开门户自部署 Langfuse 站点（9012）。
 *   · Grafana      — 待接入：先前往 grafana.com 官网；部署完成后把 target
 *                    换成控制台地址即可。
 *   · Prometheus   — 待接入：先前往 prometheus.io 官网；同上。
 * ======================================================================== */

/** Langfuse 卡片图标：火焰轮廓（Lucide "flame" 路径，ISC License），渐变描边。 */

export { ThirdPartyObservability };
