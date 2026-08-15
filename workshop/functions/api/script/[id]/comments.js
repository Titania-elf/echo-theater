import { publicJson, publicErr, preflight, json, err, now, genId } from "../../../_lib/util.js";
import { getAuthor } from "../../../_lib/session.js";

export const onRequestOptions = () => preflight();

export async function onRequestGet({ request, params, env }) {
    const script = await env.DB.prepare("SELECT id, author_id, status FROM scripts WHERE id = ?").bind(params.id).first();
    if (!script || script.status !== "public") return publicErr(404, "投稿不存在或已下架");
    const viewer = await getAuthor(request, env).catch(() => null);
    const { results } = await env.DB.prepare(`
        SELECT c.id, c.script_id, c.author_id, c.body, c.reply_body, c.replied_at,
               c.created_at, c.updated_at, a.username, a.avatar
        FROM comments c JOIN authors a ON a.discord_id = c.author_id
        WHERE c.script_id = ? AND c.status = 'public' AND a.banned = 0
        ORDER BY c.created_at DESC
        LIMIT 200
    `).bind(params.id).all();
    return publicJson({ items: (results || []).map(row => ({
        id: row.id, script_id: row.script_id, body: row.body,
        reply: row.reply_body ? { body: row.reply_body, created_at: row.replied_at } : null,
        author: { id: row.author_id, name: row.username, avatar: row.avatar || null },
        created_at: row.created_at, updated_at: row.updated_at
    })), can_reply: Boolean(viewer && viewer.discord_id === script.author_id) });
}

export async function onRequestPost({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    if (author.banned) return err(403, "账号已被限制");
    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const text = String(body?.body || "").trim();
    if (text.length < 2 || text.length > 1000) return err(400, "反馈内容需在 2 到 1000 字之间");
    const script = await env.DB.prepare("SELECT id, author_id, status FROM scripts WHERE id = ?").bind(params.id).first();
    if (!script || script.status !== "public") return err(404, "投稿不存在或已下架");
    const existing = await env.DB.prepare("SELECT id FROM comments WHERE script_id = ? AND author_id = ? AND status != 'deleted'")
        .bind(params.id, author.discord_id).first();
    if (existing) return err(409, "你已经反馈过这条投稿，可以编辑原反馈");
    const since = now() - 86400;
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM comments WHERE author_id = ? AND created_at > ?")
        .bind(author.discord_id, since).first();
    if ((Number(count?.count) || 0) >= 20) return err(429, "今天发布的反馈已达上限");

    const ts = now();
    const id = genId("cm");
    const batch = [env.DB.prepare(`
        INSERT INTO comments (id, script_id, author_id, body, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'public', ?, ?)
    `).bind(id, params.id, author.discord_id, text, ts, ts)];
    if (script.author_id !== author.discord_id) {
        batch.push(env.DB.prepare(`
            INSERT INTO notifications (id, recipient_id, actor_id, type, script_id, comment_id, created_at)
            VALUES (?, ?, ?, 'new_comment', ?, ?, ?)
        `).bind(genId("nt"), script.author_id, author.discord_id, params.id, id, ts));
    }
    await env.DB.batch(batch);
    return json({ ok: true, id }, { status: 201 });
}
