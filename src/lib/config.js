/**
 * 运行时配置入口 —— 所有可随环境变化的东西都从这里读取，代码里不硬编码任何地址。
 *
 * 覆盖方式（优先级从高到低）：
 *   1. URL 查询参数        ?obsApi=https://host  &obsInsecure=1
 *   2. 全局变量            window.__OPENAN_OBS_API__ = { baseUrl, insecure, timeoutMs, limit }
 *   3. 部署期配置文件      plugins/observation-center/runtime-config.json 的 { obsApi: {...} }
 *                          —— 随插件部署、不打进 bundle；换环境只改这个文件（主要方式，见文件底部）
 *   4. 构建期注入          window.__OPENAN_OBS_DATA_URL__（旧：指向静态 JSON 的地址）
 *   5. 内置默认值          见 DEFAULTS
 *
 * 部署到新环境时替换 runtime-config.json（或在门户侧注入全局变量）即可，无需重新构建插件。
 */

const DEFAULTS = {
    enabled: false,       // 是否启用查询服务（false = 使用内置模拟数据）
    baseUrl: '',          // '' = 与门户同源，走门户 nginx 反代；非空 = 直连查询服务
    insecure: false,      // 自签名证书时跳过校验（浏览器端无法真正跳过，仅用于提示；Node/脚本可用）
    timeoutMs: 20000,
    listLimit: 50,
};

function trimSlash(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

/** 把某个来源的 {baseUrl, insecure, timeoutMs, limit} 规范化。
 *  enabled=true 的条件：来源里出现了 baseUrl 字段。
 *    - 纯空白 / 缺失        -> 不启用（视为未配置）
 *    - 空字符串 ''          -> 启用且同源（仅 allowEmptyBaseUrl 的来源：查询参数、全局变量、部署期配置文件）
 *    - 非空                 -> 启用并直连该地址 */
function normalize(src, { allowEmptyBaseUrl = false } = {}) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    const raw = Object.prototype.hasOwnProperty.call(src, 'baseUrl') && typeof src.baseUrl === 'string' ? src.baseUrl : null;
    const trimmed = raw === null ? null : raw.trim();
    // 仅"恰好是空字符串"才表示同源；纯空白是无效值，不能被当成同源启用
    if (raw !== null && raw.length === 0 && allowEmptyBaseUrl) {
        out.enabled = true;
        out.baseUrl = '';
    } else if (trimmed) {
        out.enabled = true;
        out.baseUrl = trimSlash(trimmed);
    } else if (src.enabled === true) {
        // 显式 enabled: true 且未给 baseUrl -> 同源
        out.enabled = true;
        out.baseUrl = '';
    }
    if (src.insecure === true) out.insecure = true;
    if (Number.isFinite(Number(src.timeoutMs)) && Number(src.timeoutMs) > 0) out.timeoutMs = Number(src.timeoutMs);
    if (Number.isFinite(Number(src.limit)) && Number(src.limit) > 0) out.listLimit = Math.min(Number(src.limit), 100);
    return out;
}

function readQueryOverrides() {
    if (typeof window === 'undefined' || !window.location) return {};
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return {}; }
    const src = {};
    if (params.has('obsApi')) src.baseUrl = params.get('obsApi');     // ?obsApi= （空值）= 同源反代
    if (params.get('obsInsecure') === '1') src.insecure = true;
    if (params.has('obsLimit')) src.limit = Number(params.get('obsLimit'));
    return normalize(src, { allowEmptyBaseUrl: true });
}

function readGlobalOverrides() {
    if (typeof window === 'undefined') return {};
    return normalize(window.__OPENAN_OBS_API__, { allowEmptyBaseUrl: true });
}

function readRuntimeFileOverrides() {
    // 由 loadRuntimeConfig() 异步填充；未加载或文件不存在时为空
    return normalize(globalThis.__OPENAN_OBS_RUNTIME__, { allowEmptyBaseUrl: true });
}

/** 解析后的运行时配置（每次调用重新计算，便于测试与热更新）。 */
export function getObsConfig() {
    const cfg = {
        ...DEFAULTS,
        ...readRuntimeFileOverrides(),   // 部署期配置文件：环境级默认值
        ...readGlobalOverrides(),        // 全局变量可覆盖配置文件
        ...readQueryOverrides(),         // 查询参数优先级最高（便于临时联调）
    };
    // 兼容旧的全局：__OPENAN_OBS_DATA_URL__ 若指向的是一个 base（以 / 结尾或无 .json），也当作 API base
    if (!cfg.enabled && typeof window !== 'undefined') {
        const legacy = window.__OPENAN_OBS_DATA_URL__;
        if (typeof legacy === 'string' && legacy.trim()) {
            const url = trimSlash(legacy);
            if (!/\.json(\?|$)/i.test(url)) { cfg.enabled = true; cfg.baseUrl = url; }
        }
    }
    return cfg;
}

/** 查询服务是否已配置。未配置时插件回退到内置模拟数据。 */
export function isObsApiConfigured() {
    return getObsConfig().enabled === true;
}

/* ------------------------- 部署期配置文件（不参与构建） -------------------------
 * plugins/observation-center/runtime-config.json 随插件产物一起部署，但不打进 bundle。
 * 换环境只改这个文件，代码与构建产物都不变 —— 这是地址解耦的主要方式。
 *
 *   { "obsApi": { "baseUrl": "https://<query-service-host>", "timeoutMs": 20000, "limit": 50 } }
 *
 * 文件不存在（404）是正常情况：表示该环境未接入查询服务，使用模拟数据。
 * */

const RUNTIME_CONFIG_URL = '/plugins/observation-center/runtime-config.json';
let runtimeConfigPromise = null;

async function fetchRuntimeConfig(fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch || typeof document === 'undefined') return {};
    // 用插件脚本自身的地址推导配置文件路径，避免写死 /plugins/... 前缀
    let url = RUNTIME_CONFIG_URL;
    try {
        const me = [...document.scripts].find((s) => /observation-center\/index\.js/.test(s.src));
        if (me) url = new URL('runtime-config.json', me.src).href;
    } catch { /* 回退到默认路径 */ }
    const res = await doFetch(url, { cache: 'no-store' });
    if (!res.ok) return {};                       // 404 = 未接入，静默回退
    const data = await res.json();
    return data && typeof data.obsApi === 'object' && data.obsApi ? data.obsApi : {};
}

/** 加载一次部署期配置；结果缓存在模块级。 */
export function loadRuntimeConfig(fetchImpl) {
    if (!runtimeConfigPromise) {
        runtimeConfigPromise = fetchRuntimeConfig(fetchImpl)
            .catch(() => ({}))
            .then((cfg) => { globalThis.__OPENAN_OBS_RUNTIME__ = cfg; return cfg; });
    }
    return runtimeConfigPromise;
}
