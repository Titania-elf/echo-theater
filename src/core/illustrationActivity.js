// 配图任务的进行态通道：配图面板 → 主界面那个浮动按钮。
//
// 为什么需要它：面板的 session 是私有的，主界面那份绑定只认识「已存下来的记录」，
// 而任务**可以在面板关掉之后继续跑**（这是既有的明确语义）。没有这条通道，
// 关窗后台生成时界面上就没有任何反馈 —— 用户只能干等。
//
// 纯传输，不做状态推导：「进行态 + 图 + 错误 → 按钮该显示成什么样」的判断在
// illustrationBadge.js 里。这里只负责搬运，所以能脱离 DOM 单测。
//
// 跨模块通信用 window CustomEvent，沿用插件既有的 titania:* 惯例
// （见 illustrationStore.js 的 titania:illustrations-changed）。

export const ILLUSTRATION_ACTIVITY_EVENT = "titania:illustration-activity";

/**
 * 任务阶段。
 * - `idle` 没有进行中的任务（写入它会清除记录）
 * - `error` 任务失败。它不会自己过期 —— 由下一次任务或采用图片覆盖
 */
export const ILLUSTRATION_ACTIVITY_PHASES = Object.freeze(["selecting", "generating", "saving", "error", "idle"]);

/** sceneId -> { sceneId, phase, message, at }。只记当前正在跑或刚失败的那些，不落盘。 */
const activities = new Map();

/**
 * 写入某个场景的进行态并广播。
 *
 * 没有 sceneId 就什么都不做：那表示「还没有可归属的一轮」，写进去只会污染 Map，
 * 而按钮本来就是隐藏的。
 *
 * @param {string} sceneId
 * @param {"selecting"|"generating"|"saving"|"error"|"idle"} phase
 * @param {string} [message] 可直接展示的中文进度文案
 */
export function setIllustrationActivity(sceneId, phase, message = "") {
    const key = String(sceneId || "");
    if (!key) return;
    const text = String(message || "");
    if (phase === "idle") activities.delete(key);
    else activities.set(key, { sceneId: key, phase, message: text, at: Date.now() });
    // idle 也要广播：监听方靠它把按钮收回去。
    if (globalThis.window?.dispatchEvent) {
        window.dispatchEvent(new CustomEvent(ILLUSTRATION_ACTIVITY_EVENT, { detail: { sceneId: key, phase, message: text } }));
    }
}

/** 任务结束（成功或取消）时清掉。等价于写入 idle。 */
export function clearIllustrationActivity(sceneId) {
    setIllustrationActivity(sceneId, "idle");
}

/** @returns {{sceneId:string,phase:string,message:string,at:number}|null} */
export function getIllustrationActivity(sceneId) {
    return activities.get(String(sceneId || "")) || null;
}

/**
 * 订阅进行态变化。返回退订函数。
 * 事件不带 sceneId 过滤 —— 监听方自己比对当前场景，因为它换轮次比事件更频繁。
 */
export function subscribeIllustrationActivity(handler) {
    const target = globalThis.window;
    if (!target?.addEventListener) return () => { };
    target.addEventListener(ILLUSTRATION_ACTIVITY_EVENT, handler);
    return () => target.removeEventListener(ILLUSTRATION_ACTIVITY_EVENT, handler);
}
