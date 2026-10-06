// 柏宝绘（ST-BaiBai-Image）适配器：把配图草稿交给它的公开接口出图。
//
// 这是全插件唯一接触 globalThis.STBaiBaiImage 的地方。
// 对外文档：https://github.com/baibai-git/ST-BaiBai-Image 的 PUBLIC_API.md（API v1）。
//
// 与 Cosmos 的四处关键差异，都在这里消化掉：
//   - 回的是 dataUrl 字符串，不是 Blob（要解码，见 dataUrlToBlob）
//   - 一次只出一张，没有 count 参数
//   - 人物位置硬编码在画面中心，调用方改不了
//   - NAI 下 negative 会被忽略（用它自己渠道的负向词）
//
// ⚠ 不调用它的 getCharacters()。它的角色库按「当前聊天」作用域，在 B 聊天给 A 聊天的
//   收藏配图时会返回 B 的角色 —— 那正是本插件跨聊天隔离铁律要挡的东西。
//   人物外观仍由插件自己的 character_profiles 维护。

import { MAX_IMAGE_BYTES } from "../illustrationData.js";
import { dataUrlToBlob } from "../imageBytes.js";

/** 它广播「我准备好了」的事件名。changed 也订阅：后端配置变化会影响 configured 与能力。 */
const READY_EVENTS = ["st-baibai-image:ready", "st-baibai-image:changed"];

const PROVIDER_LABELS = { nai: "NovelAI", comfyui: "ComfyUI" };

/**
 * 从它的后端状态推导能力。
 *
 * 注意 supportsCharacters 只看模型（NAI 4.5/V5 为 true，**ComfyUI 恒为 false**），
 * 与用户配没配齐无关 —— 所以它可以在还没填 Key 时就告诉我们要不要准备 characters。
 */
function deriveCapabilities(status) {
    return Object.freeze({
        characterPrompts: status?.supportsCharacters === true,
        // 它把每个角色提示词的位置硬编码成画面中心（nai.ts 里 centers: [{x:0.5,y:0.5}]），
        // 调用方没有任何办法指定。位置仍然留在草稿里，切回 Cosmos 就能用。
        characterPositions: false,
        // characters[] 只有 {name, tag, nl}，没有逐角色负向词。
        characterNegative: false,
        // NAI 忽略 negative（用它自己渠道配置的负向词）；只有 ComfyUI 会填进工作流。
        negativePrompt: status?.backend === "comfyui",
        size: true,
        // 一次一张，没有 count 参数。
        batch: false,
        streamPreview: false,
    });
}

/**
 * 探测柏宝绘是否可用。不抛。
 * @returns {{ready:boolean,status:string,reason:string,capabilities?:object,detail?:object}}
 */
function probe() {
    const api = globalThis.window?.STBaiBaiImage;
    if (!api) return { ready: false, status: "missing", reason: "未检测到柏宝绘，请安装并启用该扩展。" };
    // apiVersion 是它**公开数据结构**的版本，与插件版本分开，且承诺只增不改不删。
    // 按它判兼容，不要去解析 pluginVersion 的语义。
    if (Number(api.apiVersion) !== 1) {
        const seen = api.apiVersion === undefined ? "未知" : String(api.apiVersion);
        return { ready: false, status: "legacy", reason: `柏宝绘的公开接口版本是 ${seen}，本插件只认 1，请升级柏宝绘。` };
    }
    if (typeof api.generate !== "function") {
        return { ready: false, status: "unsupported", reason: "柏宝绘没有提供生图接口。" };
    }

    let status;
    try {
        status = api.getBackendStatus();
    } catch {
        // 它可能还在初始化。当成「没配置好」而不是「接口不对」——用户重开会话即可。
        return { ready: false, status: "not_configured", reason: "柏宝绘还没有就绪，请稍后在它的设置里检查出图后端。" };
    }
    if (!status || typeof status !== "object") {
        return { ready: false, status: "unsupported", reason: "柏宝绘没有返回后端状态。" };
    }

    const detail = { provider: status.backend, model: status.model };
    const capabilities = deriveCapabilities(status);
    if (status.configured !== true) {
        // reason 是它给的人话，可直接展示。
        const reason = typeof status.reason === "string" && status.reason.trim()
            ? status.reason.trim()
            : "柏宝绘还没有配置好出图后端，请先在它的设置里完成配置。";
        return { ready: false, status: "not_configured", reason, capabilities, detail };
    }
    const provider = PROVIDER_LABELS[status.backend] || status.backend || "未知后端";
    const model = typeof status.model === "string" && status.model.trim() ? ` · ${status.model.trim()}` : "";
    return { ready: true, status: "ready", reason: `柏宝绘已连接（${provider}${model}）。`, capabilities, detail };
}

/**
 * 草稿的人物提示词 → 柏宝绘的 characters。
 *
 * ⚠ name 必须非空：它的 normalizeCharacters 会把 name 或 tag 为空的项**直接丢掉**。
 *   但 name 只作标识、**不进提示词**（nai.ts 的 characterCaption 只用 tag 与 nl），
 *   所以这里用合成名字是安全的，不会去查它的角色库 —— 跨聊天泄漏的口子在这一点上不成立。
 * nl 省略即可：它会归一成空串，caption 回落到只用 tag。
 *
 * 草稿里标着 1girl/1boy 的计数词不用管：它会自动转成 girl/boy（character prompt 需要的是单数主体）。
 */
function buildCharacters(characterPrompts) {
    if (!Array.isArray(characterPrompts)) return [];
    return characterPrompts
        .filter(character => typeof character?.positivePrompt === "string" && character.positivePrompt.trim())
        .map((character, index) => ({ name: `角色${index + 1}`, tag: character.positivePrompt.trim() }));
}

/** 把它的进度阶段折成插件的 fraction。队列与保存阶段没有可用的分母，就不报百分比。 */
function progressFraction(progress) {
    const max = Number(progress?.max);
    const attempt = Number(progress?.attempt);
    return Number.isFinite(max) && max > 0 && Number.isFinite(attempt)
        ? Math.min(1, Math.max(0, attempt / max))
        : undefined;
}

const ERROR_MAP = {
    not_configured: ["NOT_READY", "柏宝绘还没有配置好出图后端"],
    invalid_args: ["INVALID_ARGS", "柏宝绘拒绝了这次请求"],
    rate_limited: ["RATE_LIMITED", "柏宝绘请求过于频繁或额度不足，请稍后重试"],
    backend_error: ["GENERATION_FAILED", ""],
};

/**
 * 把柏宝绘的错误翻成插件的 code。
 *
 * **只按 error.code 分支** —— 它的文档明说 message 是给人看的中文、会随版本改，
 * 也不能用 instanceof（跨插件 bundle 边界一律失效）。message 原文照留，只是不拿它做判断。
 */
function translateError(error) {
    const code = typeof error?.code === "string" ? error.code : "";
    // 取消由门面统一识别，这里不重复处理 —— 但它的 aborted 要先认出来。
    if (code === "aborted") return Object.assign(new Error("配图任务已取消。"), { name: "AbortError", code: "ABORTED" });
    const [pluginCode, lead] = ERROR_MAP[code] || ["GENERATION_FAILED", ""];
    const detail = typeof error?.message === "string" && error.message.trim() ? error.message.trim() : "";
    const message = lead && detail ? `${lead}（${detail}）` : lead || detail || "柏宝绘生成失败，请重试。";
    return Object.assign(new Error(message), { code: pluginCode });
}

/**
 * 出图。只回原始字节（这里负责把 dataUrl 解码成 Blob），
 * 嗅探、校验、入库一律由门面统一处理。
 * @returns {Promise<{blobs:Blob[],seed?:*,applied:{characters:boolean}}>}
 */
async function generate(draft, options = {}) {
    const api = globalThis.window?.STBaiBaiImage;
    if (typeof api?.generate !== "function") {
        throw Object.assign(new Error("柏宝绘尚未就绪。"), { code: "NOT_READY" });
    }

    const characters = buildCharacters(draft.prompts.characterPrompts);
    const request = {
        prompt: draft.prompts.positivePrompt,
        // NAI 下它会忽略这个字段；照发即可，切到 ComfyUI 时就有用。
        negative: draft.prompts.negativePrompt,
        // ⚠ 必须显式传 false：它的默认是 true，会把图也存进它自己的图库。
        //   本插件的收藏、备份与图文导出都依赖自己的 /user/files 存储，不要两份。
        save: false,
    };
    if (characters.length) request.characters = characters;
    if (options.size) request.size = options.size;
    if (options.seed !== undefined && options.seed !== null && Number.isFinite(Number(options.seed))) {
        request.seed = Number(options.seed);
    }

    let result;
    try {
        result = await api.generate(request, {
            signal: options.signal,
            onProgress: progress => {
                if (options.signal?.aborted) return;
                try { options.onProgress?.({ stage: "generating", fraction: progressFraction(progress) }); } catch { /* 回调异常不能让供应方重复请求。 */ }
            },
        });
    } catch (error) {
        throw translateError(error);
    }

    let blob;
    try {
        // 先按 base64 长度算解码后大小再动手，跑飞的超大图不会先分配出一大块内存。
        blob = dataUrlToBlob(result?.dataUrl, { maxBytes: MAX_IMAGE_BYTES });
    } catch (error) {
        throw Object.assign(new Error(error?.message || "柏宝绘没有返回图片。"), { code: "GENERATION_FAILED" });
    }

    return {
        blobs: [blob],
        seed: result?.seed,
        // 不推断：它明说这次到底用上没有。传了 characters 但这里是 false = 被丢弃了
        //（通常用户在用 ComfyUI），界面要如实告诉用户。
        applied: { characters: result?.charactersApplied === true },
    };
}

export const baibaiBackend = {
    id: "baibai",
    label: "柏宝绘",
    readyEvents: READY_EVENTS,
    probe,
    generate,
};
