import { json, err, now, genId } from "../../../_lib/util.js";
import { getAuthor } from "../../../_lib/session.js";

export async function onRequestPut({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ? AND author_id = ? AND status = 'public'")
        .bind(params.id, author.discord_id).first();
    if (!row) return err(404, "评论不存在或不属于你");
    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const text = String(body?.body || "").trim();
    if (text.length < 2 || text.length > 1000) return err(400, "评论内容需在 2 到 1000 字之间");
    await env.DB.prepare("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?").bind(text, now(), params.id).run();
    return json({ ok: true });
}

export async function onRequestDelete({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    const result = await env.DB.prepare("UPDATE comments SET status = 'deleted', updated_at = ? WHERE id = ? AND author_id = ? AND status = 'public'")
        .bind(now(), params.id, author.discord_id).run();
    if (!(Number(result?.meta?.changes) || 0)) return err(404, "评论不存在或不属于你");
    return json({ ok: true });
}

export async function onRequestPost({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    if (author.banned) return err(403, "账号已被限制");
    const row = await env.DB.prepare(`
        SELECT c.*, s.author_id AS script_author_id
        FROM comments c JOIN scripts s ON s.id = c.script_id
        WHERE c.id = ? AND c.status = 'public'
    `).bind(params.id).first();
    if (!row) return err(404, "评论不存在");
    if (row.script_author_id !== author.discord_id) return err(403, "只有投稿作者可以回复");
    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const text = String(body?.body || "").trim();
    if (text.length < 1 || text.length > 1000) return err(400, "回复内容需在 1 到 1000 字之间");
    const ts = now();
    const batch = [env.DB.prepare("UPDATE comments SET reply_body = ?, replied_at = ? WHERE id = ?")
        .bind(text, ts, params.id)];
    if (!row.reply_body && row.author_id !== author.discord_id) {
        batch.push(env.DB.prepare(`
            INSERT INTO notifications (id, recipient_id, actor_id, type, script_id, comment_id, created_at)
            VALUES (?, ?, ?, 'author_reply', ?, ?, ?)
        `).bind(genId("nt"), row.author_id, author.discord_id, row.script_id, params.id, ts));
    }
    await env.DB.batch(batch);
    return json({ ok: true });
}
