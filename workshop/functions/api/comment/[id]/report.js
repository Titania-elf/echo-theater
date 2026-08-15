import { publicJson, publicErr, preflight, now } from "../../../_lib/util.js";
import { getAuthor } from "../../../_lib/session.js";

export const onRequestOptions = () => preflight();

export async function onRequestPost({ request, params, env }) {
    let body;
    try { body = await request.json(); } catch { return publicErr(400, "请求格式错误"); }
    const reason = String(body?.reason || "").trim().slice(0, 500);
    if (!reason) return publicErr(400, "请填写举报理由");
    const exists = await env.DB.prepare("SELECT 1 FROM comments WHERE id = ? AND status = 'public'").bind(params.id).first();
    if (!exists) return publicErr(404, "评论不存在");
    const author = await getAuthor(request, env).catch(() => null);
    await env.DB.prepare(`
        INSERT INTO comment_reports (comment_id, reporter_id, reason, created_at)
        VALUES (?, ?, ?, ?)
    `).bind(params.id, author?.discord_id || null, reason, now()).run();
    return publicJson({ ok: true });
}
