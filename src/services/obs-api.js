/**
 * Observability Workflow Query Service —— 纯 HTTP 客户端。
 *
 * 只认 baseUrl（由 lib/config.js 提供），不包含任何环境信息。
 * 所有方法返回解析后的 JSON；HTTP 错误与非 2xx 抛 ApiError。
 */

export class ApiError extends Error {
    constructor(message, { status, path, cause } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status ?? null;
        this.path = path ?? null;
        this.cause = cause ?? null;
    }
}

/** 把相对路径拼到 baseUrl 后，保证只有一个斜杠。 */
export function joinUrl(baseUrl, path) {
    return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
}

async function request(baseUrl, path, { method = 'GET', body, timeoutMs = 20000, fetchImpl, signal } = {}) {
    // baseUrl 允许为空字符串 = 与门户同源（走门户 nginx 反代）；只有 null/undefined/非字符串才算未配置。
    if (baseUrl === null || baseUrl === undefined || typeof baseUrl !== 'string') {
        throw new ApiError('查询服务地址未配置（baseUrl 不是字符串）', { path });
    }
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new ApiError('当前环境没有 fetch', { path });

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const onOuterAbort = () => controller && controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort);

    try {
        const res = await doFetch(joinUrl(baseUrl, path), {
            method,
            signal: controller ? controller.signal : undefined,
            headers: body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        if (text) {
            try { json = JSON.parse(text); } catch {
                throw new ApiError(`响应不是合法 JSON（HTTP ${res.status}）`, { status: res.status, path });
            }
        }
        if (!res.ok) {
            const detail = json && (json.message || json.error || json.detail);
            throw new ApiError(`HTTP ${res.status}${detail ? `：${detail}` : ''}`, { status: res.status, path });
        }
        return json;
    } catch (e) {
        if (e instanceof ApiError) throw e;
        if (e && e.name === 'AbortError') throw new ApiError('请求超时或已取消', { path, cause: e });
        // 浏览器对证书错误/网络失败只给 "Failed to fetch"，这里保留原始信息便于定位
        throw new ApiError(`无法连接查询服务：${e && e.message ? e.message : String(e)}`, { path, cause: e });
    } finally {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
}

/** OTLP AnyValue → 普通 JS 值。 */
export function anyValue(v) {
    if (v == null) return null;
    if (typeof v !== 'object') return v;
    if ('stringValue' in v) return v.stringValue;
    if ('intValue' in v) return Number(v.intValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('boolValue' in v) return v.boolValue;
    if (Array.isArray(v.arrayValue?.values)) return v.arrayValue.values.map(anyValue);
    if (v.kvlistValue?.values) return attrsToObject(v.kvlistValue.values);
    return v;
}

/** OTLP KeyValue[] → { key: value }。 */
export function attrsToObject(attrs) {
    const out = {};
    for (const a of attrs || []) {
        if (a && a.key != null) out[a.key] = anyValue(a.value);
    }
    return out;
}

export function createObsClient({ baseUrl = '', timeoutMs = 20000, fetchImpl } = {}) {
    // baseUrl: '' = 与门户同源（经门户 nginx 反代）；'https://host' = 直连查询服务
    return {
        baseUrl,
        health: (opts = {}) => request(baseUrl, '/api/observability/healthz', { timeoutMs, fetchImpl, ...opts }),

        /** Workflow 列表：{ items, nextCursor, aggregates, facets, meta, partial, sourceStatus } */
        listWorkflows: (query = {}, opts = {}) => request(baseUrl, '/api/v1/observability/workflows', {
            method: 'POST', timeoutMs, fetchImpl,
            body: { status: 'all', sort: 'startedAt', order: 'desc', limit: 50, ...query }, ...opts }),

        /** Workflow 详情：摘要 + PSOP 结构 */
        getWorkflow: (runId, opts = {}) => request(baseUrl, `/api/v1/observability/workflows/${encodeURIComponent(runId)}`, { timeoutMs, fetchImpl, ...opts }),

        /** Trace：{ resourceSpans: OTLP } */
        getTrace: (runId, opts = {}) => request(baseUrl, `/api/v1/observability/workflows/${encodeURIComponent(runId)}/trace`, {
            method: 'POST', timeoutMs, fetchImpl,
            body: { includeAttributes: true, includeEvents: true, includeLinks: true }, ...opts }),

        /** Log：{ items: OTLP LogRecord[], nextCursor, total } */
        getLogs: (runId, query = {}, opts = {}) => request(baseUrl, `/api/v1/observability/workflows/${encodeURIComponent(runId)}/logs`, {
            method: 'POST', timeoutMs, fetchImpl,
            body: { limit: 100, ...query }, ...opts }),

        /** Metric：{ collection, summary, signals, charts, partial, sourceStatus } */
        getMetrics: (runId, query = {}, opts = {}) => request(baseUrl, `/api/v1/observability/workflows/${encodeURIComponent(runId)}/metrics`, {
            method: 'POST', timeoutMs, fetchImpl,
            body: { windowMin: 5, step: '15s', ...query }, ...opts }),
    };
}
