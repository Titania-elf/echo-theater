// STscript 变量宏：选景与主提示词构建共用的求值层。
//
// 酒馆预设常拿变量当「组装草稿纸」：前段条目逐条 {{setvar::writingstyle::…}} 写入命名块，
// 后段条目再 {{getvar::writingstyle}} 取回来拼装；同一个变量可能有多条互斥候选
// （三种文风各一条），靠启用/停用挑一条。没有这一层，这类预设发出去的就是字面量。
//
// 【只跑变量宏，不跑全套宏】刻意不走 substituteParamsExtended —— 那会连带展开
// {{char}} / {{user}} / {{description}} / {{persona}} 等角色卡环境宏，全部读**当前聊天**。
// 选景这条链路要的是「预设自己写的变量」，不是「当前聊天是谁」，所以只用 ST 导出的
// getVariableMacros() 那 10 条变量宏。
//
// 也刻意不手写那 10 条正则：addvar 是拼接还是加法、incvar 的边界、索引参数这些语义
// 手写必错，复用 ST 的实现才能跟着它一起演进（同一个理由见 promptManager 的旧注释）。

import { getVariableMacros } from "../../../variables.js";

/**
 * 求值文本里的 STscript 变量宏。
 *
 * 写入宏（setvar / addvar / incvar / decvar 及 global 版）会真的改
 * chat_metadata.variables，并触发 setLocalVariable 结尾的 saveMetadataDebounced()
 * 落盘（ST variables.js:79）。所以调用方**必须**用 beginVariableSandbox() 包住整次求值。
 *
 * @param {string} text
 * @returns {string} 求值后的文本；失败时原样返回，不让一次坏变量打断整次构建
 */
export function applyVariableMacros(text) {
    const source = String(text ?? "");
    // 绝大多数条目没有宏，省掉一轮正则扫描。
    if (!source.includes("{{")) return source;
    try {
        let out = source;
        // getVariableMacros() 每次返回新构造的正则对象，不共享 lastIndex 状态。
        for (const macro of getVariableMacros()) out = out.replace(macro.regex, macro.replace);
        return out;
    } catch (e) {
        console.warn("Titania: 变量宏求值失败，保留原文", e);
        return source;
    }
}

/**
 * 变量沙箱：整次提示词构建前后给 ST 的变量存储拍快照、构建完成后还原。
 *
 * 为什么需要：{{setvar::}} 会真的写 chat_metadata.variables 并落盘。很多预设拿变量当
 * 「提示词组装草稿纸」，一次构建就写进几十个通用名变量（content、summary、language、
 * speed、thinking…），极易与主对话自己的变量撞名。
 *
 * 关键点：还原发生在构建**完成之后**，所以展开结果与 ST 完全一致，被丢弃的只是构建
 * 过程中的记账副作用。推论：求值段必须**同步** —— 中间一旦 await，外部就可能观察到
 * 临时改动。
 *
 * @param {object} [options]
 * @param {boolean} [options.persist=false] true 则完全不介入，写入照常落盘。
 *   主提示词构建把它接在用户设置上；选景链路用默认值 —— 生成一张插画不该改写你
 *   当前聊天的变量。
 * @returns {() => void} 还原函数（persist 时是空操作）
 */
export function beginVariableSandbox({ persist = false } = {}) {
    if (persist) return () => {};

    let ctx = null;
    try {
        ctx = typeof SillyTavern !== "undefined" ? SillyTavern.getContext?.() : null;
    } catch {
        return () => {};
    }
    if (!ctx) return () => {};

    // ctx.chatMetadata / ctx.extensionSettings 就是 chat_metadata / extension_settings 本体，
    // 所以直接改它们的属性等价于改 ST 的存储，无需额外 import。
    const chatMetadata = ctx.chatMetadata;
    const extensionSettings = ctx.extensionSettings;
    const localSnapshot = chatMetadata && typeof chatMetadata.variables === "object" && chatMetadata.variables
        ? { ...chatMetadata.variables }
        : null;
    const globalStore = extensionSettings?.variables;
    const globalSnapshot = globalStore && typeof globalStore.global === "object" && globalStore.global
        ? { ...globalStore.global }
        : null;

    return () => {
        try {
            if (chatMetadata && localSnapshot) chatMetadata.variables = localSnapshot;
            if (globalStore && globalSnapshot) globalStore.global = globalSnapshot;
        } catch (e) {
            console.warn("Titania: 变量沙箱还原失败", e);
        }
    };
}
