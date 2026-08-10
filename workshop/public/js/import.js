// 管理员批量导入。
//
// 入口只对站长可见（/api/auth/me 的 is_admin），但那只是 UI 开关，
// 真正的权限判定在 /api/admin/* 每个接口里各做一次。
//
// 用途：把以前散落在本地的剧本一次性传上来，归属到已注册的作者名下。
import { el, mount, loading, toast } from "./dom.js";
import { adminAuthors, adminUpload, invalidateList } from "./api.js";
import { getSession } from "./auth.js";

/** 服务端单请求上限是 100，这里留点余量，超出自动分批 */
const CHUNK = 50;

/** 预览列表最多渲染多少条。再多 DOM 就开始拖慢页面了 */
const PREVIEW_MAX = 300;

/**
 * 解析插件导出的 JSON。
 * 插件的导出格式就是 [{name, desc, prompt, category}, ...]，字段跟投稿接口一致。
 */
function parseJson(text) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : null);
    if (!arr) throw new Error("JSON 顶层需要是数组");
    return arr.map(x => ({
        name: String(x?.name ?? "").trim(),
        desc: String(x?.desc ?? x?.summary ?? "").trim(),
        prompt: String(x?.prompt ?? "").trim(),
        category: String(x?.category ?? "").trim(),
        tags: Array.isArray(x?.tags) ? x.tags.map(String) : [],
        rating: x?.rating === "mature" ? "mature" : "general"
    }));
}

/**
 * 解析插件导出的 TXT。
 * 格式见插件的 exportScriptsToTxt：### 分隔，Title/Category/Desc 行做元信息。
 */
function parseTxt(text) {
    return text.split(/(?:^|\r?\n)\s*###/)
        .map(block => {
            if (!block.trim()) return null;

            const lines = block.split(/\r?\n/);
            let name = lines[0].trim();
            let body = lines.slice(1).join("\n").trim();

            // 行内标题过长时说明那行其实是正文，回退
            if (name.length > 60) {
                body = block.trim();
                name = "";
            }

            const take = (re) => {
                const m = body.match(re);
                if (!m) return "";
                body = body.replace(m[0], "").trim();
                return m[1].trim();
            };

            const title = take(/^(?:Title|标题)[:：]\s*(.+)$/im);
            const category = take(/^(?:Category|分类)[:：]\s*(.+)$/im);
            const desc = take(/^(?:Desc|简介|描述)[:：]\s*(.+)$/im);

            if (title) name = title;
            if (!body) return null;
            if (!name) name = body.replace(/\s+/g, " ").slice(0, 20) + "…";

            return { name, desc, prompt: body, category, tags: [], rating: "general" };
        })
        .filter(Boolean);
}

/** 本地预检，跟服务端 validateScript 的规则保持一致，尽早把问题暴露出来 */
function localIssue(item) {
    if (!item.name) return "缺少标题";
    if (item.name.length > 60) return "标题超过 60 字";
    if (item.prompt.length < 10) return "指令内容太短（至少 10 字）";
    if (item.prompt.length > 20000) return "指令内容超过 20000 字";
    if (item.desc.length > 200) return "简介超过 200 字";
    if (item.category.length > 20) return "分类超过 20 字";
    return null;
}

export async function renderImport() {
    const session = await getSession();

    if (!session?.logged_in) {
        mount(el("div", { class: "empty" }, [
            el("p", { text: "批量导入需要先登录" }),
            el("a", { href: "/api/auth/login" }, [
                el("button", { class: "primary", text: "使用 Discord 登录" })
            ])
        ]));
        return;
    }
    if (!session.is_admin) {
        mount(el("div", { class: "empty", text: "页面不存在" }));
        return;
    }

    mount(loading("正在读取作者列表…"));

    let authors, knownCategories = [];
    try {
        ({ items: authors, categories: knownCategories = [] } = await adminAuthors());
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    if (!authors.length) {
        mount(el("div", { class: "empty" }, [
            el("p", { text: "还没有任何注册作者。" }),
            el("p", {
                class: "summary",
                text: "投稿必须归属到已经用 Discord 登录过工坊的人。请先让作者本人登录一次，他的账号才会出现在这里。"
            })
        ]));
        return;
    }

    // ── 状态 ──
    let parsed = [];      // 解析出来的条目
    let fileName = "";

    // ── 控件 ──
    const authorSelect = el("select", {},
        authors.map(a => el("option", {
            value: a.id,
            text: `${a.name}${a.banned ? "（已封禁）" : ""} · ${a.script_count} 条`,
            disabled: a.banned || null
        }))
    );

    const fileInput = el("input", { type: "file", accept: ".json,.txt", style: "display:none" });
    const fileLabel = el("span", { class: "summary", text: "未选择文件" });
    const previewBox = el("div");
    const submitBtn = el("button", { class: "primary", text: "开始导入", disabled: true });
    const progress = el("p", { class: "summary", text: "" });
    const anonChk = el("input", { type: "checkbox" });

    // 现有分类做候选，减少「心理分析」和「心理分析 」这类同义碎片
    const CAT_LIST_ID = "knownCats";
    const catDatalist = el("datalist", { id: CAT_LIST_ID },
        knownCategories.map(c => el("option", { value: c })));

    const bulkCatIn = el("input", {
        type: "text", maxlength: "20", list: CAT_LIST_ID,
        placeholder: "留空表示不改动"
    });

    const applyAll = (onlyEmpty) => {
        const value = bulkCatIn.value.trim();
        if (!value && !onlyEmpty) {
            if (!confirm("分类留空，确定要清掉所有条目的分类吗？")) return;
        }
        let touched = 0;
        for (const p of parsed) {
            if (onlyEmpty && p.category) continue;
            p.category = value;
            p.issue = localIssue(p);
            touched++;
        }
        toast(touched ? `已更新 ${touched} 条的分类` : "没有需要更新的条目");
        paintPreview();
    };

    const paintPreview = () => {
        if (!parsed.length) {
            previewBox.replaceChildren();
            submitBtn.disabled = true;
            return;
        }

        const bad = parsed.filter(p => p.issue);
        const good = parsed.filter(p => !p.issue);
        submitBtn.disabled = good.length === 0;
        submitBtn.textContent = `导入 ${good.length} 条`;

        previewBox.replaceChildren(
            el("div", { class: "row", style: "margin:14px 0 8px" }, [
                el("h3", { style: "margin:0;font-size:15px", text: `解析出 ${parsed.length} 条` }),
                el("span", { class: "spacer" }),
                bad.length
                    ? el("span", { class: "tag mature", text: `${bad.length} 条有问题，将跳过` })
                    : el("span", { class: "tag", text: "全部可导入" })
            ]),
            el("div", { class: "cards" }, parsed.slice(0, PREVIEW_MAX).map((p, i) => {
                // 每条的分类单独可改：批量套一个大类之后，总有几条要挪窝
                const catIn = el("input", {
                    type: "text", value: p.category, maxlength: "20", list: CAT_LIST_ID,
                    placeholder: "未分类", class: "cat-inline"
                });
                catIn.oninput = () => {
                    p.category = catIn.value.trim();
                    const issue = localIssue(p);
                    // 只重画受影响的部分，避免每敲一个字就重建整个列表把焦点弄丢
                    if (issue !== p.issue) {
                        p.issue = issue;
                        paintPreview();
                    }
                };

                return el("div", {
                    class: "card",
                    style: p.issue ? "opacity:.5" : null
                }, [
                    el("h3", { text: `${i + 1}. ${p.name || "（无标题）"}` }),
                    p.desc && el("p", { class: "summary", text: p.desc }),
                    el("div", { class: "row", style: "gap:8px;margin:6px 0" }, [
                        el("span", { class: "summary", text: "分类" }),
                        catIn
                    ]),
                    el("div", { class: "meta" }, [
                        el("span", { text: `${p.prompt.length} 字` }),
                        p.issue && el("span", { class: "tag mature", text: p.issue })
                    ])
                ]);
            })),
            parsed.length > PREVIEW_MAX
                ? el("p", {
                    class: "summary",
                    text: `列表只显示前 ${PREVIEW_MAX} 条（会导入全部 ${good.length} 条）。`
                        + `第 ${PREVIEW_MAX + 1} 条之后只能用上面的批量分类调整。`
                })
                : null
        );
    };

    fileInput.onchange = async () => {
        const file = fileInput.files[0];
        if (!file) return;

        fileName = file.name;
        fileLabel.textContent = fileName;
        progress.textContent = "";

        try {
            const text = await file.text();
            parsed = fileName.toLowerCase().endsWith(".json") ? parseJson(text) : parseTxt(text);
            parsed.forEach(p => { p.issue = localIssue(p); });

            if (!parsed.length) throw new Error("没有解析出任何内容");
            toast(`解析出 ${parsed.length} 条`);
        } catch (e) {
            parsed = [];
            toast(`解析失败：${e.message}`);
        }
        paintPreview();
    };

    submitBtn.onclick = async () => {
        const authorId = authorSelect.value;
        const author = authors.find(a => a.id === authorId);
        const queue = parsed.filter(p => !p.issue);
        if (!queue.length) return;

        const anonNote = anonChk.checked
            ? "\n\n这批将以匿名投稿发布：对外只显示「匿名作者」，不显示头像和名字。"
            : "";
        if (!confirm(`确定把 ${queue.length} 条指令导入并归属给「${author?.name}」吗？\n\n导入后这些投稿会立即公开，作者本人可以编辑和下架。${anonNote}`)) return;

        submitBtn.disabled = true;
        const collected = [];

        for (let i = 0; i < queue.length; i += CHUNK) {
            const chunk = queue.slice(i, i + CHUNK);
            progress.textContent = `正在导入 ${i + 1}–${Math.min(i + CHUNK, queue.length)} / ${queue.length}…`;

            try {
                const res = await adminUpload({
                    author_id: authorId,
                    items: chunk.map(({ name, desc, prompt, category, tags, rating }) =>
                        ({ name, desc, prompt, category, tags, rating, anonymous: anonChk.checked }))
                });
                // 服务端的 index 是分片内的下标，换算成全局序号
                collected.push(...(res.results || []).map(r => ({ ...r, index: r.index + i })));
            } catch (e) {
                chunk.forEach((c, k) => collected.push({
                    index: i + k, name: c.name, ok: false, error: e.message
                }));
            }
        }

        invalidateList();

        const okCount = collected.filter(r => r.ok).length;
        const failed = collected.filter(r => !r.ok);
        progress.textContent = "";

        mount(
            el("h1", { style: "font-size:20px;margin:0 0 14px", text: "导入完成" }),
            el("p", { text: `成功 ${okCount} 条，失败 ${failed.length} 条，归属于 ${author?.name}。` }),
            failed.length
                ? el("div", { class: "cards", style: "margin-top:14px" }, failed.map(r =>
                    el("div", { class: "card" }, [
                        el("h3", { text: `${r.index + 1}. ${r.name || "（无标题）"}` }),
                        el("p", { class: "summary", text: r.error || "未知错误" })
                    ])
                ))
                : null,
            el("div", { class: "row", style: "margin-top:18px" }, [
                el("a", { href: "#/" }, [el("button", { class: "primary", text: "去看看" })]),
                el("button", { text: "再导入一批", onclick: () => renderImport() })
            ])
        );
    };

    mount(
        el("h1", { style: "font-size:20px;margin:0 0 6px", text: "批量导入" }),
        el("p", {
            class: "summary",
            text: "把插件导出的剧本文件（.json 或 .txt）一次性导入工坊。导入的内容会归属到你选择的作者名下，之后由他本人管理。"
        }),

        el("div", { class: "card", style: "margin-top:16px" }, [
            el("h3", { style: "margin-top:0", text: "1. 归属作者" }),
            el("p", { class: "summary", text: "只能选择已经登录过工坊的人。" }),
            authorSelect
        ]),

        el("div", { class: "card", style: "margin-top:12px" }, [
            el("h3", { style: "margin-top:0", text: "2. 选择文件" }),
            el("p", { class: "summary", text: "支持插件「剧本资源管理 → 导出」产出的 JSON 和 TXT。" }),
            el("div", { class: "row" }, [
                el("button", { text: "浏览文件…", onclick: () => fileInput.click() }),
                fileLabel
            ]),
            fileInput
        ]),

        el("div", { class: "card", style: "margin-top:12px" }, [
            el("h3", { style: "margin-top:0", text: "3. 分类" }),
            el("p", {
                class: "summary",
                text: "文件里带的分类会照搬过来。想统一归类就在这里填，也可以在下面逐条微调。"
            }),
            el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
                bulkCatIn,
                el("button", { text: "套用到全部", onclick: () => applyAll(false) }),
                el("button", { text: "只填补未分类的", onclick: () => applyAll(true) })
            ]),
            catDatalist
        ]),

        el("div", { class: "card", style: "margin-top:12px" }, [
            el("h3", { style: "margin-top:0", text: "4. 署名" }),
            el("label", { class: "check-row" }, [
                anonChk,
                el("span", { text: "这批以匿名发布" })
            ]),
            el("p", {
                class: "field-hint",
                text: "勾选后对外只显示「匿名作者」，不显示头像和名字。归属关系不变，作者本人仍能编辑、下架或事后取消匿名。"
            })
        ]),

        previewBox,

        el("div", { class: "row", style: "margin-top:18px" }, [
            submitBtn,
            progress
        ])
    );
}
