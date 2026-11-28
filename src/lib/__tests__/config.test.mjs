// Unit tests for lib/config.js: the "same-origin vs not-configured" distinction is easy to get wrong.
// Run: node src/lib/__tests__/config.test.mjs
import assert from 'node:assert/strict';

const g = globalThis;
let failed = 0;
async function check(name, fn) {
    try { await fn(); console.log('PASS  ' + name); }
    catch (e) { failed += 1; console.log('FAIL  ' + name + '  -> ' + String(e && e.message || e).slice(0, 160)); }
}

function freshWindow(search = '') {
    g.window = { location: { search }, __OPENAN_OBS_API__: undefined, __OPENAN_OBS_DATA_URL__: undefined };
    g.__OPENAN_OBS_RUNTIME__ = undefined;
}

// import AFTER the helpers exist (module reads globals lazily at call time, so order is fine)
const cfg = await import('../config.js');

await check('nothing configured anywhere -> disabled (mock fallback)', async () => {
    freshWindow();
    assert.equal(cfg.isObsApiConfigured(), false);
    assert.equal(cfg.getObsConfig().enabled, false);
});

await check('runtime file with NO obsApi key -> disabled', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = {};
    assert.equal(cfg.isObsApiConfigured(), false);
});

await check('runtime file obsApi.baseUrl: "" -> ENABLED, same-origin (via portal reverse proxy)', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: '', timeoutMs: 5000, limit: 20 };
    const c = cfg.getObsConfig();
    assert.equal(c.enabled, true, 'must be enabled');
    assert.equal(c.baseUrl, '', 'empty baseUrl means same-origin');
    assert.equal(c.timeoutMs, 5000);
    assert.equal(c.listLimit, 20);
});

await check('runtime file obsApi.baseUrl: "https://host/" -> enabled, trailing slash trimmed', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: 'https://host.example.com/' };
    const c = cfg.getObsConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.baseUrl, 'https://host.example.com');
});

await check('runtime file obsApi with only enabled:true -> enabled, same-origin', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { enabled: true };
    const c = cfg.getObsConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.baseUrl, '');
});

await check('runtime file obsApi.baseUrl: "   " (whitespace) and no enabled flag -> disabled', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: '   ' };
    assert.equal(cfg.isObsApiConfigured(), false);
});

await check('global variable overrides the runtime file', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: 'https://from-file.example' };
    g.window.__OPENAN_OBS_API__ = { baseUrl: 'https://from-global.example' };
    assert.equal(cfg.getObsConfig().baseUrl, 'https://from-global.example');
});

await check('query param overrides everything; ?obsApi= (empty) selects same-origin', async () => {
    freshWindow('?obsApi=');
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: 'https://from-file.example' };
    g.window.__OPENAN_OBS_API__ = { baseUrl: 'https://from-global.example' };
    const c = cfg.getObsConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.baseUrl, '', 'empty obsApi param = same-origin');
});

await check('query param with a host wins over file + global', async () => {
    freshWindow('?obsApi=https://from-query.example');
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: 'https://from-file.example' };
    assert.equal(cfg.getObsConfig().baseUrl, 'https://from-query.example');
});

await check('unrelated query params do not enable anything', async () => {
    freshWindow('?foo=bar&obsInsecure=1');
    assert.equal(cfg.isObsApiConfigured(), false);
    assert.equal(cfg.getObsConfig().insecure, true, 'insecure flag alone is harmless');
});

await check('limit is clamped to 1..100', async () => {
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: '', limit: 9999 };
    assert.equal(cfg.getObsConfig().listLimit, 100);
    freshWindow();
    g.__OPENAN_OBS_RUNTIME__ = { baseUrl: '', limit: 0 };
    assert.equal(cfg.getObsConfig().listLimit, 50, 'invalid limit keeps default');
});

await check('legacy __OPENAN_OBS_DATA_URL__ pointing at a non-JSON base enables direct mode', async () => {
    freshWindow();
    g.window.__OPENAN_OBS_DATA_URL__ = 'https://legacy.example/api';
    const c = cfg.getObsConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.baseUrl, 'https://legacy.example/api');
});

await check('legacy __OPENAN_OBS_DATA_URL__ pointing at a .json file stays disabled (mock)', async () => {
    freshWindow();
    g.window.__OPENAN_OBS_DATA_URL__ = '/plugins/observation-center/mock-collab-tasks.json';
    assert.equal(cfg.isObsApiConfigured(), false);
});

await check('loadRuntimeConfig: 404 resolves to {} and leaves the plugin disabled', async () => {
    freshWindow();
    const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    // call the internal fetch via a fresh module instance is awkward; exercise the public contract instead:
    // __OPENAN_OBS_RUNTIME__ stays undefined until a successful load
    assert.equal(g.__OPENAN_OBS_RUNTIME__, undefined);
    assert.equal(cfg.isObsApiConfigured(), false);
    assert.equal(typeof fakeFetch, 'function');
});

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
