import { json, err, now, invalidatePublicList } from "../../../_lib/util.js";
import { isScriptCategory } from "../../../_lib/categories.js";
import { requireAdmin } from "../../../_lib/admin.js";

export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;
    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }
    const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String).filter(id => /^ws_[a-z0-9]+$/.test(id)))].slice(0, 100);
    if (!ids.length) return err(400, "没有选择投稿");
    const sets = [];
    const values = [];
    if (body.category !== undefined) {
        if (!isScriptCategory(String(body.category))) return err(400, "分类无效");
        sets.push("category = ?"); values.push(String(body.category));
    }
    if (body.rating !== undefined) {
        if (!["general", "mature"].includes(body.rating)) return err(400, "分级无效");
        sets.push("rating = ?"); values.push(body.rating);
    }
    if (body.status !== undefined) {
        if (!["public", "removed"].includes(body.status)) return err(400, "状态无效");
        sets.push("status = ?"); values.push(body.status);
    }
    if (body.reviewed !== undefined) {
        const reviewed = body.reviewed ? 1 : 0;
        sets.push("reviewed = ?", "moderated_at = ?", "moderated_by = ?");
        values.push(reviewed, reviewed ? now() : null, reviewed ? gate.author.discord_id : null);
    }
    if (!sets.length) return err(400, "没有要修改的字段");
    sets.push("updated_at = ?"); values.push(now());
    try {
        await env.DB.prepare(`UPDATE scripts SET ${sets.join(", ")} WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...values, ...ids).run();
    } catch (e) {
        if (String(e?.message || "").includes("UNIQUE")) return err(409, "所选投稿中存在与当前公开内容重复的项目");
        throw e;
    }
    await invalidatePublicList(request);
    return json({ ok: true, updated: ids.length });
}
