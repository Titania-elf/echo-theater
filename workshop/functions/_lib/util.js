// 通用工具：响应封装、CORS、哈希、ID
import { isScriptCategory } from "./categories.js";

// 插件面板跑在 localhost 的 SillyTavern 里，读接口必须允许跨域
const PUBLIC_CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

export function json(data, init = {}) {
    return new Response(JSON.stringify(data), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) }
    });
}

/** 公开只读接口用：带 CORS，可选边缘缓存时长 */
export function publicJson(data, { status = 200, maxAge = 0, headers = {} } = {}) {
    return json(data, {
        status,
        headers: {
            ...PUBLIC_CORS,
            ...(maxAge ? { "Cache-Control": `public, max-age=${maxAge}` } : {}),
            ...headers
        }
    });
}

/** 带 cookie 的私有接口不开放跨域，只处理公开接口的预检 */
export function preflight() {
    return new Response(null, { status: 204, headers: PUBLIC_CORS });
}

export function err(status, message) {
    return json({ error: message }, { status });
}

export function publicErr(status, message) {
    return publicJson({ error: message }, { status });
}

export async function invalidatePublicList(request) {
    const url = new URL("/api/list", request.url);
    await caches.default.delete(new Request(url.toString(), { method: "GET" }));
}

export const now = () => Math.floor(Date.now() / 1000);

export async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 内容指纹：忽略空白差异，防止同一段 prompt 改改缩进就重投 */
export function normalizeForHash(prompt) {
    return prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

export function genId(prefix = "ws") {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `${prefix}_` + [...bytes].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

/** 投稿字段校验，返回 {ok, value|message} */
export function validateScript(body) {
    const name = String(body?.name ?? "").trim();
    const prompt = String(body?.prompt ?? "").trim();
    const summary = String(body?.summary ?? body?.desc ?? "").trim();
    const category = String(body?.category ?? "").trim();
    const rating = body?.rating === "mature" ? "mature" : "general";

    if (name.length < 1 || name.length > 60) return { ok: false, message: "标题需在 1–60 字之间" };
    if (prompt.length < 10) return { ok: false, message: "指令内容太短了（至少 10 字）" };
    if (prompt.length > 20000) return { ok: false, message: "指令内容超出 20000 字上限" };
    if (summary.length > 200) return { ok: false, message: "简介不能超过 200 字" };
    if (!category) return { ok: false, message: "请选择分类" };
    if (!isScriptCategory(category)) return { ok: false, message: "分类无效，请从现有分类中选择" };

    let tags = Array.isArray(body?.tags) ? body.tags : [];
    tags = tags.map(t => String(t).trim()).filter(t => t && t.length <= 16).slice(0, 5);

    // 匿名只影响展示，不影响归属：作者本人照样能编辑和下架
    const anonymous = body?.anonymous === true || body?.anonymous === 1 ? 1 : 0;

    return { ok: true, value: { name, prompt, summary, category, rating, tags, anonymous } };
}

/**
 * DB 行 -> 对外 JSON。summary 对外统一叫 desc，跟插件现有剧本结构对齐。
 *
 * 匿名投稿在这里就把身份抹掉 —— 所有公开接口都经过这个函数，
 * 在这一层统一处理比让每个调用方各自记得过滤要可靠。
 * @param {boolean} owner true 时保留真实身份（「我的投稿」页要显示自己的东西）
 */
export function rowToScript(row, { withPrompt = false, owner = false } = {}) {
    const anonymous = !!row.anonymous;
    const hideIdentity = anonymous && !owner;

    const out = {
        id: row.id,
        name: row.name,
        category: row.category || "",
        desc: row.summary || "",
        tags: safeParseTags(row.tags),
        rating: row.rating,
        version: row.version,
        downloads: row.downloads,
        anonymous,
        author: hideIdentity
            // 连 id 都不能给：泄露了就能跟这个作者的其他投稿关联起来
            ? { id: null, name: "匿名作者", avatar: null }
            : {
                id: row.author_id,
                name: row.username || "未知作者",
                // Discord 头像 hash，前端自己拼 CDN 地址。没有就是 null，前端退回首字色块
                avatar: row.avatar || null
            },
        created_at: row.created_at,
        updated_at: row.updated_at
    };
    if (withPrompt) out.prompt = row.prompt;
    return out;
}

function safeParseTags(raw) {
    try {
        const v = JSON.parse(raw || "[]");
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}
