// 选景执行器：读小剧场正文 → 选出一个瞬间 → 产出配图草稿。
//
// 这一步原本由 Cosmos Vision 的 preparePrompt 承担，但它交付的新公开接口只保留了
// 「LLM 管道」与「生图管道」，把语义层整个还给了调用方，于是选景回到本插件。
//
// 【上下文隔离：不可动摇】
// 本模块只允许使用调用方传进来的 theaterText / participants / specialRequest / previousScenes。
// 严禁 getContextData()、getChatHistory()、世界书等任何「读当前聊天」的接口 ——
// 从 A 聊天打开收藏来配图时，那些接口会把当前 B 聊天的角色卡与人设悄悄注进提示词。
//
// 【提示词只写内容，不写风格】
// Cosmos 会把我们给的核心提示词插进用户预设模板，再追加质量词、前置 UC 词与 LoRA 触发词。
// 本插件若也写这些就是重复叠加，因此默认规范里明令禁止，用户改动规范时也应守住这条。

import { getExtData } from "../utils/storage.js";
import { resolveActiveBackendId } from "./illustrationBackends/registry.js";
import { getActiveConnection, sendChatRequestWithConnection } from "./connection.js";
import { extractJsonObject } from "./llmJson.js";
import { buildIllustrationMessages } from "./illustrationPresets.js";
import { applyVariableMacros, beginVariableSandbox } from "./stVariables.js";
import { illustrationError, normalizeIllustrationDraft, sanitizeIllustrationExcerpt } from "./illustrationData.js";

const RETRY_NUDGE = "上一条回复不是合法的 JSON。请只输出那个 JSON 对象本身，不要任何解释文字或代码围栏。";

/**
 * 把模型回复解析成配图草稿。
 * @param {string} raw 模型原始回复
 * @param {string} theaterText 用于校验原文摘录
 * @param {string} [backendId] 这次草稿交给哪个生图后端；缺省为默认后端
 * @returns {object} 规范化后的草稿
 */
export function draftFromSceneReply(raw, theaterText, backendId = "cosmos") {
    const parsed = extractJsonObject(raw);
    if (!parsed) throw illustrationError("模型没有返回可解析的画面信息，请重试或换一个模型。", "INVALID_RESPONSE");
    if (String(parsed.error || "").trim() === "NO_SCENE") {
        throw illustrationError("这段正文里没有找到适合落笔的画面，可以补充人物资料或换个要求再试。", "NO_SCENE");
    }

    const scene = {
        summary: parsed.summary,
        ...(typeof parsed.sourceExcerpt === "string" && parsed.sourceExcerpt.trim()
            ? { sourceExcerpt: parsed.sourceExcerpt.trim() }
            : {}),
    };
    // characters 用小剧场自己的字段名，兼容模型直接按 Cosmos 口径返回 characterPrompts 的情况。
    const characters = Array.isArray(parsed.characters) ? parsed.characters
        : Array.isArray(parsed.characterPrompts) ? parsed.characterPrompts : [];

    const draft = normalizeIllustrationDraft({
        version: 2,
        // 草稿记下这次交给哪个后端。提示词本身是后端无关的（只有内容、没有风格），
        // 所以换个后端重画不必重新选景。
        backend: backendId,
        scene,
        prompts: {
            positivePrompt: parsed.positivePrompt,
            negativePrompt: parsed.negativePrompt ?? "",
            characterPrompts: characters.map(character => ({
                positivePrompt: character?.positivePrompt ?? "",
                negativePrompt: character?.negativePrompt ?? "",
                position: character?.position ?? { x: 0.5, y: 0.5 },
            })),
        },
    });
    // 摘录对不上时只是丢掉它，不废掉整次选景（见 sanitizeIllustrationExcerpt）。
    const hasExcerpt = Boolean(draft.scene.sourceExcerpt);
    const sanitized = sanitizeIllustrationExcerpt(draft, theaterText);
    // 区分「模型给了但对不上」与「模型压根没给」：面板上两者都表现为没有摘录行，
    // 不明说一句的话，用户只会以为这个功能坏了。
    // ⚠ 这个键不在草稿 DTO 里 —— normalizeIllustrationDraft 不产出它，落盘时会被白名单
    //   丢掉，它只是给本次界面用的一次性信号。
    if (hasExcerpt && !sanitized.scene.sourceExcerpt) sanitized.excerptDropped = true;
    return sanitized;
}

/**
 * 构造选景消息。
 *
 * 预设里的 STscript 变量宏（setvar / getvar 等）要真的求值，否则拿变量当组装草稿纸的
 * 预设整份都是死的。写入类宏会真的改 ST 的变量存储并触发落盘，所以整次构建包在沙箱里：
 * 构建前快照、构建后还原。求值结果与 ST 完全一致，被丢弃的只是「构建过程顺手改了你
 * 聊天变量」这个副作用。
 *
 * 沙箱覆盖抛错路径（缺预设、缺 {{theater_text}} 都会在构建中途抛出），所以放 finally。
 * 全程同步 —— 中间一旦 await，外部就可能观察到临时改动。
 */
function buildMessages(request, data) {
    const restoreVariables = beginVariableSandbox();
    try {
        return buildIllustrationMessages(request, data, applyVariableMacros);
    } finally {
        restoreVariables();
    }
}

/**
 * 运行一次选景。
 * @param {object} request theaterText / participants / specialRequest / previousScenes
 * @param {object} [options] signal / onProgress / spec
 * @returns {Promise<object>} 配图草稿
 */
export async function selectIllustrationScene(request, options = {}) {
    const theaterText = String(request?.theaterText || "").trim();
    if (!theaterText) throw illustrationError("正文为空，无法选择画面。", "NO_CONTENT");

    const conn = getActiveConnection();
    if (!conn) throw illustrationError("请先在设置里配置 API 方案。", "LLM_NOT_CONFIGURED");

    // 消息按当前生效的选景预设构造；预设里没有 {{theater_text}} 时这里会先抛错，
    // 不会拿一份没有正文的提示词去出图并计费。
    const data = getExtData();
    // 盖的是**当前设置**选中的后端：草稿一旦落盘就固定下来，之后换设置不会改旧记录。
    const backendId = resolveActiveBackendId(data);
    const messages = buildMessages(request, data);
    const send = extra => sendChatRequestWithConnection(conn, extra, {
        signal: options.signal,
        maxTokens: 2048,
        // 选景是结构化任务，温度低于创作类请求以提高 JSON 合规率。
        temperature: 0.6,
        stream: false,
    });

    let raw = await send(messages);
    try {
        return draftFromSceneReply(raw, theaterText, backendId);
    } catch (error) {
        // 只有「格式坏了」值得重发一次：NO_SCENE 是有效结论，直接抛给用户看明白。
        // （摘录对不上已经不算失败了，见 sanitizeIllustrationExcerpt。）
        if (error?.code !== "INVALID_RESPONSE" || options.signal?.aborted) throw error;
        raw = await send([...messages, { role: "user", content: RETRY_NUDGE }]);
        return draftFromSceneReply(raw, theaterText, backendId);
    }
}
