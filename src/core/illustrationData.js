// 配图 DTO 与纯数据操作；不依赖酒馆或 Cosmos 私有模块。
export const ILLUSTRATION_INDEX_KEY = "illustration_index";
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** v2 起草稿不再记图源与模型：新接口由供应方决定且不可覆盖，只记「交给哪个生图后端」。 */
export const ILLUSTRATION_DRAFT_VERSION = 2;
const BACKENDS = new Set(["cosmos"]);
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
        // ⚠ cardKey 只作为字段带上，**绝不能**进这个散列数组：
        //   一改，illustration_index 里所有旧指针立刻变成孤儿，用户画廊全丢。
        sceneId: `scene-${illustrationHash(JSON.stringify([identity, result.scriptId || "", content]))}`,
        content,
        scriptId: String(result.scriptId || ""),
        scriptName: String(result.scriptName || "场景"),
        generationId: String(result.generationId || ""),
        // 目标内容的角色卡身份，由调用方给：当前聊天里就取 getCharacterCardKey()，
        // 收藏则取该收藏自己存下的。选景时**不要**现读，那会拿到当前聊天的角色。
        cardKey: String(result.cardKey || ""),
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

/**
 * 规范化配图草稿，并把 v1 旧草稿迁移成 v2。
 *
 * v1 的 imageSource / model 是「调用方指定图源与模型」时代的字段；新接口改由供应方决定
 * 且不可覆盖，所以读旧数据时直接丢弃这两个字段，不校验其取值（能存下来的都已通过旧校验）。
 * 本函数会在拿不到正文的读路径上被调用（存储读取、备份恢复、收藏渲染），因此
 * 绝不能在这里校验 scene.sourceExcerpt —— 那会让所有旧记录渲染失败。
 */
export function normalizeIllustrationDraft(value) {
    const version = Number(value?.version);
    if (version !== 1 && version !== ILLUSTRATION_DRAFT_VERSION) throw illustrationError("配图草稿版本不受支持。");
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
    const backend = version === 1 ? "cosmos" : requireText(value.backend, "生图后端");
    if (!BACKENDS.has(backend)) throw illustrationError("配图草稿的生图后端不受支持。");
    // 摘要不是必填：选景的输出契约已收窄到只要求 positivePrompt（见 illustrationPresets.js
    // 的托管条目「输出格式」），模型正常情况下不会再返回画面描述。老记录里它还在，照读。
    // ⚠ 这里刻意让它恒为字符串而不是缺键：消费端写的是 `textContent = draft.scene.summary`，
    //   拿到 undefined 会被渲染成字面量 "undefined"。
    const summary = typeof value.scene?.summary === "string" ? value.scene.summary.trim() : "";
    const excerpt = typeof value.scene?.sourceExcerpt === "string" ? value.scene.sourceExcerpt.trim() : "";
    return {
        version: ILLUSTRATION_DRAFT_VERSION,
        backend,
        scene: { summary, ...(excerpt ? { sourceExcerpt: excerpt } : {}) },
        prompts: {
            positivePrompt: requireText(value.prompts.positivePrompt, "正向提示词"),
            negativePrompt: requireText(value.prompts.negativePrompt, "负向提示词", true),
            characterPrompts,
        },
    };
}

/**
 * 校验画面摘录确实是正文中连续、逐字一致的一段，用来抓模型凭空编造的引用。
 * 只在选景产出时调用：读路径没有正文可用。
 * 摘录缺省时不拦截（它现在是给用户看的对照片段，不是生图的必需输入）；
 * 但一旦给出就必须对得上，否则说明模型在编原文。
 *
 * 错误码必须与 INVALID_RESPONSE 区分：那个码表示「格式坏了、重发一次可能就好了」，
 * 会被选景器当成可重试的失败；摘录对不上是内容问题，该直接把话说明白给用户看。
 */
export function assertIllustrationExcerpt(draft, theaterText) {
    const excerpt = draft?.scene?.sourceExcerpt;
    if (!excerpt) return draft;
    if (!String(theaterText ?? "").includes(excerpt)) {
        throw illustrationError("画面摘录不是正文中的连续原文，请重新选景。", "EXCERPT_MISMATCH");
    }
    return draft;
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
    // 摘要为空就不出 <figcaption> —— 它带着 margin-top:10px 与行高，空着会白占一行。
    // alt 回落成「配图」而不是空串：这是一张有内容的插图，空 alt 会让读屏软件整个跳过它。
    const captionHtml = caption
        ? `<figcaption style="margin-top:10px;font-size:0.9em;line-height:1.6">${caption}</figcaption>`
        : "";
    return `<figure data-titania-illustration="${escapeIllustrationHtml(image.id)}" style="margin:24px auto;text-align:center;max-width:100%"><a href="${image.filePath}" target="_blank" rel="noopener"><img src="${image.filePath}" alt="${caption || "配图"}" width="${image.width}" height="${image.height}" loading="lazy" style="display:block;max-width:100%;height:auto;max-height:80vh;object-fit:contain;margin:auto;border-radius:12px"></a>${captionHtml}</figure>`;
}
