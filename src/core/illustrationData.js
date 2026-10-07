// 配图 DTO 与纯数据操作；不依赖酒馆或 Cosmos 私有模块。
export const ILLUSTRATION_INDEX_KEY = "illustration_index";
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** v2 起草稿不再记图源与模型：新接口由供应方决定且不可覆盖，只记「交给哪个生图后端」。 */
export const ILLUSTRATION_DRAFT_VERSION = 2;
/**
 * 认得的生图后端 id。
 *
 * ⚠ **只增不删。** 这是读路径的校验白名单（normalizeIllustrationDraft 会拦）：删掉一个 id，
 * 所有存着该 id 的旧记录都会在 normalizeSavedIllustration 抛错，整条场景记录随之失效 ——
 * 画廊、导出、备份一起坏，而用户只是升级了一下插件。要停用一个后端就把它留在列表里、
 * 由适配器报「未安装」，别从这里删。
 *
 * 必须与 illustrationBackends/registry.js 的注册表一致，有测试盯着这一条。
 */
export const ILLUSTRATION_BACKEND_IDS = ["cosmos", "baibai"];
const BACKENDS = new Set(ILLUSTRATION_BACKEND_IDS);
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
    // 摘要不在这里硬性校验：托管条目的「输出格式」要求模型返回 summary，但旧存档、
    // 备份与用户自写的预设里它可能是空的 —— 这是读路径，必须容得下，只做类型收敛。
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
 * 把对不上的画面摘录丢掉，草稿的其余部分原样留下。
 * 只在选景产出时调用：读路径没有正文可用。
 *
 * 摘录是**给用户核对画面选得对不对**的对照片段，不是生图的必需输入，所以对不上时只是丢弃、
 * 不判失败 —— 模型改写一句引文太容易了（加省略号、调语序、动个标点），为它废掉整次已经
 * 付过费的选景不划算。缺省时同样不拦。
 *
 * ⚠ 本函数自己不报信：调用方要靠比对前后有没有 sourceExcerpt 才知道丢没丢
 *   （见 illustrationScene.draftFromSceneReply 的 excerptDropped）。这里刻意不编一个
 *   替代品填上去 —— 显示一段模型没从正文里抄来的「原文」比不显示更坏。
 */
export function sanitizeIllustrationExcerpt(draft, theaterText) {
    const excerpt = draft?.scene?.sourceExcerpt;
    if (!excerpt || String(theaterText ?? "").includes(excerpt)) return draft;
    const scene = { ...draft.scene };
    delete scene.sourceExcerpt;
    return { ...draft, scene };
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

/**
 * 递归收集一个值里出现过的所有配图路径。
 *
 * 为什么要递归而不是只看 filePath 字段：路径会嵌在任意深度 —— 收藏体里是
 * `illustration.filePath`，链式收藏里在 `items[].illustration.filePath`，
 * 导出的 HTML 里则是一整段字符串。备份导出与删除前的引用计数都需要这份能力，
 * **只留这一份实现**：两处各写一套迟早会漂移，而漂移的代价是删掉仍在用的图。
 *
 * @param {*} value 任意值
 * @param {Set<string>} [result] 累积集合（递归时传入）
 * @returns {Set<string>}
 */
export function collectIllustrationPaths(value, result = new Set()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(/\/user\/files\/titania-illustration-[a-zA-Z0-9-]+\.(?:png|jpg|webp)/g)) result.add(match[0]);
    } else if (Array.isArray(value)) value.forEach(item => collectIllustrationPaths(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach(item => collectIllustrationPaths(item, result));
    return result;
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

/**
 * 配图标记的唯一产出点：`<figure data-titania-illustration>` + `<img>` + 可选图题。
 * 内联布局，使收藏阅读页、独立导出的 HTML 与正文渲染共用同一份标记。
 *
 * ⚠ **不要删这个函数。** 主界面从 5.4 起不再把图插进正文（配图面板图库里点缩略图
 * 开灯箱看大图），但它仍有两个消费者：
 *   - `illustrationWindow.js` 的「导出图文 HTML」
 *   - `favsWindow.js` 的收藏链式分段与收藏阅读页
 * 删掉会让收藏页和导出一起坏，而且测试未必拦得住。新增消费者时记得也考虑导出侧。
 */
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
