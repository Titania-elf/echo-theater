import { el, mount, loading, toast, fmtDate } from "./dom.js";
import { getSession } from "./auth.js";
import {
    adminAuthors, adminScripts, adminScript, adminUpdateScript,
    adminScriptAction, adminBatchUpdate, fetchCategories, invalidateList
} from "./api.js";

const option = (value, text) => el("option", { value, text });

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
        el("div", { class: "toolbar admin-filters" }, [search, reviewed, rating, category, status, el("button", { text: "搜索", onclick: applyFilters })]),
        batchBar, summary, resultBox, pager
    );
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
