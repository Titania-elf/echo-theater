// API 封装 + 列表内存缓存

const cache = { list: null, at: 0 };
const LIST_TTL = 60_000;

async function req(path, options = {}) {
    const res = await fetch(path, {
        credentials: "same-origin",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        ...options
    });

    let data = null;
    try {
        data = await res.json();
    } catch { /* 非 JSON 响应，走下面的兜底 */ }

    if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
    return data;
}

export async function fetchList({ force = false } = {}) {
    if (!force && cache.list && Date.now() - cache.at < LIST_TTL) return cache.list;
    const data = await req("/api/list");
    cache.list = data;
    cache.at = Date.now();
    return data;
}

export const invalidateList = () => { cache.list = null; };

export const fetchScript = id => req(`/api/script/${encodeURIComponent(id)}`);

export const fetchAuthor = id => req(`/api/author/${encodeURIComponent(id)}`);

export const fetchCategories = () => req("/api/categories");

export const whoami = () => req("/api/auth/me");
export const logout = () => req("/api/auth/logout", { method: "POST" });

export const myScripts = () => req("/api/my/scripts");

export const createScript = payload =>
    req("/api/my/scripts", { method: "POST", body: JSON.stringify(payload) });

export const updateScript = (id, payload) =>
    req(`/api/my/script/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) });

export const deleteScript = id =>
    req(`/api/my/script/${encodeURIComponent(id)}`, { method: "DELETE" });

export const restoreScript = id =>
    req(`/api/my/script/${encodeURIComponent(id)}`, { method: "POST" });

/** 删除：不可恢复，会从「我的投稿」里消失 */
export const purgeScript = id =>
    req(`/api/my/script/${encodeURIComponent(id)}?purge=1`, { method: "DELETE" });

export const report = (scriptId, reason) =>
    req("/api/report", { method: "POST", body: JSON.stringify({ script_id: scriptId, reason }) });

// ── 管理员通道 ──
// 权限在服务端按登录身份判定，这里只是普通的同源请求

export const adminAuthors = () => req("/api/admin/authors");

export const adminUpload = payload =>
    req("/api/admin/scripts", { method: "POST", body: JSON.stringify(payload) });
