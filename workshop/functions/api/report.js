// POST /api/report —— 举报。允许匿名，因为你的策略是被动下架，门槛越低越好
import { publicJson, publicErr, preflight, now } from "../_lib/util.js";
import { getAuthor } from "../_lib/session.js";

export const onRequestOptions = () => preflight();

export async function onRequestPost({ request, env }) {
    let body;
    try {
        body = await request.json();
    } catch {
        return publicErr(400, "请求格式错误");
    }

    const scriptId = String(body?.script_id ?? "");
    const reason = String(body?.reason ?? "").trim().slice(0, 500);
    if (!/^ws_[a-z0-9]+$/.test(scriptId)) return publicErr(400, "指令 ID 无效");
    if (!reason) return publicErr(400, "请填写举报理由");

    const exists = await env.DB
        .prepare("SELECT 1 FROM scripts WHERE id = ? AND status = 'public'")
        .bind(scriptId).first();
    if (!exists) return publicErr(404, "该指令不存在或已下架");

    // 登录了就记下举报人，方便识别恶意举报；没登录也接受
    const author = await getAuthor(request, env).catch(() => null);

    await env.DB.prepare(
        `INSERT INTO reports (script_id, reporter_id, reason, created_at)
         VALUES (?, ?, ?, ?)`
    ).bind(scriptId, author?.discord_id || null, reason, now()).run();

    return publicJson({ ok: true });
}
