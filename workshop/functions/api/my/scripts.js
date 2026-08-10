// GET  /api/my/scripts  列出我的投稿（含已下架，自己能看见）
// POST /api/my/scripts  新建投稿
import { json, err, now, genId, sha256, normalizeForHash, validateScript, rowToScript } from "../../_lib/util.js";
import { getAuthor } from "../../_lib/session.js";

export async function onRequestGet({ request, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");

    const { results } = await env.DB.prepare(`
        SELECT s.*, a.username, a.avatar
        FROM scripts s JOIN authors a ON a.discord_id = s.author_id
        WHERE s.author_id = ? AND s.status != 'deleted'
        ORDER BY s.created_at DESC
    `).bind(author.discord_id).all();

    const items = (results || []).map(r => ({
        ...rowToScript(r, { withPrompt: true, owner: true }),
        status: r.status
    }));
    return json({ items });
}

export async function onRequestPost({ request, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    if (author.banned) return err(403, "账号已被限制投稿");

    let body;
    try {
        body = await request.json();
    } catch {
        return err(400, "请求格式错误");
    }

    const check = validateScript(body);
    if (!check.ok) return err(400, check.message);
    const v = check.value;

    // 每日投稿上限：没有人工审核时，这是防灌水的主要防线
    const limit = Number(env.DAILY_SUBMIT_LIMIT || 10);
    const since = now() - 86400;
    const { count } = await env.DB
        .prepare("SELECT COUNT(*) AS count FROM scripts WHERE author_id = ? AND created_at > ?")
        .bind(author.discord_id, since).first();
    if (count >= limit) return err(429, `今天的投稿数已达上限（${limit} 条），请明天再来`);

    const hash = await sha256(normalizeForHash(v.prompt));
    const dup = await env.DB
        .prepare("SELECT id FROM scripts WHERE content_hash = ? AND status = 'public'")
        .bind(hash).first();
    if (dup) return err(409, "已经有一条内容完全相同的指令了");

    const ts = now();
    const id = genId();
    await env.DB.prepare(`
        INSERT INTO scripts
            (id, author_id, name, category, summary, prompt, tags, rating,
             version, content_hash, downloads, status, anonymous, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 'public', ?, ?, ?)
    `).bind(
        id, author.discord_id, v.name, v.category, v.summary, v.prompt,
        JSON.stringify(v.tags), v.rating, hash, v.anonymous, ts, ts
    ).run();

    return json({ ok: true, id }, { status: 201 });
}
