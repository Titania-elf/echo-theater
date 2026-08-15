// POST /api/my/scripts/batch-delete —— 批量永久删除自己的投稿
import { json, err, now, invalidatePublicList } from "../../../_lib/util.js";
import { getAuthor } from "../../../_lib/session.js";

export async function onRequestPost({ request, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");

    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : [])
        .map(String).filter(id => /^ws_[a-z0-9]+$/.test(id)))].slice(0, 100);
    if (!ids.length) return err(400, "没有选择投稿");

    const ts = now();
    const result = await env.DB.prepare(`
        UPDATE scripts SET status = 'deleted', updated_at = ?
        WHERE author_id = ? AND status != 'deleted' AND id IN (${ids.map(() => "?").join(",")})
    `).bind(ts, author.discord_id, ...ids).run();
    await invalidatePublicList(request);

    return json({ ok: true, deleted: Number(result?.meta?.changes) || 0 });
}
