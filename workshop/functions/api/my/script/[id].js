// PUT    /api/my/script/:id            编辑（version+1，插件据此提示"作者有更新"）
// DELETE /api/my/script/:id            下架（可恢复）
// DELETE /api/my/script/:id?purge=1    删除（不可恢复，从「我的投稿」里消失）
// POST   /api/my/script/:id            重新上架
import { json, err, now, sha256, normalizeForHash, validateScript } from "../../../_lib/util.js";
import { getAuthor } from "../../../_lib/session.js";

async function ownedScript(env, id, authorId) {
    return env.DB
        .prepare("SELECT * FROM scripts WHERE id = ? AND author_id = ? AND status != 'deleted'")
        .bind(id, authorId).first();
}

export async function onRequestPut({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    if (author.banned) return err(403, "账号已被限制");

    const row = await ownedScript(env, params.id, author.discord_id);
    if (!row) return err(404, "指令不存在或不属于你");

    let body;
    try {
        body = await request.json();
    } catch {
        return err(400, "请求格式错误");
    }

    const check = validateScript(body);
    if (!check.ok) return err(400, check.message);
    const v = check.value;

    const hash = await sha256(normalizeForHash(v.prompt));
    if (hash !== row.content_hash) {
        const dup = await env.DB
            .prepare("SELECT id FROM scripts WHERE content_hash = ? AND status = 'public' AND id != ?")
            .bind(hash, params.id).first();
        if (dup) return err(409, "已经有一条内容完全相同的指令了");
    }

    await env.DB.prepare(`
        UPDATE scripts
        SET name = ?, category = ?, summary = ?, prompt = ?, tags = ?, rating = ?,
            anonymous = ?, content_hash = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND author_id = ?
    `).bind(
        v.name, v.category, v.summary, v.prompt, JSON.stringify(v.tags), v.rating,
        v.anonymous, hash, now(), params.id, author.discord_id
    ).run();

    return json({ ok: true, version: row.version + 1 });
}

export async function onRequestPost({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");
    if (author.banned) return err(403, "账号已被限制");

    const row = await ownedScript(env, params.id, author.discord_id);
    if (!row) return err(404, "指令不存在或不属于你");
    if (row.status === "public") return json({ ok: true, status: "public" });

    // 下架期间别人可能投了内容相同的指令，这时不能让两条同时在架
    // —— 唯一索引只约束 status='public' 的行，撞了会直接抛错
    const dup = await env.DB
        .prepare("SELECT id FROM scripts WHERE content_hash = ? AND status = 'public' AND id != ?")
        .bind(row.content_hash, params.id).first();
    if (dup) return err(409, "工坊里已经有一条内容完全相同的指令了，无法重新上架");

    await env.DB
        .prepare("UPDATE scripts SET status = 'public', updated_at = ? WHERE id = ? AND author_id = ?")
        .bind(now(), params.id, author.discord_id).run();

    return json({ ok: true, status: "public" });
}

export async function onRequestDelete({ request, params, env }) {
    const author = await getAuthor(request, env);
    if (!author) return err(401, "请先登录");

    const row = await ownedScript(env, params.id, author.discord_id);
    if (!row) return err(404, "指令不存在或不属于你");

    // purge=1 是删除，否则只是下架
    const purge = new URL(request.url).searchParams.get("purge") === "1";
    const status = purge ? "deleted" : "removed";

    // 两种都是软删除：行留在库里，举报和下载记录才有得追溯。
    // 区别在 deleted 不再出现在「我的投稿」，作者也无法自己恢复。
    await env.DB
        .prepare("UPDATE scripts SET status = ?, updated_at = ? WHERE id = ? AND author_id = ?")
        .bind(status, now(), params.id, author.discord_id).run();

    return json({ ok: true, status });
}
