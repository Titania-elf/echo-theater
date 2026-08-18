// src/ui/favsWindow.js

import { getExtData, saveExtData } from "../utils/storage.js";
import { GlobalState, syncFavIdToCurrentHistory, setFavsWindowOpen, getCurrentGenerationResult, isFavoriteEligible } from "../core/state.js";
import { getContextData } from "../core/context.js";
import { parseMeta, getSnippet, renderToShadowDOMReal, extractFromShadowDOM, canUseShadowDOM, detectInteractiveContent, openInNewWindow, exportAsHtmlFile } from "../utils/helpers.js";
import { updateFavButtonUI } from "./mainWindow.js";
import { getContinuationRoundsForFav } from "../core/api.js";

function getCurrentAvatarSrc() {
    let avatarSrc = null;

    // 尝试1：抓取聊天流中，最后一条属于角色的消息头像
    const lastCharImg = $(".mes[is_user='false'] .message_avatar_img").last();
    if (lastCharImg.length > 0) {
        avatarSrc = lastCharImg.attr("src");
    }

    // 尝试2：如果聊天里没图，尝试抓取主界面的大图
    if (!avatarSrc) {
        const mainImg = $("#character_image_div img");
        if (mainImg.length > 0 && mainImg.is(":visible")) {
            avatarSrc = mainImg.attr("src");
        }
    }

    // 尝试3：尝试抓取右侧设置栏的小头像
    if (!avatarSrc) {
        const navImg = $("#right-nav-panel .character-avatar");
        if (navImg.length > 0) {
            avatarSrc = navImg.attr("src");
        }
    }

    console.log("Titania: Captured Avatar Path ->", avatarSrc);
    return avatarSrc;
}

function escapeHtmlText(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// 分组阅读样式：必须内联注入，因为收藏内容渲染在 Shadow DOM 内，外部 css/favs.css 无法穿透。
// 折叠交互使用原生 <details>，避免在 Shadow DOM 内绑定事件（点击事件会被重定向到 shadow host）。
const CHAIN_SEGMENT_STYLE_ID = "t-chain-segment-style";
const CHAIN_SEGMENT_STYLES = `
<style data-t-style="${CHAIN_SEGMENT_STYLE_ID}">
.t-chain-segment { display: block; margin: 0; padding: 0; }
.t-chain-segment .t-chain-meta { display: block; margin: 0; padding: 0; }
.t-chain-segment .t-chain-meta > summary {
    display: flex !important;
    align-items: center;
    gap: 10px;
    padding: 14px 18px;
    cursor: pointer;
    list-style: none;
    user-select: none;
    outline: none;
}
.t-chain-segment .t-chain-meta > summary::-webkit-details-marker { display: none; }
.t-chain-segment .t-chain-meta > summary::marker { content: ""; }
.t-chain-segment .t-chain-meta-line {
    flex: 1 1 auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(191, 161, 95, 0.32), transparent);
}
.t-chain-segment .t-chain-meta-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(191, 161, 95, 0.34);
    background: rgba(191, 161, 95, 0.1);
    color: rgba(238, 220, 178, 0.78) !important;
    font-size: 11px !important;
    line-height: 1.4 !important;
    letter-spacing: 0.04em;
    white-space: nowrap;
    transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
}
.t-chain-segment .t-chain-meta > summary:hover .t-chain-meta-chip {
    color: #f6e7bf !important;
    border-color: rgba(231, 202, 143, 0.62);
    background: rgba(191, 161, 95, 0.18);
}
.t-chain-segment .t-chain-meta-caret {
    font-size: 9px !important;
    line-height: 1 !important;
    opacity: 0.7;
    transition: transform 0.2s ease;
}
.t-chain-segment .t-chain-meta[open] .t-chain-meta-caret { transform: rotate(180deg); }
.t-chain-segment .t-chain-meta-panel {
    margin: 0 18px 12px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgba(191, 161, 95, 0.22);
    background: rgba(24, 20, 14, 0.55);
}
.t-chain-segment .t-chain-meta-label {
    display: block;
    margin-bottom: 4px;
    color: rgba(229, 200, 140, 0.9) !important;
    font-size: 11px !important;
    line-height: 1.4 !important;
    letter-spacing: 0.04em;
}
.t-chain-segment .t-chain-meta-text {
    display: block;
    color: rgba(226, 219, 205, 0.86) !important;
    font-size: 12px !important;
    line-height: 1.6 !important;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
}
.t-chain-segment .t-chain-segment-body { display: block; }
</style>
`.trim();

function buildChainSegmentsHtml(chainItems) {
    const items = Array.isArray(chainItems) ? chainItems : [];
    if (items.length === 0) return "";

    return items.map((item, idx) => {
        const roundNo = Number(item?.round) || (idx + 1);
        const type = String(item?.type || (idx === 0 ? "initial" : "continuation"));
        const instruction = String(item?.instruction || "").trim() || (type === "initial" ? "（首次生成）" : "（自然续写）");
        const html = String(item?.html || "").trim();
        const chipLabel = type === "initial" ? "首次生成" : `第 ${roundNo} 段续写`;
        const instructionLabel = type === "initial" ? "生成说明" : "续写指令";

        return `
            <section class="t-chain-segment" data-round="${roundNo}" data-type="${escapeHtmlText(type)}">
                <details class="t-chain-meta">
                    <summary>
                        <span class="t-chain-meta-line"></span>
                        <span class="t-chain-meta-chip">
                            <span class="t-chain-meta-name">${escapeHtmlText(chipLabel)}</span>
                            <span class="t-chain-meta-caret">▼</span>
                        </span>
                        <span class="t-chain-meta-line"></span>
                    </summary>
                    <div class="t-chain-meta-panel">
                        <span class="t-chain-meta-label">${escapeHtmlText(instructionLabel)}</span>
                        <span class="t-chain-meta-text">${escapeHtmlText(instruction)}</span>
                    </div>
                </details>
                <div class="t-chain-segment-body">${html}</div>
            </section>
        `;
    }).join("\n");
}

/**
 * 构建分组收藏的合并 HTML
 * @param {Array} chainItems - 分组段落
 * @param {{withStyles?: boolean}} [options] - withStyles 为 true 时内联注入折叠样式（用于渲染/导出）
 */
function buildChainMergedHtml(chainItems, options = {}) {
    const segments = buildChainSegmentsHtml(chainItems);
    if (!segments) return "";
    return options.withStyles === true ? `${CHAIN_SEGMENT_STYLES}\n${segments}` : segments;
}

/**
 * 取得用于阅读/导出的分组 HTML
 * 优先按 items 实时重建，让旧收藏也能获得新的折叠布局；items 缺失时回退到已存 html
 */
function getChainDisplayHtml(item) {
    const rebuilt = buildChainMergedHtml(item?.items, { withStyles: true });
    if (rebuilt) return rebuilt;
    return String(item?.html || "");
}

function buildChainSignature(scriptId, rounds) {
    const payload = `${String(scriptId || "")}|${(Array.isArray(rounds) ? rounds : []).map(r => `${r.round}#${String(r.type || "continuation").trim()}#${String(r.instruction || "").trim()}#${String(r.content || "").trim()}`).join("|")}`;
    let hash = 0;
    for (let i = 0; i < payload.length; i++) {
        hash = (hash << 5) - hash + payload.charCodeAt(i);
        hash |= 0;
    }
    return `chain:${scriptId || "none"}:${Math.abs(hash)}`;
}

function replaceAllLiteral(str, search, replacement) {
    if (!str || !search) return str;
    return str.split(search).join(replacement);
}

function maskStringSameLength(value, maskChar = "█") {
    if (!value) return value;
    return Array.from(value).map(ch => (/\s/.test(ch) ? ch : maskChar)).join("");
}

function maskHtmlByToken(html, token, replacement) {
    if (!html || !token || !replacement) return html;

    try {
        // 包一层容器避免片段解析丢失顶层节点
        // 注意：不要在这里用 html.includes(token) 做短路。
        // 因为 raw HTML 可能包含实体编码（如 &），DOMParser 解析后文本节点会变为 &，
        // 这时字符串 includes 会误判，导致移动端直接跳过打码。
        const parser = new DOMParser();
        const doc = parser.parseFromString(`<div id="titania-mask-root">${html}</div>`, "text/html");
        const root = doc.getElementById("titania-mask-root");
        if (!root) return html;

        // 1) 文本节点打码
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
            const v = node.nodeValue;
            if (v && v.includes(token)) {
                node.nodeValue = replaceAllLiteral(v, token, replacement);
            }
        }

        // 1.5) 属性值打码（title/alt/aria-* 等可能在画面上展示或被工具提示显示）
        root.querySelectorAll("*").forEach(el => {
            try {
                const attrs = Array.from(el.attributes || []);
                attrs.forEach(attr => {
                    const name = (attr.name || "").toLowerCase();

                    // 避免破坏资源链接（src/href/srcset 等），仅处理“可能显示给用户”的属性
                    const shouldMask =
                        name === "title" ||
                        name === "alt" ||
                        name === "placeholder" ||
                        name === "value" ||
                        name === "style" ||
                        name.startsWith("aria-") ||
                        name.startsWith("data-");

                    if (!shouldMask) return;

                    const v = attr.value;
                    if (v && v.includes(token)) {
                        el.setAttribute(attr.name, replaceAllLiteral(v, token, replacement));
                    }
                });
            } catch (e) {
                // ignore
            }
        });

        // 2) style 标签里的文本（覆盖 CSS content: "..." 之类会渲染到画面上的情况）
        root.querySelectorAll("style").forEach(styleEl => {
            const css = styleEl.textContent || "";
            if (css && css.includes(token)) {
                styleEl.textContent = replaceAllLiteral(css, token, replacement);
            }
        });

        return root.innerHTML;
    } catch (e) {
        console.warn("Titania: maskHtmlByToken failed, fallback to string replace", e);
        return replaceAllLiteral(html, token, replacement);
    }
}

async function getExpandedUserNameForMasking() {
    // 优先走 ST 的 context：substituteParams("{{user}}") 与 name1
    // 目标：尽量拿到真实用户名，避免在某些移动端环境下回退到默认占位值导致打码不触发。
    try {
        if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            const u = ctx?.substituteParams?.("{{user}}");
            const name1 = ctx?.name1;

            // 1) 宏展开结果（优先），但如果返回的是默认占位 "User"，优先尝试 name1
            if (u && typeof u === "string" && u.trim() && u !== "{{user}}" && u !== "User") return u;

            // 2) ST 通常在 ctx.name1 保存用户名
            if (name1 && typeof name1 === "string" && name1.trim() && name1 !== "{{user}}") return name1;

            // 3) 如果用户名真的就叫 "User"，也允许返回 u（兜底）
            if (u && typeof u === "string" && u.trim() && u !== "{{user}}") return u;
        }
    } catch (e) {
        // ignore
    }

    // 降级：复用本插件的上下文封装
    try {
        const d = await getContextData();
        const u2 = d?.userName;
        if (u2 && typeof u2 === "string" && u2.trim() && u2 !== "{{user}}") return u2;
        return "";
    } catch (e) {
        return "";
    }
}

function createOffscreenExportDom(widthPx) {
    const root = document.createElement("div");
    root.className = "titania-offscreen-export";
    root.style.cssText = `position:fixed; left:-10000px; top:0; width:${widthPx}px; background:#0b0b0b; z-index:0; overflow:visible;`;

    const zone = document.createElement("div");
    zone.style.cssText = "width:100%; height:auto; overflow:visible;";

    const content = document.createElement("div");
    zone.appendChild(content);
    root.appendChild(zone);

    document.body.appendChild(root);

    return { root, zone, content };
}

function waitForNextPaint(frames = 2) {
    return new Promise(resolve => {
        const step = (n) => {
            if (n <= 0) return resolve();
            requestAnimationFrame(() => step(n - 1));
        };
        step(frames);
    });
}

async function waitForFontsReady(timeoutMs = 1500) {
    try {
        if (document.fonts && document.fonts.ready) {
            await Promise.race([
                document.fonts.ready,
                new Promise(r => setTimeout(r, timeoutMs))
            ]);
        }
    } catch (e) {
        // ignore
    }
}

function collectImagesDeep(rootEl) {
    const imgs = [];
    try {
        rootEl.querySelectorAll?.("img")?.forEach(img => imgs.push(img));
        rootEl.querySelectorAll?.(".t-shadow-host")?.forEach(host => {
            const shadow = host.shadowRoot;
            if (shadow) {
                shadow.querySelectorAll("img").forEach(img => imgs.push(img));
            }
        });
    } catch (e) {
        // ignore
    }
    return imgs;
}

function waitForImagesLoadedDeep(rootEl, timeoutMs = 5000) {
    const imgs = collectImagesDeep(rootEl).filter(img => !img.complete);
    if (imgs.length === 0) return Promise.resolve();

    return new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve();
        }, timeoutMs);

        let remaining = imgs.length;
        const finishOne = () => {
            remaining--;
            if (remaining <= 0 && !done) {
                done = true;
                clearTimeout(timer);
                resolve();
            }
        };

        imgs.forEach(img => {
            img.addEventListener("load", finishOne, { once: true });
            img.addEventListener("error", finishOne, { once: true });
        });
    });
}

/**
 * 一键收藏：保存当前剧场分组（首次生成 + 多轮续写）
 */
export async function saveFavorite() {
    await saveContinuationChainFavorite();
}

function getChainBaseHtmlFromItems(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return "";

    const initial = list.find(item => String(item?.type || "").trim() === "initial");
    const candidate = initial || list[0];
    return String(candidate?.html || candidate?.content || "").trim();
}

function isSameChainSessionByBaseHtml(favEntry, scriptId, currentItems) {
    if (!favEntry || favEntry.type !== "chain") return false;
    if (String(favEntry.scriptId || "") !== String(scriptId || "")) return false;

    const favBase = getChainBaseHtmlFromItems(favEntry.items);
    const currentBase = getChainBaseHtmlFromItems(currentItems);
    if (!favBase || !currentBase) return false;

    return favBase === currentBase;
}

function isSameChainSession(favEntry, scriptId, branchKey, currentItems) {
    if (!favEntry || favEntry.type !== "chain") return false;
    if (String(favEntry.scriptId || "") !== String(scriptId || "")) return false;

    const normalizedBranchKey = String(branchKey || "").trim();
    const favBranchKey = String(favEntry.branchKey || "").trim();
    if (normalizedBranchKey && favBranchKey) {
        return normalizedBranchKey === favBranchKey;
    }

    return isSameChainSessionByBaseHtml(favEntry, scriptId, currentItems);
}

/**
 * 保存当前剧本会话为分组收藏（首次生成 + 全部续写）
 */
export async function saveContinuationChainFavorite() {
    const currentResult = getCurrentGenerationResult();
    if (!isFavoriteEligible(currentResult)) {
        if (window.toastr) toastr.warning("当前没有可收藏的剧场内容");
        return false;
    }

    const display = GlobalState.displayState?.isViewingHistory
        ? GlobalState.sceneHistory?.items?.[GlobalState.displayState.currentViewIndex] || null
        : {
            scriptId: GlobalState.lastGeneratedScriptId,
            scriptName: ""
        };

    const scriptId = currentResult?.scriptId || display?.scriptId || GlobalState.lastGeneratedScriptId || GlobalState.lastUsedScriptId;
    if (!scriptId) {
        if (window.toastr) toastr.warning("未找到当前剧本，无法收藏续写链");
        return false;
    }

    const ctx = await getContextData();
    const chainData = getContinuationRoundsForFav(scriptId);
    const rounds = Array.isArray(chainData?.rounds) ? chainData.rounds : [];
    const currentDisplayContent = String(currentResult?.content || "").trim();

    const normalizedRounds = rounds.length > 0
        // 收藏入口已拒绝 running/failed 的当前结果；此处保留同一分支中已有内容的
        // partial/aborted 轮次，确保中断首段和后续成功主动续写可以一起归档。
        ? rounds.filter(round =>
            ["success", "partial", "aborted", "legacy"].includes(String(round?.status || "legacy"))
            && String(round?.content || "").trim().length > 0
        )
        : (currentDisplayContent
            ? [{ round: 1, type: "initial", instruction: "（首次生成）", content: currentDisplayContent, timestamp: Date.now() }]
            : []);

    if (normalizedRounds.length === 0) {
        if (window.toastr) toastr.warning("当前剧场没有可收藏内容");
        return false;
    }

    const items = normalizedRounds.map((item, idx) => ({
        round: Number(item?.round) || (idx + 1),
        type: String(item?.type || (idx === 0 ? "initial" : "continuation")),
        instruction: String(item?.instruction || "").trim(),
        html: String(item?.content || "").trim(),
        status: String(item?.status || "legacy"),
        generationId: String(item?.generationId || ""),
        timestamp: Number(item?.timestamp) || Date.now()
    })).filter(item => item.html.length > 0);

    if (items.length === 0) {
        if (window.toastr) toastr.warning("续写内容为空，无法收藏");
        return false;
    }

    const script = GlobalState.runtimeScripts.find(s => s.id === scriptId);
    const scriptName = String(chainData?.scriptName || script?.name || display?.scriptName || "场景");
    const branchKey = String(chainData?.branchKey || "").trim();
    const avatarSrc = getCurrentAvatarSrc();
    const chainSignature = buildChainSignature(scriptId, normalizedRounds);

    const data = getExtData();
    if (!Array.isArray(data.favs)) data.favs = [];

    const duplicated = data.favs.find(f => f?.type === "chain" && f?.chainSignature === chainSignature);
    if (duplicated) {
        GlobalState.lastFavId = duplicated.id;
        syncFavIdToCurrentHistory(duplicated.id);
        updateFavButtonUI();
        if (window.toastr) toastr.info("当前剧场分组已收藏，无需重复收藏");
        return true;
    }

    // 存储自带样式的完整 HTML，保证复制源码/旧数据回退时折叠布局依然可用
    const mergedHtml = buildChainMergedHtml(items, { withStyles: true });
    const now = Date.now();

    const activeFavId = Number(GlobalState.lastFavId) || null;
    let existingChain = null;
    if (activeFavId) {
        existingChain = data.favs.find(f => f?.type === "chain" && Number(f?.id) === activeFavId) || null;
    }
    if (!existingChain) {
        existingChain = data.favs.find(f => isSameChainSession(f, scriptId, branchKey, items)) || null;
    }

    if (existingChain) {
        existingChain.title = `${scriptName} - ${ctx.charName}`;
        existingChain.charName = ctx.charName;
        existingChain.scriptName = scriptName;
        existingChain.scriptId = scriptId;
        existingChain.date = new Date(now).toLocaleString();
        existingChain.html = mergedHtml;
        existingChain.avatar = avatarSrc;
        existingChain.branchKey = branchKey;
        existingChain.chainSignature = chainSignature;
        existingChain.items = items;

        saveExtData();
        GlobalState.lastFavId = existingChain.id;
        syncFavIdToCurrentHistory(existingChain.id);
        updateFavButtonUI();
        if (window.toastr) toastr.success(`已更新当前剧场分组收藏（共 ${items.length} 段）`);
        return true;
    }

    const entry = {
        id: now,
        type: "chain",
        title: `${scriptName} - ${ctx.charName}`,
        charName: ctx.charName,
        scriptName,
        scriptId,
        date: new Date(now).toLocaleString(),
        html: mergedHtml,
        avatar: avatarSrc,
        branchKey,
        chainSignature,
        items
    };

    data.favs.unshift(entry);
    saveExtData();

    GlobalState.lastFavId = entry.id;
    syncFavIdToCurrentHistory(entry.id);
    updateFavButtonUI();

    if (window.toastr) toastr.success(`已收藏当前剧场分组（共 ${items.length} 段）`);
    return true;
}

/**
 * 取消收藏功能
 * @returns {boolean} 是否成功取消
 */
export function unsaveFavorite() {
    if (!GlobalState.lastFavId) {
        if (window.toastr) toastr.warning("当前内容未收藏");
        return false;
    }

    const data = getExtData();
    if (!data.favs) {
        GlobalState.lastFavId = null;
        return false;
    }

    const targetFavId = String(GlobalState.lastFavId);

    // 从收藏列表中删除（兼容 number/string id）
    const originalLength = data.favs.length;
    data.favs = data.favs.filter(f => String(f?.id) !== targetFavId);

    if (data.favs.length < originalLength) {
        saveExtData();
        GlobalState.lastFavId = null;

        // 同步收藏 ID 到当前查看的历史记录项
        syncFavIdToCurrentHistory(null);

        // 更新收藏按钮 UI
        updateFavButtonUI();

        if (window.toastr) toastr.info("已取消收藏");
        return true;
    }

    // 兜底：当前收藏 ID 已失效（历史记录残留），主动校正 UI 与状态
    GlobalState.lastFavId = null;
    syncFavIdToCurrentHistory(null);
    updateFavButtonUI();
    if (window.toastr) toastr.info("收藏状态已同步为未收藏");
    return true;
}

/**
 * 收藏夹窗口
 */
export function openFavsWindow() {
    setFavsWindowOpen(true);
    $("#t-main-view").hide();
    const data = getExtData();
    const favs = data.favs || [];

    let currentFilteredList = [];
    let currentIndex = -1;
    let currentFavId = null;

    // 批量删除相关状态
    let isEditMode = false;
    let selectedIds = new Set();
    let searchDebounceTimer = null;
    let currentMap = {};
    let filteredIndexMap = new Map();
    let activeCarouselIndex = 0;
    let carouselTimer = null;
    let carouselPauseUntil = 0;
    let isThumbDragging = false;
    let thumbDragMoved = false;
    let thumbDragStartX = 0;
    let thumbDragStartScrollLeft = 0;
    let thumbVirtualRange = { start: 0, end: -1 };
    let thumbVirtualRaf = null;
    let gridRenderRaf = null;
    let pendingGridRenderOptions = null;
    let editHydrationTimer = null;
    let editHydrationToken = 0;
    let editPageIndex = 0;
    let favViewMode = String(data.favs_view_mode || "poster").trim() === "compact" ? "compact" : "poster";
    const AUTO_SWITCH_MS = 2000;
    const MANUAL_PAUSE_MS = 6000;
    const SEARCH_DEBOUNCE_MS = 240;
    const POSTER_CARD_BUFFER = 1;
    const THUMB_VIRTUAL_THRESHOLD = 120;
    const THUMB_ITEM_WIDTH = 150;
    const THUMB_ITEM_GAP = 10;
    const THUMB_RENDER_BUFFER = 6;
    const EDIT_PAGE_SIZE = 120;

    // 紧凑视图虚拟滚动状态
    let compactScrollRaf = null;
    let compactResizeObserver = null;
    let compactCardHeight = 280;
    let compactCardGap = 14;
    let compactColumnCount = 1;
    let compactRowCount = 0;
    let compactCardWidth = 260;
    const COMPACT_BUFFER_ROWS = 2;

    // 构建角色索引，优先使用独立的 charName 字段（兼容旧数据）
    const charIndex = new Set();
    favs.forEach(f => {
        // 优先使用独立存储的 charName，否则从 title 解析（兼容旧数据）
        if (f.charName) {
            f._meta = {
                char: f.charName,
                script: f.scriptName || f.title.split(' - ')[0] || f.title
            };
        } else {
            // 兼容旧数据：从 title 解析
            f._meta = parseMeta(f.title || "");
        }
        charIndex.add(f._meta.char);
    });
    const charList = ["全部角色", ...[...charIndex].sort()];

    // HTML 结构 (样式见 css/favs.css)
    const html = `
    <div class="t-box t-root t-fav-container" id="t-favs-view">
        <div class="t-header" style="flex-shrink:0;">
            <span class="t-title-main">📖 收藏画廊</span>
            <span class="t-close" id="t-fav-close">&times;</span>
        </div>
        
        <!-- 普通工具栏：抽屉内为同一套真实控件，桌面端 display:contents 平铺，移动端折叠为下拉面板 -->
        <div class="t-fav-toolbar" id="t-fav-toolbar-normal">
            <i class="fa-solid fa-filter t-fav-filter-icon" style="color:var(--t-color-text-faint);"></i>
            <select id="t-fav-filter-char" class="t-fav-filter-select">
                ${charList.map(c => `<option value="${c}">${c}</option>`).join('')}
            </select>
            <div class="t-fav-tools-drawer" id="t-fav-tools-drawer" hidden>
                <select id="t-fav-sort" class="t-fav-filter-select" title="排序方式">
                    <option value="newest">最新优先</option>
                    <option value="oldest">最早优先</option>
                    <option value="title_asc">标题 A-Z</option>
                    <option value="title_desc">标题 Z-A</option>
                </select>
                <input type="text" id="t-fav-search" class="t-fav-search" placeholder="搜索关键词...">
                <button id="t-fav-view-toggle" class="t-tool-btn t-fav-view-toggle" title="切换紧凑模式"><span>紧凑</span><span>模式</span></button>
                <button id="t-btn-img-mgr" class="t-tool-btn" title="管理角色背景图"><i class="fa-regular fa-image"></i> 图鉴</button>
            </div>
            <button id="t-btn-edit-mode" class="t-tool-btn t-fav-toolbar-tail" title="批量管理"><i class="fa-solid fa-pen-to-square"></i> 编辑</button>
            <button class="t-tool-btn t-fav-drawer-toggle" id="t-fav-drawer-toggle" title="更多工具" aria-label="更多工具" aria-controls="t-fav-tools-drawer" aria-expanded="false"><i class="fa-solid fa-sliders"></i></button>
        </div>
        
        <!-- 编辑模式工具栏 -->
        <div class="t-fav-toolbar t-fav-toolbar-edit" id="t-fav-toolbar-edit" style="display:none;">
            <div style="display:flex; align-items:center; gap:10px; flex-grow:1;">
                <button id="t-btn-select-all" class="t-tool-btn"><i class="fa-regular fa-square-check"></i> 全选</button>
                <button id="t-btn-deselect-all" class="t-tool-btn"><i class="fa-regular fa-square"></i> 取消全选</button>
                <span id="t-edit-count" style="color:var(--t-color-text-muted); font-size:0.9em;">已选择 0 项</span>
                <div id="t-edit-pager" style="display:none; align-items:center; gap:8px; margin-left:8px;">
                    <button id="t-edit-page-prev" class="t-tool-btn" title="上一页"><i class="fa-solid fa-chevron-left"></i></button>
                    <span id="t-edit-page-stat" style="color:#8f949b; font-size:0.85em; min-width:180px; text-align:center;">第 1/1 页</span>
                    <button id="t-edit-page-next" class="t-tool-btn" title="下一页"><i class="fa-solid fa-chevron-right"></i></button>
                </div>
            </div>
            <div style="display:flex; gap:10px; align-items:center;">
                <button id="t-btn-delete-selected" class="t-tool-btn t-btn-danger" title="删除选中项" disabled><i class="fa-solid fa-trash"></i> 删除选中</button>
                <button id="t-btn-exit-edit" class="t-tool-btn"><i class="fa-solid fa-xmark"></i> 退出编辑</button>
            </div>
        </div>
        
        <div class="t-fav-grid-area">
            <div class="t-fav-grid t-fav-carousel-stage" id="t-fav-grid"></div>
            <button class="t-fav-carousel-nav prev" id="t-fav-prev" title="上一张"><i class="fa-solid fa-chevron-left"></i></button>
            <button class="t-fav-carousel-nav next" id="t-fav-next" title="下一张"><i class="fa-solid fa-chevron-right"></i></button>
            <div class="t-fav-carousel-thumbs" id="t-fav-thumbs"></div>
        </div>

        <div class="t-fav-reader" id="t-fav-reader">
            <div class="t-read-header">
                <div style="display:flex; align-items:center; gap:15px; overflow:hidden; flex-grow:1;">
                    <i class="fa-solid fa-chevron-left" id="t-read-back" style="cursor:pointer; font-size:1.2em; padding:5px; color:var(--t-color-text-secondary);"></i>
                    <div style="display:flex; flex-direction:column; justify-content:center; overflow:hidden;">
                        <div id="t-read-meta" class="t-read-meta-text" style="font-weight:bold; color:#ccc; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>
                        <div id="t-read-index" style="font-size:0.75em; color:var(--t-color-text-faint);">0 / 0</div>
                    </div>
                </div>
                <div class="t-read-actions">
                    <button class="t-tool-btn" id="t-read-toggle-meta" title="展开全部段落信息" style="display:none;"><i class="fa-solid fa-circle-info"></i></button>
                    <button class="t-tool-btn t-read-inline-opt" id="t-read-rename" title="重命名"><i class="fa-solid fa-pen"></i></button>
                    <button class="t-tool-btn t-read-inline-opt" id="t-read-img" title="导出图片"><i class="fa-solid fa-camera"></i></button>
                    <button class="t-tool-btn t-read-inline-opt" id="t-read-code" title="复制HTML"><i class="fa-solid fa-code"></i></button>
                    <button class="t-tool-btn" id="t-read-open-window" title="新窗口打开(互动模式)"><i class="fa-solid fa-up-right-from-square"></i></button>
                    <div class="t-read-more-wrap">
                        <button class="t-tool-btn t-read-more-btn" id="t-read-more" title="更多操作" aria-label="更多操作" aria-haspopup="true" aria-expanded="false"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                        <div class="t-read-more-menu" id="t-read-more-menu" hidden>
                            <button type="button" class="t-read-menu-opt" data-read-action="rename"><i class="fa-solid fa-pen"></i><span>重命名</span></button>
                            <button type="button" class="t-read-menu-opt" data-read-action="img"><i class="fa-solid fa-camera"></i><span>导出图片</span></button>
                            <button type="button" class="t-read-menu-opt" data-read-action="code"><i class="fa-solid fa-code"></i><span>复制 HTML</span></button>
                            <div class="t-read-more-sep"></div>
                            <button type="button" class="danger" id="t-read-menu-del-segment" data-read-action="del-segment"><i class="fa-solid fa-scissors"></i><span>删除分组段落</span></button>
                            <button type="button" class="danger" data-read-action="del-one"><i class="fa-solid fa-trash"></i><span>删除此收藏</span></button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="t-read-body">
                <div id="t-read-capture-zone">
                    <div id="t-read-content"></div>
                </div>
            </div>
            <!-- 代理按钮：仅承载既有事件处理器，由顶栏菜单转发点击，不直接展示 -->
            <div class="t-read-proxy-actions" aria-hidden="true">
                <button type="button" id="t-read-del-segment"></button>
                <button type="button" id="t-read-del-one"></button>
            </div>
        </div>
    </div>`;

    $("#t-overlay").append(html);

    // --- 核心逻辑 ---

    const saveFavViewMode = (mode) => {
        data.favs_view_mode = mode === "compact" ? "compact" : "poster";
        saveExtData();
    };

    const isCompactView = () => favViewMode === "compact" && !isEditMode;

    const syncFavViewModeClass = () => {
        const $root = $("#t-favs-view");
        $root.toggleClass("t-fav-mode-compact", isCompactView());
    };

    const syncFavViewToggleButton = () => {
        const $btn = $("#t-fav-view-toggle");
        const compact = favViewMode === "compact";
        $btn.toggleClass("is-active", compact);
        $btn.attr("title", compact ? "切换海报轮播模式" : "切换紧凑模式");
        $btn.html(compact ? "<span>海报</span><span>模式</span>" : "<span>紧凑</span><span>模式</span>");
    };

    // 更新选中计数显示
    const updateSelectionCount = () => {
        const count = selectedIds.size;
        $("#t-edit-count").text(`已选择 ${count} 项`);
        $("#t-btn-delete-selected").prop("disabled", count === 0);
        if (count > 0) {
            $("#t-btn-delete-selected").html(`<i class="fa-solid fa-trash"></i> 删除选中 (${count})`);
        } else {
            $("#t-btn-delete-selected").html(`<i class="fa-solid fa-trash"></i> 删除选中`);
        }
    };

    const clearEditHydration = () => {
        if (editHydrationTimer) {
            clearTimeout(editHydrationTimer);
            editHydrationTimer = null;
        }
        editHydrationToken += 1;
    };

    const scheduleGridRender = (options = {}) => {
        pendingGridRenderOptions = {
            ...(pendingGridRenderOptions || {}),
            ...options
        };

        if (gridRenderRaf) return;

        gridRenderRaf = requestAnimationFrame(() => {
            gridRenderRaf = null;
            const nextOptions = pendingGridRenderOptions || {};
            pendingGridRenderOptions = null;
            renderGrid(nextOptions);
        });
    };

    const syncEditPager = (totalItems, rangeStart, rangeEndExclusive) => {
        const $pager = $("#t-edit-pager");
        const totalPages = Math.max(1, Math.ceil(totalItems / EDIT_PAGE_SIZE));

        if (!isEditMode || totalItems <= EDIT_PAGE_SIZE) {
            $pager.hide();
            return;
        }

        $pager.css("display", "flex");
        $("#t-edit-page-prev").prop("disabled", editPageIndex <= 0);
        $("#t-edit-page-next").prop("disabled", editPageIndex >= totalPages - 1);

        const start = totalItems === 0 ? 0 : rangeStart + 1;
        const end = totalItems === 0 ? 0 : Math.max(start, rangeEndExclusive);
        $("#t-edit-page-stat").text(`第 ${editPageIndex + 1}/${totalPages} 页 · ${start}-${end}/${totalItems}`);
    };

    // 切换编辑模式
    const toggleEditMode = (enable) => {
        isEditMode = enable;
        setFavDrawerOpen(false);
        if (enable) {
            $("#t-fav-toolbar-normal").hide();
            $("#t-fav-toolbar-edit").show();
            $("#t-fav-grid").addClass("edit-mode");
            selectedIds.clear();
            editPageIndex = 0;
            updateSelectionCount();
        } else {
            $("#t-fav-toolbar-normal").show();
            $("#t-fav-toolbar-edit").hide();
            $("#t-fav-grid").removeClass("edit-mode");
            selectedIds.clear();
            $(".t-fav-card").removeClass("selected");
            clearEditHydration();
        }
        syncFavViewModeClass();
        scheduleGridRender({ preserveEditPage: enable, liteEditPage: true, hydrateEditPage: true });
    };

    const getCachedSnippet = (item) => {
        if (typeof item._snippetText === "string") return item._snippetText;

        const isChain = item?.type === "chain";
        const chainItems = Array.isArray(item?.items) ? item.items : [];
        // 卡片摘要只取正文，不混入生成指令，避免预览被指令文本淹没
        const chainSnippetSource = isChain
            ? chainItems.map(seg => String(seg?.html || "").trim()).filter(Boolean).join("\n")
            : "";

        item._snippetText = getSnippet(isChain ? chainSnippetSource || item.html : item.html);
        return item._snippetText;
    };

    // 指令文本不进摘要，但仍需可被搜索命中
    const getChainInstructionText = (item) => {
        if (typeof item._instructionText === "string") return item._instructionText;

        const chainItems = item?.type === "chain" && Array.isArray(item?.items) ? item.items : [];
        item._instructionText = chainItems
            .map(seg => String(seg?.instruction || "").trim())
            .filter(Boolean)
            .join(" ");

        return item._instructionText;
    };

    const getCachedSearchText = (item) => {
        if (typeof item._searchText === "string") return item._searchText;

        const snippet = getCachedSnippet(item);
        item._searchText = [
            String(item?.title || ""),
            String(item?._meta?.script || ""),
            String(item?._meta?.char || ""),
            String(snippet || ""),
            getChainInstructionText(item)
        ].join(" ").toLowerCase();

        return item._searchText;
    };

    const clearCarouselTimer = () => {
        if (carouselTimer) {
            clearInterval(carouselTimer);
            carouselTimer = null;
        }
    };

    const pauseCarousel = (ms = MANUAL_PAUSE_MS) => {
        carouselPauseUntil = Date.now() + ms;
    };

    const normalizeCarouselIndex = (index) => {
        const total = currentFilteredList.length;
        if (total <= 0) return 0;
        const mod = index % total;
        return mod < 0 ? mod + total : mod;
    };

    const setActiveCarouselIndex = (index, options = {}) => {
        const total = currentFilteredList.length;
        if (total <= 0) return;
        const normalized = normalizeCarouselIndex(index);
        const resetPause = options.resetPause !== false;
        const smoothScroll = options.smoothScroll !== false;

        activeCarouselIndex = normalized;

        renderPosterCards(normalized);
        renderVirtualThumbs(normalized);

        const activeThumb = document.querySelector(`#t-fav-thumbs .t-fav-thumb[data-fav-index='${normalized}']`);
        if (activeThumb?.scrollIntoView) {
            activeThumb.scrollIntoView({ behavior: smoothScroll ? "smooth" : "auto", inline: "nearest", block: "nearest" });
        }

        if (resetPause) pauseCarousel();
    };

    const renderPosterCards = (activeIndex) => {
        const gridEl = document.getElementById("t-fav-grid");
        if (!gridEl) return;
        gridEl.innerHTML = "";

        const total = currentFilteredList.length;
        if (total <= 0) return;

        const active = normalizeCarouselIndex(activeIndex);
        const appendIndexIfNew = (list, idx) => {
            if (!list.includes(idx)) list.push(idx);
        };

        const visibleIndexes = [];
        appendIndexIfNew(visibleIndexes, active);
        for (let i = 1; i <= POSTER_CARD_BUFFER; i += 1) {
            appendIndexIfNew(visibleIndexes, normalizeCarouselIndex(active - i));
            appendIndexIfNew(visibleIndexes, normalizeCarouselIndex(active + i));
        }

        const cardFrag = document.createDocumentFragment();
        visibleIndexes.forEach((idx) => {
            const item = currentFilteredList[idx];
            if (!item) return;
            const card = buildCardElement(item, idx, currentMap);
            if (idx === active) {
                card.classList.add("is-active");
                card.setAttribute("aria-hidden", "false");
            } else {
                card.classList.remove("is-active");
                card.setAttribute("aria-hidden", "true");
            }
            cardFrag.appendChild(card);
        });
        gridEl.appendChild(cardFrag);
    };

    const renderAllThumbs = () => {
        const thumbsEl = document.getElementById("t-fav-thumbs");
        if (!thumbsEl) return;
        thumbsEl.innerHTML = "";
        const frag = document.createDocumentFragment();
        currentFilteredList.forEach((item, idx) => {
            frag.appendChild(buildThumbElement(item, idx, currentMap));
        });
        thumbsEl.appendChild(frag);
        thumbsEl.scrollLeft = 0;
        thumbVirtualRange = { start: 0, end: currentFilteredList.length - 1 };
    };

    const getThumbVirtualBounds = () => {
        const thumbsEl = document.getElementById("t-fav-thumbs");
        const total = currentFilteredList.length;
        if (!thumbsEl || total <= 0) return { start: 0, end: -1 };
        const itemSpan = THUMB_ITEM_WIDTH + THUMB_ITEM_GAP;
        const viewportWidth = thumbsEl.clientWidth || 1;
        const firstVisible = Math.floor((thumbsEl.scrollLeft || 0) / itemSpan);
        const visibleCount = Math.ceil(viewportWidth / itemSpan);
        const start = Math.max(0, firstVisible - THUMB_RENDER_BUFFER);
        const end = Math.min(total - 1, firstVisible + visibleCount + THUMB_RENDER_BUFFER);
        return { start, end };
    };

    const renderVirtualThumbs = (forceActiveIndex = null) => {
        const thumbsEl = document.getElementById("t-fav-thumbs");
        const total = currentFilteredList.length;
        if (!thumbsEl) return;

        if (total <= THUMB_VIRTUAL_THRESHOLD) {
            if (thumbVirtualRange.end < 0 || thumbsEl.childElementCount !== total) {
                renderAllThumbs();
            }
            const activeThumb = thumbsEl.querySelector(`[data-fav-index='${activeCarouselIndex}']`);
            if (activeThumb) {
                thumbsEl.querySelectorAll(".t-fav-thumb.is-active").forEach((el) => el.classList.remove("is-active"));
                activeThumb.classList.add("is-active");
            }
            return;
        }

        const itemSpan = THUMB_ITEM_WIDTH + THUMB_ITEM_GAP;
        let { start, end } = getThumbVirtualBounds();
        const ensureIndex = Number.isInteger(forceActiveIndex) ? normalizeCarouselIndex(forceActiveIndex) : activeCarouselIndex;
        if (ensureIndex < start) start = Math.max(0, ensureIndex - THUMB_RENDER_BUFFER);
        if (ensureIndex > end) end = Math.min(total - 1, ensureIndex + THUMB_RENDER_BUFFER);

        const hasRenderedNodes = thumbsEl.childElementCount > 0;
        const rangeUnchanged = hasRenderedNodes && thumbVirtualRange.start === start && thumbVirtualRange.end === end;
        if (!rangeUnchanged) {
            thumbsEl.innerHTML = "";

            const leftSpacer = document.createElement("div");
            leftSpacer.className = "t-fav-thumb-spacer";
            leftSpacer.style.width = `${start * itemSpan}px`;
            leftSpacer.setAttribute("aria-hidden", "true");
            leftSpacer.style.flex = "0 0 auto";
            thumbsEl.appendChild(leftSpacer);

            const frag = document.createDocumentFragment();
            for (let idx = start; idx <= end; idx += 1) {
                const item = currentFilteredList[idx];
                if (!item) continue;
                frag.appendChild(buildThumbElement(item, idx, currentMap));
            }
            thumbsEl.appendChild(frag);

            const rightSpacer = document.createElement("div");
            rightSpacer.className = "t-fav-thumb-spacer";
            rightSpacer.style.width = `${Math.max(0, (total - end - 1) * itemSpan)}px`;
            rightSpacer.setAttribute("aria-hidden", "true");
            rightSpacer.style.flex = "0 0 auto";
            thumbsEl.appendChild(rightSpacer);

            thumbVirtualRange = { start, end };
        }

        thumbsEl.querySelectorAll(".t-fav-thumb.is-active").forEach((el) => el.classList.remove("is-active"));
        const activeThumb = thumbsEl.querySelector(`[data-fav-index='${activeCarouselIndex}']`);
        if (activeThumb) activeThumb.classList.add("is-active");
    };

    const scheduleVirtualThumbRender = () => {
        if (thumbVirtualRaf) return;
        thumbVirtualRaf = requestAnimationFrame(() => {
            thumbVirtualRaf = null;
            renderVirtualThumbs();
        });
    };

    const restartCarouselAutoplay = () => {
        clearCarouselTimer();
        if (currentFilteredList.length <= 1) return;

        carouselTimer = setInterval(() => {
            if (Date.now() < carouselPauseUntil) return;
            if (isEditMode) return;
            if ($("#t-fav-reader").hasClass("show")) return;
            setActiveCarouselIndex(activeCarouselIndex + 1, { resetPause: false });
        }, AUTO_SWITCH_MS);
    };

    const buildCardElement = (item, idx, currentMap, options = {}) => {
        const useLite = options.lite === true;
        const isChain = item?.type === "chain";
        const chainItems = Array.isArray(item?.items) ? item.items : [];
        const chainCount = chainItems.length;
        const snippet = useLite ? "内容预览加载中..." : getCachedSnippet(item);
        const charName = item._meta.char;
        let bgUrl = "";
        if (!useLite) {
            bgUrl = currentMap[charName];
            if (!bgUrl) bgUrl = item.avatar;
        }
        const bgClass = bgUrl ? '' : 'no-img';
        const bgStyle = bgUrl ? `background-image: url('${bgUrl}')` : '';
        const cardBgClass = bgUrl ? '' : 'no-img';
        const charInitial = (String(charName || "?").trim().charAt(0) || "?").toUpperCase();
        const isSelected = selectedIds.has(item.id);
        const displayDate = String(item.date || "").split(' ')[0] || "-";
        const chainBadge = isChain ? `<span class="t-fav-chain-badge">剧场分组 · ${chainCount}段</span>` : "";

        const card = $(`
            <div class="t-fav-card ${isSelected ? 'selected' : ''} ${isChain ? 't-fav-card-chain' : ''} ${cardBgClass}" data-fav-id="${item.id}" data-fav-index="${idx}" aria-hidden="true">
                <div class="t-fav-card-checkbox">
                    <i class="fa-${isSelected ? 'solid fa-square-check' : 'regular fa-square'}"></i>
                </div>
                <div class="t-fav-card-bg ${bgClass}" style="${bgStyle}"></div>
                <div class="t-fav-card-poster" style="${bgStyle}" data-initial="${escapeHtmlText(charInitial)}"></div>
                <div class="t-fav-card-overlay"></div>
                <div class="t-fav-card-content">
                    <div class="t-fav-card-header">
                        <div class="t-fav-card-script">${item._meta.script}</div>
                        <div class="t-fav-card-char"><i class="fa-solid fa-user-tag" style="font-size:0.8em"></i> ${charName}</div>
                    </div>
                    <div class="t-fav-card-snippet">${snippet}</div>
                    <div class="t-fav-card-footer"><span>${displayDate}</span>${chainBadge}</div>
                </div>
            </div>
        `);

        return card[0];
    };

    const buildThumbElement = (item, idx, currentMap) => {
        const charName = item?._meta?.char || "未知角色";
        const scriptName = item?._meta?.script || item?.title || "未命名收藏";
        const bgUrl = currentMap[charName] || item.avatar || "";
        const thumb = $(`
            <button class="t-fav-thumb" data-fav-index="${idx}" title="${escapeHtmlText(scriptName)}">
                <span class="t-fav-thumb-bg" style="${bgUrl ? `background-image: url('${bgUrl}')` : ''}"></span>
                <span class="t-fav-thumb-label">${escapeHtmlText(scriptName)}</span>
            </button>
        `);
        return thumb[0];
    };

    const updateCompactResponsive = () => {
        const mobile = window.matchMedia("(max-width: 600px)").matches;
        compactCardHeight = mobile ? 220 : 280;
        compactCardGap = mobile ? 10 : 14;
    };

    const computeCompactLayout = () => {
        const gridEl = document.getElementById("t-fav-grid");
        if (!gridEl) return;
        updateCompactResponsive();
        const containerWidth = gridEl.clientWidth;
        if (containerWidth <= 0) return;
        const minCardWidth = compactCardGap === 10 ? 160 : 260;
        compactColumnCount = Math.max(1, Math.floor((containerWidth + compactCardGap) / (minCardWidth + compactCardGap)));
        compactCardWidth = (containerWidth - (compactColumnCount - 1) * compactCardGap) / compactColumnCount;
        compactRowCount = Math.max(1, Math.ceil(currentFilteredList.length / compactColumnCount));
    };

    const getCompactVisibleRange = () => {
        const gridArea = document.querySelector("#t-favs-view .t-fav-grid-area");
        if (!gridArea || compactRowCount <= 0) return { start: 0, end: -1 };
        const scrollTop = gridArea.scrollTop;
        const viewportHeight = gridArea.clientHeight;
        const rowHeight = compactCardHeight + compactCardGap;
        const firstVisibleRow = Math.floor(scrollTop / rowHeight);
        const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;
        const startRow = Math.max(0, firstVisibleRow - COMPACT_BUFFER_ROWS);
        const endRow = Math.min(compactRowCount - 1, firstVisibleRow + visibleRows + COMPACT_BUFFER_ROWS);
        return {
            start: Math.max(0, startRow * compactColumnCount),
            end: Math.min(currentFilteredList.length - 1, (endRow + 1) * compactColumnCount - 1)
        };
    };

    const updateCompactSpacer = () => {
        const gridEl = document.getElementById("t-fav-grid");
        if (!gridEl) return;
        let spacer = gridEl.querySelector(".t-fav-compact-spacer");
        if (!spacer) {
            spacer = document.createElement("div");
            spacer.className = "t-fav-compact-spacer";
            spacer.setAttribute("aria-hidden", "true");
            spacer.style.cssText = "width:100%; pointer-events:none;";
            gridEl.appendChild(spacer);
        }
        const totalHeight = Math.max(0, compactRowCount * (compactCardHeight + compactCardGap) - compactCardGap);
        spacer.style.height = `${totalHeight}px`;
    };

    const renderCompactCards = (visibleRange) => {
        const gridEl = document.getElementById("t-fav-grid");
        if (!gridEl) return;
        gridEl.querySelectorAll(".t-fav-card").forEach(el => el.remove());
        if (visibleRange.end < visibleRange.start) return;
        const frag = document.createDocumentFragment();
        for (let idx = visibleRange.start; idx <= visibleRange.end; idx++) {
            const item = currentFilteredList[idx];
            if (!item) continue;
            const col = idx % compactColumnCount;
            const row = Math.floor(idx / compactColumnCount);
            const card = buildCardElement(item, idx, currentMap);
            card.classList.add("is-active");
            card.setAttribute("aria-hidden", "false");
            Object.assign(card.style, {
                position: "absolute",
                top: `${row * (compactCardHeight + compactCardGap)}px`,
                left: `${col * (compactCardWidth + compactCardGap)}px`,
                width: `${compactCardWidth}px`,
                height: `${compactCardHeight}px`,
                boxSizing: "border-box"
            });
            frag.appendChild(card);
        }
        gridEl.appendChild(frag);
    };

    const scheduleCompactRender = () => {
        if (compactScrollRaf) return;
        compactScrollRaf = requestAnimationFrame(() => {
            compactScrollRaf = null;
            if (!isCompactView()) return;
            const range = getCompactVisibleRange();
            renderCompactCards(range);
        });
    };

    const setupCompactResizeObserver = () => {
        if (compactResizeObserver) compactResizeObserver.disconnect();
        const gridEl = document.getElementById("t-fav-grid");
        if (!gridEl) return;
        compactResizeObserver = new ResizeObserver(() => {
            if (!isCompactView()) return;
            const prevCols = compactColumnCount;
            computeCompactLayout();
            updateCompactSpacer();
            if (compactColumnCount !== prevCols) {
                const range = getCompactVisibleRange();
                renderCompactCards(range);
            }
        });
        compactResizeObserver.observe(gridEl);
    };

    const renderGrid = (options = {}) => {
        const grid = $("#t-fav-grid");
        const gridEl = grid[0];
        const thumbsEl = document.getElementById("t-fav-thumbs");
        if (!gridEl) return;

        grid.empty();
        if (thumbsEl) thumbsEl.innerHTML = "";
        filteredIndexMap.clear();
        currentMap = getExtData().character_map || {};

        const targetChar = $("#t-fav-filter-char").val();
        const sortMode = String($("#t-fav-sort").val() || "newest");
        const search = String($("#t-fav-search").val() || "").trim().toLowerCase();

        currentFilteredList = favs.filter(f => {
            if (targetChar !== "全部角色" && f._meta.char !== targetChar) return false;
            if (search && !getCachedSearchText(f).includes(search)) return false;
            return true;
        });

        const getTimeValue = (item) => {
            const idNum = Number(item?.id);
            if (Number.isFinite(idNum) && idNum > 0) return idNum;
            const parsed = Date.parse(String(item?.date || ""));
            return Number.isFinite(parsed) ? parsed : 0;
        };

        if (sortMode === "oldest") {
            currentFilteredList.sort((a, b) => getTimeValue(a) - getTimeValue(b));
        } else if (sortMode === "title_asc") {
            currentFilteredList.sort((a, b) => String(a?._meta?.script || a?.title || "").localeCompare(String(b?._meta?.script || b?.title || ""), "zh-Hans-CN"));
        } else if (sortMode === "title_desc") {
            currentFilteredList.sort((a, b) => String(b?._meta?.script || b?.title || "").localeCompare(String(a?._meta?.script || a?.title || ""), "zh-Hans-CN"));
        } else {
            currentFilteredList.sort((a, b) => getTimeValue(b) - getTimeValue(a));
        }

        currentFilteredList.forEach((item, idx) => {
            filteredIndexMap.set(String(item.id), idx);
        });

        if (currentFilteredList.length === 0) {
            grid.append('<div class="t-fav-empty">没有找到相关收藏</div>');
            clearCarouselTimer();
            thumbVirtualRange = { start: 0, end: -1 };
            return;
        }

        // 保持编辑模式类名
        if (isEditMode) {
            grid.addClass("edit-mode");
        } else {
            grid.removeClass("edit-mode");
        }

        if (isEditMode) {
            clearCarouselTimer();
            const preserveEditPage = options.preserveEditPage === true;
            if (!preserveEditPage) {
                editPageIndex = 0;
            }

            const totalItems = currentFilteredList.length;
            const totalPages = Math.max(1, Math.ceil(totalItems / EDIT_PAGE_SIZE));
            if (editPageIndex < 0) editPageIndex = 0;
            if (editPageIndex >= totalPages) editPageIndex = totalPages - 1;

            const pageStart = editPageIndex * EDIT_PAGE_SIZE;
            const pageEndExclusive = Math.min(totalItems, pageStart + EDIT_PAGE_SIZE);
            const pageItems = currentFilteredList.slice(pageStart, pageEndExclusive);
            const renderLite = options.liteEditPage === true;

            const cardFrag = document.createDocumentFragment();
            pageItems.forEach((item, localIdx) => {
                const absoluteIdx = pageStart + localIdx;
                const card = buildCardElement(item, absoluteIdx, currentMap, { lite: renderLite });
                card.classList.add("is-active");
                card.setAttribute("aria-hidden", "false");
                cardFrag.appendChild(card);
            });
            gridEl.appendChild(cardFrag);
            if (thumbsEl) {
                thumbsEl.innerHTML = "";
            }
            thumbVirtualRange = { start: 0, end: -1 };
            syncEditPager(totalItems, pageStart, pageEndExclusive);

            if (renderLite && options.hydrateEditPage !== false) {
                clearEditHydration();
                const token = editHydrationToken;
                editHydrationTimer = setTimeout(() => {
                    editHydrationTimer = null;
                    if (token !== editHydrationToken) return;
                    if (!isEditMode) return;
                    scheduleGridRender({ preserveEditPage: true, liteEditPage: false, hydrateEditPage: false });
                }, 120);
            }

            return;
        }

        syncEditPager(0, 0, 0);

        if (isCompactView()) {
            clearCarouselTimer();
            if (thumbsEl) thumbsEl.innerHTML = "";
            thumbVirtualRange = { start: 0, end: -1 };
            gridEl.querySelectorAll(".t-fav-card, .t-fav-compact-spacer").forEach(el => el.remove());
            if (currentFilteredList.length === 0) return;
            computeCompactLayout();
            updateCompactSpacer();
            const range = getCompactVisibleRange();
            renderCompactCards(range);
            const gridArea = gridEl.closest(".t-fav-grid-area");
            if (gridArea) gridArea.scrollTop = 0;
            return;
        }

        renderVirtualThumbs();

        const defaultIndex = currentFavId && filteredIndexMap.has(String(currentFavId))
            ? Number(filteredIndexMap.get(String(currentFavId))) || 0
            : 0;

        setActiveCarouselIndex(defaultIndex, { resetPause: false, smoothScroll: false });
        restartCarouselAutoplay();
    };

    const scheduleSearchRender = () => {
        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
        }
        searchDebounceTimer = setTimeout(() => {
            scheduleGridRender({ preserveEditPage: false, liteEditPage: true, hydrateEditPage: true });
        }, SEARCH_DEBOUNCE_MS);
    };

    // 存储当前查看的收藏项HTML，供新窗口打开使用
    let currentViewingHtml = "";
    let currentViewingTitle = "";

    const loadReaderItem = (index) => {
        if (index < 0 || index >= currentFilteredList.length) return;
        currentIndex = index;
        const item = currentFilteredList[index];
        currentFavId = item.id;

        if (item?.type === "chain") {
            // 使用实时重建的折叠布局（带内联样式）
            currentViewingHtml = getChainDisplayHtml(item);
            const chainItems = Array.isArray(item.items) ? item.items : [];
            const chainCount = chainItems.length;
            $("#t-read-meta").text(`${item.title}（剧场分组）`);
            $("#t-read-index").text(`${index + 1} / ${currentFilteredList.length} · ${chainCount} 段`);
            $("#t-read-menu-del-segment").show();
            $("#t-read-toggle-meta").show();
            syncToggleMetaButton(false);
        } else {
            currentViewingHtml = item.html;
            $("#t-read-meta").text(item.title);
            $("#t-read-index").text(`${index + 1} / ${currentFilteredList.length}`);
            $("#t-read-menu-del-segment").hide();
            $("#t-read-toggle-meta").hide();
        }

        currentViewingTitle = item.title;

        // 使用 Shadow DOM 渲染内容，实现 CSS 隔离
        const container = document.getElementById("t-read-content");

        // 检测是否包含互动内容
        const { isInteractive, reasons } = detectInteractiveContent(currentViewingHtml);

        // 更新新窗口按钮的显示状态
        const openWindowBtn = $("#t-read-open-window");
        if (isInteractive) {
            openWindowBtn.addClass("has-interactive").attr("title", `新窗口打开(${reasons.join(', ')})`);
        } else {
            openWindowBtn.removeClass("has-interactive").attr("title", "新窗口打开");
        }

        // 使用真正的 Shadow DOM 渲染，与主界面保持一致
        try {
            const shadow = renderToShadowDOMReal(container, currentViewingHtml);

            // 在 Shadow DOM 内重启动画
            setTimeout(() => {
                shadow.querySelectorAll('*').forEach(el => {
                    const style = window.getComputedStyle(el);
                    if (style.animationName && style.animationName !== 'none') {
                        const clone = el.cloneNode(true);
                        el.parentNode.replaceChild(clone, el);
                    }
                });
            }, 10);
        } catch (e) {
            console.warn('Titania: Shadow DOM 渲染失败，降级到 innerHTML', e);
            // 降级：直接设置 HTML
            container.innerHTML = '';
            setTimeout(() => {
                container.innerHTML = currentViewingHtml;
            }, 10);
        }

        $("#t-fav-reader").addClass("show");
    };

    // --- 工具栏抽屉 / 顶栏溢出菜单 ---
    // 抽屉与菜单只在移动端折叠：桌面端 CSS 忽略 hidden 属性，直接平铺
    const setFavDrawerOpen = (open) => {
        $("#t-fav-tools-drawer").prop("hidden", !open);
        $("#t-fav-drawer-toggle")
            .attr("aria-expanded", String(open === true))
            .toggleClass("is-active", open === true);
    };

    const setReadMenuOpen = (open) => {
        $("#t-read-more-menu").prop("hidden", !open);
        $("#t-read-more").attr("aria-expanded", String(open === true));
    };

    $("#t-fav-drawer-toggle").on("click", (e) => {
        e.stopPropagation();
        setReadMenuOpen(false);
        setFavDrawerOpen($("#t-fav-tools-drawer").prop("hidden") === true);
    });

    // 面板内部点击不冒泡，避免选择下拉项时误关闭
    $("#t-fav-tools-drawer").on("click", (e) => e.stopPropagation());
    $("#t-read-more-menu").on("click", (e) => e.stopPropagation());

    $("#t-read-more").on("click", (e) => {
        e.stopPropagation();
        setFavDrawerOpen(false);
        setReadMenuOpen($("#t-read-more-menu").prop("hidden") === true);
    });

    // 菜单项转发到既有按钮的处理器，保持单一实现
    $("#t-read-more-menu").on("click", "[data-read-action]", function () {
        const action = String($(this).data("read-action") || "");
        setReadMenuOpen(false);

        const targetId = {
            rename: "#t-read-rename",
            img: "#t-read-img",
            code: "#t-read-code",
            "del-segment": "#t-read-del-segment",
            "del-one": "#t-read-del-one"
        }[action];

        if (targetId) $(targetId).trigger("click");
    });

    // 点击窗口空白处收起
    $("#t-favs-view").on("click", () => {
        setFavDrawerOpen(false);
        setReadMenuOpen(false);
    });

    // --- 事件绑定 ---
    $("#t-fav-filter-char").on("change", () => scheduleGridRender({ preserveEditPage: false, liteEditPage: true, hydrateEditPage: true }));
    $("#t-fav-sort").on("change", () => scheduleGridRender({ preserveEditPage: false, liteEditPage: true, hydrateEditPage: true }));
    $("#t-fav-search").on("input", scheduleSearchRender);
    $("#t-fav-search").on("change", () => scheduleGridRender({ preserveEditPage: false, liteEditPage: true, hydrateEditPage: true }));
    $("#t-fav-view-toggle").on("click", () => {
        favViewMode = favViewMode === "compact" ? "poster" : "compact";
        saveFavViewMode(favViewMode);
        syncFavViewToggleButton();
        syncFavViewModeClass();
        scheduleGridRender({ preserveEditPage: false, liteEditPage: true, hydrateEditPage: true });
    });
    $("#t-btn-img-mgr").on("click", () => {
        setFavDrawerOpen(false);
        openCharImageManager(() => { scheduleGridRender({ preserveEditPage: true, liteEditPage: true, hydrateEditPage: true }); });
    });
    $("#t-read-back").on("click", () => {
        $("#t-fav-reader").removeClass("show");
        pauseCarousel(1200);
    });

    $("#t-fav-prev").on("click", () => {
        setActiveCarouselIndex(activeCarouselIndex - 1);
    });

    $("#t-fav-next").on("click", () => {
        setActiveCarouselIndex(activeCarouselIndex + 1);
    });

    $("#t-fav-thumbs").on("click", ".t-fav-thumb", function () {
        if (thumbDragMoved) return;
        const idx = Number($(this).data("fav-index"));
        if (!Number.isInteger(idx)) return;
        setActiveCarouselIndex(idx);
    });

    $("#t-fav-thumbs").on("wheel", function (e) {
        const el = this;
        if (!el) return;
        const oe = e.originalEvent;
        const delta = Math.abs(oe?.deltaX || 0) > Math.abs(oe?.deltaY || 0)
            ? (oe?.deltaX || 0)
            : (oe?.deltaY || 0);
        if (!delta) return;
        e.preventDefault();
        el.scrollLeft += delta;
    });

    $("#t-fav-thumbs").on("scroll", function () {
        if (isCompactView() || isEditMode) return;
        scheduleVirtualThumbRender();
    });

    $("#t-fav-thumbs").on("mousedown", function (e) {
        if (e.button !== 0) return;
        isThumbDragging = true;
        thumbDragMoved = false;
        thumbDragStartX = e.pageX;
        thumbDragStartScrollLeft = this.scrollLeft;
        $(this).addClass("is-dragging");
        e.preventDefault();
    });

    $(document).on("mousemove.tFavThumbDrag", (e) => {
        if (!isThumbDragging) return;
        const thumbsEl = $("#t-fav-thumbs")[0];
        if (!thumbsEl) return;
        const dx = e.pageX - thumbDragStartX;
        if (Math.abs(dx) > 3) thumbDragMoved = true;
        thumbsEl.scrollLeft = thumbDragStartScrollLeft - dx;
    });

    $(document).on("mouseup.tFavThumbDrag", () => {
        if (!isThumbDragging) return;
        isThumbDragging = false;
        $("#t-fav-thumbs").removeClass("is-dragging");
        setTimeout(() => {
            thumbDragMoved = false;
        }, 0);
    });

    // 紧凑视图虚拟滚动：监听 grid-area 滚动
    $("#t-favs-view .t-fav-grid-area").on("scroll", function () {
        if (!isCompactView()) return;
        scheduleCompactRender();
    });

    // 紧凑视图虚拟滚动：监听容器尺寸变化以重算列数
    setupCompactResizeObserver();

    let carouselTouchStartX = 0;
    let carouselTouchStartY = 0;
    $(".t-fav-grid-area").on("touchstart", (e) => {
        const touch = e.originalEvent?.touches?.[0];
        if (!touch) return;
        carouselTouchStartX = touch.clientX;
        carouselTouchStartY = touch.clientY;
    });
    $(".t-fav-grid-area").on("touchend", (e) => {
        const touch = e.originalEvent?.changedTouches?.[0];
        if (!touch) return;
        const diffX = touch.clientX - carouselTouchStartX;
        const diffY = touch.clientY - carouselTouchStartY;
        if (Math.abs(diffX) > 46 && Math.abs(diffX) > Math.abs(diffY) * 1.2) {
            if (diffX > 0) {
                setActiveCarouselIndex(activeCarouselIndex - 1);
            } else {
                setActiveCarouselIndex(activeCarouselIndex + 1);
            }
        }
    });

    $("#t-fav-grid").on("click", ".t-fav-card", function () {
        const favId = String($(this).data("fav-id"));
        const itemIndex = filteredIndexMap.get(favId);
        if (typeof itemIndex !== "number") return;
        const item = currentFilteredList[itemIndex];
        if (!item) return;

        if (isEditMode) {
            if (selectedIds.has(item.id)) {
                selectedIds.delete(item.id);
                $(this).removeClass("selected");
                $(this).find(".t-fav-card-checkbox i").removeClass("fa-solid fa-square-check").addClass("fa-regular fa-square");
            } else {
                selectedIds.add(item.id);
                $(this).addClass("selected");
                $(this).find(".t-fav-card-checkbox i").removeClass("fa-regular fa-square").addClass("fa-solid fa-square-check");
            }
            updateSelectionCount();
            return;
        }

        loadReaderItem(itemIndex);
    });

    // 编辑模式相关事件
    $("#t-btn-edit-mode").on("click", () => toggleEditMode(true));
    $("#t-btn-exit-edit").on("click", () => toggleEditMode(false));

    $("#t-btn-select-all").on("click", () => {
        currentFilteredList.forEach(item => selectedIds.add(item.id));
        $(".t-fav-card").addClass("selected");
        $(".t-fav-card-checkbox i").removeClass("fa-regular fa-square").addClass("fa-solid fa-square-check");
        updateSelectionCount();
    });

    $("#t-btn-deselect-all").on("click", () => {
        selectedIds.clear();
        $(".t-fav-card").removeClass("selected");
        $(".t-fav-card-checkbox i").removeClass("fa-solid fa-square-check").addClass("fa-regular fa-square");
        updateSelectionCount();
    });

    $("#t-btn-delete-selected").on("click", () => {
        const count = selectedIds.size;
        if (count === 0) return;

        if (confirm(`确定删除选中的 ${count} 条收藏？此操作不可撤销。`)) {
            const d = getExtData();
            d.favs = d.favs.filter(x => !selectedIds.has(x.id));
            saveExtData();

            // 同步更新本地 favs 数组
            favs.splice(0, favs.length, ...d.favs);

            // 重建角色索引（使用独立的 charName 字段）
            charIndex.clear();
            favs.forEach(f => {
                if (f.charName) {
                    f._meta = {
                        char: f.charName,
                        script: f.scriptName || f.title.split(' - ')[0] || f.title
                    };
                } else {
                    f._meta = parseMeta(f.title || "");
                }
                charIndex.add(f._meta.char);
            });

            selectedIds.clear();
            updateSelectionCount();
            scheduleGridRender({ preserveEditPage: true, liteEditPage: true, hydrateEditPage: true });

            if (window.toastr) toastr.success(`已删除 ${count} 条收藏`);

            // 如果删除后没有收藏了，退出编辑模式
            if (favs.length === 0) {
                toggleEditMode(false);
            }
        }
    });

    let touchStartX = 0; let touchStartY = 0;
    const readerBody = $(".t-read-body");
    readerBody.on("touchstart", (e) => { touchStartX = e.originalEvent.touches[0].clientX; touchStartY = e.originalEvent.touches[0].clientY; });
    readerBody.on("touchend", (e) => {
        const touchEndX = e.originalEvent.changedTouches[0].clientX; const touchEndY = e.originalEvent.changedTouches[0].clientY;
        const diffX = touchEndX - touchStartX; const diffY = touchEndY - touchStartY;
        if (Math.abs(diffX) > 60 && Math.abs(diffX) > Math.abs(diffY) * 2) {
            if (diffX > 0) { if (currentIndex > 0) loadReaderItem(currentIndex - 1); }
            else { if (currentIndex < currentFilteredList.length - 1) loadReaderItem(currentIndex + 1); }
        }
    });

    $("#t-read-code").on("click", () => {
        // 直接使用保存的原始 HTML，而不是从 iframe 中提取
        if (currentViewingHtml) {
            navigator.clipboard.writeText(currentViewingHtml);
            if (window.toastr) toastr.success("源码已复制");
        } else {
            const container = document.getElementById("t-read-content");
            // 降级：从 Shadow DOM 中提取内容
            const htmlCode = extractFromShadowDOM(container);
            navigator.clipboard.writeText(htmlCode);
            if (window.toastr) toastr.success("源码已复制");
        }
    });

    // 新窗口打开按钮
    $("#t-read-open-window").on("click", () => {
        if (currentViewingHtml) {
            openInNewWindow(currentViewingHtml, currentViewingTitle);
            if (window.toastr) toastr.success("已在新窗口打开");
        } else {
            if (window.toastr) toastr.warning("当前无内容");
        }
    });

    // [图片导出打码] 使用 html-to-image 库 + 离屏渲染截图（不影响当前界面）
    // 仅对 {{user}} 宏展开后的实际值进行打码（可在移动端选择是否打码）
    const getExportMaskUserPreference = () => {
        const d = getExtData();
        if (typeof d.favs_export_mask_user !== "boolean") {
            d.favs_export_mask_user = true;
        }
        return d.favs_export_mask_user !== false;
    };

    const saveExportMaskUserPreference = (maskUser) => {
        const d = getExtData();
        d.favs_export_mask_user = maskUser === true;
        saveExtData();
    };

    const isCompactTouchMode = () => {
        const mobileWidth = window.matchMedia?.("(max-width: 768px)")?.matches === true;
        const touchCapable = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
        return mobileWidth || (touchCapable && window.innerWidth <= 920);
    };

    const showExportOptionsSheet = (defaultMaskUser) => {
        return new Promise((resolve) => {
            $("#t-fav-export-sheet").remove();

            const sheetHtml = `
                <div id="t-fav-export-sheet" class="t-fav-export-sheet-backdrop">
                    <div class="t-fav-export-sheet t-root">
                        <div class="t-fav-export-sheet-title">图片导出选项</div>
                        <div class="t-fav-export-sheet-desc">请选择导出时是否对 User 名称打码</div>

                        <button class="t-fav-export-sheet-btn primary" data-mask="1">导出图片（打码）</button>
                        <button class="t-fav-export-sheet-btn" data-mask="0">导出图片（不打码）</button>

                        <label class="t-fav-export-sheet-remember">
                            <input type="checkbox" id="t-fav-export-remember" ${defaultMaskUser ? "checked" : ""}>
                            <span>记住本次选择为默认</span>
                        </label>

                        <button class="t-fav-export-sheet-cancel" id="t-fav-export-cancel">取消</button>
                    </div>
                </div>
            `;

            $("#t-favs-view").append(sheetHtml);

            const closeSheet = (payload) => {
                $("#t-fav-export-sheet").remove();
                resolve(payload || null);
            };

            $("#t-fav-export-sheet").on("click", (e) => {
                if (e.target === e.currentTarget) closeSheet(null);
            });

            $("#t-fav-export-cancel").on("click", () => closeSheet(null));

            $("#t-fav-export-sheet .t-fav-export-sheet-btn").on("click", function () {
                const maskUser = $(this).data("mask") === 1;
                const remember = $("#t-fav-export-remember").is(":checked");
                closeSheet({ maskUser, remember });
            });
        });
    };

    const exportCurrentFavImage = async (maskUser) => {
        const btn = $(this);
        const originalBtnHtml = btn.html();

        // 离屏 DOM 引用（用于 finally 清理）
        let offscreen = null;

        try {
            btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i>');

            // 1) 加载 html-to-image
            if (typeof htmlToImage === 'undefined') {
                if (window.toastr) toastr.info("正在加载组件...", "Titania");
                await $.getScript("https://unpkg.com/html-to-image@1.11.11/dist/html-to-image.js");
            }

            // 2) 获取待导出的 HTML（优先用收藏里保存的原始 HTML）
            let sourceHtml = currentViewingHtml;
            if (!sourceHtml) {
                const container = document.getElementById("t-read-content");
                sourceHtml = extractFromShadowDOM(container);
            }
            if (!sourceHtml || sourceHtml.trim().length < 10) {
                throw new Error("当前无可导出的内容");
            }

            let maskedHtml = sourceHtml;

            // 3) 获取 {{user}} 宏展开后的实际值，并按选项执行打码
            if (maskUser) {
                const userName = await getExpandedUserNameForMasking();
                if (userName && typeof userName === "string" && userName.trim()) {
                    const replacement = maskStringSameLength(userName, "█");
                    maskedHtml = maskHtmlByToken(sourceHtml, userName, replacement);
                }
            }

            // 4) 创建离屏容器，并用 Shadow DOM 渲染打码后的 HTML
            const onScreenZone = document.getElementById("t-read-capture-zone");
            const widthPx = Math.ceil(onScreenZone?.getBoundingClientRect?.().width || 900);
            offscreen = createOffscreenExportDom(widthPx);

            renderToShadowDOMReal(offscreen.content, maskedHtml);

            // 5) 等待渲染稳定（字体/图片/两帧布局）
            await waitForFontsReady(1500);
            await waitForNextPaint(2);
            await waitForImagesLoadedDeep(offscreen.root, 5000);
            await waitForNextPaint(1);

            // 6) 截图导出（截图目标是 zone）
            const dataUrl = await htmlToImage.toPng(offscreen.zone, {
                backgroundColor: '#0b0b0b',
                pixelRatio: 2,
                skipAutoScale: true
            });

            // 7) 下载
            const link = document.createElement('a');
            link.download = `Titania_${new Date().getTime()}.png`;
            link.href = dataUrl;
            link.click();

            if (window.toastr) {
                const modeText = maskUser ? "已打码" : "未打码";
                toastr.success(`图片导出成功（${modeText}）`);
            }

        } catch (e) {
            console.error(e);
            alert("导出失败: " + (e?.message || e) + "\n可能原因：跨域图片/浏览器不支持 SVG 转换/内存不足。");
        } finally {
            try {
                if (offscreen?.root) offscreen.root.remove();
            } catch (e) {
                // ignore
            }
            btn.prop("disabled", false).html(originalBtnHtml);
        }
    };

    $("#t-read-img").on("click", async function (e) {
        const defaultMaskUser = getExportMaskUserPreference();

        if (isCompactTouchMode()) {
            const selected = await showExportOptionsSheet(defaultMaskUser);
            if (!selected) return;

            if (selected.remember) {
                saveExportMaskUserPreference(selected.maskUser);
            }

            await exportCurrentFavImage.call(this, selected.maskUser);
            return;
        }

        await exportCurrentFavImage.call(this, defaultMaskUser);
    });

    // 桌面端：右键“导出图片”可快速切换导出选项
    $("#t-read-img").on("contextmenu", async function (e) {
        e.preventDefault();
        const defaultMaskUser = getExportMaskUserPreference();
        const selected = await showExportOptionsSheet(defaultMaskUser);
        if (!selected) return;

        if (selected.remember) {
            saveExportMaskUserPreference(selected.maskUser);
        }

        await exportCurrentFavImage.call(this, selected.maskUser);
    });

    // 重命名功能（只修改标题，不影响角色筛选）
    $("#t-read-rename").on("click", () => {
        if (!currentFavId) return;

        const currentItem = currentFilteredList[currentIndex];
        if (!currentItem) return;

        const newTitle = prompt("请输入新标题：", currentItem.title);
        if (newTitle === null || newTitle.trim() === "") return;

        const trimmedTitle = newTitle.trim();

        // 更新存储
        const d = getExtData();
        const targetFav = d.favs.find(x => x.id === currentFavId);
        if (targetFav) {
            targetFav.title = trimmedTitle;
            // 注意：不修改 charName 和 scriptName，保持角色筛选功能正常
            saveExtData();

            // 同步更新本地 favs 数组中的对应项
            const localFav = favs.find(x => x.id === currentFavId);
            if (localFav) {
                localFav.title = trimmedTitle;
                // 更新 _meta.script 用于卡片显示，但保持 _meta.char 不变
                localFav._meta.script = trimmedTitle;
            }

            // 更新当前变量
            currentViewingTitle = trimmedTitle;

            // 更新阅读器标题显示
            $("#t-read-meta").text(trimmedTitle);

            // 刷新卡片列表（角色索引不需要重建，因为 charName 没变）
            scheduleGridRender({ preserveEditPage: true, liteEditPage: true, hydrateEditPage: true });

            if (window.toastr) toastr.success("标题已更新");
        }
    });

    $("#t-read-del-one").on("click", () => {
        if (confirm("确定删除此条收藏？")) {
            const d = getExtData();
            d.favs = d.favs.filter(x => x.id !== currentFavId);
            saveExtData();
            favs.splice(0, favs.length, ...d.favs);
            scheduleGridRender({ preserveEditPage: true, liteEditPage: true, hydrateEditPage: true });
            if (currentFilteredList.length === 0) {
                $("#t-fav-reader").removeClass("show");
            } else {
                let newIdx = currentIndex;
                if (newIdx >= currentFilteredList.length) newIdx = currentFilteredList.length - 1;
                loadReaderItem(newIdx);
            }
        }
    });

    $("#t-edit-page-prev").on("click", () => {
        if (!isEditMode || editPageIndex <= 0) return;
        editPageIndex -= 1;
        scheduleGridRender({ preserveEditPage: true, liteEditPage: false, hydrateEditPage: false });
    });

    $("#t-edit-page-next").on("click", () => {
        if (!isEditMode) return;
        const totalPages = Math.max(1, Math.ceil(currentFilteredList.length / EDIT_PAGE_SIZE));
        if (editPageIndex >= totalPages - 1) return;
        editPageIndex += 1;
        scheduleGridRender({ preserveEditPage: true, liteEditPage: false, hydrateEditPage: false });
    });

    // 分组段落信息：一键展开/折叠（内容在 Shadow DOM 内，需穿透 shadowRoot 取节点）
    const getChainMetaNodes = () => {
        const container = document.getElementById("t-read-content");
        if (!container) return [];
        const host = container.querySelector(".t-shadow-host");
        const root = host?.shadowRoot || container;
        return Array.from(root.querySelectorAll("details.t-chain-meta"));
    };

    const syncToggleMetaButton = (expanded) => {
        $("#t-read-toggle-meta")
            .toggleClass("is-active", expanded === true)
            .attr("title", expanded === true ? "折叠全部段落信息" : "展开全部段落信息");
    };

    $("#t-read-toggle-meta").on("click", () => {
        const nodes = getChainMetaNodes();
        if (nodes.length === 0) {
            if (window.toastr) toastr.info("当前内容没有可展开的段落信息");
            return;
        }

        const shouldOpen = nodes.some(node => !node.open);
        nodes.forEach(node => { node.open = shouldOpen; });
        syncToggleMetaButton(shouldOpen);
    });

    $("#t-read-del-segment").on("click", () => {
        if (!currentFavId) return;

        const currentItem = currentFilteredList[currentIndex];
        if (!currentItem || currentItem.type !== "chain") return;

        const chainItems = Array.isArray(currentItem.items) ? currentItem.items : [];
        if (chainItems.length === 0) {
            if (window.toastr) toastr.warning("该分组没有可删除的段落");
            return;
        }

        const segmentTip = chainItems.map((seg, idx) => {
            const round = Number(seg?.round) || (idx + 1);
            const instruction = String(seg?.instruction || "（无指令）").replace(/\s+/g, " ").trim();
            const shortText = instruction.length > 22 ? `${instruction.slice(0, 22)}...` : instruction;
            return `${idx + 1}. 第${round}段 - ${shortText}`;
        }).join("\n");

        const input = prompt(`请输入要删除的段落序号（1-${chainItems.length}）：\n\n${segmentTip}`);
        if (input === null) return;

        const removeIndex = Number(input) - 1;
        if (!Number.isInteger(removeIndex) || removeIndex < 0 || removeIndex >= chainItems.length) {
            if (window.toastr) toastr.warning("输入的段落序号无效");
            return;
        }

        const target = chainItems[removeIndex];
        const removeRound = Number(target?.round) || (removeIndex + 1);
        if (!confirm(`确定删除第 ${removeRound} 段吗？`)) return;

        const d = getExtData();
        const targetFav = d.favs.find(x => x.id === currentFavId);
        if (!targetFav || targetFav.type !== "chain") return;

        if (!Array.isArray(targetFav.items)) targetFav.items = [];
        targetFav.items.splice(removeIndex, 1);

        if (targetFav.items.length === 0) {
            d.favs = d.favs.filter(x => x.id !== currentFavId);
            saveExtData();
            favs.splice(0, favs.length, ...d.favs);
            scheduleGridRender({ preserveEditPage: true, liteEditPage: true, hydrateEditPage: true });

            if (currentFilteredList.length === 0) {
                $("#t-fav-reader").removeClass("show");
            } else {
                const newIdx = Math.min(currentIndex, currentFilteredList.length - 1);
                loadReaderItem(newIdx);
            }

            if (window.toastr) toastr.success("已删除该段，分组已清空并移除");
            return;
        }

        targetFav.html = buildChainMergedHtml(targetFav.items, { withStyles: true });
        saveExtData();

        const localFav = favs.find(x => x.id === currentFavId);
        if (localFav) {
            localFav.items = targetFav.items;
            localFav.html = targetFav.html;
        }

        loadReaderItem(currentIndex);
        scheduleGridRender({ preserveEditPage: true, liteEditPage: true, hydrateEditPage: true });
        if (window.toastr) toastr.success(`已删除第 ${removeRound} 段`);
    });

    const closeWindow = () => {
        clearCarouselTimer();
        if (thumbVirtualRaf) {
            cancelAnimationFrame(thumbVirtualRaf);
            thumbVirtualRaf = null;
        }
        if (gridRenderRaf) {
            cancelAnimationFrame(gridRenderRaf);
            gridRenderRaf = null;
        }
        if (compactScrollRaf) {
            cancelAnimationFrame(compactScrollRaf);
            compactScrollRaf = null;
        }
        if (compactResizeObserver) {
            compactResizeObserver.disconnect();
            compactResizeObserver = null;
        }
        pendingGridRenderOptions = null;
        clearEditHydration();
        $(document).off(".tFavThumbDrag");
        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = null;
        }
        setFavsWindowOpen(false);
        $("#t-favs-view").remove();
        // 如果主窗口存在则显示它，否则关闭整个 overlay
        const $mainView = $("#t-main-view");
        if ($mainView.length > 0) {
            $mainView.css("display", "flex");
        } else {
            // 从子菜单直接打开的情况，关闭 overlay
            $("#t-overlay").remove();
        }
    };

    $("#t-fav-close").on("click", closeWindow);

    syncFavViewToggleButton();
    syncFavViewModeClass();
    scheduleGridRender({ preserveEditPage: false, liteEditPage: true, hydrateEditPage: true });
}

/**
 * 角色图鉴管理器
 */
export function openCharImageManager(onCloseCallback) {
    const data = getExtData();
    if (!data.character_map) data.character_map = {};

    // 1. 提取所有收藏中出现过的角色名（优先使用独立字段）
    const favs = data.favs || [];
    const charNames = new Set();
    favs.forEach(f => {
        if (f.charName) {
            charNames.add(f.charName);
        } else {
            // 兼容旧数据
            const parts = (f.title || "").split(' - ');
            if (parts.length >= 2) charNames.add(parts[parts.length - 1].trim());
        }
    });
    const sortedChars = [...charNames].sort();

    // 2. 辅助函数：尝试从 SillyTavern 系统中查找角色头像
    const tryFindSystemAvatar = (charName) => {
        let foundAvatar = null;
        try {
            if (SillyTavern && SillyTavern.getContext) {
                const ctx = SillyTavern.getContext();
                if (ctx.characters) {
                    Object.values(ctx.characters).forEach(c => {
                        if (c.name === charName && c.avatar) foundAvatar = c.avatar;
                    });
                }
            }
            if (!foundAvatar && typeof window.characters !== 'undefined') {
                const chars = Array.isArray(window.characters) ? window.characters : Object.values(window.characters);
                const match = chars.find(c => c.name === charName || (c.data && c.data.name === charName));
                if (match) foundAvatar = match.avatar;
            }
        } catch (e) { console.error("Titania: Auto-find avatar failed", e); }

        if (foundAvatar && !foundAvatar.startsWith("http") && !foundAvatar.startsWith("data:")) {
            if (!foundAvatar.includes("/")) foundAvatar = `characters/${foundAvatar}`;
        }
        return foundAvatar;
    };

    // HTML 结构 (样式见 css/favs.css)
    const html = `
    <div class="t-dialog-overlay t-dialog-overlay--contained t-img-mgr-overlay t-root" id="t-img-mgr">
        <div class="t-dialog-panel t-img-mgr-box">
            <div class="t-header">
                <span class="t-title-main">🖼️ 角色图鉴管理</span>
                <span class="t-close" id="t-img-close">&times;</span>
            </div>
            <div style="padding:10px 15px; background:var(--t-color-surface-raised); color:var(--t-color-text-muted); font-size:0.85em; border-bottom:1px solid var(--t-color-border);">
                <i class="fa-solid fa-circle-info"></i> 设置图片后，该角色所有收藏卡片将自动使用此背景。优先读取“图鉴设置”，其次读取“单卡数据”。
            </div>
            <div class="t-img-list" id="t-img-list-container"></div>
            <div style="padding:15px; border-top:1px solid var(--t-color-border); text-align:right;">
                <button class="t-btn primary" id="t-img-save">💾 保存并应用</button>
            </div>
        </div>
        <!-- 隐藏的文件上传 input -->
        <input type="file" id="t-img-upload-input" accept="image/*" style="display:none;">
    </div>`;

    $("#t-favs-view").append(html);

    // 临时存储编辑状态
    const tempMap = JSON.parse(JSON.stringify(data.character_map));
    let currentEditChar = null;

    const renderList = () => {
        const $list = $("#t-img-list-container");
        $list.empty();

        if (sortedChars.length === 0) {
            $list.append('<div style="text-align:center; padding:30px; color:#555;">暂无角色数据，请先去收藏一些剧本吧~</div>');
            return;
        }

        sortedChars.forEach(char => {
            const currentImg = tempMap[char] || "";
            const hasImg = !!currentImg;
            const bgStyle = hasImg ? `background-image: url('${currentImg}')` : '';

            const $row = $(`
                <div class="t-img-item">
                    <div class="t-img-preview ${hasImg ? '' : 'no-img'}" style="${bgStyle}"></div>
                    <div class="t-img-info">
                        <div class="t-img-name">${char}</div>
                        <div class="t-img-path">${hasImg ? (currentImg.startsWith('data:') ? 'Base64 Image' : currentImg) : '未设置背景'}</div>
                    </div>
                    <div class="t-img-actions">
                        <button class="t-act-btn auto btn-auto-find" title="尝试从系统角色列表抓取头像" data-char="${char}"><i class="fa-solid fa-wand-magic-sparkles"></i> 自动</button>
                        <button class="t-act-btn btn-upload" title="上传本地图片" data-char="${char}"><i class="fa-solid fa-upload"></i></button>
                        <button class="t-act-btn btn-url" title="输入图片 URL" data-char="${char}"><i class="fa-solid fa-link"></i></button>
                        ${hasImg ? `<button class="t-act-btn btn-clear" title="清除" data-char="${char}" style="color:var(--t-color-danger);"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </div>
                </div>
            `);
            $list.append($row);
        });

        $(".btn-auto-find").on("click", function () {
            const char = $(this).data("char");
            const avatar = tryFindSystemAvatar(char);
            if (avatar) {
                tempMap[char] = avatar;
                if (window.toastr) toastr.success(`已抓取到 ${char} 的头像`, "成功");
                renderList();
            } else {
                alert(`未在当前加载的系统中找到角色 [${char}] 的信息。\n请确保该角色已在 SillyTavern 角色列表中。`);
            }
        });

        $(".btn-upload").on("click", function () {
            currentEditChar = $(this).data("char");
            $("#t-img-upload-input").click();
        });

        $(".btn-url").on("click", function () {
            const char = $(this).data("char");
            const oldVal = tempMap[char] || "";
            const newVal = prompt(`请输入 [${char}] 的图片链接 (URL):`, oldVal);
            if (newVal !== null) {
                tempMap[char] = newVal.trim();
                renderList();
            }
        });

        $(".btn-clear").on("click", function () {
            const char = $(this).data("char");
            delete tempMap[char];
            renderList();
        });
    };

    $("#t-img-upload-input").on("change", function () {
        const file = this.files[0];
        if (!file || !currentEditChar) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            tempMap[currentEditChar] = e.target.result; // Base64
            renderList();
            $("#t-img-upload-input").val("");
        };
        reader.readAsDataURL(file);
    });

    $("#t-img-save").on("click", () => {
        data.character_map = tempMap;
        saveExtData();
        $("#t-img-mgr").remove();
        if (onCloseCallback) onCloseCallback();
        if (window.toastr) toastr.success("角色图鉴已更新");
    });

    $("#t-img-close").on("click", () => $("#t-img-mgr").remove());

    renderList();
}
