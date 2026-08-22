// src/core/workshopApi.js
//
// 回声工坊接口封装。
// 投稿/编辑/删除都在网页端做（那些接口要 cookie，跨域带不了），
// 插件这边只读：拉列表、拉详情、上报下载量。

/** 工坊站点地址。换域名只需要改这一行 */
export const WORKSHOP_ORIGIN = "https://echo-workshop.pages.dev";

/** 列表缓存时长。工坊的 /api/list 自带 5 分钟边缘缓存，这里只是少发几次请求 */
const LIST_TTL = 60000;

/** 网络超时。SillyTavern 跑在本机，连不上 pages.dev 是常见情况，不能让请求一直挂着 */
const TIMEOUT = 15000;

const cache = { list: null, at: 0 };

async function req(path, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

    let res;
    try {
        res = await fetch(WORKSHOP_ORIGIN + path, {
            // 公开读接口不需要身份，显式不带 cookie
            credentials: "omit",
            signal: ctrl.signal,
            headers: options.body ? { "Content-Type": "application/json" } : {},
            ...options
        });
    } catch (e) {
        if (e.name === "AbortError") throw new Error("连接工坊超时，请检查网络");
        throw new Error("无法连接工坊，请检查网络");
    } finally {
        clearTimeout(timer);
    }

    let data = null;
    try {
        data = await res.json();
    } catch { /* 非 JSON 响应，走下面的兜底 */ }

    if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
    return data;
}

/**
 * 拉取公开索引。返回的条目不含 prompt，要下载得再调 fetchScript。
 * @param {{force?: boolean}} options
 */
export async function fetchList({ force = false } = {}) {
    if (!force && cache.list && Date.now() - cache.at < LIST_TTL) return cache.list;
    const data = await req("/api/list");
    cache.list = data;
    cache.at = Date.now();
    return data;
}

export function invalidateList() {
    cache.list = null;
}

/** 拉取单条详情，含 prompt */
export function fetchScript(id) {
    return req(`/api/script/${encodeURIComponent(id)}`);
}

/** 拉取单条投稿的公开评论，插件端只读展示。 */
export function fetchComments(id) {
    return req(`/api/script/${encodeURIComponent(id)}/comments`);
}

/**
 * 批量上报下载量。失败无所谓，计数不是关键路径。
 *
 * 接口刻意做成批量的（见 workshop/functions/api/downloads.js 的注释：
 * 一次点击一个请求会最先撞穿 Workers 的 10 万/天配额），所以批量下载
 * 必须把整批 id 合成一个请求，不要循环调 countDownload。
 *
 * @param {string[]} ids
 */
export function countDownloads(ids) {
    const list = (Array.isArray(ids) ? ids : []).filter(Boolean);
    if (list.length === 0) return Promise.resolve();
    return req("/api/downloads", {
        method: "POST",
        body: JSON.stringify({ ids: list })
    }).catch(() => { });
}

/** 上报单条下载量 */
export function countDownload(id) {
    return countDownloads([id]);
}
