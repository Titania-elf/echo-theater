// 外部生图后端注册表。
//
// 本插件不自己实现生图，而是把草稿交给用户装的外部插件去画。这里登记「有哪些后端」
// 以及「当前用哪个」。加一个新后端 = 写一个适配文件 + 在 ADAPTERS 里加一项，
// 选景、存储、界面主链路都不用动。
//
// 纯模块：不 import 酒馆宿主、不碰设置存储（只操作传进来的普通对象），
// 这样测试夹具能直接加载它。

import { baibaiBackend } from "./baibai.js";
import { cosmosBackend } from "./cosmos.js";

/** 一个后端都探测不到时的能力集：界面据此把对不上的控件收起来。 */
export const EMPTY_CAPABILITIES = Object.freeze({
    characterPrompts: false,
    characterPositions: false,
    characterNegative: false,
    negativePrompt: false,
    size: false,
    batch: false,
    streamPreview: false,
});

/** 没有配置过时用哪个后端。 */
export const DEFAULT_BACKEND_ID = "cosmos";

/**
 * 探测状态 → 插件的错误码。
 * legacy 与 unsupported 都是「对方接口不对」，与「压根没装」分开报，用户能照着做。
 */
export function statusToErrorCode(status) {
    return status === "legacy" || status === "unsupported" ? "UNSUPPORTED_API" : "NOT_READY";
}

// ⚠ 这里的 id 必须与 illustrationData.js 的 ILLUSTRATION_BACKEND_IDS 完全一致（有测试盯着）：
//   那边是读路径的校验白名单，漏了一个就会出现「选得出、存得下、读不回」的草稿。
const ADAPTERS = new Map([cosmosBackend, baibaiBackend].map(adapter => [adapter.id, adapter]));

export function listIllustrationBackends() { return [...ADAPTERS.values()]; }
export function listIllustrationBackendIds() { return [...ADAPTERS.keys()]; }
export function getIllustrationBackend(id) { return ADAPTERS.get(String(id ?? "")) || null; }

/**
 * 订阅「有后端就绪」。任何一个已注册后端广播就绪事件都会触发 handler。
 * 返回退订函数；没有 window（不该发生）时给一个空操作，免得调用方还要判空。
 */
export function subscribeBackendReady(handler) {
    const target = globalThis.window;
    if (!target?.addEventListener) return () => { };
    const events = listIllustrationBackends().flatMap(adapter => adapter.readyEvents || []);
    for (const name of events) target.addEventListener(name, handler);
    return () => { for (const name of events) target.removeEventListener(name, handler); };
}

export const ILLUSTRATION_BACKEND_KEY = "illustration_backend";
const ILLUSTRATION_BACKEND_VERSION = 1;

/** 当前选中的后端 id；没设过或认不出来（比如那个后端被下架了）就回落默认值。 */
export function resolveActiveBackendId(data) {
    const id = data?.[ILLUSTRATION_BACKEND_KEY]?.active_id;
    return ADAPTERS.has(id) ? id : DEFAULT_BACKEND_ID;
}

/**
 * 规范化「当前后端」的设置项。与其它 ensure* 同款：幂等，返回「有没有改动」。
 * 由 utils/storage.js 的 getExtData() 调用；读取端也会防御性自调一次
 * （测试夹具会把 storage 整块替换掉，不能假设一定跑过）。
 */
export function ensureIllustrationBackend(data) {
    if (!data || typeof data !== "object") return false;
    const current = data[ILLUSTRATION_BACKEND_KEY];
    if (current && current.version === ILLUSTRATION_BACKEND_VERSION && ADAPTERS.has(current.active_id)) return false;
    data[ILLUSTRATION_BACKEND_KEY] = {
        version: ILLUSTRATION_BACKEND_VERSION,
        active_id: resolveActiveBackendId(data),
    };
    return true;
}
