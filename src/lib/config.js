/**
 * 运行时配置入口 —— 所有可随环境变化的东西都从这里读取，代码里不硬编码任何地址。
 *
 * 覆盖方式（优先级从高到低）：
 *   1. URL 查询参数        ?obsApi=https://host  &obsInsecure=1
 *   2. 全局变量            window.__OPENAN_OBS_API__ = { baseUrl, insecure, timeoutMs, limit }
 *   3. 构建期注入          window.__OPENAN_OBS_DATA_URL__（旧：指向静态 JSON 的地址）
 *   4. 内置默认值          见 DEFAULTS
 *
 * 部署到新环境时只需在门户侧注入全局变量或改查询参数，无需重新构建插件。
 */

const DEFAULTS = {
    baseUrl: '',
    insecure: false,      // 自签名证书时跳过校验（浏览器端无法真正跳过，仅用于提示；Node/脚本可用）
    timeoutMs: 20000,
    listLimit: 50,
};

function trimSlash(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function readQueryOverrides() {
    if (typeof window === 'undefined' || !window.location) return {};
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return {}; }
    const out = {};
    const api = params.get('obsApi');
    if (api) out.baseUrl = trimSlash(api);
    if (params.get('obsInsecure') === '1') out.insecure = true;
    const limit = Number(params.get('obsLimit'));
    if (Number.isFinite(limit) && limit > 0) out.listLimit = Math.min(limit, 100);
    return out;
}

function readGlobalOverrides() {
    if (typeof window === 'undefined') return {};
    const g = window.__OPENAN_OBS_API__;
    if (!g || typeof g !== 'object') return {};
    const out = {};
    if (typeof g.baseUrl === 'string' && g.baseUrl.trim()) out.baseUrl = trimSlash(g.baseUrl);
    if (g.insecure === true) out.insecure = true;
    if (Number.isFinite(Number(g.timeoutMs)) && Number(g.timeoutMs) > 0) out.timeoutMs = Number(g.timeoutMs);
    if (Number.isFinite(Number(g.limit)) && Number(g.limit) > 0) out.listLimit = Math.min(Number(g.limit), 100);
    return out;
}

/** 解析后的运行时配置（每次调用重新计算，便于测试与热更新）。 */
export function getObsConfig() {
    const cfg = { ...DEFAULTS, ...readGlobalOverrides(), ...readQueryOverrides() };
    // 兼容旧的全局：__OPENAN_OBS_DATA_URL__ 若指向的是一个 base（以 / 结尾或无 .json），也当作 API base
    if (!cfg.baseUrl && typeof window !== 'undefined') {
        const legacy = window.__OPENAN_OBS_DATA_URL__;
        if (typeof legacy === 'string' && legacy.trim()) {
            const url = trimSlash(legacy);
            if (!/\.json(\?|$)/i.test(url)) cfg.baseUrl = url;
        }
    }
    return cfg;
}

/** 查询服务是否已配置。未配置时插件回退到内置模拟数据。 */
export function isObsApiConfigured() {
    return getObsConfig().baseUrl !== '';
}
