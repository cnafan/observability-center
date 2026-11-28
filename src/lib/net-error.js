/**
 * 把浏览器的网络错误翻译成可操作的原因。
 * 浏览器出于安全考虑只给 "Failed to fetch" / "NetworkError"，不区分证书、跨域还是不可达，
 * 所以这里按最可能的顺序列出原因，而不是假装知道是哪一个。
 */

/** 返回建议列表（可能为空）。 */
export function explainNetworkError(message) {
    const m = String(message || '');
    const hints = [];
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
        hints.push('浏览器未能建立连接。按可能性排查：');
        hints.push('① 查询服务的 HTTPS 证书无效或已过期 —— 浏览器强制校验，前端无法绕过；请在浏览器地址栏直接打开该服务地址确认，并联系服务端续签证书');
        hints.push('② 跨域（CORS）未放行当前门户来源');
        hints.push('③ 查询服务不可达，或部署期配置 runtime-config.json 里的地址有误');
    }
    if (/aborted|超时/i.test(m)) hints.push('请求超时：查询服务响应过慢，或该运行的数据量过大。');
    if (/HTTP 404/i.test(m)) hints.push('该 runId 在查询服务中不存在（可能已被清理）。');
    if (/HTTP 5\d\d/i.test(m)) hints.push('查询服务或其前置网关异常，请稍后重试或联系服务维护者。');
    return hints;
}

/** 一句话版本，用于标题行。 */
export function summarizeNetworkError(message) {
    const m = String(message || '');
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) {
        return '无法连接查询服务（常见原因：服务证书无效或已过期、跨域未放行、地址不可达）';
    }
    return m;
}
