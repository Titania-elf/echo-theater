// 管理员批量导入。
//
// 入口只对站长可见（/api/auth/me 的 is_admin），但那只是 UI 开关，
// 真正的权限判定在 /api/admin/* 每个接口里各做一次。
//
// 用途：把以前散落在本地的剧本一次性传上来，归属到已注册的作者名下。
import { el, mount, loading, toast } from "./dom.js";
import { adminAuthors, adminUpload, fetchCategories, invalidateList } from "./api.js";
import { getSession } from "./auth.js";

/** 服务端单请求上限是 100，这里留点余量，超出自动分批 */
const CHUNK = 50;

/** 预览列表最多渲染多少条。再多 DOM 就开始拖慢页面了 */
const PREVIEW_MAX = 300;

let categoryValues = new Set();

/** 分级的可选值。留空表示「还没指定」，会被 localIssue 挡下来 */
const RATINGS = [
    { value: "general", label: "全年龄" },
    { value: "mature", label: "成人向" }
];

const ratingLabel = value => RATINGS.find(r => r.value === value)?.label || "";

/**
 * 解析插件导出的 JSON。
 * 插件的导出格式就是 [{name, desc, prompt, category}, ...]，字段跟投稿接口一致。
 * 注意插件导出里没有 rating 字段 —— 缺失时一律留空让人来选，不猜成全年龄。
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
        rating: x?.rating === "mature" || x?.rating === "general" ? x.rating : ""
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

            return { name, desc, prompt: body, category, tags: [], rating: "" };
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
    if (!item.category) return "请选择分类";
    if (!categoryValues.has(item.category)) return `分类「${item.category}」不在固定选项中`;
    if (!ratingLabel(item.rating)) return "请选择内容分级";
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

    let authors, categories;
    try {
        const [authorData, categoryData] = await Promise.all([
            adminAuthors(),
            fetchCategories()
        ]);
        authors = authorData.items || [];
        categories = Array.isArray(categoryData?.items) ? categoryData.items : [];
        categoryValues = new Set(categories.map(item => item.value));
        if (!categories.length) throw new Error("暂时无法读取投稿分类");
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

    const categoryOptions = () => [
        el("option", {
            value: "",
            text: "保留文件中的有效分类",
            disabled: true
        }),
        ...categories.map(item => el("option", {
            value: item.value,
            text: `${item.value} — ${item.description}`
        }))
    ];

    const bulkCatIn = el("select", {}, categoryOptions());
    bulkCatIn.value = "";

    const bulkRatingIn = el("select", {}, [
        el("option", { value: "", text: "请选择分级", disabled: true }),
        ...RATINGS.map(r => el("option", { value: r.value, text: r.label }))
    ]);
    bulkRatingIn.value = "";

    const applyAll = (onlyEmpty) => {
        const value = bulkCatIn.value;
        if (!categoryValues.has(value)) return toast("请先选择分类");
        let touched = 0;
        for (const p of parsed) {
            if (onlyEmpty && categoryValues.has(p.category)) continue;
            p.category = value;
            p.issue = localIssue(p);
            touched++;
        }
        toast(touched ? `已更新 ${touched} 条的分类` : "没有需要更新的条目");
        paintPreview();
    };

    const applyAllRating = (onlyEmpty) => {
        const value = bulkRatingIn.value;
        if (!ratingLabel(value)) return toast("请先选择分级");
        let touched = 0;
        for (const p of parsed) {
            if (onlyEmpty && ratingLabel(p.rating)) continue;
            p.rating = value;
            p.issue = localIssue(p);
            touched++;
        }
        toast(touched ? `已把 ${touched} 条设为${ratingLabel(value)}` : "没有需要更新的条目");
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
                // 文件中的旧分类仍显示出来，但必须改成固定选项才能导入
                const legacyCategory = p.category && !categoryValues.has(p.category) ? p.category : "";
                const catIn = el("select", { class: "cat-inline" }, [
                    el("option", { value: "", text: "请选择分类", disabled: true }),
                    legacyCategory ? el("option", {
                        value: legacyCategory,
                        text: `原分类：${legacyCategory}（需调整）`,
                        disabled: true
                    }) : null,
                    ...categories.map(item => el("option", { value: item.value, text: item.value }))
                ]);
                catIn.value = p.category || "";
                catIn.onchange = () => {
                    p.category = catIn.value;
                    p.issue = localIssue(p);
                    paintPreview();
                };

                const ratingIn = el("select", { class: "cat-inline" }, [
                    el("option", { value: "", text: "请选择", disabled: true }),
                    ...RATINGS.map(r => el("option", { value: r.value, text: r.label }))
                ]);
                ratingIn.value = ratingLabel(p.rating) ? p.rating : "";
                ratingIn.onchange = () => {
                    p.rating = ratingIn.value;
                    p.issue = localIssue(p);
                    paintPreview();
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
                    el("div", { class: "row", style: "gap:8px;margin:6px 0" }, [
                        el("span", { class: "summary", text: "分级" }),
                        ratingIn
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
                        + `第 ${PREVIEW_MAX + 1} 条之后只能用上面的批量分类和批量分级调整。`
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
        // 分级写错的代价是单向的，导入前把成人向的条数摆出来再确认一次
        const matureCount = queue.filter(p => p.rating === "mature").length;
        const ratingNote = `\n\n分级：全年龄 ${queue.length - matureCount} 条，成人向 ${matureCount} 条。`;
        if (!confirm(`确定把 ${queue.length} 条指令导入并归属给「${author?.name}」吗？${ratingNote}\n\n导入后这些投稿会立即公开，作者本人可以编辑和下架。${anonNote}`)) return;

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
                text: "文件中的有效固定分类会保留；旧分类和空分类需要在这里批量调整，或在下方逐条选择。"
            }),
            el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
                bulkCatIn,
                el("button", { text: "套用到全部", onclick: () => applyAll(false) }),
                el("button", { text: "只调整无效分类", onclick: () => applyAll(true) })
            ])
        ]),

        el("div", { class: "card", style: "margin-top:12px" }, [
            el("h3", { style: "margin-top:0", text: "4. 内容分级" }),
            el("p", {
                class: "summary",
                text: "插件导出的文件里没有分级字段，所以必须在这里指定 —— 未指定分级的条目会被跳过，不会导入。"
            }),
            el("div", { class: "row", style: "gap:8px;flex-wrap:wrap" }, [
                bulkRatingIn,
                el("button", { text: "套用到全部", onclick: () => applyAllRating(false) }),
                el("button", { text: "只调整未指定的", onclick: () => applyAllRating(true) })
            ])
        ]),

        el("div", { class: "card", style: "margin-top:12px" }, [
            el("h3", { style: "margin-top:0", text: "5. 署名" }),
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
