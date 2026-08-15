// GET /api/script/:id —— 详情，含 prompt
import { publicJson, publicErr, preflight, rowToScript } from "../../_lib/util.js";

export const onRequestOptions = () => preflight();

export async function onRequestGet({ params, env }) {
    const row = await env.DB.prepare(`
        SELECT s.*, a.username, a.avatar, a.banned
        FROM scripts s
        JOIN authors a ON a.discord_id = s.author_id
        WHERE s.id = ?
    `).bind(params.id).first();

    if (!row || row.status !== "public" || row.banned) {
        return publicErr(404, "该指令不存在或已下架");
    }

    return publicJson(rowToScript(row, { withPrompt: true }), {
        headers: { "Cache-Control": "no-store" }
    });
}
