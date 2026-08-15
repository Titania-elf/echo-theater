// POST /api/admin/scripts —— 管理员代投稿
//
// 跟 /api/my/scripts 的区别：
//   1. 要求当前登录用户是站长（ADMIN_DISCORD_ID）
//   2. 跳过每日投稿上限（内容由站长人工审核，不是灌水来源）
//   3. author_id 由请求指定，必须是已注册且未封禁的作者
//   4. 支持一次提交多条
//
// 查询次数与条数无关：作者查一次、查重查一次、插入合并成一个 batch。
// 逐条 await 的写法在上百条时会撞 Worker 的子请求上限和执行时限。
//
// 内容去重保留：schema 里的唯一索引挡的是真·重复内容，跳过它没好处。
import { json, err, now, genId, sha256, normalizeForHash, validateScript, invalidatePublicList } from "../../_lib/util.js";
import { requireAdmin } from "../../_lib/admin.js";

/**
 * 单请求条数上限。前端会自己分批，这里只是兜底，
 * 防止一个超大请求把 SQL 变量数或执行时间顶爆。
 */
const MAX_BATCH = 100;

export async function onRequestGet({ request, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;
    const url = new URL(request.url);
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(50, Math.max(10, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    const offset = (page - 1) * limit;
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
    const category = String(url.searchParams.get("category") || "").trim();
    const rating = String(url.searchParams.get("rating") || "").trim();
    const status = String(url.searchParams.get("status") || "all").trim();
    const reviewed = String(url.searchParams.get("reviewed") || "all").trim();
    const where = ["1 = 1"];
    const binds = [];
    if (q) { where.push("(s.name LIKE ? OR s.summary LIKE ? OR a.username LIKE ?)"); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (category) { where.push("s.category = ?"); binds.push(category); }
    if (rating === "general" || rating === "mature") { where.push("s.rating = ?"); binds.push(rating); }
    if (["public", "removed", "deleted"].includes(status)) { where.push("s.status = ?"); binds.push(status); }
    else where.push("s.status != 'deleted'");
    if (reviewed === "0" || reviewed === "1") { where.push("s.reviewed = ?"); binds.push(Number(reviewed)); }
    const condition = where.join(" AND ");
    const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS count FROM scripts s JOIN authors a ON a.discord_id = s.author_id WHERE ${condition}`).bind(...binds).first();
    const { results } = await env.DB.prepare(`
        SELECT s.id, s.name, s.category, s.summary, s.tags, s.rating, s.version,
               s.downloads, s.author_id, s.status, s.anonymous, s.reviewed,
               s.moderated_at, s.moderated_by, s.moderation_note,
               s.created_at, s.updated_at, a.username, a.avatar
        FROM scripts s JOIN authors a ON a.discord_id = s.author_id
        WHERE ${condition} ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?
    `).bind(...binds, limit, offset).all();
    return json({ page, limit, total: Number(totalRow?.count) || 0, items: (results || []).map(row => {
        let tags = []; try { tags = JSON.parse(row.tags || "[]"); } catch { /* legacy */ }
        return { ...row, tags: Array.isArray(tags) ? tags : [], reviewed: !!row.reviewed };
    }) });
}

export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;

    let body;
    try {
        body = await request.json();
    } catch {
        return err(400, "请求格式错误");
    }

    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items || !items.length) return err(400, "没有要投稿的内容");
    if (items.length > MAX_BATCH) {
        return err(400, `单次最多 ${MAX_BATCH} 条，请分批提交`);
    }

    const defaultAuthor = String(body?.author_id || "").trim();

    // ── 第一轮：纯内存校验，不碰数据库 ──
    const results = new Array(items.length).fill(null);
    const pending = [];

    for (let i = 0; i < items.length; i++) {
        const raw = items[i];
        const label = String(raw?.name || `第 ${i + 1} 条`);
        const authorId = String(raw?.author_id || defaultAuthor).trim();

        if (!authorId) {
            results[i] = { index: i, name: label, ok: false, error: "未指定归属作者" };
            continue;
        }

        const check = validateScript(raw);
        if (!check.ok) {
            results[i] = { index: i, name: label, ok: false, error: check.message };
            continue;
        }

        pending.push({ index: i, label, authorId, value: check.value });
    }

    // ── 作者校验：所有 author_id 一次查完 ──
    if (pending.length) {
        const ids = [...new Set(pending.map(p => p.authorId))];
        const { results: rows } = await env.DB.prepare(`
            SELECT discord_id, username, banned FROM authors
            WHERE discord_id IN (${ids.map(() => "?").join(",")})
        `).bind(...ids).all();

        const authors = new Map((rows || []).map(r => [r.discord_id, r]));

        for (const p of pending) {
            const author = authors.get(p.authorId);
            if (!author) {
                results[p.index] = { index: p.index, name: p.label, ok: false, error: "该作者尚未在工坊注册过" };
            } else if (author.banned) {
                results[p.index] = { index: p.index, name: p.label, ok: false, error: "该作者已被限制投稿" };
            } else {
                p.author = author;
            }
        }
    }

    // ── 算内容指纹，顺便挡掉同一批里的自我重复 ──
    // 这批里两条内容相同时，DB 查重查不出来（都还没入库），
    // 但插入时会撞唯一索引，所以要在这里先筛掉
    const survivors = [];
    const seenInBatch = new Map();

    for (const p of pending) {
        if (!p.author) continue;
        p.hash = await sha256(normalizeForHash(p.value.prompt));

        const twin = seenInBatch.get(p.hash);
        if (twin !== undefined) {
            results[p.index] = {
                index: p.index, name: p.label, ok: false,
                error: `与本批第 ${twin + 1} 条内容重复`
            };
            continue;
        }
        seenInBatch.set(p.hash, p.index);
        survivors.push(p);
    }

    // ── 查重：所有 hash 一次查完 ──
    if (survivors.length) {
        const hashes = survivors.map(p => p.hash);
        const { results: rows } = await env.DB.prepare(`
            SELECT id, content_hash FROM scripts
            WHERE status = 'public' AND content_hash IN (${hashes.map(() => "?").join(",")})
        `).bind(...hashes).all();

        const existing = new Map((rows || []).map(r => [r.content_hash, r.id]));

        for (let i = survivors.length - 1; i >= 0; i--) {
            const p = survivors[i];
            const dupId = existing.get(p.hash);
            if (dupId) {
                results[p.index] = {
                    index: p.index, name: p.label, ok: false,
                    error: "工坊里已有内容完全相同的指令",
                    duplicate_of: dupId
                };
                survivors.splice(i, 1);
            }
        }
    }

    // ── 插入：合并成一个 batch ──
    // D1 的 batch 是单事务，一条失败会整体回滚。
    // 前面已经把可预见的冲突都筛掉了，走到这里失败基本只剩并发竞争。
    if (survivors.length) {
        const ts = now();
        const stmt = env.DB.prepare(`
            INSERT INTO scripts
                (id, author_id, name, category, summary, prompt, tags, rating,
                 version, content_hash, downloads, status, anonymous, reviewed,
                 moderated_at, moderated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 'public', ?, 1, ?, ?, ?, ?)
        `);

        const batch = survivors.map(p => {
            p.newId = genId();
            const v = p.value;
            return stmt.bind(
                p.newId, p.author.discord_id, v.name, v.category, v.summary, v.prompt,
                JSON.stringify(v.tags), v.rating, p.hash, v.anonymous, ts, gate.author.discord_id, ts, ts
            );
        });

        try {
            await env.DB.batch(batch);
            await invalidatePublicList(request);
            for (const p of survivors) {
                results[p.index] = {
                    index: p.index, name: p.value.name, ok: true,
                    id: p.newId, author: p.author.username
                };
            }
        } catch (e) {
            const msg = String(e?.message || "");
            const reason = msg.includes("UNIQUE")
                ? "内容与工坊现有指令重复"
                : "写入失败，请重试";
            // 事务整体回滚，这批里没有一条真的入库
            for (const p of survivors) {
                results[p.index] = { index: p.index, name: p.label, ok: false, error: reason };
            }
        }
    }

    const final = results.map((r, i) => r || { index: i, ok: false, error: "未处理" });
    const succeeded = final.filter(r => r.ok).length;

    return json({
        ok: succeeded > 0,
        total: final.length,
        succeeded,
        failed: final.length - succeeded,
        results: final
    });
}
