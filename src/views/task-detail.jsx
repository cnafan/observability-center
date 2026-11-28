import React from 'react';
import { useState } from 'react';
import { SIGNAL_TABS } from '../lib/constants';
import { fmtAgo, fmtMs, fmtTime } from '../lib/format';
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
                    <DetailErrorHint message={error} />
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

/**
 * 把浏览器的网络错误翻译成可操作的原因。
 * "Failed to fetch" 在浏览器里几乎总是 CORS 或证书问题，而这两者前端都无法自行修复。
 */
function DetailErrorHint({ message }) {
    const m = String(message || '');
    const hints = [];
    if (/failed to fetch|networkerror|load failed/i.test(m)) {
        hints.push('浏览器未能建立连接。最常见的原因：');
        hints.push('· 查询服务的 HTTPS 证书无效或已过期（浏览器强制校验，前端无法绕过）——请检查服务端证书');
        hints.push('· 跨域（CORS）未放行当前门户来源');
        hints.push('· 查询服务不可达或地址配置错误');
    }
    if (/aborted|超时/i.test(m)) hints.push('请求超时：查询服务响应过慢，或该运行的数据量过大。');
    if (/HTTP 404/i.test(m)) hints.push('该 runId 在查询服务中不存在（可能已被清理）。');
    if (/HTTP 5\d\d/i.test(m)) hints.push('查询服务或其前置网关异常，请稍后重试或联系服务维护者。');
    if (!hints.length) return null;
    return (
        <ul className="obs-detail-hint">
            {hints.map((h, i) => <li key={i}>{h}</li>)}
        </ul>
    );
}
