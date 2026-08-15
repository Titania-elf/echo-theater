// 管理员查看和修改任意投稿。
import { json, err, now, sha256, normalizeForHash, validateScript, invalidatePublicList } from "../../../_lib/util.js";
import { requireAdmin } from "../../../_lib/admin.js";

async function findScript(env, id) {
    return env.DB.prepare(`
        SELECT s.*, a.username, a.avatar
        FROM scripts s JOIN authors a ON a.discord_id = s.author_id
        WHERE s.id = ?
    `).bind(id).first();
}

function output(row) {
    let tags = [];
    try { tags = JSON.parse(row.tags || "[]"); } catch { /* malformed legacy tags */ }
    return { ...row, tags: Array.isArray(tags) ? tags : [], reviewed: !!row.reviewed };
}

export async function onRequestGet({ request, params, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;
    const row = await findScript(env, params.id);
    if (!row) return err(404, "投稿不存在");
    return json({ item: output(row) });
}

export async function onRequestPut({ request, params, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;
    const row = await findScript(env, params.id);
    if (!row) return err(404, "投稿不存在");

    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const check = validateScript(body);
    if (!check.ok) return err(400, check.message);
    const v = check.value;
    const authorId = String(body.author_id || row.author_id).trim();
    const author = await env.DB.prepare("SELECT discord_id, banned FROM authors WHERE discord_id = ?").bind(authorId).first();
    if (!author) return err(400, "归属作者不存在");
    const hash = await sha256(normalizeForHash(v.prompt));
    const dup = await env.DB.prepare("SELECT id FROM scripts WHERE content_hash = ? AND status = 'public' AND id != ?").bind(hash, params.id).first();
    if (dup && (row.status === "public" || body.status === "public")) return err(409, "已有公开投稿使用完全相同的内容");

    const status = ["public", "removed", "deleted"].includes(body.status) ? body.status : row.status;
    const reviewed = body.reviewed === true || body.reviewed === 1 ? 1 : 0;
    const ts = now();
    await env.DB.prepare(`
        UPDATE scripts
        SET author_id = ?, name = ?, category = ?, summary = ?, prompt = ?, tags = ?, rating = ?,
            status = ?, anonymous = ?, content_hash = ?, reviewed = ?, moderated_at = ?,
            moderated_by = ?, moderation_note = ?, version = version + 1, updated_at = ?
        WHERE id = ?
    `).bind(
        authorId, v.name, v.category, v.summary, v.prompt, JSON.stringify(v.tags), v.rating,
        status, v.anonymous, hash, reviewed, reviewed ? ts : null,
        reviewed ? gate.author.discord_id : null, String(body.moderation_note || "").trim().slice(0, 500) || null,
        ts, params.id
    ).run();
    await invalidatePublicList(request);
    return json({ ok: true, item: output(await findScript(env, params.id)) });
}

export async function onRequestPost({ request, params, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;
    const row = await findScript(env, params.id);
    if (!row) return err(404, "投稿不存在");
    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const action = String(body?.action || "");
    if (!["review", "remove", "restore"].includes(action)) return err(400, "操作无效");
    const ts = now();
    if (action === "review") {
        await env.DB.prepare("UPDATE scripts SET reviewed = 1, moderated_at = ?, moderated_by = ?, moderation_note = ?, updated_at = ? WHERE id = ?")
            .bind(ts, gate.author.discord_id, String(body.note || "").trim().slice(0, 500) || null, ts, params.id).run();
    } else {
        const status = action === "remove" ? "removed" : "public";
        if (status === "public") {
            const dup = await env.DB.prepare("SELECT id FROM scripts WHERE content_hash = ? AND status = 'public' AND id != ?").bind(row.content_hash, params.id).first();
            if (dup) return err(409, "已有公开投稿使用完全相同的内容");
        }
        await env.DB.prepare("UPDATE scripts SET status = ?, updated_at = ? WHERE id = ?").bind(status, ts, params.id).run();
    }
    await invalidatePublicList(request);
    return json({ ok: true, item: output(await findScript(env, params.id)) });
}
