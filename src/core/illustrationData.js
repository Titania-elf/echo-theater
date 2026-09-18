// 配图 DTO 与纯数据操作；不依赖酒馆或 Cosmos 私有模块。
export const ILLUSTRATION_INDEX_KEY = "illustration_index";
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const SOURCES = new Set(["novelai", "comfyui"]);
const MIME_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function illustrationError(message, code = "INVALID_RESPONSE") {
    return Object.assign(new Error(message), { code });
}

export function newIllustrationId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// 两路独立散列 + 长度用于内容版本定位；不作密码学用途。HTTP 手机访问也可用。
export function illustrationHash(value) {
    const text = String(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${text.length.toString(16)}`;
}

export function createIllustrationTarget(result, fallbackId = "") {
    const content = String(result?.content ?? result?.html ?? "").trim();
    if (!content || result?.status === "running" || result?.status === "failed") {
        throw illustrationError("请先选择一段已完成的小剧场内容。", "NO_CONTENT");
    }
    const identity = String(result.generationId || fallbackId);
    if (!identity) throw illustrationError("这段内容缺少保存标识，请重新打开后再试。", "NO_CONTENT");
    return Object.freeze({
        sceneId: `scene-${illustrationHash(JSON.stringify([identity, result.scriptId || "", content]))}`,
        content,
        scriptId: String(result.scriptId || ""),
        scriptName: String(result.scriptName || "场景"),
        generationId: String(result.generationId || ""),
    });
}

/** 收藏跟随正在查看的生成结果；重演后翻回旧分支时不能误存活动分支。 */
export function resolveDisplayedFavoriteBranch(result, active, archived = []) {
    const matches = round => result?.generationId
        ? round?.generationId === result.generationId
        : String(round?.content || "").trim() === String(result?.content || "").trim();
    const source = [active, ...archived].find(branch => branch?.rounds?.some(matches));
    return source ? { ...active, ...source } : { ...active, branchKey: "", rounds: [] };
}

function requireText(value, label, allowEmpty = false) {
    if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
        throw illustrationError(`${label}缺失或格式错误。`);
    }
    return value.trim();
}

export function normalizeIllustrationDraft(value, theaterText) {
    if (value?.version !== 1 || !SOURCES.has(value.imageSource)) throw illustrationError("配图草稿版本或图像来源不受支持。");
    const sourceExcerpt = requireText(value.scene?.sourceExcerpt, "画面原文");
    if (typeof theaterText === "string" && !theaterText.includes(sourceExcerpt)) {
        throw illustrationError("选景原文与当前剧场不一致，请重新分析画面。");
    }
    if (!Array.isArray(value.prompts?.characterPrompts)) throw illustrationError("人物提示词应为数组。");
    const characterPrompts = value.prompts.characterPrompts.map(character => {
        const { x, y } = character?.position || {};
        if (![x, y].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) {
            throw illustrationError("人物位置应在 0–1 之间。");
        }
        return {
            positivePrompt: requireText(character.positivePrompt, "人物正向提示词", true),
            negativePrompt: requireText(character.negativePrompt, "人物负向提示词", true),
            position: { x, y },
        };
    });
    return {
        version: 1,
        imageSource: value.imageSource,
        model: requireText(value.model, "模型标识"),
        scene: { summary: requireText(value.scene.summary, "画面描述"), sourceExcerpt },
        prompts: {
            positivePrompt: requireText(value.prompts.positivePrompt, "正向提示词"),
            negativePrompt: requireText(value.prompts.negativePrompt, "负向提示词", true),
            characterPrompts,
        },
    };
}

export function illustrationExtension(mime) {
    const extension = MIME_EXTENSIONS[mime];
    if (!extension) throw illustrationError("仅支持 PNG、JPEG 和 WebP 图片。");
    return extension;
}

export async function validateIllustrationBlob(blob) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_IMAGE_BYTES) {
        throw illustrationError("图片为空或超过 32 MB，无法保存。");
    }
    illustrationExtension(blob.type);
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const matches = (sequence, offset = 0) => sequence.every((byte, index) => bytes[index + offset] === byte);
    const valid = blob.type === "image/png" ? matches([137, 80, 78, 71, 13, 10, 26, 10])
        : blob.type === "image/jpeg" ? matches([255, 216, 255])
        : matches([82, 73, 70, 70]) && matches([87, 69, 66, 80], 8);
    if (!valid) throw illustrationError("返回的文件与图片格式不符，请检查生图接口。");
    return blob;
}

export function isIllustrationPath(path) {
    return typeof path === "string" && /^\/user\/files\/titania-illustration-[a-zA-Z0-9-]+\.(png|jpg|webp)$/.test(path);
}

export function normalizeSavedIllustration(value) {
    if (!value || !isIllustrationPath(value.filePath)) throw illustrationError("配图文件路径无效。");
    const width = Number(value.width), height = Number(value.height);
    if (![width, height].every(n => Number.isInteger(n) && n > 0)) throw illustrationError("图片尺寸无效。");
    return {
        id: requireText(value.id, "图片标识"),
        filePath: value.filePath,
        draft: normalizeIllustrationDraft(value.draft),
        width, height,
        ...(typeof value.seed === "number" || typeof value.seed === "string" ? { seed: value.seed } : {}),
        createdAt: Number(value.createdAt) || 0,
    };
}

export function escapeIllustrationHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// 内联布局使 Shadow DOM、收藏和独立 HTML 使用同一份配图标记。
export function illustrationFigure(value) {
    if (!value) return "";
    let image;
    try { image = normalizeSavedIllustration(value); } catch { return ""; }
    const caption = escapeIllustrationHtml(image.draft.scene.summary);
    return `<figure data-titania-illustration="${escapeIllustrationHtml(image.id)}" style="margin:24px auto;text-align:center;max-width:100%"><a href="${image.filePath}" target="_blank" rel="noopener"><img src="${image.filePath}" alt="${caption}" width="${image.width}" height="${image.height}" loading="lazy" style="display:block;max-width:100%;height:auto;max-height:80vh;object-fit:contain;margin:auto;border-radius:12px"></a><figcaption style="margin-top:10px;font-size:0.9em;line-height:1.6">${caption}</figcaption></figure>`;
}
