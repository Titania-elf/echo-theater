// 生图后端分派门面：把配图草稿交给当前后端出图，并把结果统一成可入库的图片记录。
//
// 具体某个后端怎么调，在 illustrationBackends/ 里。本模块只做四件事：
// 分派、就绪检查、把后端抛的错误归一成插件错误、把回来的字节嗅探校验成图片。
// 后端只负责回原始 Blob（可能没有类型与尺寸），嗅探与校验只有这一条路径，所有后端共用。
//
// ⚠ 文件名是历史遗留：它现在服务所有后端，不再是 Cosmos 专用。

import { inspectImageBlob } from "./imageBytes.js";
import { illustrationError, validateIllustrationBlob } from "./illustrationData.js";
import {
    DEFAULT_BACKEND_ID, EMPTY_CAPABILITIES,
    getIllustrationBackend, statusToErrorCode,
} from "./illustrationBackends/registry.js";

/**
 * 单次生图最多保存的张数。返回张数由各个后端自己决定（Cosmos 按它的 imageCount，
 * 柏宝绘一次一张），调用方无法强制，这里只做跑飞时的护栏：
 * 超出部分丢弃并回报数量，不整批作废（图已经生成并计费了）。
 */
export const MAX_ILLUSTRATION_BATCH = 8;

/** 插件自己的错误码。已经在其中的错误不再二次包装，免得丢掉 code。 */
const PLUGIN_ERROR_CODES = new Set([
    "ABORTED", "GENERATION_FAILED", "NOT_READY", "UNSUPPORTED_API", "INVALID_ARGS",
    "RATE_LIMITED", "SAVE_FAILED", "LLM_NOT_CONFIGURED", "INVALID_RESPONSE",
    "NO_CONTENT", "NO_SCENE",
]);

function abortError() { return Object.assign(new Error("配图任务已取消。"), { name: "AbortError", code: "ABORTED" }); }

/**
 * 探测某个生图后端是否可用。
 *
 * 返回值是旧形状的超集：多了 capabilities（界面据此收起对不上的控件）与
 * detail（后端自己的补充信息，仅用于展示）。
 *
 * @param {string} [backendId] 缺省为默认后端 —— 保持旧调用点与旧用例的行为不变。
 * @returns {{ready:boolean,status:string,reason:string,capabilities:object,detail:object}}
 */
export function detectIllustrationBackend(backendId = DEFAULT_BACKEND_ID) {
    const adapter = getIllustrationBackend(backendId);
    if (!adapter) {
        return {
            ready: false, status: "unsupported",
            reason: `未安装生图后端「${backendId}」。`,
            capabilities: EMPTY_CAPABILITIES, detail: {},
        };
    }
    let state;
    try {
        state = adapter.probe() || {};
    } catch {
        // probe 按约定不抛；真抛了也不能让它把整个界面带崩。
        return {
            ready: false, status: "unsupported",
            reason: `探测 ${adapter.label} 时出错。`,
            capabilities: EMPTY_CAPABILITIES, detail: {},
        };
    }
    const ready = Boolean(state.ready);
    return {
        ready,
        status: state.status || (ready ? "ready" : "unsupported"),
        reason: state.reason || "",
        // 没就绪就不谈能力：界面据此收起控件，而不是拿一份半可信的列表去渲染。
        capabilities: ready && state.capabilities ? state.capabilities : EMPTY_CAPABILITIES,
        detail: state.detail || {},
    };
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
 * 归一化后端抛出的错误。
 *
 * 适配器已经把供应方的错误翻译成插件的 code（柏宝绘有 code，Cosmos 只有 message），
 * 所以这里先透传已知的插件错误；其余按 message 鸭子类型兜底 —— **不用 `instanceof Error`**：
 * 后者对跨 realm 的错误对象（别的 bundle、iframe）不成立，会把对方的原文吞掉换成通用文案。
 *
 * 若调用方已经取消，一律换成本地的 AbortError，免得界面把取消当成真实生成失败。
 */
function normalizeBackendError(error, signal) {
    if (signal?.aborted) return abortError();
    if (error?.name === "AbortError" || error?.code === "ABORTED") return abortError();
    if (typeof error?.code === "string" && PLUGIN_ERROR_CODES.has(error.code)) return error;
    const message = typeof error?.message === "string" && error.message.trim();
    return illustrationError(message || "生图失败，请重试。", "GENERATION_FAILED");
}

/**
 * 把后端返回的字节转成可入库的图片记录。
 * 后端回的可能是裸 Blob，没有类型也没有尺寸，类型靠嗅探补齐（否则 validateIllustrationBlob
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
 *
 * 分派依据是 **草稿自己记的 backend**，不是当前设置 —— 一份草稿始终由它自称的那个后端来画，
 * 设置只决定「新草稿盖哪个后端」。用户改设置后重画时，界面会把会话草稿重新盖章。
 *
 * @param {object} draft 已规范化的配图草稿（v2）
 * @param {object} [options] signal / onProgress / onStreamPreview / size / seed
 * @returns {Promise<{images:Array<{blob:Blob,width:number,height:number}>,dropped:number,seed?:*,applied?:object}>}
 */
export async function generateTheaterIllustration(draft, options = {}) {
    return runAbortableIllustrationTask(async () => {
        const backendId = draft?.backend;
        const adapter = getIllustrationBackend(backendId);
        if (!adapter) throw illustrationError(`配图草稿的生图后端「${backendId}」不受支持。`, "UNSUPPORTED_API");
        const state = detectIllustrationBackend(backendId);
        if (!state.ready) throw illustrationError(state.reason, statusToErrorCode(state.status));

        let result;
        try {
            result = await adapter.generate(draft, {
                signal: options.signal,
                onProgress: options.onProgress,
                onStreamPreview: options.onStreamPreview,
                size: options.size,
                seed: options.seed,
            });
        } catch (error) {
            throw normalizeBackendError(error, options.signal);
        }

        const blobs = Array.isArray(result?.blobs) ? result.blobs : [];
        if (!blobs.length) throw illustrationError("生图接口没有返回图片。", "GENERATION_FAILED");
        const kept = blobs.slice(0, MAX_ILLUSTRATION_BATCH);
        return {
            images: await readGeneratedImages(kept),
            dropped: blobs.length - kept.length,
            seed: result?.seed,
            applied: result?.applied,
        };
    }, options.signal);
}
