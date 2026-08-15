import { el, fmtDate, toast } from "./dom.js";
import { getSession } from "./auth.js";
import { fetchComments, createComment, updateComment, deleteComment, replyComment, reportComment } from "./api.js";
import { avatar, authorLink } from "./card.js";

export function commentSection(script, { focusCommentId = "" } = {}) {
    const root = el("section", { class: "comments-section", id: "feedback" });

    const load = async () => {
        root.replaceChildren(el("div", { class: "comments-loading", text: "正在加载使用反馈…" }));
        let session, data;
        try { [session, data] = await Promise.all([getSession(), fetchComments(script.id)]); }
        catch (e) { root.replaceChildren(el("div", { class: "empty", text: `反馈加载失败：${e.message}` })); return; }
        const items = data.items || [];
        const mine = items.find(item => item.author.id === session?.user?.id);
        const form = !mine ? feedbackForm(async body => {
            await createComment(script.id, body); toast("反馈已发布"); await load();
        }) : el("p", { class: "comments-own-hint", text: "你已经反馈过这条投稿，可以在自己的反馈下编辑。" });

        root.replaceChildren(
            el("div", { class: "comments-head" }, [
                el("div", {}, [el("p", { class: "comments-kicker", text: "USER FEEDBACK" }), el("h2", { text: `使用反馈 · ${items.length}` })]),
                el("p", { text: "说说实际使用感受、遇到的问题或改进建议。" })
            ]),
            form,
            el("div", { class: "comment-list" }, items.length
                ? items.map(item => commentCard(item, session, load, data.can_reply))
                : [el("div", { class: "comments-empty", text: "还没有使用反馈，来留下第一条吧。" })])
        );
        if (focusCommentId) {
            requestAnimationFrame(() => {
                const target = document.getElementById(`comment-${focusCommentId}`);
                if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
            });
        }
    };
    load();
    return root;
}

function feedbackForm(onSubmit, { value = "", submitText = "发布反馈", cancel = null } = {}) {
    const input = el("textarea", { rows: "4", maxlength: "1000", placeholder: "请尽量描述实际使用后的体验，这会直接帮助作者改进指令。" });
    input.value = value;
    const submit = el("button", { class: "primary", text: submitText });
    submit.addEventListener("click", async () => {
        const body = input.value.trim();
        if (body.length < 2) return toast("请至少写 2 个字");
        submit.disabled = true;
        try { await onSubmit(body); } catch (e) { toast(e.message); submit.disabled = false; }
    });
    return el("div", { class: "feedback-form" }, [input, el("div", { class: "feedback-form-actions" }, [
        el("span", { text: "每位用户对每条投稿可发布一条反馈" }),
        cancel && el("button", { text: "取消", onclick: cancel }), submit
    ])]);
}

function commentCard(item, session, reload, canReply) {
    const isMine = item.author.id === session?.user?.id;
    const isOwner = Boolean(canReply);
    const card = el("article", { class: "comment-card", id: `comment-${item.id}` });
    const paint = () => {
        const actions = [];
        if (isMine) {
            actions.push(el("button", { text: "编辑", onclick: () => {
                card.replaceChildren(feedbackForm(async body => {
                    await updateComment(item.id, body); toast("反馈已更新"); await reload();
                }, { value: item.body, submitText: "保存修改", cancel: paint }));
            }}));
            actions.push(el("button", { class: "danger", text: "删除", onclick: async () => {
                if (!confirm("确定删除这条反馈吗？删除后无法恢复。")) return;
                try { await deleteComment(item.id); toast("反馈已删除"); await reload(); } catch (e) { toast(e.message); }
            }}));
        } else {
            actions.push(el("button", { text: "举报", onclick: async () => {
                const reason = prompt("请简要说明举报理由：");
                if (!reason?.trim()) return;
                try { await reportComment(item.id, reason.trim()); toast("举报已提交"); } catch (e) { toast(e.message); }
            }}));
        }
        if (isOwner) actions.push(el("button", { text: item.reply ? "修改作者回复" : "作者回复", onclick: () => {
            const input = prompt("请输入公开回复：", item.reply?.body || "");
            if (!input?.trim()) return;
            replyComment(item.id, input.trim()).then(() => { toast("回复已发布"); reload(); }).catch(e => toast(e.message));
        }}));

        card.replaceChildren(
            el("div", { class: "comment-author-row" }, [avatar(item.author, 32), el("div", { class: "comment-author-copy" }, [
                authorLink(item.author), el("span", { text: fmtDate(item.updated_at || item.created_at) })
            ])]),
            el("p", { class: "comment-body", text: item.body }),
            item.reply && el("div", { class: "comment-reply" }, [
                el("strong", { text: "作者回复" }), el("p", { text: item.reply.body }), el("span", { text: fmtDate(item.reply.created_at) })
            ]),
            actions.length && el("div", { class: "comment-actions" }, actions)
        );
    };
    paint();
    return card;
}
