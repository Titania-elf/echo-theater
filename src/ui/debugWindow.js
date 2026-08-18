// src/ui/debugWindow.js

import { getPromptTraceList } from "../core/state.js";
import { TitaniaLogger } from "../core/logger.js";
import { ensureOverlay } from "../utils/dom.js";
import { estimateTokens, countTokensBatch } from "../utils/helpers.js";

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function makePreview(text, maxLen = 260) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, maxLen)}...`;
}

function formatTimeText(ts) {
    if (!ts) return "-";
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function getTraceSourceLabel(source) {
    const s = String(source || "").toLowerCase();
    if (s === "user_continuation") return "主动续写";
    if (s === "auto_continuation") return "自动续写";
    if (s === "manual") return "手动生成";
    if (s === "queue") return "队列生成";
    return source || "未知来源";
}

function expandBuiltinContextDetails(details, trace, meta) {
    const mode = String(trace?.mode || "");
    const sectionLengths = meta?.sectionLengths;
    if (!["narrative", "visual"].includes(mode)
        || meta?.promptScheme?.type !== "builtin"
        || !sectionLengths) {
        return details;
    }

    const userEntryId = `${mode}_user`;
    // 顺序必须与 api.js 里 user 字符串的拼接顺序一致——下面按长度连续切片
    const definitions = [
        ["director", "导演指令"],
        ["persona", "角色人设"],
        ["userDesc", "用户设定"],
        ["worldInfo", "世界观设定"],
        ["history", "聊天历史"],
        ["scriptInstruction", "剧本指令"],
        ["continuationPreamble", "续写模式说明"],
        ["continuationContext", "续写会话上下文"],
        ["continuationInstruction", "本轮续写指令"]
    ];

    return details.flatMap(detail => {
        if (detail?.entryId !== userEntryId) return [detail];

        const content = String(detail.content || "");
        const sections = [];
        let offset = 0;

        definitions.forEach(([key, name]) => {
            const length = Math.max(0, Math.floor(Number(sectionLengths[key]) || 0));
            if (length === 0) return;

            const part = content.slice(offset, offset + length);
            offset += length;
            if (!part) return;

            sections.push({
                ...detail,
                entryId: `${userEntryId}_${key}`,
                name,
                content: part,
                chars: part.length,
                tokens: estimateTokens(part)
            });
        });

        if (offset < content.length) {
            const remainder = content.slice(offset);
            sections.push({
                ...detail,
                entryId: `${userEntryId}_other`,
                name: "其他生成上下文",
                content: remainder,
                chars: remainder.length,
                tokens: estimateTokens(remainder)
            });
        }

        return sections.length > 0 ? sections : [detail];
    }).map((detail, index) => ({ ...detail, index }));
}

function getPromptMessagesView(source, isTrace = false) {
    const finalMessages = isTrace ? source?.finalMessages : source;
    const messages = finalMessages?.messages || [];
    const meta = finalMessages?.meta || source?.meta || {};
    const suppliedDetails = isTrace ? meta.messageDetails : source?.messageDetails;
    const rawDetails = Array.isArray(suppliedDetails) && suppliedDetails.length > 0
        ? suppliedDetails
        : messages.map((message, index) => ({
            index,
            entryId: `message_${index}`,
            sourceIdentifier: null,
            name: `消息 ${index + 1}`,
            role: message.role || "user",
            type: "text",
            marker: null,
            required: false,
            content: String(message.content || ""),
            chars: String(message.content || "").length,
            tokens: estimateTokens(message.content || "")
        }));
    const details = isTrace
        ? expandBuiltinContextDetails(rawDetails, source, meta)
        : expandBuiltinContextDetails(rawDetails, { mode: source?.mode }, { ...meta, promptScheme: source?.promptScheme });
    const sections = details.map((detail, index) => ({
        id: detail.entryId || `message_${index}`,
        title: detail.name || `消息 ${index + 1}`,
        role: detail.role || "user",
        order: Number.isFinite(detail.index) ? detail.index : index,
        content: String(detail.content || ""),
        tokens: Number(detail.tokens) || estimateTokens(detail.content || "")
    }));
    return {
        sections,
        totalTokens: sections.reduce((sum, section) => sum + section.tokens, 0)
    };
}

let tokenCountRun = 0;

/**
 * 用 ST 真实分词器覆盖同步渲染时的估算值。
 * 先渲染后填充：面板立即可见，数字随后就位，避免大提示词下的空白等待。
 * run 号用于丢弃过期结果——快速切换数据源时旧请求不应覆盖新渲染。
 * @param {Array<{id: string, content: string}>} sections
 */
async function applyExactTokenCounts(sections) {
    const run = ++tokenCountRun;
    const { counts, total, exact } = await countTokensBatch(sections.map(item => item.content || ""));
    if (run !== tokenCountRun) return;

    sections.forEach((section, index) => {
        $(`.t-prompt-token-count[data-token-for="${section.id}"]`).text(`${counts[index]} tk`);
    });
    $("#t-prompt-total-token").text(total);
    $("#t-prompt-token-approx").toggle(!exact);
    $("#t-prompt-total-token").closest(".t-prompt-count").attr("title", exact
        ? "由 SillyTavern 分词器精确计算"
        : "分词器不可用，当前为估算值");
}

/**
 * 显示提示词查看窗口
 */
export async function showDebugInfo() {
    if ($("#t-debug-view").length) return;

    ensureOverlay();

    const $mainView = $("#t-main-view");
    const hasMainView = $mainView.length > 0;
    if (hasMainView) {
        $mainView.hide();
    }

    const html = `
    <div class="t-box t-root" id="t-debug-view" style="max-width:1400px; width:95vw; height:92vh; display:flex; flex-direction:column;">
        <div class="t-header" style="flex-shrink:0;">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-layer-group" style="color:#74b9ff;"></i>
                <span class="t-title-main">提示词查看</span>
            </div>
            <span class="t-close" id="t-debug-close">&times;</span>
        </div>

        <div class="t-prompt-source-bar">
            <div class="t-prompt-source-tabs" role="tablist" aria-label="提示词数据来源">
                <button class="t-prompt-source-tab active" data-source="preview" role="tab" aria-selected="true"><i class="fa-regular fa-circle"></i> 当前预览</button>
                <button class="t-prompt-source-tab" data-source="actual" role="tab" aria-selected="false"><i class="fa-solid fa-circle"></i> 最近实际请求</button>
                <button id="t-prompt-info-btn" class="t-prompt-info-btn" title="查看当前数据来源说明" aria-label="查看当前数据来源说明" aria-expanded="false"><i class="fa-solid fa-circle-info"></i></button>
                <div id="t-prompt-info-popover" class="t-prompt-info-popover" hidden></div>
            </div>
        </div>

        <div class="t-prompt-summary">
            <div class="t-prompt-request">
                <span id="t-prompt-source-state" class="t-prompt-actual"><i class="fa-regular fa-circle"></i> 当前预览 · 尚未发送</span>
                <span id="t-prompt-request-meta">正在构造当前提示词...</span>
            </div>
            <div class="t-prompt-summary-actions">
                <span class="t-prompt-count"><strong id="t-prompt-total-token">0</strong> tokens<span id="t-prompt-token-approx" style="display:none"> (估算)</span> · <b id="t-prompt-section-count">0</b> 条消息</span>
                <button id="t-prompt-expand-all-btn" class="t-prompt-tool-btn" title="展开全部消息" aria-label="展开全部消息"><i class="fa-solid fa-angles-down"></i><span class="t-prompt-expand-label">展开全部</span></button>
                <button id="t-debug-refresh" class="t-prompt-tool-btn t-prompt-icon-btn" title="刷新"><i class="fa-solid fa-rotate-right"></i></button>
            </div>
        </div>

        <div class="t-prompt-sections" id="t-prompt-sections"></div>
    </div>`;

    $("#t-overlay").append(html);

    let activeSource = "preview";
    let currentPreview = null;
    let previewLoading = false;

    const getLatestActualTrace = () => getPromptTraceList().find(trace => trace?.finalMessages?.messages?.length > 0) || null;

    const getPreviewContinuation = source => {
        const info = source?.meta?.continuation;
        return info?.isContinuation ? info : null;
    };

    const updateInfoPopover = () => {
        const isPreview = activeSource === "preview";
        const source = isPreview ? currentPreview : getLatestActualTrace();
        const modeName = isPreview
            ? source?.promptScheme?.name || source?.mode || "当前模式"
            : source?.finalMessages?.meta?.promptScheme?.name || source?.mode || "未知模式";
        const scriptName = isPreview ? source?.script?.name : source?.scriptName;
        const time = isPreview ? source?.timestamp : source?.endedAt || source?.startedAt;
        const continuation = isPreview ? getPreviewContinuation(source) : null;
        const description = !isPreview
            ? "这是最近一次实际发送给模型的固定消息快照。"
            : continuation
                ? `下一步动作是续写，因此按续写口径构造：已注入 ${continuation.injectedRounds}/${continuation.totalRounds} 轮历史（含最近一次续写结果），token 已计入。动态宏与上下文可能在实际生成时变化。`
                : "基于当前角色、世界书、聊天历史和设置即时构造，没有发送请求。动态宏与上下文可能在实际生成时变化。";
        $("#t-prompt-info-popover").html(`
            <strong>${isPreview ? (continuation ? "当前构造预览 · 续写口径" : "当前构造预览") : "最近实际请求"}</strong>
            <p>${description}</p>
            <dl>
                <div><dt>模式</dt><dd>${escapeHtml(modeName || "-")}</dd></div>
                <div><dt>剧本</dt><dd>${escapeHtml(scriptName || "-")}</dd></div>
                <div><dt>${isPreview ? "构建时间" : "发送时间"}</dt><dd>${escapeHtml(formatTimeText(time))}</dd></div>
            </dl>`);
    };

    const renderPromptWindow = () => {
        const $sections = $("#t-prompt-sections");
        const isPreview = activeSource === "preview";
        const source = isPreview ? currentPreview : getLatestActualTrace();
        if (isPreview && previewLoading) {
            $sections.html('<div class="t-prompt-empty"><i class="fa-solid fa-spinner fa-spin"></i><span>正在构造当前提示词</span><small>正在读取当前角色、世界书和聊天历史...</small></div>');
            $("#t-prompt-total-token, #t-prompt-section-count").text("0");
            $("#t-prompt-request-meta").text("正在构造当前提示词...");
            return;
        }
        if (!source || (isPreview && source.ok === false)) {
            const error = isPreview ? source?.error || "无法构造当前提示词" : "还没有实际发送过提示词";
            const detail = isPreview ? "请先在小剧场主界面选择一个可用剧本。" : "切换到“当前预览”可直接查看当前提示词构造。";
            $sections.html(`<div class="t-prompt-empty"><i class="fa-regular fa-file-lines"></i><span>${escapeHtml(error)}</span><small>${escapeHtml(detail)}</small></div>`);
            $("#t-prompt-total-token, #t-prompt-section-count").text("0");
            $("#t-prompt-request-meta").text(isPreview ? "预览不可用" : "暂无实际请求");
            $("#t-prompt-source-state").html(isPreview
                ? '<i class="fa-regular fa-circle"></i> 当前预览 · 尚未发送'
                : '<i class="fa-solid fa-circle"></i> 最近实际请求');
            updateInfoPopover();
            return;
        }

        const { sections, totalTokens } = getPromptMessagesView(source, !isPreview);
        const expandedIds = new Set();
        $("#t-prompt-sections .t-prompt-section-card.expanded").each(function () {
            expandedIds.add($(this).data("section-id"));
        });

        const cardsHtml = [...sections]
            .sort((a, b) => a.order - b.order)
            .map(section => {
                const roleClass = `t-prompt-role-${section.role}`;
                const previewText = makePreview(section.content, 150);
                const wasExpanded = expandedIds.has(section.id);
                return `
                <div class="t-prompt-section-card ${roleClass}${wasExpanded ? " expanded" : ""}" data-section-id="${section.id}" data-role="${section.role}">
                    <div class="t-prompt-section-head">
                        <div class="t-prompt-section-title">
                            <i class="fa-solid fa-chevron-right t-prompt-chevron"></i>
                            <span class="t-prompt-order">${section.order + 1}</span>
                            <span class="t-prompt-role-label">${escapeHtml(section.role)}</span>
                            <span class="t-prompt-name">${escapeHtml(section.title)}</span>
                        </div>
                        <div class="t-prompt-token-count" data-token-for="${section.id}">${section.tokens} tk</div>
                    </div>
                    <div class="t-prompt-section-preview">${escapeHtml(previewText)}</div>
                    <pre class="t-prompt-section-content">${escapeHtml(section.content || "(无内容)")}</pre>
                </div>`;
            }).join("");
        $sections.html(cardsHtml);

        $("#t-prompt-total-token").text(totalTokens);
        $("#t-prompt-section-count").text(sections.length);
        applyExactTokenCounts(sections);
        if (isPreview) {
            const continuation = getPreviewContinuation(source);
            $("#t-prompt-source-state").html(continuation
                ? '<i class="fa-regular fa-circle"></i> 当前预览 · 续写口径 · 尚未发送'
                : '<i class="fa-regular fa-circle"></i> 当前预览 · 尚未发送');
            const modeLabel = continuation
                ? `续写模式 · 注入 ${continuation.injectedRounds}/${continuation.totalRounds} 轮`
                : source.promptScheme?.name || source.mode || "当前模式";
            $("#t-prompt-request-meta").text(`${modeLabel} · ${source.script?.name || "未知剧本"} · ${formatTimeText(source.timestamp)}`);
        } else {
            $("#t-prompt-source-state").html('<i class="fa-solid fa-circle"></i> 最近实际请求');
            $("#t-prompt-request-meta").text(`${getTraceSourceLabel(source.source)} · ${source.scriptName || "未知剧本"} · ${formatTimeText(source.endedAt || source.startedAt)}`);
        }
        updateInfoPopover();
    };

    const loadCurrentPreview = async () => {
        if (previewLoading) return;
        previewLoading = true;
        renderPromptWindow();
        try {
            const { buildPromptCompositionPreview } = await import("../core/api.js");
            currentPreview = await buildPromptCompositionPreview();
        } catch (error) {
            currentPreview = { ok: false, error: error?.message || "预览构造失败" };
        } finally {
            previewLoading = false;
            renderPromptWindow();
        }
    };

    await loadCurrentPreview();

    $(".t-prompt-source-tab").on("click", async function () {
        activeSource = String($(this).data("source") || "preview");
        $(".t-prompt-source-tab").removeClass("active").attr("aria-selected", "false");
        $(this).addClass("active").attr("aria-selected", "true");
        $("#t-prompt-info-popover").prop("hidden", true);
        $("#t-prompt-info-btn").attr("aria-expanded", "false");
        if (activeSource === "preview") {
            currentPreview = null;
            await loadCurrentPreview();
        } else {
            renderPromptWindow();
        }
    });

    $("#t-prompt-info-btn").on("click", function (event) {
        event.stopPropagation();
        updateInfoPopover();
        const $popover = $("#t-prompt-info-popover");
        const shouldOpen = $popover.prop("hidden");
        $popover.prop("hidden", !shouldOpen);
        $(this).attr("aria-expanded", String(shouldOpen));
    });
    $("#t-prompt-info-popover").on("click", event => event.stopPropagation());
    $(document).off("click.tpromptinfo").on("click.tpromptinfo", () => {
        $("#t-prompt-info-popover").prop("hidden", true);
        $("#t-prompt-info-btn").attr("aria-expanded", "false");
    });

    // 手动刷新
    $("#t-debug-refresh").on("click", async () => {
        if (activeSource === "preview") {
            currentPreview = null;
            await loadCurrentPreview();
            if (window.toastr) toastr.info("当前提示词预览已重新构造", "Titania");
        } else {
            renderPromptWindow();
            if (window.toastr) toastr.info("实际请求快照已刷新", "Titania");
        }
    });

    // 段落卡片点击展开/折叠
    $("#t-prompt-sections").on("click", ".t-prompt-section-head", function () {
        const $card = $(this).closest(".t-prompt-section-card");
        $card.toggleClass("expanded");
        syncExpandAllButton();
    });

    // 全部展开/折叠
    const syncExpandAllButton = () => {
        const $cards = $("#t-prompt-sections .t-prompt-section-card");
        const $btn = $("#t-prompt-expand-all-btn");
        if ($cards.length === 0) return;
        const allExpanded = $cards.filter(".expanded").length === $cards.length;
        if (allExpanded) {
            $btn.html('<i class="fa-solid fa-angles-up"></i><span class="t-prompt-expand-label">折叠全部</span>');
            $btn.attr({ title: "折叠全部消息", "aria-label": "折叠全部消息" });
        } else {
            $btn.html('<i class="fa-solid fa-angles-down"></i><span class="t-prompt-expand-label">展开全部</span>');
            $btn.attr({ title: "展开全部消息", "aria-label": "展开全部消息" });
        }
    };

    $("#t-prompt-expand-all-btn").on("click", function () {
        const $cards = $("#t-prompt-sections .t-prompt-section-card");
        if ($cards.length === 0) return;
        const allExpanded = $cards.filter(".expanded").length === $cards.length;
        if (allExpanded) {
            $cards.removeClass("expanded");
        } else {
            $cards.addClass("expanded");
        }
        syncExpandAllButton();
    });

    const close = () => {
        $(document).off("click.tpromptinfo");
        $("#t-debug-view").remove();
        if (hasMainView) {
            $mainView.show();
        } else {
            $("#t-overlay").remove();
        }
    };

    $("#t-debug-close").on("click", close);
}

/**
 * 显示诊断日志窗口
 * 用于实时查看插件日志和导出报告
 */
export function showDiagnosticsWindow() {
    // 如果已存在则不重复创建
    if ($("#t-diagnostics-view").length) return;

    // 确保 overlay 存在
    ensureOverlay();

    // 隐藏主窗口（如果存在）
    const $mainView = $("#t-main-view");
    const hasMainView = $mainView.length > 0;
    if (hasMainView) {
        $mainView.hide();
    }

    const html = `
    <div class="t-box t-root t-diagnostics-container" id="t-diagnostics-view">
        <div class="t-header" style="flex-shrink:0;">
            <div style="display:flex; align-items:center; gap:10px;">
                <i class="fa-solid fa-stethoscope" style="color:#ff9f43;"></i>
                <span class="t-title-main">诊断日志</span>
            </div>
            <span class="t-close" id="t-diag-close">&times;</span>
        </div>
        
        <div style="padding:15px; background:#181818; border-bottom:1px solid var(--t-color-border);">
            <div style="background: rgba(255, 159, 67, 0.1); border:1px solid rgba(255, 159, 67, 0.3); padding:12px; border-radius:6px;">
                <div style="font-weight:bold; color:#feca57; font-size:0.9em; margin-bottom:5px;">
                    <i class="fa-solid fa-triangle-exclamation"></i> 报错排查指南
                </div>
                <div style="font-size:0.85em; color:var(--t-color-text-label); line-height:1.5;">
                    如果您遇到生成失败或内容被截断的情况，请点击下方"导出完整报告"按钮，将生成的 JSON 文件发送给开发者。
                    报告中包含您的 Prompt（用于排查安全审查），但 <b>API Key 已自动脱敏</b>。
                </div>
            </div>
        </div>
        
        <div style="flex:1; overflow:hidden; display:flex; flex-direction:column; padding:15px;">
            <div style="font-weight:bold; color:var(--t-color-text-secondary); margin-bottom:10px;">
                <i class="fa-solid fa-scroll"></i> 实时日志 <span style="font-size:0.8em; color:var(--t-color-text-faint);">(内存缓存 50 条)</span>
            </div>
            <div class="t-log-box" id="t-diag-log-viewer" style="flex:1; overflow-y:auto;"></div>
        </div>
        
        <div style="padding:15px; background:#181818; border-top:1px solid var(--t-color-border); display:flex; gap:10px;">
            <button id="t-diag-refresh" class="t-btn">
                <i class="fa-solid fa-rotate-right"></i> 刷新日志
            </button>
            <button id="t-diag-clear" class="t-btn" style="color:var(--t-color-danger); border-color:var(--t-color-danger);">
                <i class="fa-solid fa-trash"></i> 清空日志
            </button>
            <button id="t-diag-export" class="t-btn primary" style="margin-left:auto;">
                <i class="fa-solid fa-download"></i> 导出完整报告 (.json)
            </button>
        </div>
    </div>`;

    $("#t-overlay").append(html);

    // 渲染日志
    const renderLogView = () => {
        const logs = TitaniaLogger.logs;
        const $viewer = $("#t-diag-log-viewer");

        if (!logs || logs.length === 0) {
            $viewer.html('<div style="text-align:center; margin-top:50px; color:#555;"><i class="fa-solid fa-inbox" style="font-size:2em; margin-bottom:10px;"></i><br>暂无日志</div>');
            return;
        }

        let html = "";
        logs.forEach(l => {
            let colorClass = "t-log-entry-info";
            if (l.type === 'ERROR') colorClass = "t-log-entry-error";
            if (l.type === 'WARN') colorClass = "t-log-entry-warn";

            let detailStr = "";
            if (l.details) {
                if (l.details.diagnostics) {
                    const d = l.details.diagnostics;
                    const net = d.network || {};
                    const summary = {
                        phase: d.phase,
                        status: net.status,
                        latency: net.latency + 'ms',
                        input: d.input_stats
                    };
                    if (d.raw_response_snippet) {
                        summary.raw_snippet = d.raw_response_snippet.substring(0, 100) + (d.raw_response_snippet.length > 100 ? '...' : '');
                    }
                    detailStr = `\n[Diagnostics]: ${JSON.stringify(summary, null, 2)}`;
                } else {
                    try {
                        detailStr = `\n${JSON.stringify(l.details, null, 2)}`;
                    } catch (e) { detailStr = "\n[Complex Data]"; }
                }
            }
            html += `<div class="${colorClass}">[${l.timestamp}] [${l.type}] ${l.message}${detailStr}</div>`;
        });
        $viewer.html(html);

        // 自动滚动到底部
        $viewer.scrollTop($viewer[0].scrollHeight);
    };

    // 初始渲染
    renderLogView();

    // 事件绑定
    // 关闭
    const closeWindow = () => {
        $("#t-diagnostics-view").remove();
        // 如果主窗口存在则显示它，否则关闭整个 overlay
        if (hasMainView) {
            $mainView.show();
        } else {
            $("#t-overlay").remove();
        }
    };

    $("#t-diag-close").on("click", closeWindow);

    // 刷新日志
    $("#t-diag-refresh").on("click", () => {
        renderLogView();
        if (window.toastr) toastr.info("日志已刷新", "Titania");
    });

    // 清空日志
    $("#t-diag-clear").on("click", () => {
        if (!confirm("确定要清空所有日志吗？")) return;
        TitaniaLogger.logs.length = 0;
        renderLogView();
        if (window.toastr) toastr.success("日志已清空", "Titania");
    });

    // 导出报告
    $("#t-diag-export").on("click", () => {
        TitaniaLogger.downloadReport();
    });

    // 设置自动刷新（每3秒刷新一次）
    const autoRefreshInterval = setInterval(() => {
        if ($("#t-diagnostics-view").length === 0) {
            clearInterval(autoRefreshInterval);
            return;
        }
        renderLogView();
    }, 3000);
}
