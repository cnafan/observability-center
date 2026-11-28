import React, { useMemo } from 'react';
import { useState } from 'react';
import { AGENT_LABELS, TASK_TYPE_LABELS } from '../lib/constants';
import { fmtAgo, fmtMs, fmtTime } from '../lib/format';
import { explainNetworkError, summarizeNetworkError } from '../lib/net-error';
import { StatusPill, SummaryChips } from '../ui/common';
import { IconChevronRight, IconRefresh, IconSearch } from '../ui/icons';
import { useResizableColumns } from '../hooks/useResizableColumns';

/** 任务列表的列：表头与数据行共用，顺序即渲染顺序。最后一列为无表头的跳转箭头。 */
const COLUMNS = [
    { key: 'task', label: '协作任务', track: 'minmax(150px, 1fr)' },
    { key: 'type', label: '类型', track: 'max-content' },
    { key: 'agents', label: '参与智能体', track: 'minmax(130px, 1fr)' },
    { key: 'time', label: '开始时间', track: 'max-content' },
    { key: 'duration', label: '耗时', track: 'max-content' },
    { key: 'spans', label: 'Span', track: 'max-content' },
    { key: 'status', label: '状态', track: 'max-content' },
    { key: 'actions', label: '操作', track: 'max-content' },
    { key: 'go', label: '', track: 'minmax(20px, max-content)' },
];
const COLUMN_KEYS = COLUMNS.map((column) => column.key);
const COLUMN_STORAGE_KEY = 'openan.observation-center.task-list.columns';

/**
 * 表头与数据行共用的 grid-template-columns。
 * 未拖过的列用各自的默认轨道（与 index.css 的列模板一致），拖过的列覆盖为具体像素。
 * 表头和数据行必须用完全相同的模板，否则两者列宽会对不齐。
 */
function buildGridTemplate(widths) {
    return COLUMNS.map((column) => (widths[column.key] ? `${widths[column.key]}px` : column.track)).join(' ');
}

export function TaskListView({ loading, error, dataset, onOpen, onOpenBusiness, onReload }) {
    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const { widths, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp, resetColumn, resetAll } =
        useResizableColumns(COLUMN_STORAGE_KEY, COLUMN_KEYS);
    const gridTemplate = useMemo(() => buildGridTemplate(widths), [widths]);
    const hasCustomWidths = Object.keys(widths).length > 0;
    const tasks = (dataset?.tasks || []).slice();
    const filtered = tasks.filter((t) => {
        if (statusFilter === 'ok' && t.status === 'error') return false;
        if (statusFilter === 'error' && t.status !== 'error') return false;
        if (!query.trim()) return true;
        const q = query.trim().toLowerCase();
        return [t.title, t.runId, t.taskId, t.taskType, ...(t.agents || [])]
            .some((v) => String(v).toLowerCase().includes(q));
    });
    return (
        <div className="obs-body">
            {loading && !dataset && (
                <div className="obs-list-empty"><div className="obs-spinner" /><p>正在加载协作任务轨迹…</p></div>
            )}
            {error && !dataset && (
                <div className="obs-list-empty">
                    <p className="obs-error-title">协作任务数据加载失败</p>
                    <p className="obs-panel-note">{summarizeNetworkError(error)}</p>
                    {explainNetworkError(error).length > 0 && (
                        <ul className="obs-detail-hint">
                            {explainNetworkError(error).map((h, i) => <li key={i}>{h}</li>)}
                        </ul>
                    )}
                    <button type="button" className="obs-btn obs-btn-primary" onClick={onReload}><IconRefresh /><span>重试</span></button>
                </div>
            )}
            {dataset && (
                <>
                    <SummaryChips tasks={tasks} />
                    <div className="obs-list-tools">
                        <label className="obs-search">
                            <IconSearch />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="搜索任务 / runId / 智能体"
                            />
                        </label>
                        <div className="obs-filter">
                            {[['all', `全部 ${tasks.length}`], ['ok', `成功 ${tasks.filter((t) => t.status !== 'error').length}`], ['error', `失败 ${tasks.filter((t) => t.status === 'error').length}`]].map(([k, label]) => (
                                <button
                                    key={k}
                                    type="button"
                                    className={`obs-filter-btn ${statusFilter === k ? 'obs-filter-btn-active' : ''}`}
                                    onClick={() => setStatusFilter(k)}
                                >{label}</button>
                            ))}
                        </div>
                        <span className="obs-list-hint">
                            数据源：{dataset.source || 'simulated'} · {dataset.shape || ''}
                        </span>
                        {hasCustomWidths && (
                            <button
                                type="button"
                                className="obs-btn obs-col-reset"
                                onClick={resetAll}
                                title="清除已保存的列宽，全部列恢复自适应"
                            >
                                重置列宽
                            </button>
                        )}
                    </div>
                    <div className="obs-task-scroll">
                        <div
                            className={`obs-task-list${hasCustomWidths ? ' obs-task-list-resized' : ''}`}
                            style={{ gridTemplateColumns: gridTemplate }}
                        >
                            <div className="obs-task-row obs-task-head">
                                {COLUMNS.map((column) => (
                                    <span
                                        key={column.key}
                                        className="obs-task-head-cell"
                                        title={column.label ? '拖动右缘调整列宽，双击恢复自适应' : undefined}
                                        onDoubleClick={() => resetColumn(column.key)}
                                    >
                                        <span className="obs-task-head-label">{column.label}</span>
                                        {column.key !== 'go' && column.key !== 'actions' && (
                                            <span
                                                className="obs-col-resizer"
                                                role="separator"
                                                aria-orientation="vertical"
                                                aria-label={`调整「${column.label}」列宽`}
                                                onPointerDown={(event) => onHandlePointerDown(event, column.key)}
                                                onPointerMove={onHandlePointerMove}
                                                onPointerUp={onHandlePointerUp}
                                                onPointerCancel={onHandlePointerUp}
                                                onDoubleClick={(event) => { event.stopPropagation(); resetColumn(column.key); }}
                                            />
                                        )}
                                    </span>
                                ))}
                            </div>
                            {filtered.map((t) => (
                                <div key={t.taskId} className="obs-task-row" onClick={() => onOpen(t)} role="button" tabIndex={0}
                                    onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t); }}>
                                    <div className="obs-task-title">
                                        <span className="obs-task-name">{t.title}</span>
                                        <span className="obs-task-run">{t.runId}</span>
                                    </div>
                                    <span className="obs-type-tag">{TASK_TYPE_LABELS[t.taskType] || t.taskType}</span>
                                    <span className="obs-task-agents">{(t.agents || []).map((a) => AGENT_LABELS[a] || a).join(' · ')}</span>
                                    <span className="obs-task-time">{fmtTime(t.startedAt)}<em>{fmtAgo(t.startedAt)}</em></span>
                                    <span className="obs-task-dur">{fmtMs(t.durationMs)}</span>
                                    <span className="obs-task-spans">{t.spanCount}</span>
                                    <StatusPill status={t.status} />
                                    <span className="obs-task-actions">
                                        <button
                                            type="button"
                                            className="obs-btn obs-task-action"
                                            onClick={(e) => { e.stopPropagation(); onOpen(t); }}
                                            title="查看原始观测信号：Metric / Trace / Log 与数据信号字典"
                                        >
                                            原始信号
                                        </button>
                                        <button
                                            type="button"
                                            className="obs-btn obs-task-action obs-task-action-biz"
                                            onClick={(e) => { e.stopPropagation(); onOpenBusiness(t); }}
                                            title="查看业务观测：工作流执行、协商与通知、Token 用量"
                                        >
                                            业务观测
                                        </button>
                                    </span>
                                    <span className="obs-task-go"><IconChevronRight /></span>
                                </div>
                            ))}
                            {filtered.length === 0 && <div className="obs-list-empty"><p>没有匹配的任务</p></div>}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

/** 按智能体聚合 Span 统计（Agent 维度）。 */
