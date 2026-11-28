import React from 'react';
import { useState } from 'react';
import { SIGNAL_TABS } from '../lib/constants';
import { fmtAgo, fmtMs, fmtTime } from '../lib/format';
import { explainNetworkError } from '../lib/net-error';
import { AttrChip, StatusPill } from '../ui/common';
import { DictContent } from '../ui/dict';
import { IconChevronLeft } from '../ui/icons';
import { LogTab } from '../ui/log-tab';
import { MetricPromTab } from '../ui/metric';
import { TraceContent } from '../ui/trace';

export function DimensionBlock({ label, note, children }) {
    return (
        <div className="obs-dimblock">
            <div className="obs-dimblock-head">
                <span className="obs-dimblock-name">{label}</span>
                {note && <span className="obs-panel-note">{note}</span>}
            </div>
            {children}
        </div>
    );
}

export function TaskDetailView({ task, dataset, onBack, loading = false, error = null, charts = null }) {
    const [signal, setSignal] = useState('metric'); // 顶层：metric | trace | log
    const [topoOpen, setTopoOpen] = useState(false); // 默认折叠为左侧窄条
    const collection = dataset?.collection;
    const ready = task && !task._summary;
    return (
        <div className="obs-body">
            <div className="obs-detail-head">
                <button type="button" className="obs-btn" onClick={onBack}><IconChevronLeft /><span>返回列表</span></button>
                <div className="obs-detail-title">
                    <span className="obs-task-name">{task.title}</span>
                    <span className="obs-task-meta">
                        {task.runId} · {task.taskId} · 开始 {fmtTime(task.startedAt)}（{fmtAgo(task.startedAt)}）· 总耗时 {fmtMs(task.durationMs)}
                    </span>
                </div>
                <StatusPill status={task.status} />
            </div>

            {loading && (
                <div className="obs-panel obs-detail-state" role="status">
                    <span className="obs-panel-note">正在加载该运行的 Trace / Log / Metric…</span>
                </div>
            )}
            {!loading && error && (
                <div className="obs-panel obs-detail-state obs-detail-state-error" role="alert">
                    <div className="obs-panel-title"><span>无法加载该运行的观测数据</span></div>
                    <p className="obs-panel-note">{error}</p>
                    {explainNetworkError(error).length > 0 && (
                        <ul className="obs-detail-hint">
                            {explainNetworkError(error).map((h, i) => <li key={i}>{h}</li>)}
                        </ul>
                    )}
                </div>
            )}

            {!loading && !error && ready && (
            <div className={`obs-detail-layout ${topoOpen ? '' : 'obs-detail-layout-collapsed'}`}>
                {topoOpen ? (
                    <div className="obs-topo">
                        <div className="obs-panel-title">
                            <span>协作拓扑图</span>
                            <span className="obs-panel-note">按 Trace Span 聚合</span>
                            <button
                                type="button"
                                className="obs-btn obs-topo-toggle"
                                onClick={() => setTopoOpen(false)}
                                title="收起协作拓扑图（收起到左侧窄条）"
                            >
                                收起 ‹
                            </button>
                        </div>
                        <TopologyGraph task={task} />
                    </div>
                ) : (
                    <div className="obs-topo obs-topo-rail">
                        <button
                            type="button"
                            className="obs-btn obs-topo-rail-expand"
                            onClick={() => setTopoOpen(true)}
                            title="展开协作拓扑图"
                        >
                            »
                        </button>
                        <span className="obs-topo-rail-label">协作拓扑图</span>
                    </div>
                )}
                <div className="obs-dim">
                    <div className="obs-dim-tabs">
                        {SIGNAL_TABS.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                className={`obs-dim-tab ${signal === t.key ? 'obs-dim-tab-active' : ''}`}
                                onClick={() => setSignal(t.key)}
                            >{t.label}</button>
                        ))}
                    </div>
                    {signal === 'metric' && collection && (
                        <div className="obs-attr-row obs-attr-row-note obs-collection-row">
                            <span className="obs-attr-row-label">采集周期：</span>
                            <AttrChip k="interval" v={`${collection.intervalSec}s`} />
                            <AttrChip k="折线窗口" v={`最近 ${collection.windowMin >= 60 ? `${collection.windowMin / 60} 小时` : `${collection.windowMin} 分钟`}`} />
                            <AttrChip k="保留" v={`${collection.retentionHours}h`} />
                            <span className="obs-panel-note">{collection.note}</span>
                        </div>
                    )}
                    {signal === 'metric' && <MetricPromTab task={task} dataset={dataset} charts={charts} />}
                    {signal === 'trace' && (
                        <DimensionBlock label="协作任务 Trace" note="同一 Trace 贯穿消息 / 工作流 / Agent 三个维度">
                            <TraceContent task={task} />
                        </DimensionBlock>
                    )}
                    {signal === 'log' && <LogTab task={task} />}
                    {signal === 'dict' && <DictContent />}
                </div>
            </div>
            )}
        </div>
    );
}
