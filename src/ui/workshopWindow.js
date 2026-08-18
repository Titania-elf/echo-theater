// src/ui/workshopWindow.js
//
// 回声工坊浏览窗。只做「看 + 下载」，投稿和编辑去网页端。

import { fetchList, fetchScript, fetchComments, countDownload, WORKSHOP_ORIGIN } from "../core/workshopApi.js";
import { saveUserScript } from "../core/scriptData.js";
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
            </div>
            <div class="t-ws-stats" id="t-ws-stats"></div>
            <div class="t-ws-grid" id="t-ws-list"></div>
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
                    <div class="t-ws-card-actions">
                        <button class="t-btn t-btn-soft t-ws-preview">预览</button>
                        <button class="t-btn primary t-ws-get">下载</button>
                    </div>
                </div>
            `);

            bindAvatarFallback($card);
            $card.find(".t-ws-preview").on("click", () => openPreview(item));
            $card.find(".t-ws-get").on("click", function () {
                downloadScript(item, $(this));
            });
            $list.append($card);
        });
    };

    /** 下载 = 拉详情 -> 存成用户剧本 -> 上报计数 */
    const downloadScript = async (item, $btn) => {
        const originalText = $btn.text();
        $btn.prop("disabled", true).text("下载中...");
        try {
            const detail = await fetchScript(item.id);
            saveUserScript({
                id: "ws_" + item.id + "_" + Date.now(),
                name: detail.name,
                desc: detail.desc || "",
                prompt: detail.prompt,
                category: detail.category || "工坊下载",
                workshop_source_id: item.id,
                workshop_author_id: item.author?.id || null
            });
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
                    <div class="t-ws-sk-line" style="width:100%;"></div>
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
    $("#t-ws-refresh").on("click", () => load({ force: true }));
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
        toggleMature();
        paintRatingToggle();
        renderCategories();
        renderList();
    });
    $("#t-ws-search").on("input", function () {
        currentFilter.search = $(this).val().trim();
        renderList();
    });
    $("#t-ws-cat").on("change", function () {
        currentFilter.category = $(this).val();
        renderList();
    });
    $("#t-ws-sort").val(currentFilter.sort).on("change", function () {
        currentFilter.sort = $(this).val();
        renderList();
    });

    paintRatingToggle();
    load();
}
