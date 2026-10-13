// src/core/directorInjection.js
//
// 「盲盒导演」的实时注入与生命周期。和 pacingInjection 是姊妹件，但**生命周期相反**：
//
//   节奏把控：手动武装一次 → GENERATION_ENDED 后清掉（一次性）。
//   盲盒导演：每条原生回复结束 → 后台跑一次判定 → 刷新注入（持续挂着，不清），
//             直到下回合判定再覆盖它，或判定说"本回合不出手"时清掉。
//
// ── 为什么判定放在 GENERATION_ENDED 之后 ──
// 用户读完回复、正在打字的间隙，判定在后台跑完，下一条原生生成时引导已就位——延迟被藏掉。
// 判定走 storyOutlineWindow 的无头 API（插件自有链路，不 emit GENERATION_*，见
// plugin-never-emits-st-generation-events），所以这里的后台判定不会反过来触发自己。
//
// ── 为什么要触发签名（v2 新增）──
// ST 的 GENERATION_ENDED 其实是从 hideStopButton() 里发的（script.js），也就是说
// **凡是显示过停止按钮的生成都会发一次**：swipe、continue、impersonate，乃至总结插件
// 自己跑的 quiet 生成。v1 对每一次都跑一遍判定，同一段正文被判多次＝多掷几次骰，
// 事件自然越判越快。所以这里先算一个签名（末楼层下标 + swipe 下标 + 文本指纹）：
//   · 末楼层不是「可见的角色回复」（用户楼层 / 被总结插件隐藏的摘要楼层）→ 不判；
//   · 签名和上次判定时一样（impersonate 只写输入框、quiet 生成不改末楼层）→ 不判。
//
// ── 为什么用独立注入键 ──
// 和 PACING_PROMPT_KEY 分开（各占 extension_prompts 一格），两者能并存、互不覆盖。
//
// ── 为什么不静态 import storyOutlineWindow ──
// 那是 4000 行的大模块。本模块开机即加载（要挂事件），若静态引它，懒加载就白费了。
// 故 GENERATION_ENDED 里先用 extData 做一次**廉价判断**（有没有激活的、已封印、未暂停的
// 盲盒方案），只有命中才动态 import 大模块跑 runDirectorTurn。

import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    eventSource,
    event_types,
} from "../../../../script.js";
import { getExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";

export const DIRECTOR_PROMPT_KEY = "TITANIA_DIRECTOR";

const ROLE_NAME_TO_ENUM = {
    system: extension_prompt_roles.SYSTEM,
    user: extension_prompt_roles.USER,
    assistant: extension_prompt_roles.ASSISTANT,
};

// 与 storyOutlineWindow 保持一致的 extData 键（廉价判断用，勿各自改写一份）。
const PLANS_KEY = "story_outline_plans";
const ACTIVE_PLAN_KEY = "story_outline_active_plan_id";
const BLINDBOX_KIND = "blindbox";

let listenersBound = false;
let armed = false;
let running = false; // 判定进行中，防重入（上一拍没跑完又来一拍）
let lastSig = "";   // 上次判定过的触发签名（见文件头「触发签名」）

function normalizeRole(role) {
    const name = String(role || "system").toLowerCase();
    return name in ROLE_NAME_TO_ENUM ? name : "system";
}

function normalizeDepth(depth) {
    const n = Number(depth);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(10000, Math.floor(n));
}

/** 读注入参数（depth/role），缺省 depth=0 / role=system。 */
export function getDirectorInjectConfig() {
    const d = getExtData()?.director || {};
    const role = ["system", "user", "assistant"].includes(d.inject_role) ? d.inject_role : "system";
    const depthRaw = Number(d.inject_depth);
    const depth = Number.isFinite(depthRaw) && depthRaw >= 0 ? Math.floor(depthRaw) : 0;
    return { depth, role };
}

/** 武装/刷新一条导演引导：持续挂着，直到下回合覆盖或清除。空内容等价于清除。 */
export function armDirectorDirective(text, options = {}) {
    const body = String(text || "").trim();
    if (!body) {
        clearDirectorDirective();
        return false;
    }
    const roleName = normalizeRole(options.role);
    setExtensionPrompt(
        DIRECTOR_PROMPT_KEY,
        body,
        extension_prompt_types.IN_CHAT,
        normalizeDepth(options.depth),
        false,
        ROLE_NAME_TO_ENUM[roleName],
    );
    armed = true;
    return true;
}

/** 清除注入（置空串即从 extension_prompts 移除实际文本）。 */
export function clearDirectorDirective() {
    setExtensionPrompt(DIRECTOR_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 0);
    armed = false;
}

export function isDirectorArmed() {
    return armed;
}

/** 廉价判断：当前激活方案是不是一个"已封印、未解封、未暂停"的盲盒——够格跑导演。 */
function isDirectorActive() {
    try {
        const data = getExtData();
        const plans = Array.isArray(data?.[PLANS_KEY]) ? data[PLANS_KEY] : [];
        if (plans.length === 0) return false;
        const activeId = typeof data?.[ACTIVE_PLAN_KEY] === "string" ? data[ACTIVE_PLAN_KEY] : "";
        const plan = plans.find((p) => p?.id === activeId) || plans[0];
        if (!plan || plan.kind !== BLINDBOX_KIND) return false;
        const bb = plan.blindbox;
        return !!bb && bb.sealed === true && bb.unsealed !== true && bb.directorPaused !== true;
    } catch {
        return false;
    }
}

/** 末楼层文本指纹（32 位），只取尾部一截：改一个字就变，够用来识别 swipe/continue。 */
function fingerprint(text) {
    const s = String(text || "");
    const tail = s.length > 400 ? s.slice(-400) : s;
    let h = 2166136261;
    for (let i = 0; i < tail.length; i += 1) {
        h ^= tail.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/**
 * 本次触发的判定对象：末楼层是哪一楼、哪个 swipe、签名是什么。
 * eligible=false 表示这次 GENERATION_ENDED 不该触发判定（没有新的角色正文）。
 * 同时导出给 storyOutlineWindow：手动调 runDirectorTurn 时也要带上同一份上下文。
 */
export function getDirectorTrigger() {
    const none = { eligible: false, floor: -1, swipeId: "", sig: "" };
    try {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return none;
        const chat = SillyTavern.getContext()?.chat;
        if (!Array.isArray(chat) || chat.length === 0) return none;
        const floor = chat.length - 1;
        const msg = chat[floor];
        const text = typeof msg?.mes === "string" ? msg.mes.trim() : "";
        // 只有「可见的角色回复」算一拍：用户楼层不是，摘要/已隐藏楼层（is_system/is_hidden）也不是。
        const eligible = !!text && msg?.is_user !== true && msg?.is_system !== true && msg?.is_hidden !== true;
        const swipeId = Number.isFinite(Number(msg?.swipe_id)) ? String(Math.floor(Number(msg.swipe_id))) : "0";
        return {
            eligible,
            floor,
            swipeId,
            sig: `${chat.length}:${floor}:${swipeId}:${text.length}:${fingerprint(text)}`,
        };
    } catch {
        return none;
    }
}

async function onGenerationEnded() {
    if (running) return;
    if (!isDirectorActive()) {
        // 激活方案不是盲盒（或已暂停/解封）：确保没有残留注入挂着。
        if (armed) clearDirectorDirective();
        return;
    }
    const trigger = getDirectorTrigger();
    // 不是新的角色正文（impersonate 只写输入框、总结插件的 quiet 生成不改末楼层、
    // 或末楼层是用户/摘要楼层）：保留上一拍的引导，什么也别判。
    if (!trigger.eligible || !trigger.sig || trigger.sig === lastSig) return;
    lastSig = trigger.sig; // 先占住签名：同一拍里若又来一次事件，不会重复判
    running = true;
    try {
        const mod = await import("../ui/storyOutlineWindow.js");
        let turn = null;
        if (typeof mod.runDirectorTurn === "function") turn = await mod.runDirectorTurn(trigger);
        // 判定跑完了，但 ST 的渲染事件早在判定之前就发完了（判定要等一次 API 往返），所以
        // 横条上的进度与"刚解锁"的角标/音效都还停在旧状态。这里把结果交接给气泡模块去结账：
        //   音效在解锁那一刻响、角标点亮、面板若还开着就地刷新。
        // 动态 import 走的是模块缓存（entry.js 已静态加载过它），且不必让本模块静态依赖 UI 层。
        const planId = turn?.planId;
        if (planId) {
            const bubble = await import("../ui/sceneAdvanceBubble.js");
            if (typeof bubble.notifyBlindboxUnlocks === "function") await bubble.notifyBlindboxUnlocks(planId);
            // 心跳/流水：**没有新解锁也要刷**。notifyBlindboxUnlocks 在没有新解锁时直接 return，
            // 靠它刷不出来——而"这一拍没出手"恰恰是最需要看见的一拍（否则它与"没在跑"无异）。
            if (typeof bubble.refreshDirectorPanel === "function") bubble.refreshDirectorPanel();
        }
        // 判定没跑成时 runDirectorTurn 不抛错、而是回一个 failed 标记（它要把失败也记进流水）。
        // 这里补一条 WARN 留住排查线索——WARN 只进内存日志，查看器/调试报告里能看到。
        if (turn?.failed === "api") TitaniaLogger.warn("盲盒导演判定失败（已忽略，不打断对话）", turn.error);
        else if (turn?.failed === "parse") TitaniaLogger.warn("盲盒导演判定返回无法解析，本拍跳过（保留上一拍引导）");
    } catch (e) {
        TitaniaLogger.warn("盲盒导演判定失败（已忽略，不打断对话）", e);
    } finally {
        running = false;
    }
}

/** 注册生命周期。幂等。 */
export function initDirectorInjection() {
    if (listenersBound) return;
    listenersBound = true;
    clearDirectorDirective(); // 开机兜底清一次（HMR/重init）

    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    if (event_types.CHAT_CHANGED) {
        // 换聊天：清掉上一个聊天的引导，别带进新聊天的第一条回复；签名也要清，
        // 否则两个聊天的末楼层恰好同签名时会被误判成"已经判过了"。
        eventSource.on(event_types.CHAT_CHANGED, () => {
            lastSig = "";
            if (armed) clearDirectorDirective();
        });
    }
    TitaniaLogger.info("盲盒导演注入已初始化");
}
