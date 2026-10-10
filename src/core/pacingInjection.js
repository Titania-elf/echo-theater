// src/core/pacingInjection.js
//
// 「叙事节奏把控」的一次性注入生命周期。
//
// 它只做一件事：把一条节奏指令塞进 ST **原生回复**的提示词、让它只对下一条回复生效、
// 回复完就清掉。判断"该写什么指令"在 storyOutlineWindow.js（headless），这里只管注入。
//
// ── 为什么用 setExtensionPrompt 而不是 chatInjector ──
// chatInjector 往聊天里加一条真实 narrator 消息，会**永久留痕**并进入之后每次提示词；
// 节奏指令是一次性的、不该当成在世界内的发言。setExtensionPrompt 是 ST 原生的临时注入
// （script.js:8866，按 extension_prompt_types.IN_CHAT 的深度插进提示词），不落聊天记录，
// 用完置空即移除——正好对上"只影响本次这一条回复"。
//
// ── 一次性靠什么保证 ──
// arm 后置 armed 标志；监听 GENERATION_ENDED，一旦有生成结束就清掉并解除武装。
// 插件自己的小剧场生成走 api.js 的自有链路、不经 ST Generate()，不会 emit 这个事件
// （全库只监听、从不 emit GENERATION_*），所以这里只会被 ST 原生回复触发——
// 也就是我们想影响的那一条。换聊天（CHAT_CHANGED）也解除，别把 A 聊天的指令带进 B。

import {
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    eventSource,
    event_types,
} from "../../../../script.js";
import { TitaniaLogger } from "./logger.js";

/** 注入键。ST 用它作 extension_prompts 的下标，置空串即移除。 */
export const PACING_PROMPT_KEY = "TITANIA_PACING";

/** 注入内容的表头——让写作模型一眼认出这是节奏提示，而非剧情正文。 */
const DIRECTIVE_HEADER = "【叙事节奏提示】\n";

const ROLE_NAME_TO_ENUM = {
    system: extension_prompt_roles.SYSTEM,
    user: extension_prompt_roles.USER,
    assistant: extension_prompt_roles.ASSISTANT,
};

let listenersBound = false;
/** 已武装的指令状态（模块级，刻意不落盘：一次性，不该跨会话留存）。 */
let armed = false;
let armedSummary = "";
let armedDepth = 0;
let armedRole = "system";

function normalizeRole(role) {
    const name = String(role || "system").toLowerCase();
    return name in ROLE_NAME_TO_ENUM ? name : "system";
}

function normalizeDepth(depth) {
    const n = Number(depth);
    if (!Number.isFinite(n) || n < 0) return 0;
    // ST 的 MAX_INJECTION_DEPTH 是 10000（script.js:499），夹在安全范围内。
    return Math.min(10000, Math.floor(n));
}

function briefSummary(text, maxLen = 40) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/**
 * 武装一条节奏指令：注入进 ST 原生回复的提示词，只待下一次生成消费。
 *
 * @param {string} text 指令正文（空/纯空白 → 等价于清除，返回 false）
 * @param {{ depth?: number, role?: string }} [options] 注入深度与角色（用户可调）
 * @returns {boolean} 是否成功武装
 */
export function armPacingDirective(text, options = {}) {
    const body = String(text || "").trim();
    if (!body) {
        clearPacingDirective();
        return false;
    }
    const roleName = normalizeRole(options.role);
    const depth = normalizeDepth(options.depth);
    setExtensionPrompt(
        PACING_PROMPT_KEY,
        DIRECTIVE_HEADER + body,
        extension_prompt_types.IN_CHAT,
        depth,
        false,
        ROLE_NAME_TO_ENUM[roleName]
    );
    armed = true;
    armedSummary = briefSummary(body);
    armedDepth = depth;
    armedRole = roleName;
    TitaniaLogger.info("节奏指令已武装", { depth, role: roleName });
    return true;
}

/** 置空注入并解除武装。空串即从 extension_prompts 移除实际文本。 */
export function clearPacingDirective() {
    setExtensionPrompt(PACING_PROMPT_KEY, "", extension_prompt_types.IN_CHAT, 0);
    armed = false;
    armedSummary = "";
}

/** 当前武装状态快照，供面板显示武装条。 */
export function getArmedPacing() {
    return { armed, summary: armedSummary, depth: armedDepth, role: armedRole };
}

/**
 * 注册一次性清除与换聊天解除。幂等——重复调用只刷新一次订阅。
 */
export function initPacingInjection() {
    if (listenersBound) return;
    listenersBound = true;

    // 开机清一次：extension_prompts 是运行时态，正常是空的，这里只为 HMR/重init 兜底。
    clearPacingDirective();

    // 一次性：任何 ST 原生生成结束都清掉已武装的指令。
    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (armed) clearPacingDirective();
    });
    // 换聊天解除，别把上一个聊天的节奏指令带过去。
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (armed) clearPacingDirective();
        });
    }

    TitaniaLogger.info("叙事节奏注入已初始化");
}
