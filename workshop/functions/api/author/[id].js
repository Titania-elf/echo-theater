// GET /api/author/:id —— 作者主页：资料 + 他的公开投稿
import { publicJson, publicErr, preflight, rowToScript } from "../../_lib/util.js";

export const onRequestOptions = () => preflight();

export async function onRequestGet({ params, env }) {
    const author = await env.DB
        .prepare("SELECT discord_id, username, avatar, banned, created_at FROM authors WHERE discord_id = ?")
        .bind(params.id).first();

    if (!author || author.banned) return publicErr(404, "该作者不存在");

    // anonymous = 0 是关键：匿名投稿不能从作者页反查出来，
    // 否则「匿名」就只是卡片上不显示名字，实际还是能被关联
    const { results } = await env.DB.prepare(`
        SELECT s.id, s.name, s.category, s.summary, s.tags, s.rating,
               s.version, s.downloads, s.author_id, s.created_at, s.updated_at,
               s.anonymous, a.username, a.avatar
        FROM scripts s
        JOIN authors a ON a.discord_id = s.author_id
        WHERE s.author_id = ? AND s.status = 'public' AND s.anonymous = 0
        ORDER BY s.updated_at DESC
        LIMIT 500
    `).bind(params.id).all();

    const items = (results || []).map(r => rowToScript(r));
    const downloads = items.reduce((sum, s) => sum + (Number(s.downloads) || 0), 0);

    return publicJson({
        author: {
            id: author.discord_id,
            name: author.username,
            avatar: author.avatar || null,
            joined_at: author.created_at
        },
        stats: { count: items.length, downloads },
        items
    }, { maxAge: 300 });
}
