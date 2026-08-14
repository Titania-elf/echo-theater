// 投稿表单（最简版：几个输入框 + 一个 textarea）
import { el, mount, toast, loading } from "./dom.js";
import { createScript, updateScript, fetchScript, fetchCategories, invalidateList } from "./api.js";

const PROMPT_MAX = 20000;

export async function renderEditor(editId) {
    let init = { name: "", category: "", desc: "", prompt: "", tags: [], rating: "general" };
    let categories;

    mount(loading("正在加载投稿表单…"));
    try {
        const [categoryData, script] = await Promise.all([
            fetchCategories(),
            editId ? fetchScript(editId) : Promise.resolve(null)
        ]);
        categories = Array.isArray(categoryData?.items) ? categoryData.items : [];
        if (!categories.length) throw new Error("暂时无法读取投稿分类");
        if (script) init = script;
    } catch (e) {
        mount(el("div", { class: "empty", text: `加载失败：${e.message}` }));
        return;
    }

    const nameIn = el("input", { type: "text", value: init.name, maxlength: "60", placeholder: "例如：🔍 此刻心声" });
    const categoryValues = new Set(categories.map(item => item.value));
    const legacyCategory = init.category && !categoryValues.has(init.category) ? init.category : "";
    const catIn = el("select", {}, [
        el("option", { value: "", text: "请选择分类", disabled: true }),
        legacyCategory ? el("option", {
            value: legacyCategory,
            text: `原分类：${legacyCategory}（请重新选择）`,
            disabled: true
        }) : null,
        ...categories.map(item => el("option", { value: item.value, text: item.value }))
    ]);
    catIn.value = init.category || "";
    const catHint = el("p", { class: "field-hint" });
    const paintCategoryHint = () => {
        const selected = categories.find(item => item.value === catIn.value);
        catHint.textContent = selected
            ? selected.description
            : legacyCategory
                ? `旧分类「${legacyCategory}」仍可浏览，但保存前需要改为新的固定分类。`
                : "分类按最终生成的内容形式选择；题材和风格请填写在标签中。";
    };
    catIn.addEventListener("change", paintCategoryHint);
    paintCategoryHint();
    const descIn = el("input", { type: "text", value: init.desc || "", maxlength: "200", placeholder: "一句话说明这条指令做什么" });
    const tagsIn = el("input", { type: "text", value: (init.tags || []).join(", "), placeholder: "逗号分隔，最多 5 个" });
    const promptIn = el("textarea", { rows: "16", maxlength: String(PROMPT_MAX), placeholder: "在这里写完整的剧本指令…" });
    promptIn.value = init.prompt || "";

    const ratingSel = el("select", {}, [
        el("option", { value: "general", text: "全年龄" }),
        el("option", { value: "mature", text: "成人向" })
    ]);
    ratingSel.value = init.rating || "general";

    const anonChk = el("input", { type: "checkbox" });
    anonChk.checked = !!init.anonymous;

    const counter = el("span", { class: "counter" });
    const updateCount = () => { counter.textContent = `${promptIn.value.length} / ${PROMPT_MAX}`; };
    promptIn.addEventListener("input", updateCount);
    updateCount();

    const submitBtn = el("button", { class: "primary", text: editId ? "保存修改" : "发布投稿" });

    submitBtn.addEventListener("click", async () => {
        const payload = {
            name: nameIn.value.trim(),
            category: catIn.value,
            desc: descIn.value.trim(),
            prompt: promptIn.value.trim(),
            rating: ratingSel.value,
            anonymous: anonChk.checked,
            tags: tagsIn.value.split(/[,，]/).map(t => t.trim()).filter(Boolean).slice(0, 5)
        };

        if (!payload.name) return toast("请填写标题");
        if (!categoryValues.has(payload.category)) return toast("请选择分类");
        if (payload.prompt.length < 10) return toast("指令内容太短了");

        submitBtn.disabled = true;
        try {
            if (editId) await updateScript(editId, payload);
            else await createScript(payload);
            invalidateList();
            toast(editId ? "已保存" : "发布成功");
            location.hash = "#/mine";
        } catch (e) {
            toast(e.message);
            submitBtn.disabled = false;
        }
    });

    const field = (label, node) => el("div", { class: "field" }, [el("label", { text: label }), node]);

    mount(
        el("div", {}, [
            el("a", { href: "#/mine", text: "← 返回我的投稿", style: "font-size:13px;color:var(--muted)" }),
            el("h1", { text: editId ? "编辑指令" : "发布新指令", style: "font-size:20px" }),
            field("标题 *", nameIn),
            el("div", { class: "field" }, [
                el("label", { text: "分类 *" }),
                catIn,
                catHint
            ]),
            field("简介", descIn),
            field("标签", tagsIn),
            field("内容分级", ratingSel),
            el("div", { class: "field" }, [
                el("label", { class: "check-row" }, [
                    anonChk,
                    el("span", { text: "匿名发布" })
                ]),
                el("p", {
                    class: "field-hint",
                    text: "勾选后，工坊和插件里都不会显示你的头像和名字，只显示「匿名作者」。这条投稿仍然属于你，随时可以编辑、下架或取消匿名。"
                })
            ]),
            el("div", { class: "field" }, [
                el("label", {}, [el("span", { text: "指令内容 *" }), counter]),
                promptIn
            ]),
            el("div", { class: "actions" }, [submitBtn])
        ])
    );
}
