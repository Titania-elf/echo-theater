// GET /api/admin/authors —— 已注册作者列表，给批量导入的归属下拉用
import { json } from "../../_lib/util.js";
import { requireAdmin } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;

    // 带上每人的投稿数，方便在下拉里认人
    const { results } = await env.DB.prepare(`
        SELECT a.discord_id, a.username, a.avatar, a.banned,
               COUNT(s.id) AS script_count
        FROM authors a
        LEFT JOIN scripts s ON s.author_id = a.discord_id AND s.status = 'public'
        GROUP BY a.discord_id
        ORDER BY a.username COLLATE NOCASE
    `).all();

    const items = (results || []).map(r => ({
        id: r.discord_id,
        name: r.username,
        avatar: r.avatar || null,
        banned: !!r.banned,
        script_count: Number(r.script_count) || 0
    }));

    // 现有分类：导入页拿它做候选，避免手打造成「心理分析」「心理分析 」这类碎片
    const { results: catRows } = await env.DB.prepare(`
        SELECT category, COUNT(*) AS n FROM scripts
        WHERE status = 'public' AND category IS NOT NULL AND category != ''
        GROUP BY category ORDER BY n DESC
    `).all();
    const categories = (catRows || []).map(r => r.category);

    // 空列表是正常状态（还没人登录过），交给前端提示，不当错误处理
    return json({ count: items.length, items, categories });
}
