import {
    illustrationError, newIllustrationId, normalizeIllustrationDraft, validateIllustrationBlob,
} from "./illustrationData.js";

function getApi() {
    const api = globalThis.window?.CosmosVision;
    if (!api) throw illustrationError("请启用支持公开接口的 Cosmos Vision，然后点击重新检测。", "NOT_READY");
    if (!/^1\./.test(String(api.apiVersion || "")) || !["getCapabilities", "preparePrompt", "generate"].every(key => typeof api[key] === "function")) {
        throw illustrationError("Cosmos Vision 接口版本不兼容，需要公开接口 v1。", "UNSUPPORTED_API");
    }
    return api;
}

export async function getCosmosCapabilities() {
    const api = getApi();
    const capabilities = await api.getCapabilities();
    if (!capabilities?.ready) throw illustrationError(capabilities?.reason || "Cosmos Vision 正在初始化，请稍后重试。", "NOT_READY");
    if (!capabilities.enabled) throw illustrationError("请先在扩展设置中启用 Cosmos Vision。", "DISABLED");
    if (!capabilities.features?.theaterPrompt || !capabilities.features?.providedContext) {
        throw illustrationError("Cosmos Vision 尚不支持小剧场选景与显式上下文。", "UNSUPPORTED_MODE");
    }
    if (!Array.isArray(capabilities.imageSources) || !Number.isInteger(capabilities.limits?.maxTextChars) || capabilities.limits.maxTextChars < 1) {
        throw illustrationError("Cosmos Vision 能力信息不完整。");
    }
    return capabilities;
}

function abortError() { return Object.assign(new Error("配图任务已取消。"), { name: "AbortError", code: "ABORTED" }); }

// 即使供应方迟到返回，也不再继续保存图片或覆盖 UI。
export function runAbortableIllustrationTask(task, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal?.removeEventListener("abort", abort);
            reject(abortError());
        };
        signal?.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
            if (signal?.aborted) throw abortError();
            return task();
        }).then(value => signal?.aborted ? reject(abortError()) : resolve(value), reject)
            .finally(() => signal?.removeEventListener("abort", abort));
    });
}

function requestControl(options) {
    const requestId = newIllustrationId();
    return {
        requestId,
        signal: options.signal,
        onProgress(event) {
            if (options.signal?.aborted || event?.requestId !== requestId) return;
            try { options.onProgress?.(event); } catch { /* 界面回调不能让供应方重复请求。 */ }
        },
    };
}

export async function prepareTheaterIllustration(request, options = {}) {
    return runAbortableIllustrationTask(async () => {
        const capabilities = await getCosmosCapabilities();
        if (!request.theaterText?.trim()) throw illustrationError("正文为空，无法选择画面。", "NO_CONTENT");
        if (request.theaterText.length > capabilities.limits.maxTextChars) {
            throw illustrationError(`正文超过 Cosmos 支持的 ${capabilities.limits.maxTextChars} 字符，请缩短本次配图素材。`, "TEXT_TOO_LONG");
        }
        const source = capabilities.imageSources.find(item => item.id === request.imageSource);
        if (!source?.ready) throw illustrationError(source?.reason || "所选生图来源尚未配置。", "PROVIDER_NOT_CONFIGURED");
        if (options.signal?.aborted) throw abortError();
        const draft = normalizeIllustrationDraft(await getApi().preparePrompt(request, requestControl(options)), request.theaterText);
        if (draft.imageSource !== request.imageSource) throw illustrationError("返回草稿的图像来源与请求不一致。");
        return draft;
    }, options.signal);
}

export async function generateTheaterIllustration(draft, options = {}) {
    return runAbortableIllustrationTask(async () => {
        const normalized = normalizeIllustrationDraft(draft);
        const capabilities = await getCosmosCapabilities();
        const source = capabilities.imageSources.find(item => item.id === normalized.imageSource);
        if (!source?.ready) throw illustrationError(source?.reason || "所选生图来源尚未配置。", "PROVIDER_NOT_CONFIGURED");
        if (options.signal?.aborted) throw abortError();
        const control = requestControl(options);
        const result = await getApi().generate({ draft: normalized, count: 1 }, control);
        if (result?.requestId !== control.requestId || !Array.isArray(result.images) || result.images.length !== 1) {
            throw illustrationError("生图结果的任务标识或图片数量不符合接口约定。");
        }
        const actualDraft = normalizeIllustrationDraft(result.draft);
        if (actualDraft.imageSource !== normalized.imageSource || actualDraft.model !== normalized.model
            || actualDraft.scene.sourceExcerpt !== normalized.scene.sourceExcerpt) throw illustrationError("生图结果来源、模型或选景原文不一致。");
        const image = result.images[0];
        await validateIllustrationBlob(image.blob);
        if (image.mimeType !== image.blob.type || ![image.width, image.height].every(n => Number.isInteger(n) && n > 0)) {
            throw illustrationError("生图结果的格式或尺寸无效。");
        }
        return { draft: actualDraft, image };
    }, options.signal);
}
