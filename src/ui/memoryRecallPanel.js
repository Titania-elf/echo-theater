// src/ui/memoryRecallPanel.js
// 记忆召回面板 UI - 参考 favsWindow 实现

import { TitaniaLogger } from "../core/logger.js";
import { ensureOverlay } from "../utils/dom.js";
import {
    recallMemories,
    appendMemoriesToInput,
    getDefaultQuery,
    getRecallStatus,
    getCurrentCharacterId
} from "../core/memoryRecall.js";

let searchResults = [];
let selectedIndices = new Set();
let isSearching = false;

/**
 * 创建记忆召回按钮（放在输入框旁边）- 保留兼容性
 */
export function createMemoryRecallButton() {
    // 现在改用悬浮球子菜单，此函数保留但不执行
}

/**
 * 移除记忆召回按钮
 */
export function removeMemoryRecallButton() {
    closeRecallPanel();
}

/**
 * 切换面板显示
 */
export function toggleRecallPanel() {
    const $view = $("#t-recall-view");
    if ($view.length > 0 && $view.is(":visible")) {
        closeRecallPanel();
    } else {
        openRecallPanel();
    }
}

/**
 * 打开记忆召回面板（参考 favsWindow 的实现方式）
 */
export async function openRecallPanel() {
    // 先隐藏主窗口（如果存在）
    $("#t-main-view").hide();

    // 确保 overlay 存在
    ensureOverlay();

    // 检查是否已存在面板
    if ($("#t-recall-view").length > 0) {
        $("#t-recall-view").show();
        return;
    }

    // 获取状态
    let status = { available: false, vectorCount: 0, message: "正在检查..." };
    try {
        status = await getRecallStatus();
    } catch (e) {
        TitaniaLogger.warn("获取召回状态失败", e);
        status = { available: false, vectorCount: 0, message: "状态检查失败" };
    }

    // 构建 HTML（参考 favsWindow 的结构）
    const html = `
    <div class="t-box t-root t-recall-container" id="t-recall-view">
        <div class="t-header t-shrink-0">
            <span class="t-title-main"><i class="fa-solid fa-lightbulb"></i> 记忆召回</span>
            <span class="t-recall-status-badge ${status.available ? 'available' : 'unavailable'}" style="margin-left: auto; margin-right: 15px; font-size: 0.85em; padding: 4px 10px; border-radius: 12px; background: ${status.available ? '#2a4a3a' : '#4a2a2a'}; color: ${status.available ? '#4caf50' : '#ff6b6b'};">
                ${status.message}
            </span>
            <span class="t-close" id="t-recall-close">&times;</span>
        </div>
        
        <div class="t-recall-toolbar" style="padding: 15px; border-bottom: 1px solid var(--t-color-border); background: var(--t-color-surface-sunken);">
            <div style="display: flex; gap: 10px; align-items: center;">
                <input type="text"
                       id="t-recall-query"
                       class="t-input t-flex-1"
                       placeholder="输入要检索的内容（留空使用最近消息）..."
                       ${!status.available ? 'disabled' : ''}>
                <button id="t-recall-search-btn"
                        class="t-btn t-btn-primary"
                        ${!status.available ? 'disabled' : ''}>
                    <i class="fa-solid fa-search"></i> 检索
                </button>
            </div>
            
            <div style="display: flex; gap: 15px; margin-top: 10px;">
                <label style="display: flex; align-items: center; gap: 5px; color: var(--t-color-text-secondary); font-size: 0.9em;">
                    最大数量:
                    <select id="t-recall-max-results" class="t-input" style="width: 70px; padding: 4px;">
                        <option value="5">5</option>
                        <option value="10" selected>10</option>
                        <option value="15">15</option>
                        <option value="20">20</option>
                    </select>
                </label>
                <label style="display: flex; align-items: center; gap: 5px; color: var(--t-color-text-secondary); font-size: 0.9em;">
                    最小相似度:
                    <select id="t-recall-min-score" class="t-input" style="width: 70px; padding: 4px;">
                        <option value="0.4">40%</option>
                        <option value="0.5" selected>50%</option>
                        <option value="0.6">60%</option>
                        <option value="0.7">70%</option>
                    </select>
                </label>
            </div>
        </div>
        
        <div style="padding: 10px 15px; background: var(--t-color-surface-raised); border-bottom: 1px solid var(--t-color-border); display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--t-color-text-muted);">检索结果</span>
            <div style="display: flex; gap: 10px; align-items: center;">
                <button id="t-recall-select-all" class="t-tool-btn" disabled>全选</button>
                <button id="t-recall-deselect-all" class="t-tool-btn" disabled>取消</button>
                <span id="t-recall-selected-count" style="color: var(--t-color-text-muted); font-size: 0.9em;">已选: 0</span>
            </div>
        </div>
        
        <div class="t-recall-results-area" style="flex: 1; overflow-y: auto; padding: 10px;">
            <div id="t-recall-results-list">
                <div style="text-align: center; padding: 40px; color: var(--t-color-text-faint);">
                    ${status.available ? '输入关键词并点击检索' : '请先建立向量索引'}
                </div>
            </div>
        </div>
        
        <div style="padding: 15px; border-top: 1px solid var(--t-color-border); display: flex; justify-content: flex-end; gap: 10px; background: var(--t-color-surface-sunken);">
            <button id="t-recall-cancel" class="t-btn">取消</button>
            <button id="t-recall-append" class="t-btn t-btn-primary" disabled>
                <i class="fa-solid fa-paperclip"></i> 附加到输入框
            </button>
        </div>
    </div>`;

    $("#t-overlay").append(html);

    // 重置状态
    searchResults = [];
    selectedIndices.clear();

    // 绑定事件
    bindRecallEvents();

    // 填充默认查询
    try {
        const defaultQuery = getDefaultQuery();
        if (defaultQuery) {
            $("#t-recall-query").val(defaultQuery.substring(0, 200));
        }
    } catch (e) {
        TitaniaLogger.warn("填充默认查询失败", e);
    }
}

/**
 * 关闭面板
 */
export function closeRecallPanel() {
    $("#t-recall-view").remove();
    // 如果主窗口存在则显示它，否则关闭整个 overlay
    const $mainView = $("#t-main-view");
    if ($mainView.length > 0) {
        $mainView.css("display", "flex");
    } else {
        // 从子菜单直接打开的情况，关闭 overlay
        $("#t-overlay").remove();
    }
}

/**
 * 绑定面板事件
 */
function bindRecallEvents() {
    // 关闭按钮
    $("#t-recall-close").on("click", closeRecallPanel);

    // 取消按钮
    $("#t-recall-cancel").on("click", closeRecallPanel);

    // 检索按钮
    $("#t-recall-search-btn").on("click", handleSearch);

    // 回车检索
    $("#t-recall-query").on("keypress", (e) => {
        if (e.key === 'Enter' && !isSearching) {
            handleSearch();
        }
    });

    // 全选/取消全选
    $("#t-recall-select-all").on("click", () => {
        selectedIndices = new Set(searchResults.map((_, i) => i));
        updateResultsSelection();
    });

    $("#t-recall-deselect-all").on("click", () => {
        selectedIndices.clear();
        updateResultsSelection();
    });

    // 附加按钮
    $("#t-recall-append").on("click", handleAppend);
}

/**
 * 处理检索
 */
async function handleSearch() {
    if (isSearching) return;

    let query = $("#t-recall-query").val()?.trim() || '';

    // 如果查询为空，使用默认查询
    if (!query) {
        query = getDefaultQuery();
        if (!query) {
            if (window.toastr) {
                toastr.warning("请输入检索内容", "Titania");
            }
            return;
        }
    }

    const maxResults = parseInt($("#t-recall-max-results").val()) || 10;
    const minScore = parseFloat($("#t-recall-min-score").val()) || 0.5;

    // 显示加载状态
    isSearching = true;
    $("#t-recall-search-btn").html('<i class="fa-solid fa-spinner fa-spin"></i> 检索中...').prop("disabled", true);
    $("#t-recall-results-list").html('<div style="text-align: center; padding: 40px; color: var(--t-color-text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> 检索中...</div>');

    try {
        searchResults = await recallMemories(query, { maxResults, minScore });
        selectedIndices.clear();

        if (searchResults.length === 0) {
            $("#t-recall-results-list").html('<div style="text-align: center; padding: 40px; color: var(--t-color-text-faint);">未找到相关记忆</div>');
        } else {
            renderResults();
        }
    } catch (e) {
        TitaniaLogger.error("检索失败", e);
        $("#t-recall-results-list").html('<div style="text-align: center; padding: 40px; color: var(--t-color-danger);">' + e.message + '</div>');
        if (window.toastr) {
            toastr.error(e.message, "检索失败");
        }
    } finally {
        isSearching = false;
        $("#t-recall-search-btn").html('<i class="fa-solid fa-search"></i> 检索').prop("disabled", false);
    }
}

/**
 * 渲染检索结果
 */
function renderResults() {
    const $resultsList = $("#t-recall-results-list");
    if (!$resultsList.length) return;

    const html = searchResults.map((result, index) => {
        const scorePercent = Math.round(result.score * 100);
        const isSelected = selectedIndices.has(index);
        const scoreColor = scorePercent >= 70 ? '#4caf50' : (scorePercent >= 50 ? '#ff9800' : '#888');
        const displayText = escapeHtml(result.text).substring(0, 300) + (result.text.length > 300 ? '...' : '');

        return '<div class="t-recall-result-item" data-index="' + index + '" style="' +
            'display: flex; gap: 10px; padding: 12px; margin-bottom: 8px; ' +
            'background: ' + (isSelected ? '#2a3a4a' : '#1e1e1e') + '; ' +
            'border: 1px solid ' + (isSelected ? '#4a9eff' : '#333') + '; ' +
            'border-radius: 8px; cursor: pointer; transition: all 0.2s;">' +
            '<div style="flex-shrink: 0; padding-top: 2px;">' +
            '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' style="cursor: pointer;">' +
            '</div>' +
            '<div style="flex: 1; min-width: 0;">' +
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">' +
            '<span style="color: var(--t-color-text-muted); font-size: 0.85em;">#' + result.messageIndex + '</span>' +
            '<span style="color: ' + scoreColor + '; font-weight: bold; font-size: 0.9em;">' + scorePercent + '%</span>' +
            '</div>' +
            '<div style="color: var(--t-color-text-label); font-size: 0.9em; line-height: 1.5; word-break: break-word;">' + displayText + '</div>' +
            '</div>' +
            '</div>';
    }).join('');

    $resultsList.html(html);

    // 绑定选择事件
    $resultsList.find(".t-recall-result-item").each(function () {
        const $item = $(this);
        const index = parseInt($item.data("index"));

        $item.on("click", function (e) {
            if (e.target.tagName === 'INPUT') return;

            if (selectedIndices.has(index)) {
                selectedIndices.delete(index);
            } else {
                selectedIndices.add(index);
            }
            updateResultsSelection();
        });

        $item.find("input[type='checkbox']").on("change", function () {
            if (this.checked) {
                selectedIndices.add(index);
            } else {
                selectedIndices.delete(index);
            }
            updateResultsSelection();
        });
    });

    // 更新按钮状态
    updateButtonStates();
}

/**
 * 更新选择状态显示
 */
function updateResultsSelection() {
    $(".t-recall-result-item").each(function () {
        const $item = $(this);
        const index = parseInt($item.data("index"));
        const isSelected = selectedIndices.has(index);

        $item.css({
            "background": isSelected ? "#2a3a4a" : "#1e1e1e",
            "border-color": isSelected ? "#4a9eff" : "#333"
        });
        $item.find("input[type='checkbox']").prop("checked", isSelected);
    });

    updateButtonStates();
}

/**
 * 更新按钮状态
 */
function updateButtonStates() {
    const hasResults = searchResults.length > 0;
    const hasSelection = selectedIndices.size > 0;

    $("#t-recall-select-all").prop("disabled", !hasResults);
    $("#t-recall-deselect-all").prop("disabled", !hasSelection);
    $("#t-recall-append").prop("disabled", !hasSelection);
    $("#t-recall-selected-count").text("已选: " + selectedIndices.size);
}

/**
 * 处理附加操作
 */
function handleAppend() {
    if (selectedIndices.size === 0) {
        if (window.toastr) {
            toastr.warning("请先选择要附加的记忆", "Titania");
        }
        return;
    }

    // 获取选中的记忆
    const selectedMemories = Array.from(selectedIndices)
        .sort((a, b) => a - b)
        .map(i => searchResults[i]);

    // 附加到输入框
    const success = appendMemoriesToInput(selectedMemories);

    if (success) {
        closeRecallPanel();
        if (window.toastr) {
            toastr.success("已附加 " + selectedMemories.length + " 条记忆到输入框", "Titania");
        }
    }
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 销毁面板
 */
export function destroyRecallPanel() {
    $("#t-recall-view").remove();
    searchResults = [];
    selectedIndices.clear();
}