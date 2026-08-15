// 我的投稿
import { el, mount, loading, toast, fmtDate } from "./dom.js";
import { myScripts, deleteScript, restoreScript, purgeScript, batchDeleteScripts, invalidateList } from "./api.js";
import { getSession } from "./auth.js";

export async function renderMine() {
    const session = await getSession();

    if (!session?.logged_in) {
        mount(el("div", { class: "empty" }, [
            el("p", { text: "投稿和管理需要先用 Discord 登录" }),
            el("a", { href: "/api/auth/login" }, [
                el("button", { class: "primary", text: "使用 Discord 登录" })
            ])
        ]));
        return;
    }

    if (session.banned) {
        mount(el("div", { class: "empty", text: "你的账号已被限制投稿。如有疑问请在 Discord 联系管理员。" }));
        return;
    }

    mount(loading());

    let items;
    try {
        ({ items } = await myScripts());
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    const newBtn = el("a", { href: "#/new" }, [el("button", { class: "primary", text: "＋ 发布新指令" })]);
    let selected = new Set();
    const batchBar = el("div", { class: "mine-batch", hidden: true });
    const selectAllBtn = el("button", { text: "全选" });
    selectAllBtn.addEventListener("click", () => {
        selected = selected.size === items.length ? new Set() : new Set(items.map(item => item.id));
        paintBatchBar();
        paint();
    });

    const paintBatchBar = () => {
        batchBar.hidden = selected.size === 0;
        batchBar.replaceChildren(
            el("strong", { text: `已选 ${selected.size} 条` }),
            el("button", { class: "danger", text: "批量删除", onclick: async () => {
                const count = selected.size;
                if (!confirm(`确定永久删除选中的 ${count} 条投稿吗？\n\n它们会从“我的投稿”中消失，之后无法恢复。`)) return;
                try {
                    await batchDeleteScripts([...selected]);
                    invalidateList();
                    items = items.filter(item => !selected.has(item.id));
                    selected = new Set();
                    toast(`已删除 ${count} 条投稿`);
                    paintBatchBar();
                    paint();
                } catch (e) { toast(e.message); }
            }})
        );
    };

    if (!items.length) {
        mount(el("div", { class: "empty" }, [
            el("p", { text: "你还没有投稿过。" }),
            newBtn
        ]));
        return;
    }

    const listBox = el("div", { class: "cards" });
    const emptyNote = el("p", { class: "summary", hidden: true, text: "这里空了。点右上角发布新指令。" });

    const paint = () => {
        // 删光之后卡片区会是空的，给一句提示，别留一片空白
        emptyNote.hidden = items.length > 0;
        selectAllBtn.textContent = items.length && selected.size === items.length ? "取消全选" : "全选";
        listBox.replaceChildren(...items.map(s => {
            const removed = s.status === "removed";
            const select = el("input", { type: "checkbox", class: "mine-select", "aria-label": `选择 ${s.name}` });
            select.checked = selected.has(s.id);
            select.addEventListener("change", () => {
                if (select.checked) selected.add(s.id); else selected.delete(s.id);
                paintBatchBar();
            });

            const onDelete = async () => {
                if (!confirm(`确定下架「${s.name}」吗？下架后其他人将无法看到，你可以随时重新上架。`)) return;
                try {
                    await deleteScript(s.id);
                    invalidateList();
                    // 下架是软删除，条目还在库里 —— 这里只改状态，不能从列表里抹掉，
                    // 否则用户会以为被删了，而且没有入口重新上架
                    s.status = "removed";
                    toast("已下架");
                    paint();
                } catch (e) {
                    toast(e.message);
                }
            };

            const onPurge = async () => {
                // 删除不可恢复，所以要求手打标题确认 —— 比再点一次「确定」更难误触
                const typed = prompt(
                    `删除「${s.name}」后无法恢复，已经下载过的人不受影响。

    ` +
                    `确认请输入指令标题：`
                );
                if (typed === null) return;
                if (typed.trim() !== s.name.trim()) return toast("标题不匹配，已取消");

                try {
                    await purgeScript(s.id);
                    invalidateList();
                    // 这里才该从列表里抹掉：服务端已置成 deleted，刷新也不会回来
                    items = items.filter(x => x.id !== s.id);
                    selected.delete(s.id);
                    toast("已删除");
                    paintBatchBar();
                    paint();
                } catch (e) {
                    toast(e.message);
                }
            };

            const onRestore = async () => {
                try {
                    await restoreScript(s.id);
                    invalidateList();
                    s.status = "public";
                    toast("已重新上架");
                    paint();
                } catch (e) {
                    toast(e.message);
                }
            };

            return el("div", { class: "card", style: removed ? "opacity:.55" : null }, [
                el("div", { class: "row mine-card-title" }, [select, el("h3", { text: s.name })]),
                s.desc && el("p", { class: "summary", text: s.desc }),
                el("div", { class: "meta" }, [
                    s.category && el("span", { class: "tag", text: s.category }),
                    s.rating === "mature" && el("span", { class: "tag mature", text: "成人向" }),
                    s.anonymous && el("span", { class: "tag", text: "🕶 匿名" }),
                    removed && el("span", { class: "tag", text: "已下架" }),
                    el("span", { text: `v${s.version} · ↓ ${s.downloads} · ${fmtDate(s.updated_at)}` })
                ]),
                el("div", { class: "row", style: "margin-top:8px" }, [
                    el("a", { href: `#/s/${s.id}`, text: "查看", style: "font-size:13px;color:var(--muted)" }),
                    el("span", { class: "spacer" }),
                    el("button", { text: "编辑", onclick: () => { location.hash = `#/edit/${s.id}`; } }),
                    removed
                        ? el("button", { text: "重新上架", onclick: onRestore })
                        : el("button", { text: "下架", onclick: onDelete }),
                    el("button", { class: "danger", text: "删除", onclick: onPurge })
                ])
            ]);
        }));
    };

    paint();

    mount(
        el("div", { class: "row", style: "margin-bottom:14px" }, [
            el("h1", { text: "我的投稿", style: "font-size:20px;margin:0" }),
            el("span", { class: "spacer" }),
            selectAllBtn,
            newBtn
        ]),
        batchBar,
        listBox,
        emptyNote
    );
}
