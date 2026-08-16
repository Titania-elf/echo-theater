// src/ui/scriptManager.js

import { getExtData, saveExtData } from "../utils/storage.js";
import { GlobalState } from "../core/state.js";
import {
    saveUserScript,
    deleteUserScript,
    loadScripts,
    sortScripts,
    getScriptSortMode,
    setScriptSortMode,
    createScriptStatsReader,
    buildScriptStatsOverview,
    cleanupOrphanScriptStats
} from "../core/scriptData.js";
import { refreshScriptList } from "./mainWindow.js";
import { openSettingsWindow } from "./settingsWindow.js";
import { openWorkshopWindow } from "./workshopWindow.js";

const SORT_MODE_LABELS = {
    default: "默认顺序",
    smart: "智能排序",
    recent_added: "最近添加",
    recent_generated: "最近使用",
    most_used: "最常使用",
    name_asc: "名称 A-Z",
    name_desc: "名称 Z-A"
};

function formatRelativeTime(ts) {
    const time = Number(ts) || 0;
    if (!time) return "未使用";
    const diff = Date.now() - time;
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
    return new Date(time).toLocaleDateString("zh-CN");
}

/**
 * 剧本管理器
 */
export function openScriptManager() {
    // 内部状态
    let currentFilter = {
        category: '全部', search: '', hidePresets: false
    };
    let currentSortMode = getScriptSortMode();
    let isBatchMode = false;

    cleanupOrphanScriptStats();

    const getCategories = () => {
        const cats = new Set(GlobalState.runtimeScripts.map(s => s.category).filter(c => c));
        // 简单按字母/拼音排序
        const sortedCats = [...cats].sort((a, b) => a.localeCompare(b, 'zh-CN'));
        return ["全部", ...sortedCats];
    };

    // HTML 结构 (样式见 css/manager.css)
    const html = `
    <div class="t-box t-root" id="t-mgr-view">
        <div class="t-header"><span class="t-title-main">📂 剧本资源管理</span><span class="t-close" id="t-mgr-close">&times;</span></div>
        <div class="t-mgr-body">
            <div class="t-mgr-sidebar" id="t-mgr-sidebar-desktop">
                <div class="t-mgr-sb-group">
                    <div class="t-mgr-sb-title">
                        <span>分类</span>
                    </div>
                    <div id="t-mgr-cat-list"></div>
                </div>
            </div>
            <!-- 移动端分类下拉选择器 -->
            <div class="t-mgr-mobile-cat" id="t-mgr-sidebar-mobile">
                <select id="t-mgr-cat-select" class="t-mgr-cat-dropdown"></select>
                <button id="t-mgr-cat-edit-mobile" class="t-mgr-cat-edit-btn" title="重命名分类" style="display:none;">
                    <i class="fa-solid fa-pen"></i>
                </button>
            </div>
                <div class="t-mgr-main" id="t-mgr-main-area">
                <div class="t-mgr-toolbar">
                    <input type="text" id="t-mgr-search-inp" class="t-mgr-search" placeholder="🔍 搜索...">
                    <select id="t-mgr-sort" class="t-mgr-sort" title="排序方式">
                        <option value="smart">智能排序</option>
                        <option value="recent_added">最近添加</option>
                        <option value="recent_generated">最近使用</option>
                        <option value="most_used">最常使用</option>
                        <option value="name_asc">名称 A-Z</option>
                        <option value="name_desc">名称 Z-A</option>
                        <option value="default">默认顺序</option>
                    </select>
                    <button id="t-mgr-workshop-btn" class="t-tool-btn" title="回声工坊"><i class="fa-solid fa-store"></i> 工坊</button>
                    <button id="t-mgr-import-btn" class="t-tool-btn" title="导入"><i class="fa-solid fa-file-import"></i></button>
                    <button id="t-mgr-export-btn" class="t-tool-btn" title="导出"><i class="fa-solid fa-file-export"></i></button>
                    <button id="t-mgr-batch-toggle" class="t-tool-btn" style="border:1px solid #444;" title="批量管理">
                        <i class="fa-solid fa-list-check"></i> 管理
                    </button>
                </div>
                <div class="t-mgr-overview" id="t-mgr-overview"></div>
                <div class="t-mgr-header-row t-batch-elem" style="padding: 8px 15px; background: #2a2a2a; border-bottom: 1px solid #333; color: #ccc; font-size: 0.9em; flex-shrink:0;">
                    <label style="display:flex; align-items:center; cursor:pointer;">
                        <input type="checkbox" id="t-mgr-select-all" style="margin-right:10px;"> 全选当前列表
                    </label>
                </div>
                <div class="t-mgr-list" id="t-mgr-list-container"></div>
                <div class="t-mgr-footer-bar t-batch-elem">
                    <span id="t-batch-count-label">已选: 0</span>
                    <button id="t-mgr-move-to" class="t-tool-btn" style="color:#bfa15f; border-color:#bfa15f;">📁 移动到</button>
                    <button id="t-mgr-export-selected" class="t-tool-btn" style="color:#90cdf4; border-color:#90cdf4;">📤 导出</button>
                    <button id="t-mgr-del-confirm" class="t-tool-btn" style="color:#ff6b6b; border-color:#ff6b6b;">🗑️ 删除</button>
                </div>
            </div>
        </div>
        
        <div id="t-imp-modal" class="t-imp-modal t-root">
            <div class="t-imp-box">
                <h3 style="margin-top:0; border-bottom:1px solid #333; padding-bottom:10px;">📥 导入剧本</h3>
                <div class="t-imp-row">
                    <span class="t-imp-label">存入分类:</span>
                    <input id="t-imp-cat-m" list="t-cat-dl-m" class="t-input" placeholder="输入或选择分类 (可选)" style="width:100%;">
                    <datalist id="t-cat-dl-m"></datalist>
                </div>
                <div class="t-imp-row">
                    <span class="t-imp-label">选择文件 (.txt):</span>
                    <div style="display:flex; gap:10px; align-items:center; background:#111; padding:5px; border-radius:4px; border:1px solid #333;">
                        <input type="file" id="t-file-input-m" accept=".txt" style="display:none;">
                        <button id="t-btn-choose-file" class="t-btn" style="font-size:0.9em; padding:4px 10px;">📂 浏览文件...</button>
                        <span id="t-file-name-label" style="font-size:0.85em; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width: 150px;">未选择文件</span>
                    </div>
                </div>
                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="t-imp-cancel" class="t-btn" style="flex:1;">取消</button>
                    <button id="t-imp-ok" class="t-btn primary" style="flex:1;">开始导入</button>
                </div>
            </div>
        </div>
        
        <div id="t-export-modal" class="t-imp-modal t-root">
            <div class="t-imp-box">
                <h3 style="margin-top:0; border-bottom:1px solid #333; padding-bottom:10px;">📤 导出剧本</h3>
                <div class="t-imp-row">
                    <span class="t-imp-label">导出范围:</span>
                    <div style="background:#111; padding:10px; border-radius:4px; border:1px solid #333; display:flex; flex-direction:column; gap:8px;">
                        <label><input type="radio" name="exp-scope" value="all" checked> 导出全部用户剧本</label>
                        <label><input type="radio" name="exp-scope" value="category"> 导出指定分类</label>
                        <label><input type="radio" name="exp-scope" value="current"> 导出当前列表 (<span id="exp-current-count">0</span> 个)</label>
                    </div>
                </div>
                <div class="t-imp-row" id="exp-cat-row" style="display:none;">
                    <span class="t-imp-label">选择分类:</span>
                    <select id="t-exp-cat" class="t-input" style="width:100%;"></select>
                </div>
                <div class="t-imp-row">
                    <span class="t-imp-label">导出格式:</span>
                    <div style="background:#111; padding:5px; border-radius:4px; border:1px solid #333; display:flex; gap:15px;">
                        <label><input type="radio" name="exp-format" value="txt" checked> TXT (纯文本)</label>
                        <label><input type="radio" name="exp-format" value="json"> JSON (结构化)</label>
                    </div>
                </div>
                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="t-exp-cancel" class="t-btn" style="flex:1;">取消</button>
                    <button id="t-exp-ok" class="t-btn primary" style="flex:1;">开始导出</button>
                </div>
            </div>
        </div>
        
        <div id="t-move-modal" class="t-imp-modal t-root">
            <div class="t-imp-box">
                <h3 style="margin-top:0; border-bottom:1px solid #333; padding-bottom:10px;">📁 移动到分类</h3>
                <div class="t-imp-row">
                    <span class="t-imp-label">目标分类:</span>
                    <input id="t-move-cat" list="t-move-cat-list" class="t-input" placeholder="输入或选择分类" style="width:100%;">
                    <datalist id="t-move-cat-list"></datalist>
                </div>
                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="t-move-cancel" class="t-btn" style="flex:1;">取消</button>
                    <button id="t-move-ok" class="t-btn primary" style="flex:1;">确认移动</button>
                </div>
            </div>
        </div>
        
        <div id="t-cat-rename-modal" class="t-imp-modal t-root">
            <div class="t-imp-box">
                <h3 style="margin-top:0; border-bottom:1px solid #333; padding-bottom:10px;">✏️ 重命名分类</h3>
                <div class="t-imp-row">
                    <span class="t-imp-label">当前分类: <span id="t-rename-old" style="color:#bfa15f;"></span></span>
                </div>
                <div class="t-imp-row">
                    <span class="t-imp-label">新名称:</span>
                    <input id="t-rename-new" class="t-input" placeholder="输入新的分类名称" style="width:100%;">
                </div>
                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="t-rename-cancel" class="t-btn" style="flex:1;">取消</button>
                    <button id="t-rename-ok" class="t-btn primary" style="flex:1;">确认重命名</button>
                </div>
            </div>
        </div>
    </div>`;

    $("#t-overlay").append(html);

    // --- 逻辑 ---
    const renderSidebarCats = () => {
        const cats = getCategories();

        // 桌面端侧边栏
        $("#t-mgr-cat-list").empty();
        $("#t-cat-dl-m").empty().append(cats.map(c => `<option value="${c}">`));
        cats.forEach(c => {
            const isAll = c === "全部";
            const $item = $(`
                <div class="t-mgr-sb-item" data-filter="category" data-val="${c}">
                    <span class="t-cat-name">${c}</span>
                    ${!isAll ? '<i class="fa-solid fa-pen t-cat-edit" style="font-size:0.7em; opacity:0; margin-left:auto; padding:3px;" title="重命名"></i>' : ''}
                </div>
            `);
            if (currentFilter.category === c) $item.addClass("active");

            // 点击整个分类项筛选（排除编辑图标）
            $item.on("click", function (e) {
                // 如果点击的是编辑图标，不触发筛选
                if ($(e.target).hasClass("t-cat-edit")) return;

                $(".t-mgr-sb-item[data-filter='category']").removeClass("active");
                $item.addClass("active");
                currentFilter.category = c;
                // 同步移动端下拉选择器
                $("#t-mgr-cat-select").val(c);
                renderList();
            });

            // 点击编辑图标重命名
            $item.find(".t-cat-edit").on("click", function (e) {
                e.stopPropagation();
                openRenameCategoryModal(c);
            });

            // 悬停时显示编辑图标
            $item.on("mouseenter", function () {
                $(this).find(".t-cat-edit").css("opacity", "1");
            }).on("mouseleave", function () {
                $(this).find(".t-cat-edit").css("opacity", "0");
            });

            $("#t-mgr-cat-list").append($item);
        });

        // 移动端下拉选择器
        const $select = $("#t-mgr-cat-select");
        $select.empty();
        cats.forEach(c => {
            const selected = currentFilter.category === c ? 'selected' : '';
            $select.append(`<option value="${c}" ${selected}>${c}</option>`);
        });

        // 更新移动端编辑按钮显示状态
        if (currentFilter.category === "全部" || currentFilter.category === "all") {
            $("#t-mgr-cat-edit-mobile").hide();
        } else {
            $("#t-mgr-cat-edit-mobile").show();
        }
    };

    // 移动端下拉选择器事件
    $("#t-mgr-cat-select").on("change", function () {
        const selectedCat = $(this).val();
        currentFilter.category = selectedCat;
        // 同步桌面端高亮
        $(".t-mgr-sb-item[data-filter='category']").removeClass("active");
        $(`.t-mgr-sb-item[data-val="${selectedCat}"]`).addClass("active");
        // 显示/隐藏移动端编辑按钮（"全部"分类不可编辑）
        if (selectedCat === "全部") {
            $("#t-mgr-cat-edit-mobile").hide();
        } else {
            $("#t-mgr-cat-edit-mobile").show();
        }
        renderList();
    });

    // 移动端分类编辑按钮事件
    $("#t-mgr-cat-edit-mobile").on("click", function () {
        const selectedCat = $("#t-mgr-cat-select").val();
        if (selectedCat && selectedCat !== "全部") {
            openRenameCategoryModal(selectedCat);
        }
    });

    // 重命名分类弹窗
    const openRenameCategoryModal = (oldName) => {
        $("#t-rename-old").text(oldName);
        $("#t-rename-new").val(oldName);
        $("#t-cat-rename-modal").css("display", "flex");
        $("#t-rename-new").focus().select();
    };

    // 确认重命名分类
    $("#t-rename-cancel").on("click", () => $("#t-cat-rename-modal").hide());
    $("#t-rename-ok").on("click", () => {
        const oldName = $("#t-rename-old").text();
        const newName = $("#t-rename-new").val().trim();

        if (!newName) {
            alert("分类名称不能为空");
            return;
        }

        if (newName === oldName) {
            $("#t-cat-rename-modal").hide();
            return;
        }

        // 检查是否存在同名分类
        const existingCats = [...new Set(GlobalState.runtimeScripts.map(s => s.category).filter(c => c))];
        if (existingCats.includes(newName)) {
            if (!confirm(`分类 "${newName}" 已存在，是否合并？`)) {
                return;
            }
        }

        // 批量更新所有该分类下的剧本
        const data = getExtData();
        let updatedCount = 0;

        (data.user_scripts || []).forEach(s => {
            if (s.category === oldName) {
                s.category = newName;
                updatedCount++;
            }
        });

        // 更新分类排序列表中的名称
        if (data.category_order) {
            const idx = data.category_order.indexOf(oldName);
            if (idx !== -1) {
                data.category_order[idx] = newName;
            }
        }

        saveExtData();
        loadScripts();
        refreshAll();

        $("#t-cat-rename-modal").hide();
        if (window.toastr) toastr.success(`已将 ${updatedCount} 个剧本移至分类 "${newName}"`);
    });

    const updateBatchCount = () => {
        const n = $(".t-mgr-check:checked").length;
        $("#t-batch-count-label").text(`已选: ${n}`);
        $("#t-mgr-del-confirm").prop("disabled", n === 0).css("opacity", n === 0 ? 0.5 : 1);
    };

    const renderOverview = () => {
        const overview = buildScriptStatsOverview(GlobalState.runtimeScripts, { days: 7 });
        const $box = $("#t-mgr-overview");
        if (!$box.length) return;

        const topUsed = overview.top_used || [];
        const topItems = topUsed.length > 0
            ? topUsed.map(item => `<span class="t-mgr-ov-item" title="${item.name}">${item.name} (${item.generated_count})</span>`).join("")
            : '<span class="t-mgr-ov-empty">暂无使用数据</span>';

        const categoryTop = (overview.category_ranking || []).slice(0, 3);
        const categoryText = categoryTop.length > 0
            ? categoryTop.map(x => `${x.category}(${x.generated_count})`).join(" · ")
            : "暂无";

        $box.html(`
            <div class="t-mgr-ov-meta">
                <span>排序：${SORT_MODE_LABELS[currentSortMode] || currentSortMode}</span>
                <span>已追踪：${overview.total_tracked_scripts || 0}</span>
                <span>${overview.days || 7}天活跃：${overview.active_last_days || 0}</span>
                <span>分类热度：${categoryText}</span>
            </div>
            <div class="t-mgr-ov-top">Top5：${topItems}</div>
        `);
    };

    const renderList = () => {
        const $list = $("#t-mgr-list-container");
        $list.empty();
        $("#t-mgr-select-all").prop("checked", false);
        updateBatchCount();

        const sortedScripts = sortScripts(GlobalState.runtimeScripts, currentSortMode);
        let filtered = sortedScripts.filter(s => {
            // 分类筛选：只有当选择了具体分类（非"全部"）时才过滤
            if (currentFilter.category && currentFilter.category !== "全部") {
                const sCat = s.category || "未分类";
                if (sCat !== currentFilter.category) return false;
            }
            // 搜索筛选
            if (currentFilter.search) {
                const term = currentFilter.search.toLowerCase();
                if (!s.name.toLowerCase().includes(term)) return false;
            }
            return true;
        });

        if (filtered.length === 0) {
            $list.append(`<div style="text-align:center; color:#555; margin-top:50px;">无数据</div>`);
            return;
        }

        const readStats = createScriptStatsReader();
        filtered.forEach(s => {
            const isUser = s._type === 'user';
            const catLabel = s.category ? `<span class="t-mgr-tag">${s.category}</span>` : '';
            const presetLabel = !isUser ? `<span class="t-mgr-tag" style="background:#444;">预设</span>` : '';
            const stats = readStats(s.id);
            const statsLine = `使用 ${stats.generated_count || 0} 次 · 选择 ${stats.selected_count || 0} 次 · 最近 ${formatRelativeTime(stats.last_generated_at || stats.last_selected_at)}`;

            const $row = $(`
                <div class="t-mgr-item">
                    <div class="t-mgr-item-check-col">
                        <input type="checkbox" class="t-mgr-check" data-id="${s.id}" data-type="${s._type}">
                    </div>
                    <div class="t-mgr-item-meta" style="cursor:pointer;">
                        <div class="t-mgr-item-title">${s.name} ${presetLabel} ${catLabel}</div>
                        <div class="t-mgr-item-desc">${s.desc || "..."}</div>
                        <div class="t-mgr-item-stats">${statsLine}</div>
                    </div>
                    <div style="padding-left:10px;">
                        <i class="fa-solid fa-pen" style="color:#666; cursor:pointer;"></i>
                    </div>
                </div>
            `);

            $row.find(".t-mgr-item-meta, .fa-pen").on("click", () => {
                if (!isBatchMode) {
                    $("#t-mgr-view").hide();
                    openEditor(s.id, 'manager');
                } else {
                    const cb = $row.find(".t-mgr-check");
                    cb.prop("checked", !cb.prop("checked")).trigger("change");
                }
            });
            $row.find(".t-mgr-check").on("change", updateBatchCount);
            $list.append($row);
        });
    };

    const refreshAll = () => { renderSidebarCats(); renderOverview(); renderList(); };

    // 事件绑定
    $("#t-mgr-batch-toggle").on("click", function () {
        isBatchMode = !isBatchMode;
        const main = $("#t-mgr-main-area");
        const btn = $(this);
        if (isBatchMode) {
            main.addClass("t-batch-active");
            btn.html('<i class="fa-solid fa-check"></i> 完成').css({ background: "#bfa15f", color: "#000", borderColor: "#bfa15f" });
        } else {
            main.removeClass("t-batch-active");
            btn.html('<i class="fa-solid fa-list-check"></i> 管理').css({ background: "", color: "", borderColor: "#444" });
            $(".t-mgr-check").prop("checked", false);
        }
    });

    // 导出功能
    const exportScriptsToTxt = (scripts) => {
        let content = "";
        scripts.forEach((s, idx) => {
            if (idx > 0) content += "\n\n";
            content += `### ${s.name}\n`;
            content += `Title: ${s.name}\n`;
            if (s.category) content += `Category: ${s.category}\n`;
            if (s.desc) content += `Desc: ${s.desc}\n`;
            content += `\n${s.prompt}`;
        });
        return content;
    };

    const exportScriptsToJson = (scripts) => {
        const exportData = scripts.map(s => ({
            name: s.name,
            desc: s.desc || "",
            prompt: s.prompt,
            category: s.category || ""
        }));
        return JSON.stringify(exportData, null, 2);
    };

    const downloadFile = (content, filename, type) => {
        const blob = new Blob([content], { type: type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const getExportScripts = (scope) => {
        const userScripts = GlobalState.runtimeScripts.filter(s => s._type === 'user');

        if (scope === 'all') {
            return userScripts;
        } else if (scope === 'category') {
            const cat = $("#t-exp-cat").val();
            return userScripts.filter(s => (s.category || "未分类") === cat);
        } else if (scope === 'current') {
            // 获取当前筛选条件下的剧本
            return GlobalState.runtimeScripts.filter(s => {
                if (s._type !== 'user') return false;
                // 分类筛选
                if (currentFilter.category && currentFilter.category !== "全部") {
                    const sCat = s.category || "未分类";
                    if (sCat !== currentFilter.category) return false;
                }
                // 搜索筛选
                if (currentFilter.search) {
                    const term = currentFilter.search.toLowerCase();
                    if (!s.name.toLowerCase().includes(term)) return false;
                }
                return true;
            });
        }
        return [];
    };

    $("#t-mgr-export-btn").on("click", () => {
        // 更新当前列表数量
        const currentListCount = GlobalState.runtimeScripts.filter(s => {
            if (s._type !== 'user') return false;
            // 分类筛选
            if (currentFilter.category && currentFilter.category !== "全部") {
                const sCat = s.category || "未分类";
                if (sCat !== currentFilter.category) return false;
            }
            // 搜索筛选
            if (currentFilter.search) {
                const term = currentFilter.search.toLowerCase();
                if (!s.name.toLowerCase().includes(term)) return false;
            }
            return true;
        }).length;
        $("#exp-current-count").text(currentListCount);

        // 填充分类下拉框
        const cats = getCategories().filter(c => c !== "全部");
        cats.unshift("未分类");
        $("#t-exp-cat").empty();
        [...new Set(cats)].forEach(c => {
            $("#t-exp-cat").append(`<option value="${c}">${c}</option>`);
        });

        $("#t-export-modal").css("display", "flex");
    });

    $("input[name='exp-scope']").on("change", function () {
        if ($(this).val() === 'category') {
            $("#exp-cat-row").show();
        } else {
            $("#exp-cat-row").hide();
        }
    });

    $("#t-exp-cancel").on("click", () => $("#t-export-modal").hide());

    $("#t-exp-ok").on("click", () => {
        const scope = $("input[name='exp-scope']:checked").val();
        const format = $("input[name='exp-format']:checked").val();
        const scripts = getExportScripts(scope);

        if (scripts.length === 0) {
            alert("没有可导出的剧本");
            return;
        }

        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        let content, filename, mimeType;

        if (format === 'txt') {
            content = exportScriptsToTxt(scripts);
            filename = `Titania_Scripts_${timestamp}.txt`;
            mimeType = "text/plain;charset=utf-8";
        } else {
            content = exportScriptsToJson(scripts);
            filename = `Titania_Scripts_${timestamp}.json`;
            mimeType = "application/json;charset=utf-8";
        }

        downloadFile(content, filename, mimeType);
        $("#t-export-modal").hide();
        if (window.toastr) toastr.success(`已导出 ${scripts.length} 个剧本`);
    });

    // 批量导出选中的剧本
    $("#t-mgr-export-selected").on("click", () => {
        const selectedIds = [];
        $(".t-mgr-check:checked").each(function () {
            const type = $(this).data("type");
            if (type === 'user') {
                selectedIds.push($(this).data("id"));
            }
        });

        if (selectedIds.length === 0) {
            alert("请先选择要导出的用户剧本（预设剧本不支持导出）");
            return;
        }

        const scripts = GlobalState.runtimeScripts.filter(s => selectedIds.includes(s.id));
        const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const content = exportScriptsToTxt(scripts);
        downloadFile(content, `Titania_Selected_${timestamp}.txt`, "text/plain;charset=utf-8");

        if (window.toastr) toastr.success(`已导出 ${scripts.length} 个剧本`);
    });

    $("#t-mgr-workshop-btn").on("click", () => openWorkshopWindow('manager'));

    $("#t-mgr-import-btn").on("click", () => { $("#t-imp-modal").css("display", "flex"); $("#t-file-input-m").val(""); $("#t-file-name-label").text("未选择文件"); });
    $("#t-btn-choose-file").on("click", () => $("#t-file-input-m").click());
    $("#t-file-input-m").on("change", function () { $("#t-file-name-label").text(this.files[0] ? this.files[0].name : "未选择文件"); });
    $("#t-imp-cancel").on("click", () => $("#t-imp-modal").hide());

    // 智能导入解析逻辑
    $("#t-imp-ok").on("click", () => {
        const file = $("#t-file-input-m")[0].files[0];
        if (!file) return alert("请选择文件");
        const defaultCat = $("#t-imp-cat-m").val().trim();

        const reader = new FileReader();
        reader.onload = function (evt) {
            const content = evt.target.result;
            const fileName = file.name.replace(/\.[^/.]+$/, "");
            const blocks = content.split(/(?:^|\r?\n)\s*###/);

            let importCount = 0;
            blocks.forEach((block, index) => {
                if (!block || !block.trim()) return;

                let lines = block.split(/\r?\n/);
                let potentialInlineTitle = lines[0].trim();
                let bodyLines = lines;

                let scriptTitle = "";
                let scriptCat = defaultCat;

                if (potentialInlineTitle.length > 0 && potentialInlineTitle.length < 50) {
                    scriptTitle = potentialInlineTitle;
                    bodyLines = lines.slice(1);
                }

                let rawBody = bodyLines.join("\n").trim();

                const titleMatch = rawBody.match(/^(?:Title|标题)[:：]\s*(.+)$/im);
                if (titleMatch) {
                    scriptTitle = titleMatch[1].trim();
                    rawBody = rawBody.replace(titleMatch[0], "").trim();
                }

                const catMatch = rawBody.match(/^(?:Category|分类)[:：]\s*(.+)$/im);
                if (catMatch) {
                    scriptCat = catMatch[1].trim();
                    rawBody = rawBody.replace(catMatch[0], "").trim();
                }

                // 解析 Desc/简介 字段
                let scriptDesc = "";
                const descMatch = rawBody.match(/^(?:Desc|简介|描述)[:：]\s*(.+)$/im);
                if (descMatch) {
                    scriptDesc = descMatch[1].trim();
                    rawBody = rawBody.replace(descMatch[0], "").trim();
                }

                if (!scriptTitle) {
                    const cleanStart = rawBody.replace(/\s+/g, " ").substring(0, 20);
                    if (cleanStart) {
                        scriptTitle = cleanStart + "...";
                    } else {
                        scriptTitle = `${fileName}_${String(index + 1).padStart(2, '0')}`;
                    }
                }

                if (!rawBody) return;

                saveUserScript({
                    id: "imp_" + Date.now() + "_" + Math.floor(Math.random() * 10000),
                    name: scriptTitle,
                    desc: scriptDesc || "导入数据",
                    prompt: rawBody,
                    category: scriptCat
                });
                importCount++;
            });

            alert(`成功导入 ${importCount} 个剧本`);
            $("#t-imp-modal").hide();
            refreshAll();
        };
        reader.readAsText(file);
    });

    $("#t-mgr-del-confirm").on("click", function () {
        const toDeleteUser = [];
        const toHidePreset = [];
        $(".t-mgr-check:checked").each(function () {
            const id = $(this).data("id");
            const type = $(this).data("type");
            if (type === 'user') toDeleteUser.push(id);
            else if (type === 'preset') toHidePreset.push(id);
        });

        const total = toDeleteUser.length + toHidePreset.length;
        if (total === 0) return;

        if (confirm(`⚠️ 确定删除选中的 ${total} 个剧本？\n(注：官方预设将变为隐藏状态，可去设置里恢复)`)) {
            if (toDeleteUser.length > 0) toDeleteUser.forEach(id => deleteUserScript(id));
            if (toHidePreset.length > 0) {
                const data = getExtData();
                if (!data.disabled_presets) data.disabled_presets = [];
                data.disabled_presets = [...new Set([...data.disabled_presets, ...toHidePreset])];
                saveExtData();
                loadScripts();
            }
            refreshAll();
            $("#t-mgr-select-all").prop("checked", false);
        }
    });

    // 批量移动到分类
    $("#t-mgr-move-to").on("click", () => {
        const selectedIds = [];
        $(".t-mgr-check:checked").each(function () {
            const type = $(this).data("type");
            if (type === 'user') {
                selectedIds.push($(this).data("id"));
            }
        });

        if (selectedIds.length === 0) {
            alert("请先选择要移动的用户剧本（预设剧本不支持移动）");
            return;
        }

        // 填充分类列表
        const cats = getCategories().filter(c => c !== "全部");
        $("#t-move-cat-list").empty();
        cats.forEach(c => {
            $("#t-move-cat-list").append(`<option value="${c}">`);
        });
        $("#t-move-cat").val("");

        $("#t-move-modal").css("display", "flex");
    });

    $("#t-move-cancel").on("click", () => $("#t-move-modal").hide());
    $("#t-move-ok").on("click", () => {
        const targetCat = $("#t-move-cat").val().trim();
        if (!targetCat) {
            alert("请输入或选择目标分类");
            return;
        }

        const selectedIds = [];
        $(".t-mgr-check:checked").each(function () {
            const type = $(this).data("type");
            if (type === 'user') {
                selectedIds.push($(this).data("id"));
            }
        });

        // 使用 saveUserScript 逐个更新，确保数据一致性
        const data = getExtData();
        const scriptsToMove = (data.user_scripts || []).filter(s => selectedIds.includes(s.id));

        scriptsToMove.forEach(s => {
            saveUserScript({ ...s, category: targetCat });
        });

        refreshAll();

        $("#t-move-modal").hide();
        $(".t-mgr-check").prop("checked", false);
        updateBatchCount();

        if (window.toastr) toastr.success(`已将 ${scriptsToMove.length} 个剧本移至 "${targetCat}"`);
    });

    $("#t-mgr-close").on("click", () => {
        $("#t-mgr-view").remove();

        // 检查是否有主窗口存在
        const $mainView = $("#t-main-view");
        if ($mainView.length > 0) {
            $mainView.show();
            // 刷新主窗口的下拉列表
            refreshScriptList();
        } else {
            // 如果主窗口不存在，检查 overlay 是否为空
            // 如果 overlay 内没有其他可见内容，移除整个 overlay
            const $overlay = $("#t-overlay");
            if ($overlay.length > 0 && $overlay.children(":visible").length === 0) {
                $overlay.remove();
            }
        }
    });

    $("#t-mgr-search-inp").on("input", function () { currentFilter.search = $(this).val(); renderList(); });
    $("#t-mgr-select-all").on("change", function () { $(".t-mgr-check:not(:disabled)").prop("checked", $(this).is(":checked")); updateBatchCount(); });
    $("#t-mgr-sort").val(currentSortMode).on("change", function () {
        currentSortMode = setScriptSortMode($(this).val());
        renderOverview();
        renderList();
    });

    refreshAll();
}

/**
 * 剧本编辑器
 * @param {string|null} id - 剧本 ID，null 表示新建
 * @param {string} source - 来源: 'manager' | 'main'
 */
export function openEditor(id, source = 'main') {
    const isEdit = !!id;
    let data = { id: Date.now().toString(), name: "新剧本", desc: "", prompt: "", category: "" };
    if (isEdit) data = GlobalState.runtimeScripts.find(s => s.id === id);
    const isPreset = data._type === 'preset';

    // 根据来源隐藏对应窗口
    if (source === 'manager') {
        $("#t-mgr-view").hide();
    } else {
        // 'main' - 从主窗口打开
        $("#t-main-view").hide();
    }

    // 获取现有分类用于联想
    const existingCats = [...new Set(GlobalState.runtimeScripts.map(s => s.category).filter(c => c))].sort();
    const dataListOpts = existingCats.map(c => `<option value="${c}">`).join("");

    const html = `
    <div class="t-box t-root" id="t-editor-view">
        <div class="t-header"><span class="t-title-main">${isPreset ? '查看' : (isEdit ? '编辑' : '新建')}</span></div>
        <div class="t-body">
            <div style="display:flex; gap:10px; margin-bottom:5px;">
                <div style="flex-grow:1;">
                    <label>标题:</label>
                    <input id="ed-name" class="t-input" value="${data.name}" ${isPreset ? 'disabled' : ''}>
                </div>
                <div style="width: 150px;">
                    <label>分类:</label>
                    <input id="ed-cat" list="ed-cat-list" class="t-input" value="${data.category || ''}" placeholder="默认" ${isPreset ? 'disabled' : ''}>
                    <datalist id="ed-cat-list">${dataListOpts}</datalist>
                </div>
            </div>

            <label>简介:</label><input id="ed-desc" class="t-input" value="${data.desc}" ${isPreset ? 'disabled' : ''}>
            
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px;">
                <label>Prompt:</label>
                ${!isPreset ? `<div class="t-tool-btn" id="ed-btn-expand" style="cursor:pointer;"><i class="fa-solid fa-maximize"></i> 大屏</div>` : ''}
            </div>
            <textarea id="ed-prompt" class="t-input" rows="6" ${isPreset ? 'disabled' : ''}>${data.prompt}</textarea>
            
            <div class="t-btn-row">
                ${!isPreset ? '<button id="ed-save" class="t-btn primary" style="flex:1;">保存</button>' : ''}
                <button id="ed-cancel" class="t-btn" style="flex:1;">返回</button>
            </div>
        </div>
    </div>`;

    $("#t-overlay").append(html);

    // 事件绑定
    $("#ed-cancel").on("click", () => {
        $("#t-editor-view").remove();
        if (source === 'manager') {
            // 从管理器打开 -> 返回管理器
            $("#t-mgr-view").remove();
            openScriptManager();
        } else {
            // 从主窗口打开 -> 返回主窗口
            $("#t-main-view").show();
        }
    });

    $("#ed-btn-expand").on("click", () => {
        const originalContent = $("#ed-prompt").val();
        $("#t-editor-view").hide();

        // 创建大屏编辑视图，添加遮罩层防止点击穿透
        // 使用 padding 确保在手机端也能正确居中显示
        const largeEditHtml = `
        <div id="t-large-edit-overlay" style="position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); z-index:20000; display:flex; align-items:center; justify-content:center; padding:10px; box-sizing:border-box;">
            <div class="t-box t-root" id="t-large-edit-view" style="width:100%; max-width:800px; height:90vh; max-height:90vh; margin:auto; display:flex; flex-direction:column;">
                <div class="t-header" style="flex-shrink:0;">
                    <span class="t-title-main">大屏编辑模式</span>
                    <span class="t-close" id="ed-large-close">&times;</span>
                </div>
                <div class="t-body" style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
                    <textarea id="ed-large-text" class="t-input" style="flex:1; resize:none; font-family:monospace; line-height:1.5; font-size:14px; min-height:0;">${originalContent}</textarea>
                    <div class="t-btn-row" style="flex-shrink:0; margin-top:10px;">
                        <button id="ed-large-ok" class="t-btn primary" style="flex:1;">确认保存</button>
                        <button id="ed-large-cancel" class="t-btn" style="flex:1;">取消</button>
                    </div>
                </div>
            </div>
        </div>`;

        $("body").append(largeEditHtml);

        // 检查是否有未保存的修改
        const checkUnsavedChanges = () => {
            const currentContent = $("#ed-large-text").val();
            return currentContent !== originalContent;
        };

        // 关闭大屏编辑的函数
        const closeLargeEdit = (saveChanges = false) => {
            if (saveChanges) {
                $("#ed-prompt").val($("#ed-large-text").val());
            }
            $("#t-large-edit-overlay").remove();
            $("#t-editor-view").show();
        };

        // 带确认的关闭
        const confirmClose = () => {
            if (checkUnsavedChanges()) {
                if (confirm("您有未保存的修改，确定要放弃吗？")) {
                    closeLargeEdit(false);
                }
            } else {
                closeLargeEdit(false);
            }
        };

        // 点击遮罩层关闭（带确认）
        $("#t-large-edit-overlay").on("click", function (e) {
            if (e.target === this) {
                confirmClose();
            }
        });

        // 关闭按钮
        $("#ed-large-close").on("click", confirmClose);

        // 取消按钮
        $("#ed-large-cancel").on("click", confirmClose);

        // 确认按钮
        $("#ed-large-ok").on("click", () => closeLargeEdit(true));

        // ESC 键关闭（带确认）
        $(document).on("keydown.largeedit", function (e) {
            if (e.key === "Escape") {
                confirmClose();
                e.preventDefault();
            }
        });

        // 清理事件监听
        $("#t-large-edit-overlay").on("remove", function () {
            $(document).off("keydown.largeedit");
        });
    });

    if (!isPreset) {
        $("#ed-save").on("click", () => {
            saveUserScript({
                id: isEdit ? data.id : "user_" + Date.now(),
                name: $("#ed-name").val(),
                desc: $("#ed-desc").val(),
                prompt: $("#ed-prompt").val(),
                category: $("#ed-cat").val().trim()
            });
            $("#t-editor-view").remove();
            if (source === 'manager') {
                // 从管理器打开 -> 返回管理器
                $("#t-mgr-view").remove();
                openScriptManager();
            } else {
                // 从主窗口打开 -> 返回主窗口
                $("#t-main-view").show();
            }
        });
    }
}
