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
// ── 为什么用独立注入键 ──
// 和 PACING_PROMPT_KEY 分开（各占 extension_prompts 一格），两者能并存、互不覆盖。
//
// ── 为什么不静态 import storyOutlineWindow ──
// 那是 3800 行的大模块。本模块开机即加载（要挂事件），若静态引它，懒加载就白费了。
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

async function onGenerationEnded() {
    if (running) return;
    if (!isDirectorActive()) {
        // 激活方案不是盲盒（或已暂停/解封）：确保没有残留注入挂着。
        if (armed) clearDirectorDirective();
        return;
    }
    running = true;
    try {
        const mod = await import("../ui/storyOutlineWindow.js");
        if (typeof mod.runDirectorTurn === "function") await mod.runDirectorTurn();
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
        // 换聊天：清掉上一个聊天的引导，别带进新聊天的第一条回复。
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (armed) clearDirectorDirective();
        });
    }
    TitaniaLogger.info("盲盒导演注入已初始化");
}
