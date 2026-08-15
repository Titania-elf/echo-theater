import { el, mount, loading, toast, fmtDate } from "./dom.js";
import { getSession } from "./auth.js";
import {
    adminAuthors, adminScripts, adminScript, adminUpdateScript,
    adminScriptAction, adminBatchUpdate, adminReports, adminReportCounts,
    adminReportAction, fetchCategories, invalidateList
} from "./api.js";

const option = (value, text) => el("option", { value, text });

/**
 * 未处理举报数。徽标和标签页的角标共用一份，
 * 免得同一个数字在页面上要请求两次
 */
let openReports = 0;

/** 顶栏「内容管理」上的角标。只有站长会调用 */
export async function refreshReportBadge() {
    const badge = document.getElementById("reportBadge");
    if (!badge) return;
    try {
        const { open_totals } = await adminReportCounts();
        openReports = (open_totals?.script || 0) + (open_totals?.comment || 0);
        badge.textContent = openReports > 99 ? "99+" : String(openReports || "");
        badge.hidden = !openReports;
    } catch {
        badge.hidden = true;
    }
}

function syncReportBadge(open_totals) {
    openReports = (open_totals?.script || 0) + (open_totals?.comment || 0);
    const badge = document.getElementById("reportBadge");
    if (!badge) return;
    badge.textContent = openReports > 99 ? "99+" : String(openReports || "");
    badge.hidden = !openReports;
}

const adminTabs = active => el("div", { class: "admin-tabs" }, [
    el("a", { class: `admin-tab${active === "scripts" ? " is-active" : ""}`, href: "#/admin", text: "投稿" }),
    el("a", { class: `admin-tab${active === "reports" ? " is-active" : ""}`, href: "#/admin/reports" }, [
        el("span", { text: "举报" }),
        openReports ? el("span", { class: "admin-tab-count", text: String(openReports) }) : null
    ])
]);

async function requireAdminPage() {
    const session = await getSession();
    if (!session?.is_admin) {
        mount(el("div", { class: "empty", text: "页面不存在" }));
        return false;
    }
    return true;
}

export async function renderAdmin(id) {
    if (!await requireAdminPage()) return;
    // 投稿 id 一律是 ws_ 前缀，跟这个子路由撞不上
    if (id === "reports") return renderAdminReports();
    if (id) return renderAdminEditor(id);
    return renderAdminList();
}

async function renderAdminList() {
    mount(loading("正在加载内容管理…"));
    let authors, categories;
    try {
        const [authorData, categoryData] = await Promise.all([adminAuthors(), fetchCategories()]);
        authors = authorData.items || [];
        categories = categoryData.items || [];
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    let page = 1;
    let selected = new Set();
    const search = el("input", { type: "search", placeholder: "搜索标题、简介或作者" });
    const reviewed = el("select", {}, [option("0", "待审核"), option("all", "全部审核状态"), option("1", "已审核")]);
    const rating = el("select", {}, [option("", "全部分级"), option("general", "全年龄"), option("mature", "成人向")]);
    const category = el("select", {}, [option("", "全部分类"), ...categories.map(x => option(x.value, x.value))]);
    const status = el("select", {}, [option("all", "公开与下架"), option("public", "公开"), option("removed", "已下架"), option("deleted", "已删除")]);
    const resultBox = el("div", { class: "admin-list" });
    const summary = el("div", { class: "admin-summary" });
    const pager = el("div", { class: "admin-pager" });
    const batchBar = el("div", { class: "admin-batch", hidden: true });

    const filters = () => ({ page, limit: 20, q: search.value.trim(), reviewed: reviewed.value, rating: rating.value, category: category.value, status: status.value });

    const runBatch = async (payload, label) => {
        if (!selected.size) return;
        try {
            await adminBatchUpdate({ ids: [...selected], ...payload });
            invalidateList();
            toast(`已${label} ${selected.size} 条投稿`);
            selected = new Set();
            await load();
        } catch (e) { toast(e.message); }
    };

    const paintBatch = () => {
        batchBar.hidden = selected.size === 0;
        batchBar.replaceChildren(
            el("strong", { text: `已选 ${selected.size} 条` }),
            el("button", { text: "标记已审核", onclick: () => runBatch({ reviewed: true }, "审核") }),
            el("button", { text: "设为全年龄", onclick: () => runBatch({ rating: "general" }, "调整") }),
            el("button", { text: "设为成人向", onclick: () => runBatch({ rating: "mature" }, "调整") }),
            el("button", { text: "公开", onclick: () => runBatch({ status: "public" }, "公开") }),
            el("button", { class: "danger", text: "下架", onclick: () => runBatch({ status: "removed" }, "下架") })
        );
    };

    const load = async () => {
        resultBox.replaceChildren(loading());
        let data;
        try { data = await adminScripts(filters()); }
        catch (e) { resultBox.replaceChildren(el("div", { class: "empty", text: `加载失败：${e.message}` })); return; }
        const pages = Math.max(1, Math.ceil(data.total / data.limit));
        if (page > pages) { page = pages; return load(); }
        summary.textContent = `共 ${data.total} 条，第 ${page} / ${pages} 页`;
        resultBox.replaceChildren(...data.items.map(s => {
            const check = el("input", { type: "checkbox", "aria-label": `选择 ${s.name}` });
            check.checked = selected.has(s.id);
            check.addEventListener("change", () => {
                if (check.checked) selected.add(s.id); else selected.delete(s.id);
                paintBatch();
            });
            return el("div", { class: "admin-row" }, [
                check,
                el("div", { class: "admin-row-main" }, [
                    el("a", { class: "admin-title", href: `#/admin/${s.id}`, text: s.name }),
                    el("div", { class: "admin-row-meta" }, [
                        el("span", { text: s.username }),
                        s.category && el("span", { class: "tag cat", text: s.category }),
                        el("span", { class: s.rating === "mature" ? "tag mature" : "tag", text: s.rating === "mature" ? "成人向" : "全年龄" }),
                        el("span", { class: s.reviewed ? "tag reviewed" : "tag pending", text: s.reviewed ? "已审核" : "待审核" }),
                        s.status !== "public" && el("span", { class: "tag", text: s.status === "removed" ? "已下架" : "已删除" }),
                        el("span", { text: fmtDate(s.updated_at) })
                    ])
                ]),
                el("a", { class: "admin-open", href: `#/admin/${s.id}`, text: "管理" })
            ]);
        }));
        if (!data.items.length) resultBox.replaceChildren(el("div", { class: "empty", text: "没有符合条件的投稿" }));
        pager.replaceChildren(
            el("button", { text: "上一页", disabled: page <= 1, onclick: () => { page--; load(); } }),
            el("button", { text: "下一页", disabled: page >= pages, onclick: () => { page++; load(); } })
        );
    };

    const applyFilters = () => { page = 1; selected = new Set(); paintBatch(); load(); };
    [reviewed, rating, category, status].forEach(node => node.addEventListener("change", applyFilters));
    search.addEventListener("keydown", e => { if (e.key === "Enter") applyFilters(); });

    mount(
        el("div", { class: "row admin-head" }, [
            el("h1", { text: "内容管理" }),
            el("span", { class: "spacer" }),
            el("a", { href: "#/import" }, [el("button", { text: "批量投稿" })])
        ]),
        adminTabs("scripts"),
        el("div", { class: "toolbar admin-filters" }, [search, reviewed, rating, category, status, el("button", { text: "搜索", onclick: applyFilters })]),
        batchBar, summary, resultBox, pager
    );
    await load();
}

const STATUS_LABEL = { public: "公开中", removed: "已下架", deleted: "已删除" };

/** 「3 条举报，来自 1 个登录用户 + 2 条匿名」—— 一个人刷和多人围攻要能分辨 */
function reporterSummary(item) {
    const parts = [];
    if (item.named_reporters) parts.push(`${item.named_reporters} 个登录用户`);
    if (item.anon_reports) parts.push(`${item.anon_reports} 条匿名`);
    return parts.length ? `来自 ${parts.join(" + ")}` : "";
}

async function renderAdminReports() {
    let type = "script";
    let status = "open";
    let page = 1;

    const typeSelect = el("select", {}, [option("script", "投稿举报"), option("comment", "评论举报")]);
    const statusSelect = el("select", {}, [option("open", "待处理"), option("handled", "已处理"), option("all", "全部")]);
    const resultBox = el("div", { class: "admin-list" });
    const summary = el("div", { class: "admin-summary" });
    const pager = el("div", { class: "admin-pager" });
    const tabs = el("div");

    const act = async (item, payload, label) => {
        try {
            await adminReportAction({ type, target_id: item.target_id, ...payload });
            invalidateList();
            toast(label);
            await load();
        } catch (e) { toast(e.message); }
    };

    const reportRow = item => {
        const t = item.target;
        const isScript = type === "script";
        const actions = [];

        if (t && isScript) {
            actions.push(t.status === "public"
                ? el("button", { class: "danger", text: "下架并标记已处理", onclick: () => act(item, { action: "remove", handled: true }, "已下架并标记处理") })
                : t.status === "removed"
                    ? el("button", { text: "恢复公开", onclick: () => act(item, { action: "restore" }, "已恢复公开") })
                    : null);
        }
        if (t && !isScript) {
            actions.push(t.status === "public"
                ? el("button", { class: "danger", text: "隐藏并标记已处理", onclick: () => act(item, { action: "hide", handled: true }, "已隐藏并标记处理") })
                : t.status === "removed"
                    ? el("button", { text: "恢复评论", onclick: () => act(item, { action: "restore" }, "已恢复评论") })
                    : null);
        }
        actions.push(item.open_count
            ? el("button", { text: "仅标记已处理", onclick: () => act(item, { handled: true }, "已标记处理") })
            : el("button", { text: "重新打开", onclick: () => act(item, { handled: false }, "已重新打开") }));

        // 举报对象可能已被彻底删掉，这时只剩举报记录本身可看
        const href = !t ? null
            : isScript ? `#/s/${t.id}`
            : `#/comment/${t.script.id}/${t.id}`;
        const title = !t ? (isScript ? "投稿已不存在" : "评论已不存在")
            : isScript ? t.name
            : `《${t.script.name}》下的评论`;

        return el("div", { class: "admin-row report-row" }, [
            el("div", { class: "admin-row-main" }, [
                href
                    ? el("a", { class: "admin-title", href, text: title })
                    : el("span", { class: "admin-title report-title-gone", text: title }),
                el("div", { class: "admin-row-meta" }, [
                    el("span", {
                        class: item.open_count ? "tag pending" : "tag reviewed",
                        text: item.open_count ? `${item.open_count} 条待处理` : "已处理"
                    }),
                    el("span", { text: `共 ${item.report_count} 条举报` }),
                    reporterSummary(item) ? el("span", { text: reporterSummary(item) }) : null,
                    t && el("span", {
                        class: t.status === "public" ? "tag" : "tag pending",
                        text: STATUS_LABEL[t.status] || t.status
                    }),
                    t && el("span", { text: isScript ? t.author.name : `评论者 ${t.author.name}` }),
                    el("span", { text: `最近 ${fmtDate(item.last_at)}` })
                ]),
                // 评论内容本身就是要判断的东西，直接摊在这里，省一次跳转
                !isScript && t && el("p", { class: "report-quote", text: t.body }),
                // 三元而不是 && —— el() 只跳过 null/undefined/false，
                // 用长度做短路会把 0 当成文本节点渲染出来
                item.reasons.length ? el("ul", { class: "report-reasons" }, item.reasons.map(r => el("li", {}, [
                    el("span", { class: "report-reason-text", text: r.reason }),
                    el("span", { class: "report-reason-meta", text: [
                        r.reporter ? r.reporter.name : "匿名举报",
                        fmtDate(r.created_at),
                        r.handled ? "已处理" : ""
                    ].filter(Boolean).join(" · ") })
                ]))) : null,
                el("div", { class: "report-actions" }, actions)
            ])
        ]);
    };

    const load = async () => {
        resultBox.replaceChildren(loading());
        let data;
        try { data = await adminReports({ type, status, page, limit: 20 }); }
        catch (e) { resultBox.replaceChildren(el("div", { class: "empty", text: `加载失败：${e.message}` })); return; }

        syncReportBadge(data.open_totals);
        tabs.replaceChildren(adminTabs("reports"));

        // 评论举报表是 migrate-comments.sql 建的，老库可能没跑过
        if (data.missing_table) {
            summary.textContent = "";
            pager.replaceChildren();
            resultBox.replaceChildren(el("div", { class: "empty" }, [
                el("p", { text: `数据库里没有 ${data.missing_table} 表，这类举报现在提交会失败。` }),
                el("p", { class: "summary", text: "执行 wrangler d1 execute echo-workshop --remote --file=./migrate-comments.sql 后再回来。" })
            ]));
            return;
        }

        const pages = Math.max(1, Math.ceil(data.total / data.limit));
        if (page > pages) { page = pages; return load(); }

        const pendingHint = [
            data.open_totals?.script ? `投稿待处理 ${data.open_totals.script}` : "",
            data.open_totals?.comment ? `评论待处理 ${data.open_totals.comment}` : ""
        ].filter(Boolean).join(" · ");
        summary.textContent = `共 ${data.total} 组，第 ${page} / ${pages} 页${pendingHint ? `　·　${pendingHint}` : ""}`;

        resultBox.replaceChildren(...data.items.map(reportRow));
        if (!data.items.length) {
            resultBox.replaceChildren(el("div", { class: "empty", text: status === "open" ? "没有待处理的举报" : "没有符合条件的举报" }));
        }
        pager.replaceChildren(
            el("button", { text: "上一页", disabled: page <= 1, onclick: () => { page--; load(); } }),
            el("button", { text: "下一页", disabled: page >= pages, onclick: () => { page++; load(); } })
        );
    };

    typeSelect.addEventListener("change", () => { type = typeSelect.value; page = 1; load(); });
    statusSelect.addEventListener("change", () => { status = statusSelect.value; page = 1; load(); });

    mount(
        el("div", { class: "row admin-head" }, [
            el("h1", { text: "举报处理" }),
            el("span", { class: "spacer" })
        ]),
        tabs,
        el("div", { class: "toolbar admin-filters" }, [typeSelect, statusSelect]),
        summary, resultBox, pager
    );
    tabs.replaceChildren(adminTabs("reports"));
    await load();
}

async function renderAdminEditor(id) {
    mount(loading("正在加载投稿…"));
    let item, authors, categories;
    try {
        const [scriptData, authorData, categoryData] = await Promise.all([adminScript(id), adminAuthors(), fetchCategories()]);
        item = scriptData.item; authors = authorData.items || []; categories = categoryData.items || [];
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    const name = el("input", { value: item.name, maxlength: "60" });
    const author = el("select", {}, authors.map(a => option(a.id, `${a.name}${a.banned ? "（已限制）" : ""}`)));
    author.value = item.author_id;
    const category = el("select", {}, categories.map(x => option(x.value, x.value))); category.value = item.category;
    const summary = el("input", { value: item.summary || "", maxlength: "200" });
    const tags = el("input", { value: (item.tags || []).join(", ") });
    const rating = el("select", {}, [option("general", "全年龄"), option("mature", "成人向")]); rating.value = item.rating;
    const status = el("select", {}, [option("public", "公开"), option("removed", "下架"), option("deleted", "删除")]); status.value = item.status;
    const reviewed = el("input", { type: "checkbox" }); reviewed.checked = !!item.reviewed;
    const anonymous = el("input", { type: "checkbox" }); anonymous.checked = !!item.anonymous;
    const note = el("textarea", { rows: "3", maxlength: "500" }); note.value = item.moderation_note || "";
    const prompt = el("textarea", { rows: "18", maxlength: "20000" }); prompt.value = item.prompt || "";
    const save = el("button", { class: "primary", text: "保存修改" });
    save.addEventListener("click", async () => {
        save.disabled = true;
        try {
            await adminUpdateScript(id, {
                name: name.value.trim(), author_id: author.value, category: category.value,
                summary: summary.value.trim(), tags: tags.value.split(/[,，]/).map(x => x.trim()).filter(Boolean).slice(0, 5),
                rating: rating.value, status: status.value, reviewed: reviewed.checked,
                anonymous: anonymous.checked, moderation_note: note.value.trim(), prompt: prompt.value.trim()
            });
            invalidateList(); toast("已保存");
            location.hash = "#/admin";
        } catch (e) { toast(e.message); save.disabled = false; }
    });

    const quickAction = async action => {
        try {
            await adminScriptAction(id, action, note.value.trim()); invalidateList();
            toast(action === "review" ? "已标记为审核完成" : action === "remove" ? "已下架" : "已恢复公开");
            location.hash = "#/admin";
        } catch (e) { toast(e.message); }
    };
    const field = (label, node) => el("div", { class: "field" }, [el("label", { text: label }), node]);
    mount(
        el("a", { class: "admin-back", href: "#/admin", text: "← 返回内容管理" }),
        el("div", { class: "row admin-head" }, [el("h1", { text: "管理投稿" }), el("span", { class: "spacer" }), el("span", { class: "admin-id", text: id })]),
        el("div", { class: "admin-form-grid" }, [field("标题", name), field("归属作者", author), field("分类", category), field("分级", rating), field("状态", status), field("简介", summary)]),
        field("标签", tags),
        el("div", { class: "admin-checks" }, [
            el("label", { class: "check-row" }, [reviewed, el("span", { text: "已人工审核" })]),
            el("label", { class: "check-row" }, [anonymous, el("span", { text: "匿名发布" })])
        ]),
        field("审核备注", note), field("完整内容", prompt),
        el("div", { class: "actions" }, [
            save,
            !item.reviewed && el("button", { text: "直接标记已审核", onclick: () => quickAction("review") }),
            item.status === "public"
                ? el("button", { class: "danger", text: "下架", onclick: () => quickAction("remove") })
                : el("button", { text: "恢复公开", onclick: () => quickAction("restore") })
        ])
    );
}
