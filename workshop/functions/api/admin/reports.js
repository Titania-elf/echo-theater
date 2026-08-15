// GET/POST /api/admin/reports —— 举报处理台
//
// 举报表在这之前只写不读：用户点「举报」会真的落库，但没有任何界面读它，
// handled 字段永远是 0。这个接口把后半段接上。
//
// 聚合单位是「被举报对象」而不是「单条举报」——
// 要处理的是「这条投稿有问题」，不是「第 7 号举报」。所以计数、标记已处理
// 都按 script_id / comment_id 整组操作，一次点击处理完这个对象的全部举报。
//
// open / handled 的筛选走 HAVING 而不是 WHERE：聚合始终覆盖该对象的全部历史举报，
// 这样「被举报过 5 次、这是第 6 次」和「第一次被举报」在列表里能区分开。
import { json, err, now, invalidatePublicList } from "../../_lib/util.js";
import { requireAdmin } from "../../_lib/admin.js";

/** 每组最多回传多少条理由。被刷举报的对象不该把响应撑爆 */
const MAX_REASONS = 20;

/** 未处理举报数。聚合和筛选都要用，写死成常量避免两处写法漂移 */
const OPEN_SUM = "SUM(CASE WHEN r.handled = 0 THEN 1 ELSE 0 END)";

/**
 * 两类举报的差异全部收敲在这张表里，查询语句本身是共用的。
 * 表名和列名都来自这里的常量，不接受请求参数，不存在拼接注入。
 */
const SOURCES = {
    script: {
        table: "reports",
        key: "script_id",
        // 举报可能指向已被彻底删掉的对象，所以一律 LEFT JOIN，宁可回传 target: null
        join: `LEFT JOIN scripts t ON t.id = r.script_id
               LEFT JOIN authors a ON a.discord_id = t.author_id`,
        columns: `t.id AS t_id, t.name AS t_name, t.status AS t_status, t.rating AS t_rating,
                  t.reviewed AS t_reviewed, t.author_id AS t_author_id, a.username AS t_username`,
        target: row => row.t_id ? {
            kind: "script",
            id: row.t_id,
            name: row.t_name,
            status: row.t_status,
            rating: row.t_rating,
            reviewed: !!row.t_reviewed,
            author: { id: row.t_author_id, name: row.t_username || "未知作者" }
        } : null
    },
    comment: {
        table: "comment_reports",
        key: "comment_id",
        join: `LEFT JOIN comments t ON t.id = r.comment_id
               LEFT JOIN scripts s ON s.id = t.script_id
               LEFT JOIN authors a ON a.discord_id = t.author_id`,
        columns: `t.id AS t_id, t.body AS t_body, t.status AS t_status, t.created_at AS t_created_at,
                  t.script_id AS t_script_id, s.name AS t_script_name,
                  t.author_id AS t_author_id, a.username AS t_username`,
        target: row => row.t_id ? {
            kind: "comment",
            id: row.t_id,
            body: row.t_body,
            status: row.t_status,
            created_at: row.t_created_at,
            script: { id: row.t_script_id, name: row.t_script_name || "已删除投稿" },
            author: { id: row.t_author_id, name: row.t_username || "未知用户" }
        } : null
    }
};

/**
 * 老库没跑过 migrate-comments.sql 时 comment_reports 不存在。
 * 这种情况要给出「去跑迁移」的提示，不能变成一个看不出原因的 500。
 */
const isMissingTable = e => /no such table/i.test(String(e?.message || ""));

async function openCount(env, { table, key }) {
    try {
        const row = await env.DB
            .prepare(`SELECT COUNT(DISTINCT ${key}) AS count FROM ${table} WHERE handled = 0`)
            .first();
        return Number(row?.count) || 0;
    } catch (e) {
        // 缺表回传 null，让前端能区分「没有举报」和「表还没建」
        if (isMissingTable(e)) return null;
        throw e;
    }
}

async function openTotals(env) {
    const [script, comment] = await Promise.all([
        openCount(env, SOURCES.script),
        openCount(env, SOURCES.comment)
    ]);
    return { script, comment };
}

export async function onRequestGet({ request, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;

    const url = new URL(request.url);
    const open_totals = await openTotals(env);

    // 导航徽标只要数字，不必跑聚合和理由查询
    if (url.searchParams.get("count")) return json({ open_totals });

    const type = url.searchParams.get("type") === "comment" ? "comment" : "script";
    const src = SOURCES[type];
    const asked = String(url.searchParams.get("status") || "");
    const status = ["open", "handled", "all"].includes(asked) ? asked : "open";
    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(50, Math.max(10, Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20));
    const offset = (page - 1) * limit;

    const having = status === "open" ? `HAVING ${OPEN_SUM} > 0`
        : status === "handled" ? `HAVING ${OPEN_SUM} = 0`
        : "";

    let totalRow, groups;
    try {
        totalRow = await env.DB.prepare(`
            SELECT COUNT(*) AS count FROM (
                SELECT r.${src.key} FROM ${src.table} r GROUP BY r.${src.key} ${having}
            )
        `).first();

        const res = await env.DB.prepare(`
            SELECT r.${src.key} AS target_id,
                   COUNT(*) AS report_count,
                   ${OPEN_SUM} AS open_count,
                   COUNT(DISTINCT r.reporter_id) AS named_reporters,
                   SUM(CASE WHEN r.reporter_id IS NULL THEN 1 ELSE 0 END) AS anon_reports,
                   MIN(r.created_at) AS first_at,
                   MAX(r.created_at) AS last_at,
                   ${src.columns}
            FROM ${src.table} r
            ${src.join}
            GROUP BY r.${src.key}
            ${having}
            ORDER BY open_count DESC, last_at DESC
            LIMIT ? OFFSET ?
        `).bind(limit, offset).all();
        groups = res.results || [];
    } catch (e) {
        if (isMissingTable(e)) {
            return json({ page, limit, type, status, total: 0, items: [], open_totals, missing_table: src.table });
        }
        throw e;
    }

    // 理由单独查一次：跟在聚合里 group_concat 比，这样能保留每条的举报人和 handled
    const reasons = new Map();
    if (groups.length) {
        const ids = groups.map(g => g.target_id);
        const { results } = await env.DB.prepare(`
            SELECT r.id, r.${src.key} AS target_id, r.reason, r.created_at, r.handled,
                   r.reporter_id, a.username AS reporter_name
            FROM ${src.table} r
            LEFT JOIN authors a ON a.discord_id = r.reporter_id
            WHERE r.${src.key} IN (${ids.map(() => "?").join(",")})
            ORDER BY r.created_at DESC
        `).bind(...ids).all();

        for (const row of results || []) {
            const list = reasons.get(row.target_id) || [];
            reasons.set(row.target_id, list);
            if (list.length >= MAX_REASONS) continue;
            list.push({
                id: row.id,
                reason: row.reason || "",
                created_at: row.created_at,
                handled: !!row.handled,
                reporter: row.reporter_id
                    ? { id: row.reporter_id, name: row.reporter_name || "未知用户" }
                    : null
            });
        }
    }

    return json({
        page, limit, type, status,
        total: Number(totalRow?.count) || 0,
        open_totals,
        items: groups.map(row => ({
            target_id: row.target_id,
            report_count: Number(row.report_count) || 0,
            open_count: Number(row.open_count) || 0,
            // 同一个登录用户刷 5 次，report_count 是 5 而 named_reporters 是 1。
            // 这个差值就是判断「围攻」还是「一个人在刷」的依据
            named_reporters: Number(row.named_reporters) || 0,
            anon_reports: Number(row.anon_reports) || 0,
            first_at: row.first_at,
            last_at: row.last_at,
            target: src.target(row),
            reasons: reasons.get(row.target_id) || []
        }))
    });
}

/**
 * 处理举报：下架/隐藏被举报对象、标记该对象的举报为已处理，两件事可以一次做完。
 * body: { type, target_id, action?, handled? }
 *   action —— 投稿 remove/restore，评论 hide/restore
 *   handled —— true 标记已处理，false 重新打开
 */
export async function onRequestPost({ request, env }) {
    const gate = await requireAdmin(request, env);
    if (gate.response) return gate.response;

    let body;
    try { body = await request.json(); } catch { return err(400, "请求格式错误"); }

    const type = body?.type === "comment" ? "comment" : "script";
    const src = SOURCES[type];
    const targetId = String(body?.target_id || "").trim();
    if (!targetId) return err(400, "未指定举报对象");

    const action = String(body?.action || "");
    const allowed = type === "script" ? ["", "remove", "restore"] : ["", "hide", "restore"];
    if (!allowed.includes(action)) return err(400, "操作无效");

    const markHandled = body?.handled === true || body?.handled === 1;
    const markOpen = body?.handled === false || body?.handled === 0;
    if (!action && !markHandled && !markOpen) return err(400, "没有要执行的操作");

    const ts = now();
    const batch = [];
    let touchedPublicList = false;

    if (action && type === "script") {
        const row = await env.DB.prepare("SELECT id, status, content_hash FROM scripts WHERE id = ?")
            .bind(targetId).first();
        if (!row) return err(404, "投稿不存在");
        if (action === "restore") {
            // 下架期间可能有人投了相同内容，恢复前要按唯一索引的规则先确认
            const dup = await env.DB.prepare("SELECT id FROM scripts WHERE content_hash = ? AND status = 'public' AND id != ?")
                .bind(row.content_hash, targetId).first();
            if (dup) return err(409, "已有公开投稿使用完全相同的内容");
        }
        batch.push(env.DB.prepare("UPDATE scripts SET status = ?, updated_at = ? WHERE id = ?")
            .bind(action === "remove" ? "removed" : "public", ts, targetId));
        touchedPublicList = true;
    }

    if (action && type === "comment") {
        const row = await env.DB.prepare("SELECT id, status FROM comments WHERE id = ?").bind(targetId).first();
        if (!row) return err(404, "评论不存在");
        // deleted 是作者自己删的，管理端不去改它 —— 已经不可见，恢复它也不合适
        if (row.status === "deleted") return err(409, "该评论已被作者删除");
        // removed 仍然占着 idx_comment_once，被隐藏的人不能换一条重发
        batch.push(env.DB.prepare("UPDATE comments SET status = ?, updated_at = ? WHERE id = ?")
            .bind(action === "hide" ? "removed" : "public", ts, targetId));
    }

    if (markHandled || markOpen) {
        batch.push(env.DB.prepare(`UPDATE ${src.table} SET handled = ? WHERE ${src.key} = ?`)
            .bind(markHandled ? 1 : 0, targetId));
    }

    try {
        await env.DB.batch(batch);
    } catch (e) {
        if (isMissingTable(e)) return err(503, `${src.table} 表不存在，请先执行 migrate-comments.sql`);
        throw e;
    }

    if (touchedPublicList) await invalidatePublicList(request);
    return json({ ok: true });
}
