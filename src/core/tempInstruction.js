// src/core/tempInstruction.js
//
// 「临时指令」（界面文案叫「本次补充」）—— 叠在已选定剧本之上、只对本次生成生效的补充。
//
// 为什么单独成模块、而且零 import
// ------------------------------
// 它要同时被两处读：core 层的 api.js（两个提示词组装点必须看到同一份值），
// 和 ui 层的顶栏（输入条 / 已生效提示条）。塞进 GlobalState 会让 ui 依赖 core 的
// 内部结构，放进 ui/mainWindow/viewState.js 又会让 core 反向依赖 ui
// （api.js 已经 import 了 ui/mainWindow.js，那种异味不宜再加一条）。
// 零 import 还带来一个实在好处：tests/ 的 vm 夹具可以零桩直接加载它。
//
// ── 两条不能破的约束（改这里之前先读完）──────────────────────────
//
// 1. 这个块必须作为 user 串**末尾的独立一段**、拼在 [剧本指令] 块之后，
//    绝不能并进 processedPrompt。续写口径下 applyScriptInstructionSectionLengths
//    （api.js:597-611）要求 continuationPreamble+Context+Instruction **恰好等于**
//    promptBody.length 才肯拆三段，并进正文会让求和立刻对不上、**静默**退回单段计数 ——
//    提示词查看器里续写的三段拆分就此消失，且不报错、不留痕。
//    所以 sectionLengths.tempInstruction 单独计数，debugWindow.js 的 definitions
//    里它排在 continuationInstruction 之后（顺序 = user 串的拼接顺序）。
//
// 2. 选用预设模式下，api.js 拼出来的整条 user 串**根本不会被注入**：
//    buildPromptMessageDetails 的 contentByEntry 以 `${generationMode}_user` 为键，
//    而预设条目的 id 是 st_* / custom_* / titania_*，永远不等于 preset_user。
//    预设模式下剧本正文的唯一通道是 {{titaniaScript}} 标记，所以 api.js 还必须把它
//    并进 runtimePromptContext.titaniaScript。只改 user 的话，预设模式用户会
//    100% 静默看不到这段补充。
//
// ── 只对本次生成生效，靠什么保证 ──
// 不落盘、不写回 script.prompt。已生效的快照是模块级的一个对象，且**记着它属于哪个
// 剧本**（scriptId）—— 换了剧本、或翻到别的剧本的稿子上续写，getActiveTempInstruction
// 直接返回空串。这条 scriptId 比对是唯一的守卫，不需要额外的清除逻辑兜底。

/** 块表头。查看器里的分段标签也用它（debugWindow.js 的 definitions）。 */
export const TEMP_INSTRUCTION_HEADER = "[本次补充要求]";

const HINT_CREATE = "（在上述剧本基础上，本次创作额外遵循以下要求；与上文冲突时以本节为准）";
// 主动续写时剧本正文根本不在提示词里（composeContinuationPromptOverride 整份替换了
// 它，续写包只有 [续写模式] + [续写会话上下文] + [本轮续写指令]），
// 所以任何"在上述剧本基础上"的说法都是假的，必须换掉这半句。
const HINT_CONTINUATION = "（在本次续写要求之外，本次创作额外遵循以下要求；与上文冲突时以本节为准）";

/**
 * 哪些生成来源允许携带临时指令。
 *
 * `generationSource` 由 api.js 算出：`generationOverrides?.source || (silent ? "queue" : "manual")`。
 * 队列批量（api.js executeQueueGeneration）与 ST 事件自动演绎（entry.js）都传 silent=true
 * → 都是 "queue"，一处判掉即可；主动续写显式传 "user_continuation"。
 *
 * ⚠ 别改用"有没有待演绎剧本（pending）"来做判据：pending 在演绎发起前就被清空了，
 *   用它判会把正常的首轮演绎也挡掉。
 *
 * @param {string} source
 * @returns {boolean}
 */
export function isTempInstructionGenerationSource(source) {
    return source === "manual" || source === "user_continuation";
}

/**
 * 组装临时指令块。
 *
 * 返回串的尾部**没有**多余空白，使 `block.length` 与它在 user 串末尾实际占用的长度
 * 逐字符相等 —— 提示词查看器按累计长度连续切片，差一个字符后面就全错位。
 *
 * @param {string} text 原文；空或纯空白 → 返回 ""（不产出空段）
 * @param {{ continuation?: boolean }} [options] 续写口径换措辞
 * @returns {string}
 */
export function buildTempInstructionBlock(text, options = {}) {
    const body = String(text ?? "").trim();
    if (!body) return "";
    const hint = options?.continuation === true ? HINT_CONTINUATION : HINT_CREATE;
    // 前缀 \n\n：scriptBlock 末尾没有换行，靠它把补充段与剧本正文分开。
    return `\n\n${TEMP_INSTRUCTION_HEADER}\n${hint}\n${body}`;
}

/* ------------------------------------------------------------------ *
 * 运行时状态（模块级，刻意不落盘）
 *
 * draft —— 输入框里的内容（未生效）
 * active —— 已生效快照 { scriptId, text }，记着它属于哪个剧本
 * ------------------------------------------------------------------ */

let draft = "";
let active = null;

export function getTempInstructionDraft() {
    return draft;
}

export function setTempInstructionDraft(text) {
    draft = String(text ?? "").trim();
    return draft;
}

/**
 * 取已生效的临时指令。
 * @param {string} scriptId 当前生成/续写针对的剧本
 * @returns {string} 不属于该剧本则 ""
 */
export function getActiveTempInstruction(scriptId) {
    if (!active) return "";
    return active.scriptId === String(scriptId || "") ? active.text : "";
}

export function hasActiveTempInstruction(scriptId) {
    return getActiveTempInstruction(scriptId) !== "";
}

/** 已生效快照属于哪个剧本；没有快照时 ""。撤销要拿它把"待演绎"重新架回去。 */
export function getActiveTempInstructionScriptId() {
    return active ? active.scriptId : "";
}

/**
 * 首轮演绎（或重演）发起时把草稿快照成"已生效"，并清空草稿。
 *
 * 清空草稿就是需求里的"用完自动清空"；快照则负责让随后从这一稿发起的主动续写
 * 继续带上它。重演时草稿通常已是空的 → 快照被置空，正好等于"重新演绎丢弃快照"，
 * 不需要为它单开一条分支。
 *
 * @param {string} scriptId
 * @returns {string} 本次生效的文本（无则 ""）
 */
export function consumeTempInstruction(scriptId) {
    const id = String(scriptId || "");
    const text = draft.trim();
    draft = "";
    active = text && id ? { scriptId: id, text } : null;
    return active ? active.text : "";
}

/**
 * 取出并清除已生效快照（撤销用）。
 * @returns {{ scriptId: string, text: string }|null}
 */
export function takeActiveTempInstruction() {
    const taken = active;
    active = null;
    return taken;
}

export function clearActiveTempInstruction() {
    active = null;
}

/** 草稿与快照一起清掉（换剧本用）。 */
export function clearTempInstruction() {
    draft = "";
    active = null;
}
