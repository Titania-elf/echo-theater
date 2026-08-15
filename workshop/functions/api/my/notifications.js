import { json, err, now } from "../../_lib/util.js";
import { getAuthor } from "../../_lib/session.js";

export async function onRequestGet({ request, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    const unread = await env.DB.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND read_at IS NULL")
        .bind(author.discord_id).first();
    const { results } = await env.DB.prepare(`
        SELECT n.*, a.username AS actor_name, s.name AS script_name
        FROM notifications n
        LEFT JOIN authors a ON a.discord_id = n.actor_id
        LEFT JOIN scripts s ON s.id = n.script_id
        WHERE n.recipient_id = ?
        ORDER BY n.created_at DESC LIMIT 100
    `).bind(author.discord_id).all();
    return json({ unread: Number(unread?.count) || 0, items: results || [] });
}

export async function onRequestPost({ request, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    let body = {};
    try { body = await request.json(); } catch { /* mark all */ }
    const ids = (Array.isArray(body?.ids) ? body.ids : []).map(String).filter(id => /^nt_[a-z0-9]+$/.test(id)).slice(0, 100);
    if (ids.length) {
        await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
            .bind(now(), author.discord_id, ...ids).run();
    } else {
        await env.DB.prepare("UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL")
            .bind(now(), author.discord_id).run();
    }
    return json({ ok: true });
}
