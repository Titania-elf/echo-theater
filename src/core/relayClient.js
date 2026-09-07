// src/core/relayClient.js
// 自定义连接统一请求层：所有 OpenAI 兼容请求一律经 SillyTavern 后端代理转发，
// 不做浏览器直连（对齐 ST-SevenDaysCal/构画的实现）。
//
// 为什么走 ST 后端而不是浏览器直连：
// - CORS：部分中转站（如 tokenrhythm.studio）服务端 CORS 只放行自家域名，浏览器
//   直连的预检 OPTIONS 直接 404，拉模型和生成全部失败（TypeError: Failed to fetch）。
// - 混合内容：ST 以 HTTPS 提供时，浏览器禁止页面 fetch http:// 端点；Node 端无此限制。
// - 内网端点：浏览器够不到的内网地址，ST 服务器可达。
//
// 注意（G1）：esbuild 按字面量字符串把 ST 核心模块标 external（见 build.js external
// 列表），bundle 落在扩展根 index.js，因此下面这些导入必须相对【扩展根】写，
// 而不是相对本文件——路径错了构建照样过、运行时才 404。
import { getRequestHeaders } from "../../../../script.js";
import EventSourceStream from "../../../sse-stream.js";
import { tryParseStreamingError } from "../../../openai.js";
import { normalizeApiBaseUrl } from "./apiProfileRegistry.js";
import { TitaniaLogger } from "./logger.js";

const ST_STATUS_URL = "/api/backends/chat-completions/status";
const ST_GENERATE_URL = "/api/backends/chat-completions/generate";

/**
 * 规范化为 OpenAI 兼容 base URL（供 reverse_proxy 使用）。
 * 规则对齐构画 api/sse.js normalizeApiUrl：
 * - 去 /chat/completions、/v1/models、/models 尾巴（用户贴错完整端点时容错）；
 * - 仅当 URL 是裸域名（无任何路径）时补 /v1；
 * - 自定义路径（如 https://x/v2/coding）原样保留，不猜。
 * @param {string} url
 * @returns {string} 规范化后的 base URL，无效输入返回 ""
 */
export function toOpenAiBase(url) {
    const base = normalizeApiBaseUrl(url);
    if (!base) return "";
    if (/^https?:\/\/[^/?#]+$/i.test(base)) return `${base}/v1`;
    return base;
}

/**
 * 拉取模型列表（经 ST 后端 /status 路由代理）。
 * @param {{ url: string, key?: string }} options
 * @returns {Promise<string[]>} 模型 ID 列表（可能为空数组，由调用方提示）
 */
export async function fetchModelList({ url, key = "" }) {
    const base = toOpenAiBase(url);
    if (!base) throw new Error("API 地址无效");

    const res = await fetch(ST_STATUS_URL, {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            chat_completion_source: "openai",
            reverse_proxy: base,
            // 后端允许 reverse_proxy 存在时空 key，但必须是字符串，否则拼出 "Bearer undefined"
            proxy_password: String(key || ""),
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${errText ? " - " + errText.substring(0, 120) : ""}`);
    }

    const json = await res.json().catch(() => null);
    if (!json || json.error === true) {
        // /status 路由对上游失败回 {error:true}，不带细节
        throw new Error("中转服务器连接失败（经 ST 后端代理），请检查地址与 Key");
    }

    const list = Array.isArray(json?.data) ? json.data : (Array.isArray(json?.models) ? json.models : []);
    return [...new Set(
        list
            .map((m) => (typeof m === "string" ? m : String(m?.id || "").trim()))
            .filter(Boolean)
    )].sort();
}

/**
 * 把 OpenAI 线上格式的 response_format 翻译成 ST 后端 /generate 认的顶层 json_schema。
 * 后端（src/endpoints/backends/chat-completions.js:2542-2550）会把它转回
 * response_format 转发给上游，且该翻译不区分 chat_completion_source。
 * @param {{ type: string, json_schema: { name: string, strict?: boolean, schema: object } }} responseFormat
 */
function toStJsonSchema(responseFormat) {
    const js = responseFormat?.json_schema;
    if (!js || typeof js !== "object") return null;
    return {
        name: String(js.name || "response"),
        strict: js.strict ?? true,
        value: js.schema,
    };
}

/**
 * 统一的 SSE 消费循环（取自原 connection.js 自定义分支实现）。
 * ST 后端在 stream:true 时字节级透传上游 SSE，客户端解析方式与直连完全一致。
 * @returns {Promise<{ content: string, chunkCount: number, parseFailCount: number }>}
 */
async function consumeSse(res, { onProgress, signal }) {
    const eventStream = new EventSourceStream();
    res.body.pipeThrough(eventStream);
    const reader = eventStream.readable.getReader();
    let content = "";
    let chunkCount = 0;
    let parseFailCount = 0;

    try {
        while (true) {
            if (signal?.aborted) {
                await reader.cancel();
                throw new DOMException("Generation aborted", "AbortError");
            }

            const { done, value } = await reader.read();
            if (done) break;

            // value 是 MessageEvent，data 属性包含实际数据
            const data = value.data;
            if (data === "[DONE]") break;

            // 参考 ST：解析流式错误（配额/审核等，上游以 data: {"error":...} 事件返回）
            try {
                tryParseStreamingError(res, data, { quiet: true });
            } catch (streamParseErr) {
                throw streamParseErr;
            }

            chunkCount++;

            try {
                const json = JSON.parse(data);
                const chunk = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
                if (chunk) {
                    content += chunk;
                    if (onProgress) onProgress(content);
                }
            } catch (parseErr) {
                // 记录解析失败而不是完全静默（前 3 次告警）
                parseFailCount++;
                if (parseFailCount <= 3) {
                    TitaniaLogger.warn("流式 chunk 解析失败 (#" + parseFailCount + ")", {
                        data: String(data).substring(0, 100),
                        error: parseErr.message,
                    });
                }
            }
        }
    } finally {
        try { reader.cancel(); } catch { /* 流已结束/已取消 */ }
    }

    return { content, chunkCount, parseFailCount };
}

/**
 * 构造 HTTP 错误并附带状态码与原始错误体。
 * .status/.body 供改写的 400/422 去 schema 重试和续写的 5xx 非流式回落判断使用。
 */
function throwHttpError(res, bodyText, prefix = "") {
    const e = new Error(`${prefix}HTTP ${res.status}${res.statusText ? ": " + res.statusText : ""}${bodyText ? " - " + bodyText.substring(0, 180) : ""}`);
    e.status = res.status;
    e.body = bodyText || "";
    throw e;
}

/**
 * 发送聊天补全请求（经 ST 后端 /generate 路由代理）。
 *
 * @param {object} options
 * @param {string} options.url - 用户配置的 API base URL
 * @param {string} [options.key] - API Key（可空，代理层允许空 key）
 * @param {string} options.model - 模型名
 * @param {Array<{role: string, content: string}>} options.messages - 消息数组（必须是数组，
 *   字符串会被 ST 后端静默改走 /completions）
 * @param {boolean} [options.stream] - 是否流式
 * @param {number} [options.maxTokens] - max_tokens
 * @param {number} [options.temperature] - 温度（undefined = 不发送该参数）
 * @param {AbortSignal} [options.signal] - 中断信号
 * @param {(accumulated: string) => void} [options.onProgress] - 流式增量回调（累积文本）
 * @param {object} [options.responseFormat] - OpenAI 线上格式 response_format（json_schema）
 * @param {boolean} [options.wireStreamOverride] - 内部用：非流式 + responseFormat 时
 *   强制以流式上线（G3，见 sendChatCompletion 注释）
 * @param {object} [options.diagnostics] - 诊断对象（api.js 风格，可选）
 * @returns {Promise<string>} 生成的完整文本
 */
export async function sendChatCompletion(options = {}) {
    const {
        url, key = "", model, messages,
        stream = false,
        maxTokens, temperature,
        signal = null,
        onProgress = null,
        responseFormat = null,
        wireStreamOverride = null,
        diagnostics = null,
    } = options;

    const base = toOpenAiBase(url);
    if (!base) throw new Error("ERR_CONFIG: API URL 未设置");
    if (!Array.isArray(messages)) {
        throw new Error("ERR_CONFIG: messages 必须是数组（字符串会被 ST 后端改走 /completions）");
    }

    // G3：非流式 + responseFormat（改写主路径）时强制以流式上线。
    // ST 后端的非流式错误会被包成 HTTP 200 {error:{message: 仅statusText}}，上游错误体丢失；
    // 而流式路径透传上游状态码与原始错误体——改写功能的 400/422 去 schema 重试靠 err.body
    // 命中，必须走流式才能拿到。此模式下抑制中间 onProgress，结束时回调一次。
    const wireStream = wireStreamOverride !== null ? wireStreamOverride : stream;
    const suppressProgress = wireStream === true && stream !== true;

    if (diagnostics) {
        diagnostics.transport = "st_proxy";
        diagnostics.endpoint = `[ST 代理] ${base}/chat/completions`;
    }

    const body = {
        chat_completion_source: "openai",
        reverse_proxy: base,
        proxy_password: String(key || ""),
        model,
        messages,
        stream: wireStream,
    };
    if (Number.isFinite(maxTokens)) body.max_tokens = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;
    const stJsonSchema = toStJsonSchema(responseFormat);
    if (stJsonSchema) body.json_schema = stJsonSchema;

    const startedAt = Date.now();
    const res = await fetch(ST_GENERATE_URL, {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
        signal,
    });

    if (diagnostics) {
        diagnostics.network = diagnostics.network || {};
        diagnostics.network.status = res.status;
        diagnostics.network.latency = Date.now() - startedAt;
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        if (diagnostics) diagnostics.raw_response_snippet = errText.substring(0, 500);

        // ST 路由本身拒绝（CSRF 失效、配置缺失等）；先走结构化错误解析
        try {
            tryParseStreamingError(res, errText, { quiet: true });
        } catch (parsedErr) {
            throw parsedErr;
        }
        throwHttpError(res, errText, "ST 后端代理请求失败: ");
    }

    if (wireStream) {
        // 流式：ST 后端字节级透传上游 SSE，解析与直连时代完全一致
        if (diagnostics) diagnostics.phase = "streaming";
        const attemptStartTime = Date.now();
        const { content, chunkCount, parseFailCount } = await consumeSse(res, {
            onProgress: suppressProgress ? null : onProgress,
            signal,
        });

        // 0-chunk 兜底：某些端点会忽略 stream:true 直接回普通 JSON
        // （表现为 0 个数据块）。此时改用真实非流式重试一次。
        if (chunkCount === 0 && suppressProgress) {
            return sendChatCompletion({ ...options, wireStreamOverride: false, signal, diagnostics });
        }

        if (chunkCount === 0) {
            throw new Error("ERR_STREAM_NO_CHUNKS: 服务器未返回任何数据块");
        }
        if (diagnostics) {
            diagnostics.stream_stats = diagnostics.stream_stats || {};
            diagnostics.stream_stats.ttft = Date.now() - attemptStartTime;
            diagnostics.stream_stats.chunks = chunkCount;
        }
        if (parseFailCount > 0 && !content) {
            throw new Error("ERR_STREAM_PARSE_FAILED: 流式响应解析失败");
        }
        if (!content) {
            throw new Error("ERR_STREAM_EMPTY: 未接收到任何数据块");
        }
        if (suppressProgress && onProgress) onProgress(content);
        return content;
    }

    // 非流式
    if (diagnostics) diagnostics.phase = "parsing_json";
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error("Invalid JSON response");
    }

    if (json?.error) {
        // ST 后端把上游非 2xx 包成 HTTP 200 {error:{message}}（仅 statusText，上游详情丢失）
        const e = new Error(`上游返回错误（经 ST 后端代理）: ${json.error?.message || json.error}`);
        e.proxy = true;
        throw e;
    }

    if (!Array.isArray(json.choices)) {
        throw new Error("ERR_INVALID_API_RESPONSE: 响应缺少 choices 数组");
    }

    const content = json.choices[0]?.message?.content || "";
    if (onProgress) onProgress(content);
    return content;
}
