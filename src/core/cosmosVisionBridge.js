// 生图后端适配层：把小剧场的配图草稿交给 Cosmos Vision 的公开接口出图。
//
// 这是全插件唯一接触 window.CosmosVision 的地方。选景已回归插件自有 LLM
// （见 illustrationScene.js），本模块只负责「拿提示词换图片」。
//
// 注意接口形状已经变了：Cosmos 交付的是 { version, requestPrompt, generateImage }，
// 没有 getCapabilities / preparePrompt / generate，也没有 imageSource、model、
// count、stage 进度。图源与模型由 Cosmos 自己的设置决定，调用方不可覆盖。

import { inspectImageBlob } from "./imageBytes.js";
import { illustrationError, newIllustrationId, validateIllustrationBlob } from "./illustrationData.js";

/**
 * 单次生图最多保存的张数。Cosmos 的返回张数由它自己的 imageCount 决定，调用方无法强制，
 * 这里只做跑飞时的护栏：超出部分丢弃并回报数量，不整批作废（图已经生成并计费了）。
 */
export const MAX_ILLUSTRATION_BATCH = 8;

function abortError() { return Object.assign(new Error("配图任务已取消。"), { name: "AbortError", code: "ABORTED" }); }

/**
 * 探测生图后端是否可用。按方法存在性判断，不看版本号 ——
 * api.version 是 Cosmos 的插件版本（当前 1.3.0），拿它做兼容性判断会随对方发版误判。
 * @returns {{ready:boolean,status:string,reason:string}}
 */
export function detectIllustrationBackend() {
    const api = globalThis.window?.CosmosVision;
    if (!api) return { ready: false, status: "missing", reason: "未检测到 Cosmos Vision，请安装并启用该扩展。" };
    if (typeof api.generateImage !== "function") {
        // 旧版（v1 契约）只有 preparePrompt/generate，给一句能照着做的提示。
        if (typeof api.preparePrompt === "function" || api.apiVersion) {
            return { ready: false, status: "legacy", reason: "检测到旧版 Cosmos Vision 接口，请升级到提供 generateImage 的版本。" };
        }
        return { ready: false, status: "unsupported", reason: "Cosmos Vision 没有提供生图接口。" };
    }
    return { ready: true, status: "ready", reason: "Cosmos Vision 已连接。" };
}

function requireBackend() {
    const state = detectIllustrationBackend();
    if (!state.ready) throw illustrationError(state.reason, state.status === "legacy" ? "UNSUPPORTED_API" : "NOT_READY");
    return globalThis.window.CosmosVision;
}

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

/**
 * 归一化后端抛出的错误：Cosmos 的错误是普通 Error，没有 code。
 * 若调用方已经取消，就换成本地的 AbortError，免得界面把它当成真实生成失败。
 *
 * 这里按 message 鸭子类型判断而不是 `instanceof Error`：后者对跨 realm 的
 * 错误对象（别的 bundle、iframe）不成立，会把对方的原文吞掉换成通用文案。
 */
function normalizeBackendError(error, signal) {
    if (signal?.aborted) return abortError();
    if (error?.name === "AbortError" || error?.code === "ABORTED") return abortError();
    const message = typeof error?.message === "string" && error.message.trim();
    return illustrationError(message || "生图失败，请重试。", "GENERATION_FAILED");
}

/**
 * 把后端返回的字节转成可入库的图片记录。
 * Cosmos 只回裸 Blob，没有类型也没有尺寸，类型靠嗅探补齐（否则 validateIllustrationBlob
 * 会因 blob.type 为空直接判定「不支持该格式」），尺寸靠头部解析。
 */
async function readGeneratedImages(blobs) {
    const images = [];
    for (const blob of blobs) {
        const inspected = await inspectImageBlob(blob);
        if (!inspected) throw illustrationError("返回的文件不是可识别的图片，请检查生图接口。", "GENERATION_FAILED");
        await validateIllustrationBlob(inspected.blob);
        images.push({ blob: inspected.blob, width: inspected.width, height: inspected.height });
    }
    return images;
}

/**
 * 按草稿生成图片。
 * @param {object} draft 已规范化的配图草稿（v2）
 * @param {object} [options] signal / onProgress / onStreamPreview
 * @returns {Promise<{images:Array<{blob:Blob,width:number,height:number}>,dropped:number}>}
 */
export async function generateTheaterIllustration(draft, options = {}) {
    return runAbortableIllustrationTask(async () => {
        const api = requireBackend();
        const requestId = newIllustrationId();
        let result;
        try {
            result = await api.generateImage({
                // 只给「画面里有什么」。质量词、UC 词、画风预设与 LoRA 触发词由 Cosmos 追加，
                // 这里再写一遍就会重复叠加 —— v1 需求与联调清单都点名过这条。
                prompts: {
                    positivePrompt: draft.prompts.positivePrompt,
                    negativePrompt: draft.prompts.negativePrompt,
                    characterPrompts: draft.prompts.characterPrompts,
                },
                requestId,
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
        } catch (error) {
            throw normalizeBackendError(error, options.signal);
        }

        const blobs = Array.isArray(result?.imageBlobs) ? result.imageBlobs : [];
        if (!blobs.length) throw illustrationError("生图接口没有返回图片。", "GENERATION_FAILED");
        const kept = blobs.slice(0, MAX_ILLUSTRATION_BATCH);
        return { images: await readGeneratedImages(kept), dropped: blobs.length - kept.length };
    }, options.signal);
}
