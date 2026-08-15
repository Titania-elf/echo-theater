// 详情页：完整指令仅作纯文本展示，网页端限制常规复制
import { el, mount, loading, fmtDate, toast } from "./dom.js";
import { fetchScript, report } from "./api.js";
import { avatar, authorLink } from "./card.js";
import { showMature, toggleMature } from "./rating.js";
import { commentSection } from "./comments.js";

export async function renderDetail(id, focusCommentId = "") {
    mount(loading());

    let s;
    try {
        s = await fetchScript(id);
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    if (s.rating === "mature" && !showMature()) {
        const unlock = el("button", { class: "primary", text: "显示成人向内容" });
        unlock.addEventListener("click", () => {
            if (toggleMature()) renderDetail(id, focusCommentId);
        });
        mount(el("div", { class: "rating-gate" }, [
            el("div", { class: "rating-gate-icon", text: "18+" }),
            el("h1", { text: "此投稿属于成人向内容" }),
            el("p", { text: "当前内容范围为全年龄。开启后才能查看这条投稿。" }),
            el("div", { class: "actions" }, [
                el("a", { href: "#/" }, [el("button", { text: "返回列表" })]),
                unlock
            ])
        ]));
        return;
    }

    const onReport = async () => {
        const reason = prompt("请简要说明举报理由：");
        if (!reason?.trim()) return;
        try {
            await report(s.id, reason.trim());
            toast("已提交，感谢反馈");
        } catch (e) {
            toast(e.message);
        }
    };

    mount(
        el("div", { class: "detail" }, [
            el("a", { href: "#/", text: "← 返回列表", style: "font-size:13px;color:var(--muted)" }),
            el("h1", { text: s.name }),
            el("div", { class: "meta detail-author" }, [
                avatar(s.author, 24),
                authorLink(s.author, { anonymous: s.anonymous }),
                el("span", { text: `${fmtDate(s.updated_at)} · ↓ ${s.downloads} · v${s.version}` })
            ]),
            el("div", { class: "meta", style: "margin-bottom:12px" }, [
                s.category && el("span", { class: "tag", text: s.category }),
                s.anonymous && el("span", { class: "tag", text: "匿名投稿" }),
                s.rating === "mature" && el("span", { class: "tag mature", text: "成人向" }),
                ...s.tags.map(t => el("span", { class: "tag", text: t }))
            ]),
            s.desc && el("p", { text: s.desc, style: "color:var(--muted)" }),
            el("div", { class: "actions" }, [
                el("span", { class: "spacer" }),
                el("button", { class: "danger", text: "举报", onclick: onReport })
            ]),
            // 纯文本展示，绝不渲染 —— 这里的内容全是陌生人写的
            el("div", {
                class: "prompt-box",
                text: s.prompt,
                oncopy: event => {
                    event.preventDefault();
                    toast("网页端不支持复制，请在回声剧场插件中使用该指令");
                }
            }),
            commentSection(s, { focusCommentId })
        ])
    );
}
