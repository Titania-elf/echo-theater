// 智绘姬（st-chatu8）适配器：借酒馆自己的事件总线请它出图。
//
// 它**没有** command、没有 window.* API —— 作者给的对外口子就是两条事件
// （见其教程「前端接入」，也在它的源码里逐字核实过）：
//
//   请求  generate-image-request   { id, prompt, width?, height?, change?, negative_prompt? }
//   响应  generate-image-response  { id, success, imageData, error, prompt, change, ... }
//
// 事件走的是**酒馆自己的 eventSource**：chatu8 那边 `import { eventSource } from "../../../../script.js"`，
// 而前端的 eventEmit/eventOn 也只是它的转发壳（JS-Slash-Runner 的 src/function/event.ts 里
// `_eventEmit` 就是 `await eventSource.emit(...)`）。所以这里**不依赖前端助手**，
// 走 `SillyTavern.getContext().eventSource` 即可 —— 那也是本模块唯一接触宿主的地方，
// 与柏宝绘看 `globalThis.STBaiBaiImage`、Cosmos 看 `globalThis.window.CosmosVision` 同一性质。
//
// 接单的是它**当前选中的那个渠道**（sd / novelai / comfyui / banana / runninghub）：
// 监听器只在「插件已启用 + 该渠道被选中」时注册（它自己的 replaceWithXxx 开关）。
// 所以这里不需要知道用户用哪一家，也不用管它的密钥、工作流、替换词怎么配 —— 那些全归它。
//
// 与柏宝绘的四处差异：
//   - 一次只出一张（一个响应一张图）
//   - 请求里只有一个 prompt 字段：**不支持分人物提示词与人物位置**
//   - 负向词只在部分渠道生效（banana 那条不读 negative_prompt）
//   - **没有取消接口**：取消只能做到「本地不再等」，它那边会照常算完 ——
//     与走 ST 主连接时同一个口径，界面的措辞已经如实反映这一点。

import { MAX_IMAGE_BYTES, newIllustrationId } from "../illustrationData.js";
import { dataUrlToBlob } from "../imageBytes.js";

const REQUEST_EVENT = "generate-image-request";
const RESPONSE_EVENT = "generate-image-response";

/** 它能出图的渠道。用户没选（或选了它自己都认不出的值）时按「没配好」报。 */
const MODE_LABELS = {
    sd: "Stable Diffusion",
    novelai: "NovelAI",
    comfyui: "ComfyUI",
    banana: "Banana / Grok",
    runninghub: "RunningHub",
};

/**
 * 读得到 negative_prompt 的渠道。banana 那条的处理器没收这个字段
 * （见它源码里 bananaGenerate 的解构），填了也不会生效 —— 与其静默吞掉，
 * 不如按能力上报，让界面把负向框收起来并说明。
 */
const NEGATIVE_MODES = new Set(["sd", "novelai", "comfyui", "runninghub"]);

/** 等响应的上限。它自己的渠道超时更长（ComfyUI 1800s），这里只是防「发出去没人接」。 */
const RESPONSE_TIMEOUT_MS = 15 * 60 * 1000;

/** chatu8 的全部状态都在酒馆设置的 extension_settings["st-chatu8"] 里。只读，不写。 */
function readSettings() {
    try {
        const settings = globalThis.SillyTavern?.getContext?.()?.extensionSettings?.["st-chatu8"];
        return settings && typeof settings === "object" ? settings : null;
    } catch {
        return null;
    }
}

/** 同一个 getContext 里的 eventSource —— 与 chatu8 听的是同一个对象。 */
function getBus() {
    try {
        const bus = globalThis.SillyTavern?.getContext?.()?.eventSource;
        return bus && typeof bus.emit === "function" && typeof bus.on === "function" ? bus : null;
    } catch {
        return null;
    }
}

function isEnabled(settings) {
    return settings?.scriptEnabled === true || settings?.scriptEnabled === "true";
}

function readMode(settings) {
    const mode = String(settings?.mode || "");
    return Object.hasOwn(MODE_LABELS, mode) ? mode : "";
}

function deriveCapabilities(mode) {
    return Object.freeze({
        // 请求里只有一个 prompt：分人物与位置都无处安放。草稿里仍然留着，
        // 切回支持它们的后端就用得上。
        characterPrompts: false,
        characterPositions: false,
        characterNegative: false,
        negativePrompt: NEGATIVE_MODES.has(mode),
        // 它按自己渠道里配的宽高出图，不从这里指定画幅。
        size: false,
        // 一个响应一张图。
        batch: false,
        streamPreview: false,
    });
}

/**
 * 探测智绘姬是否可用。不抛。
 * @returns {{ready:boolean,status:string,reason:string,capabilities?:object,detail?:object}}
 */
function probe() {
    const settings = readSettings();
    if (!settings) {
        return { ready: false, status: "missing", reason: "未检测到智绘姬（st-chatu8），请安装并启用该扩展。" };
    }
    if (!isEnabled(settings)) {
        return { ready: false, status: "not_configured", reason: "智绘姬已安装但没有启用，请打开它的插件开关。" };
    }
    const mode = readMode(settings);
    if (!mode) {
        const seen = String(settings.mode || "").trim();
        return {
            ready: false,
            status: "not_configured",
            reason: seen
                ? `智绘姬的渠道「${seen}」不能用来出图，请在它的「主要设置」里改选 SD / NovelAI / ComfyUI / Banana / RunningHub。`
                : "智绘姬还没有选渠道，请在它的「主要设置」里选一个能出图的渠道。",
        };
    }
    if (!getBus()) {
        // 设置齐了但事件总线拿不到，只可能是酒馆没就绪。当成「暂时不可用」，不是接口不对。
        return { ready: false, status: "not_configured", reason: "酒馆的事件总线还没就绪，请刷新页面后再试。" };
    }
    return {
        ready: true,
        status: "ready",
        reason: `智绘姬已连接（${MODE_LABELS[mode]} 渠道）。`,
        capabilities: deriveCapabilities(mode),
        detail: { mode },
    };
}

function abortError() {
    return Object.assign(new Error("配图任务已取消。"), { name: "AbortError", code: "ABORTED" });
}

/**
 * 发一条请求并等它那一条响应。
 *
 * ⚠ 必须按 id 过滤：事件是**广播**的，同一时刻可能有别的调用方（前端卡、它的自动点击）
 *   也在等自己的那一单。响应里的 id 与请求一一对应，这是唯一的归属判据。
 *
 * `options.timeoutMs` 只有测试会传（门面不传）：默认 15 分钟，够它那边最慢的渠道。
 */
function requestImage(bus, request, options) {
    const { signal } = options;
    const waitMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : RESPONSE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            bus.removeListener?.(RESPONSE_EVENT, onResponse);
            signal?.removeEventListener?.("abort", onAbort);
        };
        const done = (error, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve(value);
        };
        const onResponse = data => {
            if (!data || String(data?.id) !== String(request.id)) return;
            done(null, data);
        };
        const onAbort = () => done(abortError());
        const timer = setTimeout(() => done(Object.assign(
            new Error("智绘姬没有回应。请确认它在设置里已启用、渠道已选好，或稍后重试。"),
            { code: "NOT_READY" },
        )), waitMs);

        if (signal?.aborted) { done(abortError()); return; }
        signal?.addEventListener?.("abort", onAbort, { once: true });
        bus.on(RESPONSE_EVENT, onResponse);
        bus.emit(REQUEST_EVENT, request);
    });
}

/**
 * 出图。只回原始字节（这里负责把 dataURL 解码成 Blob），
 * 嗅探、校验、入库一律由门面统一处理。
 * @returns {Promise<{blobs:Blob[]}>}
 */
async function generate(draft, options = {}) {
    const state = probe();
    const bus = getBus();
    if (!state.ready || !bus) {
        throw Object.assign(new Error(state.reason), { code: "NOT_READY" });
    }

    const settings = readSettings();
    const mode = readMode(settings);
    const request = {
        id: newIllustrationId(),
        prompt: draft.prompts.positivePrompt,
        // 文档给的形状就是 null = 用它自己渠道里配的尺寸。
        width: null,
        height: null,
    };
    if (NEGATIVE_MODES.has(mode) && String(draft.prompts.negativePrompt || "").trim()) {
        // 它自己的负向词（各渠道的 UCP 预设）照常叠加，这里只是把我们这份也带上。
        request.negative_prompt = draft.prompts.negativePrompt;
    }

    const response = await requestImage(bus, request, options);
    if (response.success === false) {
        const detail = String(response.error || "").trim();
        throw Object.assign(
            new Error(detail ? `智绘姬生成失败：${detail}` : "智绘姬生成失败，请重试。"),
            { code: "GENERATION_FAILED" },
        );
    }
    if (response.isVideo) {
        // 我们从不发 {视频} 这类 change，出现即说明它那边的配置串了，如实报出来。
        throw Object.assign(new Error("智绘姬这次返回的是视频，配图只收图片。"), { code: "GENERATION_FAILED" });
    }

    let blob;
    try {
        // 先按 base64 长度算解码后大小再动手，跑飞的超大图不会先分配出一大块内存。
        blob = dataUrlToBlob(response.imageData, { maxBytes: MAX_IMAGE_BYTES });
    } catch (error) {
        throw Object.assign(new Error(error?.message || "智绘姬没有返回图片。"), { code: "GENERATION_FAILED" });
    }

    return { blobs: [blob] };
}

export const chatu8Backend = {
    id: "chatu8",
    label: "智绘姬",
    // 它没有「我准备好了」的广播：配置变化派发的是 document 上的
    // st-chatu8-config-updated，而界面订阅的是 window 上的事件（且那个 CustomEvent 不冒泡）。
    // 所以这里不挂就绪事件 —— 用户在面板上点「重新检测」即可，这也正是那个按钮的用途。
    readyEvents: [],
    probe,
    generate,
};
