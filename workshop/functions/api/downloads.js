// POST /api/downloads —— 批量上报下载量
// 刻意做成批量：一次点击一个请求会最先撞穿 Workers 的 10 万/天
import { publicJson, publicErr, preflight } from "../_lib/util.js";

export const onRequestOptions = () => preflight();

export async function onRequestPost({ request, env }) {
    let ids;
    try {
        ({ ids } = await request.json());
    } catch {
        return publicErr(400, "请求格式错误");
    }
    if (!Array.isArray(ids) || !ids.length) return publicErr(400, "缺少 ids");

    const clean = [...new Set(ids.filter(v => typeof v === "string" && /^ws_[a-z0-9]+$/.test(v)))].slice(0, 50);
    if (!clean.length) return publicJson({ ok: true, counted: 0 });

    const placeholders = clean.map(() => "?").join(",");
    await env.DB.prepare(
        `UPDATE scripts SET downloads = downloads + 1
         WHERE id IN (${placeholders}) AND status = 'public'`
    ).bind(...clean).run();

    return publicJson({ ok: true, counted: clean.length });
}
