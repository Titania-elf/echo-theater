// GET /api/list —— 公开索引。不含 prompt，400 条约 60KB
import { publicJson, preflight, rowToScript } from "../_lib/util.js";

export const onRequestOptions = () => preflight();

export async function onRequestGet({ request, env, waitUntil }) {
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const { results } = await env.DB.prepare(`
        SELECT s.id, s.name, s.category, s.summary, s.tags, s.rating,
               s.version, s.downloads, s.author_id, s.created_at, s.updated_at,
               s.anonymous, a.username, a.avatar
        FROM scripts s
        JOIN authors a ON a.discord_id = s.author_id
        WHERE s.status = 'public' AND a.banned = 0
        ORDER BY s.updated_at DESC
        LIMIT 2000
    `).all();

    const items = (results || []).map(r => rowToScript(r));
    const res = publicJson(
        { updated_at: Math.floor(Date.now() / 1000), count: items.length, items },
        { maxAge: 300 }
    );

    // 5 分钟边缘缓存：几千用户随便刷，一天也就几百次真实调用
    waitUntil(cache.put(cacheKey, res.clone()));
    return res;
}
