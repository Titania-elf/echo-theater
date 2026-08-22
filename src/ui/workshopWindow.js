// src/ui/workshopWindow.js
//
// 回声工坊浏览窗。只做「看 + 下载」，投稿和编辑去网页端。

import { fetchList, fetchScript, fetchComments, countDownload, countDownloads, WORKSHOP_ORIGIN } from "../core/workshopApi.js";
import { saveUserScript, saveUserScripts } from "../core/scriptData.js";
import { GlobalState } from "../core/state.js";
import { refreshScriptList } from "./mainWindow.js";
import { showMature, toggleMature, filterByRating } from "../core/workshopRating.js";

/** 工坊内容来源不可控，凡是拼进 HTML 的字段都要先过这里 */
function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
}

/** 热度阈值：到这个下载量就点亮金色徽章 */
const HOT_THRESHOLD = 50;

/**
 * 批量下载的并发上限。
 *
 * /api/script/{id} 没有批量版本，一条一个请求。串行太慢 —— 单条最坏要等满
 * workshopApi 的 15s 超时，20 条能拖到 5 分钟；但全并发对部署在 Cloudflare 上的
 * 工坊不礼貌，也容易被判成异常流量。3 是折中。
 */
const BATCH_CONCURRENCY = 3;

/** 超过这个条数才弹确认：批量下载不是破坏性操作，小批量不值得打断 */
const BATCH_CONFIRM_THRESHOLD = 10;

/** 头像色板。按作者 ID 取模，同一作者永远同一个颜色 */
const AVATAR_COLORS = [
    "linear-gradient(135deg, #bfa15f, #8a7038)",
    "linear-gradient(135deg, #90cdf4, #4a7fb5)",
    "linear-gradient(135deg, #ff9a9e, #c96b73)",
    "linear-gradient(135deg, #55efc4, #2d9e80)",
    "linear-gradient(135deg, #e0c3fc, #9a7fc4)",
    "linear-gradient(135deg, #f6c177, #b8823c)"
];

/** 匿名投稿没有作者 id，统一给一个中性灰，跟具名作者的彩色区分开 */
const ANON_COLOR = "linear-gradient(135deg, #5a5a5a, #3a3a3a)";

function pickAvatarColor(id) {
    const key = String(id || "");
    if (!key) return ANON_COLOR;
    let sum = 0;
    for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
    return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

/**
 * 作者头像。
 * 结构是「色块打底 + 图片盖在上层」：Discord CDN 在部分网络下连不上，
 * 加载失败时把 img 摘掉就露出底下的首字色块。
 * 不用内联 onerror，避免字符串转义和 CSP 的麻烦。
 */
function renderAvatar(author, anonymous = false) {
    const name = author?.name || "未知作者";
    const initial = anonymous
        ? '<i class="fa-solid fa-user-secret"></i>'
        : esc([...name][0] || "?");
    const color = pickAvatarColor(anonymous ? null : author?.id);

    let img = "";
    // hash 会拼进 URL，先按 Discord 的格式校验一遍，不合规就只用色块
    if (!anonymous && author?.avatar && author?.id && /^[a-zA-Z0-9_]+$/.test(author.avatar)) {
        const ext = author.avatar.startsWith("a_") ? "gif" : "png";
        const url = `https://cdn.discordapp.com/avatars/${encodeURIComponent(author.id)}/${author.avatar}.${ext}?size=64`;
        img = `<img class="t-ws-avatar-img" src="${url}" alt="">`;
    }

    return `<span class="t-ws-avatar" style="background:${color};">
                <span class="t-ws-avatar-initial">${initial}</span>${img}
            </span>`;
}

/** 头像加载失败就摘掉图片，露出底下的首字色块 */
function bindAvatarFallback($scope) {
    $scope.find(".t-ws-avatar-img").on("error", function () {
        $(this).remove();
    });
}

function renderPreviewComments(items) {
    if (!items?.length) {
        return `<div class="t-ws-pv-comments-empty">还没有评论，去网页给作者留句话吧。</div>`;
    }
    return items.map(item => `
        <article class="t-ws-pv-comment">
            <div class="t-ws-pv-comment-head">
                ${renderAvatar(item.author)}
                <div class="t-ws-pv-comment-author">
                    <strong>${esc(item.author?.name || "未知用户")}</strong>
                    <small>${formatRelativeTime(item.updated_at || item.created_at)}</small>
                </div>
            </div>
            <div class="t-ws-pv-comment-body">${esc(item.body)}</div>
            ${item.reply ? `<div class="t-ws-pv-comment-reply"><strong>作者回复</strong><span>${esc(item.reply.body)}</span></div>` : ""}
        </article>
    `).join("");
}

function formatRelativeTime(ts) {
    // 工坊的时间戳是秒，插件内部用的是毫秒
    const time = (Number(ts) || 0) * 1000;
    if (!time) return "";
    const diff = Date.now() - time;
    if (diff < 3600000) return "刚刚";
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(time).toLocaleDateString("zh-CN");
}

const SORT_MODES = {
    newest: { label: "最新发布", fn: (a, b) =>
        (b.created_at || b.updated_at || 0) - (a.created_at || a.updated_at || 0)
        || (b.updated_at || 0) - (a.updated_at || 0)
        || String(b.id).localeCompare(String(a.id)) },
    latest: { label: "最新更新", fn: (a, b) => (b.updated_at || 0) - (a.updated_at || 0) },
    downloads: { label: "下载最多", fn: (a, b) => (b.downloads || 0) - (a.downloads || 0) },
    name: { label: "名称 A-Z", fn: (a, b) => String(a.name).localeCompare(String(b.name), "zh-CN") }
};

/**
 * 工坊浏览窗口
 * @param {string} source - 来源: 'manager' | 'main'，决定关闭后返回哪
 */
export function openWorkshopWindow(source = 'manager') {
    let allItems = [];
    let currentFilter = { category: "全部", search: "", sort: "newest" };
    // 批量模式：勾选多条一次下载。卡片上的复选框只在这个模式下渲染
    let batchMode = false;
    // 批量下载进行中的取消标志。见 batchDownload 里对「取消不打断飞行中请求」的说明
    let batchCancelled = false;
    let batchRunning = false;

    // 兜底：来源传错就按实际打开的窗口纠正。
    // #t-overlay 是 flex 容器，漏隐藏上一层窗口会变成两个窗口并排。
    if (source === 'manager' && !$("#t-mgr-view").length) source = 'main';
    if (source === 'main' && !$("#t-main-view").length && $("#t-mgr-view").length) source = 'manager';

    if (source === 'manager') {
        $("#t-mgr-view").hide();
    } else {
        $("#t-main-view").hide();
    }

    const sortOptions = Object.entries(SORT_MODES)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

    const html = `
    <div class="t-box t-root" id="t-ws-view">
        <div class="t-header">
            <div class="t-title-container">
                <div class="t-title-main">回声工坊</div>
                <div class="t-title-sub">ECHO WORKSHOP</div>
            </div>
            <div class="t-header-actions">
                <button class="t-ws-rating-toggle" id="t-ws-rating-toggle" type="button"></button>
                <i class="fa-solid fa-arrow-up-right-from-square t-icon-btn" id="t-ws-open-site" title="在浏览器中打开工坊（投稿/编辑）"></i>
                <i class="fa-solid fa-rotate t-icon-btn" id="t-ws-refresh" title="刷新"></i>
                <span class="t-close" id="t-ws-close">&times;</span>
            </div>
        </div>
        <div class="t-ws-body">
            <div class="t-ws-toolbar">
                <input type="text" id="t-ws-search" class="t-ws-search" placeholder="🔍 搜索标题、简介、作者、标签...">
                <select id="t-ws-cat" class="t-ws-select"></select>
                <select id="t-ws-sort" class="t-ws-select">${sortOptions}</select>
                <button type="button" id="t-ws-batch-toggle" class="t-ws-batch-toggle" title="批量下载" aria-pressed="false">
                    <i class="fa-solid fa-list-check"></i> 批量
                </button>
            </div>
            <div class="t-ws-stats" id="t-ws-stats"></div>
            <div class="t-ws-grid" id="t-ws-list"></div>
            <div class="t-ws-bulk-bar" id="t-ws-bulk-bar">
                <span class="t-ws-bulk-count" id="t-ws-bulk-count">已选 0 条</span>
                <button type="button" class="t-btn t-btn-soft" id="t-ws-bulk-all"></button>
                <button type="button" class="t-btn primary" id="t-ws-bulk-get" disabled>
                    <i class="fa-solid fa-download"></i> 下载所选
                </button>
            </div>
        </div>
    </div>`;

    $("#t-overlay").append(html);

    const closeWindow = () => {
        $("#t-ws-view").remove();
        if (source === 'manager') {
            // 回管理器时重建，让新下载的剧本出现在列表里
            $("#t-mgr-view").remove();
            import("./scriptManager.js").then(m => m.openScriptManager());
        } else {
            $("#t-main-view").show();
            refreshScriptList();
        }
    };

    const renderCategories = () => {
        const cats = [...new Set(filterByRating(allItems).map(i => i.category).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, "zh-CN"));
        const $sel = $("#t-ws-cat");
        $sel.empty().append(`<option value="全部">全部分类</option>`);
        cats.forEach(c => $sel.append(`<option value="${esc(c)}">${esc(c)}</option>`));
        $sel.val(currentFilter.category);
    };

    const renderStats = (shownCount) => {
        const visibleItems = filterByRating(allItems);
        if (!visibleItems.length) { $("#t-ws-stats").empty(); return; }

        const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
        const fresh = visibleItems.filter(i => (i.created_at || 0) >= weekAgo).length;
        const totalDownloads = visibleItems.reduce((sum, i) => sum + (Number(i.downloads) || 0), 0);
        const filtered = shownCount !== visibleItems.length;

        $("#t-ws-stats").html(`
            <span><b>${visibleItems.length}</b> 条当前可见投稿</span>
            ${fresh ? `<span>本周新增 <b>${fresh}</b></span>` : ""}
            <span>累计下载 <b>${totalDownloads}</b></span>
            ${filtered ? `<span class="t-ws-stats-filter">当前显示 <b>${shownCount}</b></span>` : ""}
        `);
    };

    const getFiltered = () => {
        const list = filterByRating(allItems).filter(item => {
            if (currentFilter.category !== "全部" && item.category !== currentFilter.category) return false;
            if (currentFilter.search) {
                const term = currentFilter.search.toLowerCase();
                const hay = [item.name, item.desc, item.author?.name, ...(item.tags || [])]
                    .join(" ").toLowerCase();
                if (!hay.includes(term)) return false;
            }
            return true;
        });
        const sorter = SORT_MODES[currentFilter.sort] || SORT_MODES.newest;
        return list.sort(sorter.fn);
    };

    const renderList = () => {
        const $list = $("#t-ws-list");
        const filtered = getFiltered();
        renderStats(filtered.length);

        $list.empty().removeClass("t-ws-grid-empty");

        if (filtered.length === 0) {
            $list.addClass("t-ws-grid-empty");
            if (allItems.length) {
                $list.html(`
                    <div class="t-ws-placeholder">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <div class="t-ws-ph-title">没有可显示的投稿</div>
                        <div class="t-ws-ph-desc">换个关键词、分类，或切换内容范围</div>
                    </div>`);
            } else {
                $list.html(`
                    <div class="t-ws-placeholder">
                        <i class="fa-solid fa-store"></i>
                        <div class="t-ws-ph-title">工坊里还没有投稿</div>
                        <div class="t-ws-ph-desc">去网页端发布第一条，让大家用上你的指令</div>
                        <button class="t-btn t-btn-soft" id="t-ws-ph-site">前往工坊网站</button>
                    </div>`);
                $("#t-ws-ph-site").on("click", () => window.open(WORKSHOP_ORIGIN, "_blank"));
            }
            return;
        }

        filtered.forEach(item => {
            // 本地已有同名剧本时整卡变淡，方便一眼跳过已下载的
            const dup = GlobalState.runtimeScripts.some(s => s.name === item.name);
            const downloads = Number(item.downloads) || 0;
            const hot = downloads >= HOT_THRESHOLD;
            const tags = (item.tags || []).slice(0, 3)
                .map(t => `<span class="t-ws-tag">#${esc(t)}</span>`).join("");

            const $card = $(`
                <div class="t-ws-card${dup ? " is-dup" : ""}" style="--card-accent:${pickAvatarColor(item.anonymous ? null : item.author?.id)};">
                    ${dup ? `<div class="t-ws-dup-flag" title="本地已有同名剧本"><i class="fa-solid fa-check"></i></div>` : ""}
                    ${batchMode ? `<label class="t-ws-select-wrap" title="${dup ? "本地已有同名剧本，批量下载会跳过" : "选中以批量下载"}">
                        <input type="checkbox" class="t-ws-select t-choice-input t-choice-input--accent t-choice-input--subdued-disabled" data-ws-id="${esc(item.id)}" ${dup ? "disabled" : ""} aria-label="选择《${esc(item.name)}》">
                    </label>` : ""}
                    <div class="t-ws-card-head">
                        ${renderAvatar(item.author, item.anonymous)}
                        <span class="t-ws-author-name">${esc(item.author?.name || "未知作者")}</span>
                        <div class="t-ws-heat${hot ? " is-hot" : ""}" title="下载量">
                            <i class="fa-solid fa-fire"></i> ${downloads}
                        </div>
                    </div>
                    <div class="t-ws-card-title">${esc(item.name)}</div>
                    <div class="t-ws-card-desc">${esc(item.desc) || "作者没有写简介"}</div>
                    <div class="t-ws-card-tags">
                        ${item.category ? `<span class="t-ws-tag t-ws-tag-cat">${esc(item.category)}</span>` : ""}
                        ${item.rating === "mature" ? `<span class="t-ws-tag t-ws-tag-mature">成人向</span>` : ""}
                        ${tags}
                        <span class="t-ws-tag">v${Number(item.version) || 1}</span>
                    </div>
                </div>
            `);

            bindAvatarFallback($card);
            if (batchMode) {
                $card.find(".t-ws-select").on("change", updateBulkBar);
                // 点卡面直接切换勾选，否则用户得去瞄准左上角那个小复选框。
                // 复选框和它的 label 自己会处理点击，再冒泡上来就会切两次，所以排除掉。
                $card.on("click", function (e) {
                    if ($(e.target).closest(".t-ws-select-wrap").length) return;
                    const $box = $card.find(".t-ws-select:not(:disabled)");
                    if (!$box.length) return;
                    $box.prop("checked", !$box.prop("checked"));
                    updateBulkBar();
                });
            } else {
                // 卡片上原先有「预览」「下载」两个按钮。预览页里本来就有「下载到本地」，
                // 于是卡面按钮撤掉、整张卡点进预览 —— 少一层按钮，卡片也让出一行给简介。
                // 可点性靠 cursor:pointer 与 hover 抬升表达（见 workshop.css）。
                $card.on("click", () => openPreview(item));
            }
            $list.append($card);
        });
        if (batchMode) updateBulkBar();
    };

    /** 当前筛选下可勾选的复选框（已在本地的那些是 disabled，不算） */
    const selectableChecks = () => $("#t-ws-list .t-ws-select:not(:disabled)");

    /**
     * 重画批量条：选中计数、全选按钮的文案、下载按钮的可用状态。
     *
     * 全选只作用于**当前筛选可见**的卡，所以有筛选时按钮文案要带范围后缀 ——
     * 否则「全选」看起来像是选中了工坊全部投稿。同 mainWindow 世界书选择器的做法。
     */
    const updateBulkBar = () => {
        const $all = selectableChecks();
        const $checked = $all.filter(":checked");
        const scoped = currentFilter.search || currentFilter.category !== "全部";
        const suffix = scoped ? "（当前筛选）" : "";
        const allChecked = $all.length > 0 && $checked.length === $all.length;

        // 选中态的高亮。放在这里统一同步：单个勾选和「全选」都会经过本函数，
        // 各自去 toggleClass 就会漏。用类而不是 CSS 的 :has()，本项目不依赖 :has()
        $("#t-ws-list .t-ws-select").each(function () {
            $(this).closest(".t-ws-card").toggleClass("is-selected", $(this).prop("checked"));
        });

        $("#t-ws-bulk-count").text(`已选 ${$checked.length} 条`);
        $("#t-ws-bulk-all")
            .prop("disabled", $all.length === 0)
            .html(allChecked
                ? `<i class="fa-solid fa-circle-xmark"></i> 取消全选${suffix}`
                : `<i class="fa-solid fa-check-double"></i> 全选${suffix}`);
        $("#t-ws-bulk-get").prop("disabled", $checked.length === 0);
    };

    /** 把工坊详情转成本地用户剧本。单条与批量共用，保证两条路径存下来的东西一致 */
    const toUserScript = (item, detail) => ({
        id: "ws_" + item.id + "_" + Date.now(),
        name: detail.name,
        desc: detail.desc || "",
        prompt: detail.prompt,
        category: detail.category || "工坊下载",
        workshop_source_id: item.id,
        workshop_author_id: item.author?.id || null
    });

    /** 下载 = 拉详情 -> 存成用户剧本 -> 上报计数 */
    const downloadScript = async (item, $btn) => {
        const originalText = $btn.text();
        $btn.prop("disabled", true).text("下载中...");
        try {
            const detail = await fetchScript(item.id);
            saveUserScript(toUserScript(item, detail));
            countDownload(item.id);
            $btn.text("✓ 已下载");
            if (window.toastr) toastr.success(`已保存「${detail.name}」`);
            // 重新渲染让「已下载」标记生效，留一点时间让用户看到按钮反馈
            setTimeout(renderList, 1200);
        } catch (e) {
            $btn.prop("disabled", false).text(originalText);
            if (window.toastr) toastr.error(e.message);
            else alert(e.message);
        }
    };

    /**
     * 批量下载选中的投稿。
     *
     * 与单条下载的关键差别在收尾：详情要一条条拉（/api/script/{id} 没有批量版本），
     * 但**存盘只做一次**（saveUserScripts）、**下载量上报也只发一个请求**
     * （countDownloads —— 接口本来就是批量的，见 workshopApi 里的注释）。
     * 逐条调 saveUserScript 会重建 runtimeScripts N 次，逐条上报会浪费 N 倍配额。
     *
     * 单条失败不中断整批：网络抖一下不该让已经拉到的十几条白费。失败项收集起来最后汇报。
     *
     * ⚠ 取消的局限：workshopApi 的 req() 自己内部 new AbortController，没有外部 signal
     *   入口，所以这里的取消只能在**下一条开始前**生效，已经在飞行中的最多 3 条会跑完。
     *   要做到即时中断得给 req() 加 signal 参数，那是独立一件事。
     */
    const batchDownload = async (items) => {
        if (items.length === 0) return;
        if (items.length > BATCH_CONFIRM_THRESHOLD
            && !confirm(`即将下载 ${items.length} 条剧本，要逐条向工坊请求详情，可能需要一会儿。\n\n确定继续吗？`)) {
            return;
        }

        batchRunning = true;
        batchCancelled = false;
        const saved = [];
        const failed = [];
        let done = 0;

        const $count = $("#t-ws-bulk-count");
        const $getBtn = $("#t-ws-bulk-get");
        const $allBtn = $("#t-ws-bulk-all");
        const paintProgress = () => $count.text(`下载中 ${done}/${items.length}`);

        $allBtn.prop("disabled", true);
        $getBtn.html('<i class="fa-solid fa-xmark"></i> 取消').prop("disabled", false);
        $getBtn.off("click.bulkrun").on("click.bulkrun", () => {
            batchCancelled = true;
            $getBtn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> 正在停止');
        });
        // 批量期间禁掉会重画列表的表单控件，否则渲染会把正在跑的这一批的复选框状态冲掉。
        // 一个 const 供禁用/恢复共用，两处各写一份必然漂移。
        // #t-ws-refresh 刻意不在这里：它是 <i> 元素，disabled 对它无效，
        // 改由它自己的 click 处理器判断 batchRunning。
        const $frozen = $("#t-ws-search, #t-ws-cat, #t-ws-sort, #t-ws-batch-toggle, #t-ws-rating-toggle");
        $frozen.prop("disabled", true);
        paintProgress();

        // 并发池：BATCH_CONCURRENCY 个 worker 共享同一个游标，各自取下一条
        let cursor = 0;
        const worker = async () => {
            while (true) {
                if (batchCancelled) return;
                const index = cursor++;
                if (index >= items.length) return;
                const item = items[index];
                try {
                    const detail = await fetchScript(item.id);
                    saved.push({ item, script: toUserScript(item, detail) });
                } catch (e) {
                    failed.push({ name: item.name, message: e?.message || "未知错误" });
                }
                done++;
                paintProgress();
            }
        };
        await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker));

        // 已经拉到的一律入库 —— 取消或部分失败都不回滚，那些请求已经花出去了
        saveUserScripts(saved.map(entry => entry.script));
        countDownloads(saved.map(entry => entry.item.id));

        batchRunning = false;
        $getBtn.off("click.bulkrun");
        $frozen.prop("disabled", false);
        $getBtn.html('<i class="fa-solid fa-download"></i> 下载所选');

        renderList();

        if (window.toastr) {
            const parts = [`成功 ${saved.length} 条`];
            if (failed.length) parts.push(`失败 ${failed.length} 条`);
            const skipped = items.length - saved.length - failed.length;
            if (skipped > 0) parts.push(`未开始 ${skipped} 条`);
            const summary = parts.join(" · ");
            if (failed.length) {
                // 用了 escapeHtml:false 才能让 <br> 生效，所以剧本名必须自己过 esc() ——
                // 名字是工坊来的不可控内容（见文件顶部 esc 的说明）
                const names = failed.slice(0, 5).map(f => `「${esc(f.name)}」`).join("、");
                const more = failed.length > 5 ? ` 等 ${failed.length} 条` : "";
                toastr.warning(`${summary}<br>失败：${names}${more}`, "批量下载", { escapeHtml: false });
            } else if (batchCancelled) {
                toastr.info(summary, "批量下载已停止");
            } else {
                toastr.success(summary, "批量下载完成");
            }
        }
    };

    const openPreview = async (item) => {
        const downloads = Number(item.downloads) || 0;
        const previewHtml = `
        <div id="t-ws-preview-overlay" class="t-ws-preview-overlay t-root">
            <div class="t-box t-root t-ws-preview-box">
                <div class="t-header">
                    <span class="t-title-main" style="font-size:1.15em;">${esc(item.name)}</span>
                    <div class="t-header-actions">
                        <span class="t-close" id="t-ws-pv-close">&times;</span>
                    </div>
                </div>
                <div class="t-ws-preview-body">
                    <div class="t-ws-pv-bar">
                        <div class="t-ws-author">
                            ${renderAvatar(item.author, item.anonymous)}
                            <div class="t-ws-author-meta">
                                <div class="t-ws-author-name">${esc(item.author?.name || "未知作者")}</div>
                                <div class="t-ws-author-time">v${Number(item.version) || 1} · ${formatRelativeTime(item.updated_at)}</div>
                            </div>
                        </div>
                        <div class="t-ws-heat${downloads >= HOT_THRESHOLD ? " is-hot" : ""}">
                            <i class="fa-solid fa-fire"></i> ${downloads}
                        </div>
                        ${item.rating === "mature" ? `<span class="t-ws-tag t-ws-tag-mature">成人向</span>` : ""}
                    </div>
                    ${item.desc ? `<div class="t-ws-pv-desc">${esc(item.desc)}</div>` : ""}
                    <div class="t-ws-pv-label">
                        <span>指令内容</span>
                    </div>
                    <textarea class="t-input t-ws-pv-prompt" readonly>加载中...</textarea>
                    <section class="t-ws-pv-comments">
                        <div class="t-ws-pv-comments-head">
                            <div>
                                <span class="t-ws-pv-label">评论</span>
                                <strong id="t-ws-pv-comments-count">加载中...</strong>
                            </div>
                            <button class="t-btn t-btn-soft" id="t-ws-pv-comment-open">去网页评论</button>
                        </div>
                        <div id="t-ws-pv-comments-list" class="t-ws-pv-comments-list">
                            <div class="t-ws-pv-comments-empty">正在加载评论...</div>
                        </div>
                    </section>
                    <div class="t-btn-row">
                        <button class="t-btn primary t-flex-1" id="t-ws-pv-get">下载到本地</button>
                    </div>
                </div>
            </div>
        </div>`;

        $("body").append(previewHtml);
        bindAvatarFallback($("#t-ws-preview-overlay"));

        const closePreview = () => {
            $("#t-ws-preview-overlay").remove();
            $(document).off("keydown.wspreview");
        };

        $("#t-ws-pv-close").on("click", closePreview);
        $("#t-ws-pv-comment-open").on("click", () => window.open(`${WORKSHOP_ORIGIN}/#/comment/${encodeURIComponent(item.id)}`, "_blank"));
        $("#t-ws-preview-overlay").on("click", function (e) {
            if (e.target === this) closePreview();
        });
        $(document).on("keydown.wspreview", e => {
            if (e.key === "Escape") { closePreview(); e.preventDefault(); }
        });

        const [detailResult, commentsResult] = await Promise.allSettled([fetchScript(item.id), fetchComments(item.id)]);
        if (detailResult.status === "fulfilled") {
            $("#t-ws-preview-overlay .t-ws-pv-prompt").val(detailResult.value.prompt);

            $("#t-ws-pv-get").on("click", function () {
                downloadScript(item, $(this));
                setTimeout(closePreview, 800);
            });
        } else {
            $("#t-ws-preview-overlay .t-ws-pv-prompt").val(`加载失败：${detailResult.reason?.message || "未知错误"}`);
            $("#t-ws-pv-get").prop("disabled", true);
        }
        if (commentsResult.status === "fulfilled") {
            const items = commentsResult.value.items || [];
            $("#t-ws-pv-comments-count").text(`${items.length} 条`);
            $("#t-ws-pv-comments-list").html(renderPreviewComments(items));
            bindAvatarFallback($("#t-ws-pv-comments-list"));
        } else {
            $("#t-ws-pv-comments-count").text("暂不可用");
            $("#t-ws-pv-comments-list").html(`<div class="t-ws-pv-comments-empty">评论加载失败：${esc(commentsResult.reason?.message || "未知错误")}</div>`);
        }
    };

    /** 骨架屏：网络慢的时候比一行「加载中」体感好很多 */
    const renderSkeleton = () => {
        $("#t-ws-stats").empty();
        $("#t-ws-list").removeClass("t-ws-grid-empty").html(
            Array.from({ length: 6 }, () => `
                <div class="t-ws-card t-ws-skeleton">
                    <div class="t-ws-card-head">
                        <div class="t-ws-sk-circle"></div>
                        <div class="t-ws-sk-line" style="width:50%;"></div>
                    </div>
                    <div class="t-ws-sk-line" style="width:75%; height:13px;"></div>
                    <div class="t-ws-sk-line t-w-full"></div>
                    <div class="t-ws-sk-line" style="width:60%;"></div>
                </div>`).join("")
        );
    };

    const load = async ({ force = false } = {}) => {
        renderSkeleton();
        try {
            const data = await fetchList({ force });
            allItems = data?.items || [];
            renderCategories();
            renderList();
        } catch (e) {
            allItems = [];
            $("#t-ws-stats").empty();
            $("#t-ws-list").addClass("t-ws-grid-empty").html(`
                <div class="t-ws-placeholder">
                    <i class="fa-solid fa-plug-circle-xmark" style="color:var(--t-color-danger);"></i>
                    <div class="t-ws-ph-title">${esc(e.message)}</div>
                    <div class="t-ws-ph-desc">工坊部署在 Cloudflare，部分网络环境可能无法访问</div>
                    <button class="t-btn t-btn-soft" id="t-ws-retry">重试</button>
                </div>
            `);
            $("#t-ws-retry").on("click", () => load({ force: true }));
        }
    };

    $("#t-ws-close").on("click", closeWindow);
    // 批量下载期间挡掉所有会重画列表的入口。
    // 刷新和分级切换必须在这里显式判断，不能只靠上面 batchDownload 里的 prop("disabled")：
    // #t-ws-refresh 是 <i> 元素，disabled 属性对它无效，点了照样会走 load() 把列表清空
    $("#t-ws-refresh").on("click", () => {
        if (batchRunning) return;
        load({ force: true });
    });
    $("#t-ws-open-site").on("click", () => window.open(WORKSHOP_ORIGIN, "_blank"));
    const paintRatingToggle = () => {
        const mature = showMature();
        $("#t-ws-rating-toggle")
            .toggleClass("is-mature", mature)
            .attr("aria-pressed", String(mature))
            .attr("title", mature ? "点击隐藏成人向内容" : "点击显示成人向内容")
            .html(`<i class="fa-solid fa-shield-halved"></i> ${mature ? "包含成人向" : "全年龄"}`);
    };
    $("#t-ws-rating-toggle").on("click", () => {
        if (batchRunning) return;
        toggleMature();
        paintRatingToggle();
        renderCategories();
        renderList();
    });
    $("#t-ws-search").on("input", function () {
        if (batchRunning) return;
        currentFilter.search = $(this).val().trim();
        renderList();
    });
    $("#t-ws-cat").on("change", function () {
        if (batchRunning) return;
        currentFilter.category = $(this).val();
        renderList();
    });
    $("#t-ws-sort").val(currentFilter.sort).on("change", function () {
        if (batchRunning) return;
        currentFilter.sort = $(this).val();
        renderList();
    });

    // ── 批量下载 ──────────────────────────────────────────────
    // 状态类挂在 #t-ws-view 上，复选框的显隐与卡片按钮的隐藏都由 CSS 按它决定。
    // 刻意不学 scriptManager 那样用 jQuery .css() 写死配色 —— 那样浅色主题下是错的，
    // 而且 css-audit 的 A16/A17 只扫 style="..." 字面量，看不见 .css({})。
    $("#t-ws-batch-toggle").on("click", function () {
        if (batchRunning) return;
        batchMode = !batchMode;
        $("#t-ws-view").toggleClass("is-batch", batchMode);
        $(this)
            .toggleClass("is-active", batchMode)
            .attr("aria-pressed", String(batchMode))
            .attr("title", batchMode ? "退出批量下载" : "批量下载")
            .html(batchMode
                ? '<i class="fa-solid fa-xmark"></i> 退出批量'
                : '<i class="fa-solid fa-list-check"></i> 批量');
        // 批量条的显隐完全由上面那个 .is-batch 决定（CSS 里 display:none -> flex）。
        // 刻意不再用 hidden 属性：.t-ws-bulk-bar 的 display:flex 是类选择器，
        // 优先级高过浏览器默认样式表的 [hidden]{display:none}，两者并存时 hidden 无效
        // —— 这正是它此前一直显示的原因。
        renderList();
    });

    $("#t-ws-bulk-all").on("click", () => {
        const $all = selectableChecks();
        if (!$all.length) return;
        const allChecked = $all.filter(":checked").length === $all.length;
        $all.prop("checked", !allChecked);
        updateBulkBar();
    });

    $("#t-ws-bulk-get").on("click", () => {
        if (batchRunning) return;
        // 从 DOM 取选中 id，再回 allItems 找完整条目 —— 卡片上只存了 id
        const ids = new Set(selectableChecks().filter(":checked").map(function () {
            return String($(this).data("ws-id"));
        }).get());
        batchDownload(allItems.filter(item => ids.has(String(item.id))));
    });

    paintRatingToggle();
    load();
}
