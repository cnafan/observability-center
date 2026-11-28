import React from 'react';
import { useState } from 'react';
import { AGENT_LABELS } from '../lib/constants';
import { fmtAgo, fmtMs, fmtTime } from '../lib/format';
import { StatusPill } from '../ui/common';

const NEGOTIATION_LABELS = { agree: '达成一致', reject: '拒绝', timeout: '超时', pending: '进行中' };
const NOTIFICATION_LABELS = {
    'progress-report': '进度上报',
    'task-complete': '任务完成',
    'exception-alert': '异常告警',
    'resource-request': '资源申请',
};

function Block({ title, note, children }) {
    return (
        <div className="obs-panel obs-biz-block">
            <div className="obs-prom-panel-head">
                <div className="obs-prom-panel-title">
                    <span className="obs-prom-expr">{title}</span>
                    {note && <span className="obs-prom-panel-sub">{note}</span>}
                </div>
            </div>
            {children}
        </div>
    );
}

function KV({ k, v }) {
    return (
        <div className="obs-biz-kv">
            <span className="obs-attr-row-label">{k}</span>
            <span className="obs-biz-kv-v">{v}</span>
        </div>
    );
}

/** 工作流执行概览：工作流标识 + 各步骤的执行时序条。 */
function WorkflowBlock({ task }) {
    const wf = task.workflow || {};
    const steps = task.steps || [];
    const total = Math.max(task.durationMs, 1);
    return (
        <Block title="工作流执行" note="业务侧的步骤编排与各步骤耗时占比">
            <div className="obs-biz-kv-grid">
                <KV k="工作流 ID" v={wf.id || '—'} />
                <KV k="工作流类型" v={wf.type || '—'} />
                <KV k="会话 ID" v={wf.sessionId || '—'} />
                <KV k="工作流状态" v={<StatusPill status={wf.status} />} />
            </div>
            {steps.length > 0 ? (
                <ol className="obs-biz-steps">
                    {steps.map((s) => (
                        <li key={s.index} className="obs-biz-step">
                            <span className="obs-biz-step-idx">{s.index + 1}</span>
                            <span className="obs-biz-step-name">{s.name}</span>
                            <span className="obs-biz-step-owner">{AGENT_LABELS[s.owner] || s.owner}</span>
                            <span className="obs-biz-step-track">
                                <span
                                    className={`obs-wf-bar obs-wf-bar-internal ${s.status === 'error' ? 'obs-wf-bar-err' : ''}`}
                                    style={{ left: `${(s.startOffsetMs / total) * 100}%`, width: `${Math.max((s.durationMs / total) * 100, 1.5)}%` }}
                                />
                            </span>
                            <span className="obs-biz-step-dur">{fmtMs(s.durationMs)}</span>
                        </li>
                    ))}
                </ol>
            ) : <span className="obs-sig-none">本任务无步骤记录</span>}
        </Block>
    );
}

/** 协商与通知：A2A-T 协作的业务结果。 */
function CollaborationBlock({ task }) {
    const neg = task.negotiation;
    const notif = task.notification;
    return (
        <Block title="协商与通知" note="智能体间的协商结果与对外的通知上报">
            {neg ? (
                <div className="obs-biz-kv-grid">
                    <KV k="协商 ID" v={neg.id} />
                    <KV k="协商结果" v={<span className={`obs-pill ${neg.result === 'agree' ? 'obs-pill-ok' : 'obs-pill-err'}`}>{NEGOTIATION_LABELS[neg.result] || neg.result}</span>} />
                    <KV k="协商轮次" v={`${neg.rounds} 轮`} />
                </div>
            ) : <span className="obs-sig-none">本任务无协商记录</span>}
            {notif ? (
                <div className="obs-biz-kv-grid obs-biz-kv-grid-gap">
                    <KV k="通知主题" v={NOTIFICATION_LABELS[notif.topic] || notif.topic} />
                    <KV k="通知次数" v={`${notif.count} 次`} />
                </div>
            ) : <span className="obs-sig-none">{neg ? '本任务无通知上报' : '本任务无通知记录'}</span>}
        </Block>
    );
}

/** Token 用量：按智能体 × 模型汇总输入/输出，并以条形展示占比。 */
function TokensBlock({ task }) {
    const tokens = task.tokens || [];
    const [byModel, setByModel] = useState('all');
    const models = [...new Set(tokens.map((t) => t.model))];
    const rows = tokens.filter((t) => byModel === 'all' || t.model === byModel);
    const sum = (list, type) => list.filter((t) => t.tokenType === type).reduce((a, t) => a + t.tokens, 0);
    const totalIn = sum(rows, 'input');
    const totalOut = sum(rows, 'output');
    const grand = totalIn + totalOut;
    const byAgent = {};
    for (const t of rows) {
        const key = t.agent;
        byAgent[key] = byAgent[key] || { input: 0, output: 0, models: new Set() };
        byAgent[key][t.tokenType] += t.tokens;
        byAgent[key].models.add(t.model);
    }
    const agents = Object.entries(byAgent)
        .map(([agent, v]) => [agent, { ...v, models: [...v.models].sort() }])
        .sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output));
    const maxAgent = Math.max(1, ...agents.map(([, v]) => v.input + v.output));

    return (
        <Block title="Token 用量" note="按智能体统计的大模型调用开销（输入 / 输出）">
            {tokens.length === 0 ? <span className="obs-sig-none">本任务无 Token 记录</span> : (
                <>
                    <div className="obs-biz-token-summary">
                        <span className="obs-biz-token-num">输入 <b>{totalIn.toLocaleString()}</b></span>
                        <span className="obs-biz-token-num">输出 <b>{totalOut.toLocaleString()}</b></span>
                        <span className="obs-biz-token-num">合计 <b>{grand.toLocaleString()}</b></span>
                        {models.length > 1 && (
                            <span className="obs-biz-token-filter">
                                <select className="obs-prom-input" value={byModel} onChange={(e) => setByModel(e.target.value)} aria-label="按模型筛选">
                                    <option value="all">全部模型（{models.length}）</option>
                                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                                </select>
                            </span>
                        )}
                    </div>
                    <table className="obs-biz-table">
                        <thead>
                            <tr><th>智能体</th><th>模型</th><th>输入</th><th>输出</th><th>合计</th><th className="obs-biz-bar-col">输入 / 输出占比</th></tr>
                        </thead>
                        <tbody>
                            {agents.map(([agent, v]) => {
                                const sumA = v.input + v.output;
                                const inPct = sumA ? (v.input / sumA) * 100 : 0;
                                const outPct = 100 - inPct;
                                return (
                                    <tr key={agent}>
                                        <td>{AGENT_LABELS[agent] || agent}</td>
                                        <td className="obs-biz-model">{v.models.join(' · ')}</td>
                                        <td>{v.input.toLocaleString()}</td>
                                        <td>{v.output.toLocaleString()}</td>
                                        <td>{sumA.toLocaleString()}</td>
                                        <td className="obs-biz-bar-col">
                                            <span
                                                className="obs-biz-bar-track obs-biz-bar-split"
                                                title={`占总量 ${grand ? Math.round((sumA / grand) * 100) : 0}% · 输入 ${inPct.toFixed(0)}% / 输出 ${outPct.toFixed(0)}%`}
                                            >
                                                <span className="obs-biz-bar obs-biz-bar-in" style={{ width: `${(v.input / maxAgent) * 100}%` }} />
                                                <span className="obs-biz-bar obs-biz-bar-out" style={{ width: `${(v.output / maxAgent) * 100}%` }} />
                                            </span>
                                            <span className="obs-biz-bar-pct">{inPct.toFixed(0)} / {outPct.toFixed(0)}</span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    <div className="obs-panel-note">占比条宽度按各智能体总量对齐；数字为该智能体内 输入 / 输出 的百分比</div>
                </>
            )}
        </Block>
    );
}

/**
 * 业务观测视图：从业务结果（而非原始信号）角度审视一次协作任务。
 * 与 TaskDetailView（原始观测信号）并列，由任务列表的「查看业务观测」进入。
 */
export function BusinessObservationView({ task, onBack, loading = false, error = null }) {
    const wf = task.workflow || {};
    const steps = task.steps || [];
    const failedSteps = steps.filter((s) => s.status === 'error').length;
    const tokens = task.tokens || [];
    const tokenTotal = tokens.reduce((a, t) => a + t.tokens, 0);
    const ready = task && !task._summary;

    const kpis = [
        { label: '总耗时', value: fmtMs(task.durationMs) },
        { label: '执行步骤', value: `${steps.length} 步${failedSteps ? ` · ${failedSteps} 步失败` : ''}` },
        { label: '参与智能体', value: `${(task.agents || []).length} 个` },
        { label: 'Token 合计', value: tokenTotal.toLocaleString() },
        { label: '工作流结果', value: <StatusPill status={wf.status || task.status} /> },
    ];

    return (
        <div className="obs-body">
            <div className="obs-detail-head">
                <button type="button" className="obs-btn" onClick={onBack}><span>‹ 返回列表</span></button>
                <div className="obs-detail-title">
                    <span className="obs-task-name">{task.title}</span>
                    <span className="obs-task-meta">
                        业务观测 · {task.runId} · {task.taskId} · 开始 {fmtTime(task.startedAt)}（{fmtAgo(task.startedAt)}）· 总耗时 {fmtMs(task.durationMs)}
                    </span>
                </div>
                <StatusPill status={task.status} />
            </div>

            {loading && (
                <div className="obs-panel obs-detail-state" role="status">
                    <span className="obs-panel-note">正在加载该运行的工作流 / Trace / 指标…</span>
                </div>
            )}
            {!loading && error && (
                <div className="obs-panel obs-detail-state obs-detail-state-error" role="alert">
                    <div className="obs-panel-title"><span>无法加载该运行的业务观测数据</span></div>
                    <p className="obs-panel-note">{error}</p>
                </div>
            )}

            {!loading && !error && ready && (
            <>
            <div className="obs-biz-kpis">
                {kpis.map((k) => (
                    <div key={k.label} className="obs-biz-kpi">
                        <span className="obs-biz-kpi-label">{k.label}</span>
                        <span className="obs-biz-kpi-value">{k.value}</span>
                    </div>
                ))}
            </div>

            <div className="obs-biz-grid">
                <WorkflowBlock task={task} />
                <CollaborationBlock task={task} />
            </div>
            <TokensBlock task={task} />
            </>
            )}
        </div>
    );
}
