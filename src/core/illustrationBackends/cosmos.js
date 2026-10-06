// Cosmos Vision 适配器：把配图草稿交给 Cosmos 的公开接口出图。
//
// 这是全插件唯一接触 window.CosmosVision 的地方。选景已回归插件自有 LLM
// （见 illustrationScene.js），本模块只负责「拿提示词换图片」。
//
// 接口形状（dev 分支交付的薄接口）：{ version, generateImage }，
// 没有 getCapabilities / preparePrompt / generate，也没有 imageSource、model、
// count、stage 进度。图源与模型由 Cosmos 自己的设置决定，调用方不可覆盖。

import { newIllustrationId } from "../illustrationData.js";

/**
 * Cosmos 没有能力协商接口，所以一律报「全支持」，以完整保留今天的界面行为。
 *
 * ⚠ 这里有一处已知的不实：Cosmos 在 ComfyUI 下会静默忽略 characterPrompts 与人物位置
 *   （见 docs/小剧场-场景配图.md 的对接约定）。它没有查询接口，我们探测不到。
 *   一律报 false 会把 NAI 下本来好用的位置编辑器也一起藏掉，那更坏 —— 维持现状，
 *   并把这处不实写明在文档的已知限制里。
 */
const CAPABILITIES = Object.freeze({
    characterPrompts: true,
    characterPositions: true,
    characterNegative: true,
    negativePrompt: true,
    size: false,
    batch: true,
    streamPreview: true,
});

/**
 * 探测 Cosmos Vision 是否可用。按方法存在性判断，不看版本号 ——
 * version 是 Cosmos 的插件版本（当前 1.3.0），拿它做兼容性判断会随对方发版误判。
 * @returns {{ready:boolean,status:string,reason:string,capabilities?:object}} 本函数不抛
 */
function probe() {
    const api = globalThis.window?.CosmosVision;
    if (!api) return { ready: false, status: "missing", reason: "未检测到 Cosmos Vision，请安装并启用该扩展。" };
    if (typeof api.generateImage !== "function") {
        // 旧版（v1 契约）只有 preparePrompt/generate，给一句能照着做的提示。
        if (typeof api.preparePrompt === "function" || api.apiVersion) {
            return { ready: false, status: "legacy", reason: "检测到旧版 Cosmos Vision 接口，请升级到提供 generateImage 的版本。" };
        }
        return { ready: false, status: "unsupported", reason: "Cosmos Vision 没有提供生图接口。" };
    }
    return { ready: true, status: "ready", reason: "Cosmos Vision 已连接。", capabilities: CAPABILITIES };
}

/**
 * 出图。只回原始字节，嗅探、校验、入库一律由门面统一处理（所有后端共用一条路径）。
 * @param {object} draft 已规范化的 v2 草稿
 * @param {object} [options] signal / onProgress / onStreamPreview
 * @returns {Promise<{blobs:Blob[]}>}
 */
async function generate(draft, options = {}) {
    const api = globalThis.window?.CosmosVision;
    if (typeof api?.generateImage !== "function") {
        // 门面在调用前已查过就绪，这里是防手滑的兜底：宁可报清楚，也别抛 TypeError。
        const state = probe();
        throw Object.assign(new Error(state.reason), { code: "NOT_READY" });
    }
    const result = await api.generateImage({
        // 只给「画面里有什么」。质量词、UC 词、画风预设与 LoRA 触发词由 Cosmos 追加，
        // 这里再写一遍就会重复叠加 —— v1 需求与联调清单都点名过这条。
        prompts: {
            positivePrompt: draft.prompts.positivePrompt,
            negativePrompt: draft.prompts.negativePrompt,
            characterPrompts: draft.prompts.characterPrompts,
        },
        requestId: newIllustrationId(),
        signal: options.signal,
        // 每次调用各有独立回调闭包，事件不会串任务，所以不做 requestId 过滤
        // （Cosmos 缺省会自增 requestId，硬比会误伤合法事件）。
        onProgress: progress => {
            if (options.signal?.aborted) return;
            const max = Number(progress?.max);
            const value = Number(progress?.value);
            const fraction = Number.isFinite(max) && max > 0 && Number.isFinite(value)
                ? Math.min(1, Math.max(0, value / max))
                : undefined;
            try { options.onProgress?.({ stage: "generating", fraction }); } catch { /* 回调异常不能让供应方重复请求。 */ }
        },
        onStreamPreview: event => {
            if (options.signal?.aborted) return;
            try { options.onStreamPreview?.({ blob: event?.previewBlob, isFinal: Boolean(event?.isFinal) }); } catch { /* 同上。 */ }
        },
    });
    return { blobs: Array.isArray(result?.imageBlobs) ? result.imageBlobs : [] };
}

export const cosmosBackend = {
    id: "cosmos",
    label: "Cosmos Vision",
    // 它准备好的广播事件。界面订阅所有后端的这一份，任何一个就绪都会重新探测。
    readyEvents: ["cosmos-vision:api-ready"],
    probe,
    generate,
};
