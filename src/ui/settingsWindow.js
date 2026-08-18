// src/ui/settingsWindow.js (Part 1/2)

import { getExtData, saveExtData } from "../utils/storage.js";
import { GlobalState } from "../core/state.js";
import { TitaniaLogger } from "../core/logger.js";
import { fileToBase64 } from "../utils/helpers.js";
import { createFloatingButton } from "./floatingBtn.js";
import { loadScripts } from "../core/scriptData.js";
import { openScriptManager } from "./scriptManager.js";
import { ensureOverlay } from "../utils/dom.js";
import { refreshOutlineEntryButton } from "./outlineEntryButton.js";
import { refreshRewriteEntryButton } from "./rewriteEntryButton.js";
import { ensureMainApiProfiles } from "../core/apiProfileRegistry.js";
import { createApiConnectionEditor, renderApiConnectionEditorHTML } from "./shared/apiConnectionEditor.js";
import { normalizeChatCompletionPreset, getPresetEntrySummary, ensurePromptManager, ensureTitaniaPresetEntries, createCustomPresetEntry, getPresetInsertLimit } from "../core/promptManager.js";
import {
    HEADER_ACTION_REGISTRY,
    HEADER_ACTION_MAX,
    getHeaderActions,
    saveHeaderActions
} from "./mainWindow/headerActions.js";

/**
 * 应用自定义 CSS 样式
 * @param {string} cssText - CSS 代码
 */
export function applyCustomCSS(cssText) {
    let styleEl = document.getElementById('t-custom-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 't-custom-style';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = cssText || "";
}

/**
 * 应用字体设置
 * @param {object} fontSettings - 字体设置对象 { source, import_url, font_name, font_data }
 */
export function applyFontSettings(fontSettings) {
    if (!fontSettings) return;

    const root = document.documentElement;

    // 移除旧的字体样式
    const oldFontStyle = document.getElementById('t-custom-font-style');
    if (oldFontStyle) oldFontStyle.remove();

    // 根据来源类型处理
    if (fontSettings.source === 'default' || !fontSettings.source) {
        // 系统默认 - 移除自定义字体
        root.style.removeProperty('--t-font-global');
        return;
    }

    if (fontSettings.source === 'online') {
        // 在线字体 (@import)
        if (fontSettings.import_url && fontSettings.font_name) {
            // 注入 @import 样式
            const styleEl = document.createElement('style');
            styleEl.id = 't-custom-font-style';
            styleEl.textContent = `@import url('${fontSettings.import_url}');`;
            document.head.appendChild(styleEl);

            // 设置字体变量
            root.style.setProperty('--t-font-global', `'${fontSettings.font_name}', -apple-system, BlinkMacSystemFont, sans-serif`);
        }
        return;
    }

    if (fontSettings.source === 'upload') {
        // 上传字体
        if (fontSettings.font_data) {
            // 创建 @font-face
            const fontName = fontSettings.font_name || 'TitaniaCustomFont';
            const styleEl = document.createElement('style');
            styleEl.id = 't-custom-font-style';
            styleEl.textContent = `
                @font-face {
                    font-family: '${fontName}';
                    src: url('${fontSettings.font_data}') format('woff2');
                    font-weight: normal;
                    font-style: normal;
                    font-display: swap;
                }
            `;
            document.head.appendChild(styleEl);

            // 设置字体变量
            root.style.setProperty('--t-font-global', `'${fontName}', -apple-system, BlinkMacSystemFont, sans-serif`);
        }
        return;
    }
}

export function openSettingsWindow() {
    const data = getExtData();
    const cfg = data.config || {};
    // 默认外观配置
    const app = data.appearance || {};
    // 主界面布局偏好 (modern | legacy)
    const mainWindowMode = data.ui_prefs?.main_window_mode === "legacy" ? "legacy" : "modern";
    // 自定义 CSS (兼容旧格式迁移)
    const customCSS = data.custom_css || "";

    // CSS 主题方案配置
    const cssThemes = data.css_themes || {
        profiles: [{ id: "default", name: "默认主题", css: customCSS }],
        active_profile_id: "default"
    };
    // 如果旧格式有 CSS 但新格式为空，迁移数据
    if (customCSS && cssThemes.profiles.length === 1 && !cssThemes.profiles[0].css) {
        cssThemes.profiles[0].css = customCSS;
    }
    // 字体设置 (新格式)
    const fontSettings = data.font_settings || {
        source: "default",  // "default" | "online" | "upload"
        import_url: "",
        font_name: "",
        font_data: "",      // base64 字体数据 (上传时使用)
        force_override: false // 是否强制覆盖内联样式
    };
    app.type = app.type || "emoji";
    app.content = app.content || "🎭";
    app.size = app.size || 56;
    app.animation = app.animation || "rainbow";
    const dirCfg = data.director || { length: "", perspective: "auto", style_ref: "" };

    // 文笔参考方案配置
    const styleProfiles = data.style_profiles || [
        { id: "default", name: "默认 (无)", content: "" }
    ];
    const activeStyleId = data.active_style_id || "default";

    // 边框颜色和背景颜色默认值
    if (!app.border_color) app.border_color = "#90cdf4";
    if (!app.bg_color) app.bg_color = "#2b2b2b";
    // 透明度默认值 (0-100)
    if (app.border_opacity === undefined) app.border_opacity = 100;
    if (app.bg_opacity === undefined) app.bg_opacity = 100;

    const normalizedApiConfig = ensureMainApiProfiles(cfg);
    cfg.profiles = normalizedApiConfig.profiles;
    cfg.active_profile_id = normalizedApiConfig.active_profile_id;

    // 深度拷贝临时数据 (用于编辑，不直接修改原始数据)
    let tempProfiles = JSON.parse(JSON.stringify(cfg.profiles));
    let tempActiveId = cfg.active_profile_id;
    let tempApp = JSON.parse(JSON.stringify(app));
    if (!tempApp.size) tempApp.size = 56;
    if (!tempApp.border_color) tempApp.border_color = "#90cdf4";
    if (!tempApp.bg_color) tempApp.bg_color = "#2b2b2b";
    if (tempApp.border_opacity === undefined) tempApp.border_opacity = 100;
    if (tempApp.bg_opacity === undefined) tempApp.bg_opacity = 100;
    if (tempApp.ui_font_scale === undefined) tempApp.ui_font_scale = 100;

    // 旧配置兼容：内容是图片 data URI 时，自动纠正为 image 类型
    const isTempAppImageData = typeof tempApp.content === 'string' && tempApp.content.trim().toLowerCase().startsWith("data:image/");
    if (isTempAppImageData) {
        tempApp.type = 'image';
    }

    // 文笔方案临时数据
    let tempStyleProfiles = JSON.parse(JSON.stringify(styleProfiles));
    let tempActiveStyleId = activeStyleId;
    let styleContentModified = false; // 跟踪是否有未保存的修改

    ensurePromptManager(data);
    let tempPromptManager = JSON.parse(JSON.stringify(data.prompt_manager));

    // CSS 主题方案临时数据
    let tempCssThemes = JSON.parse(JSON.stringify(cssThemes.profiles));
    let tempActiveCssThemeId = cssThemes.active_profile_id || "default";
    let cssThemeModified = false; // 跟踪 CSS 主题是否有未保存的修改

    // 确保 overlay 容器存在（支持从悬浮球菜单直接打开）
    ensureOverlay();

    // 如果主窗口存在则隐藏，否则只打开设置
    const $mainView = $("#t-main-view");
    const hasMainView = $mainView.length > 0;
    if (hasMainView) {
        $mainView.hide();
    }

    // HTML 结构 (样式见 css/settings.css)
    const html = `
    <div class="t-box t-root" id="t-settings-view">
        <div class="t-header"><span class="t-title-main">⚙️ 设置</span><span class="t-close" id="t-set-close">&times;</span></div>
        <div class="t-set-shell-body t-set-body">
            <div class="t-set-shell-nav t-set-nav">
                <div class="t-set-shell-tab t-set-tab-btn active" data-tab="prompts">📜 提示词管理</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="data">🗂️ 剧本管理</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="connection">🔌 API 连接</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="automation">🤖 自动化</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="appearance">🎨 外观设置</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="toolbar">🛠️ 快捷工具栏</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="theme">🖌️ 主题样式</div>
                <div class="t-set-shell-tab t-set-tab-btn" data-tab="director">🎬 导演模式</div>
            </div>

            <div class="t-set-shell-content t-set-content">
                <!-- Tab 5: 外观 -->
                <div id="page-appearance" class="t-set-page">
                    <div class="t-preview-container">
                        <div style="font-size:0.8em; color:var(--t-color-text-faint); margin-bottom:15px;">动画效果预览</div>
                        <div id="p-ball" class="t-preview-ball"></div>
                        <div style="display:flex; gap:10px; margin-top:20px;">
                            <button class="t-tool-btn" id="btn-test-anim">▶️ 播放动画</button>
                            <button class="t-tool-btn" id="btn-test-notify">🔔 通知效果</button>
                        </div>
                    </div>
                    
                    <div class="t-form-group">
                        <label class="t-form-label">🎬 加载动画效果</label>
                        <div class="t-anim-grid" id="p-anim-grid">
                            <div class="t-anim-option ${tempApp.animation === 'ripple' ? 'active' : ''}" data-anim="ripple">
                                <div class="t-anim-icon">🌊</div>
                                <div class="t-anim-name">脉冲波纹</div>
                            </div>
                            <div class="t-anim-option ${tempApp.animation === 'arc' ? 'active' : ''}" data-anim="arc">
                                <div class="t-anim-icon">⚡</div>
                                <div class="t-anim-name">电磁闪烁</div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="t-form-group">
                        <label class="t-form-label">🎨 球体边框颜色</label>
                        <div style="display:flex; align-items:center; gap:15px;">
                            <input type="color" id="p-border-color" value="${tempApp.border_color}" style="width:50px; height:35px; border:none; cursor:pointer; background:transparent;">
                            <input type="text" id="p-border-color-text" class="t-input" value="${tempApp.border_color}" style="width:100px; font-family:monospace;">
                            <div style="display:flex; gap:8px;">
                                <span class="t-color-preset" data-color="#90cdf4" style="width:24px; height:24px; border-radius:50%; background:#90cdf4; cursor:pointer; border:2px solid transparent;" title="天蓝"></span>
                                <span class="t-color-preset" data-color="#a29bfe" style="width:24px; height:24px; border-radius:50%; background:#a29bfe; cursor:pointer; border:2px solid transparent;" title="紫罗兰"></span>
                                <span class="t-color-preset" data-color="#55efc4" style="width:24px; height:24px; border-radius:50%; background:#55efc4; cursor:pointer; border:2px solid transparent;" title="薄荷绿"></span>
                                <span class="t-color-preset" data-color="#ffd93d" style="width:24px; height:24px; border-radius:50%; background:#ffd93d; cursor:pointer; border:2px solid transparent;" title="金黄"></span>
                                <span class="t-color-preset" data-color="#ff6b6b" style="width:24px; height:24px; border-radius:50%; background:#ff6b6b; cursor:pointer; border:2px solid transparent;" title="珊瑚红"></span>
                                <span class="t-color-preset" data-color="#fd79a8" style="width:24px; height:24px; border-radius:50%; background:#fd79a8; cursor:pointer; border:2px solid transparent;" title="粉红"></span>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
                            <span style="font-size:0.85em; color:var(--t-color-text-muted); min-width:60px;">透明度:</span>
                            <input type="range" id="p-border-opacity" min="0" max="100" step="5" value="${tempApp.border_opacity}" style="flex:1;">
                            <span id="p-border-opacity-val" style="font-size:0.85em; color:var(--t-color-brand); min-width:40px;">${tempApp.border_opacity}%</span>
                        </div>
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:8px;">此颜色将应用于悬浮球边框及动画效果</p>
                    </div>
                    
                    <div class="t-form-group">
                        <label class="t-form-label">🖌️ 球体背景颜色</label>
                        <div style="display:flex; align-items:center; gap:15px;">
                            <input type="color" id="p-bg-color" value="${tempApp.bg_color}" style="width:50px; height:35px; border:none; cursor:pointer; background:transparent;">
                            <input type="text" id="p-bg-color-text" class="t-input" value="${tempApp.bg_color}" style="width:100px; font-family:monospace;">
                            <div style="display:flex; gap:8px;">
                                <span class="t-bg-preset" data-color="#2b2b2b" style="width:24px; height:24px; border-radius:50%; background:#2b2b2b; cursor:pointer; border:2px solid transparent;" title="深灰 (默认)"></span>
                                <span class="t-bg-preset" data-color="#1a1a2e" style="width:24px; height:24px; border-radius:50%; background:#1a1a2e; cursor:pointer; border:2px solid transparent;" title="深蓝"></span>
                                <span class="t-bg-preset" data-color="#16213e" style="width:24px; height:24px; border-radius:50%; background:#16213e; cursor:pointer; border:2px solid transparent;" title="藏青"></span>
                                <span class="t-bg-preset" data-color="#1e272e" style="width:24px; height:24px; border-radius:50%; background:#1e272e; cursor:pointer; border:2px solid transparent;" title="炭黑"></span>
                                <span class="t-bg-preset" data-color="#2d132c" style="width:24px; height:24px; border-radius:50%; background:#2d132c; cursor:pointer; border:2px solid transparent;" title="深紫"></span>
                                <span class="t-bg-preset" data-color="#0a3d62" style="width:24px; height:24px; border-radius:50%; background:#0a3d62; cursor:pointer; border:2px solid transparent;" title="海蓝"></span>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
                            <span style="font-size:0.85em; color:var(--t-color-text-muted); min-width:60px;">透明度:</span>
                            <input type="range" id="p-bg-opacity" min="0" max="100" step="5" value="${tempApp.bg_opacity}" style="flex:1;">
                            <span id="p-bg-opacity-val" style="font-size:0.85em; color:var(--t-color-brand); min-width:40px;">${tempApp.bg_opacity}%</span>
                        </div>
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:8px;">球体的背景填充颜色（透明度为0时完全透明）</p>
                    </div>
                    
                    <div class="t-form-group">
                        <div class="t-form-label" style="display:flex; justify-content:space-between;"><span>悬浮球尺寸</span><span id="p-size-val" style="color:var(--t-color-brand);">${tempApp.size}px</span></div>
                        <input type="range" id="p-size-input" min="40" max="100" step="2" value="${tempApp.size}" style="width:100%;">
                    </div>

                    <div class="t-form-group">
                        <div class="t-form-label" style="display:flex; justify-content:space-between;"><span>UI 字体大小</span><span id="p-ui-font-scale-val" style="color:var(--t-color-brand);">${tempApp.ui_font_scale}%</span></div>
                        <input type="range" id="p-ui-font-scale" min="80" max="130" step="5" value="${tempApp.ui_font_scale}" style="width:100%;">
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:6px;">影响插件全部界面字体（不影响内容区渲染文本）。</p>
                    </div>
                    
                    <div class="t-form-group">
                        <label class="t-form-label">图标类型</label>
                        <div style="display:flex; gap:20px; margin-bottom:15px;">
                            <label><input type="radio" name="p-type" value="emoji" ${tempApp.type === 'emoji' ? 'checked' : ''}> Emoji 表情</label>
                            <label><input type="radio" name="p-type" value="image" ${tempApp.type === 'image' ? 'checked' : ''}> 自定义图片</label>
                        </div>
                        <div id="box-emoji" style="display:${tempApp.type === 'emoji' ? 'block' : 'none'}">
                            <input id="p-emoji-input" class="t-input" value="${tempApp.type === 'emoji' ? tempApp.content : '🎭'}" style="width:100px; text-align:center; font-size:1.5em;">
                        </div>
                        <div id="box-image" style="display:${tempApp.type === 'image' ? 'block' : 'none'}">
                            <input type="file" id="p-file-input" accept="image/*" style="display:none;">
                            <div class="t-upload-card" id="btn-upload-card" title="点击更换图片"><i class="fa-solid fa-camera fa-2x"></i><span>点击上传</span></div>
                        </div>
                    </div>
                    
                    <div class="t-form-group" style="margin-top:15px; padding-top:15px; border-top:1px solid var(--t-color-border);">
                        <label style="cursor:pointer; display:flex; align-items:center;">
                            <input type="checkbox" id="p-show-timer" ${tempApp.show_timer !== false ? 'checked' : ''} style="margin-right:10px;">
                            <span style="color:var(--t-color-text-label);">⏱️ 显示生成计时统计</span>
                        </label>
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:5px; margin-left:22px;">生成时在悬浮球上方显示耗时</p>
                    </div>

                    <div class="t-form-group" style="margin-top:15px; padding-top:15px; border-top:1px solid var(--t-color-border);">
                        <label style="color:var(--t-color-text-label); display:block; margin-bottom:8px;">🎭 小剧场主界面</label>
                        <select id="p-main-window-mode" class="t-input">
                            <option value="modern" ${mainWindowMode !== 'legacy' ? 'selected' : ''}>新版（工具箱 + 常驻续写栏）</option>
                            <option value="legacy" ${mainWindowMode === 'legacy' ? 'selected' : ''}>经典版（双演绎按钮 + 工具网格）</option>
                        </select>
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:6px;">两版功能完全相同，仅布局不同。切换后需重新打开小剧场生效。</p>
                    </div>

                    <div class="t-form-group" style="margin-top:15px; padding-top:15px; border-top:1px solid var(--t-color-border);">
                        <label style="color:var(--t-color-text-label); display:block; margin-bottom:8px;">🎨 标题栏图标 <span id="p-header-actions-count" class="t-header-action-count"></span></label>
                        <div id="p-header-actions" class="t-header-action-list"></div>
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:6px;">勾选要常驻标题栏的功能（最多 ${HEADER_ACTION_MAX} 个），拖动可调整顺序。没选中的会收进标题栏的「更多」菜单。改动立即生效。</p>
                    </div>
                </div>

                <!-- Tab 6: 快捷工具栏 -->
                <div id="page-toolbar" class="t-set-page">
                    <div style="background:#181818; padding:15px; border-radius:6px; border:1px solid var(--t-color-border); margin-bottom:20px;">
                        <div style="font-weight:bold; color:var(--t-color-brand); margin-bottom:10px;"><i class="fa-solid fa-wand-magic-sparkles"></i> 快捷工具栏</div>
                        <div style="font-size:0.85em; color:var(--t-color-text-muted); line-height:1.6;">
                            启用后，点击悬浮球将展开快捷菜单而非直接打开主窗口。<br>
                            你可以自定义菜单中显示哪些功能按钮。
                        </div>
                    </div>
                    
                    <div class="t-form-group">
                        <label style="cursor:pointer; display:flex; align-items:center; color:#55efc4; font-weight:bold;">
                            <input type="checkbox" id="cfg-toolbar-enabled" ${(data.quick_toolbar?.enabled) ? 'checked' : ''} style="margin-right:10px;">
                            启用快捷工具栏
                        </label>
                        <p style="font-size:0.8em; color:var(--t-color-text-faint); margin-top:5px; margin-left:22px;">
                            禁用时，点击悬浮球将直接打开主窗口
                        </p>
                    </div>
                    
                    <div id="toolbar-settings-panel" style="display:${(data.quick_toolbar?.enabled) ? 'block' : 'none'}; margin-top:20px; padding-top:20px; border-top:1px solid var(--t-color-border);">
                        <div class="t-form-group">
                            <label class="t-form-label">可用按钮</label>
                            <p style="font-size:0.8em; color:var(--t-color-text-muted); margin-bottom:15px;">
                                勾选要显示的功能按钮（最多5个）
                            </p>
                            <div class="t-toolbar-config" id="t-toolbar-config">
                                <label class="t-toolbar-item">
                                    <input type="checkbox" class="t-toolbar-chk t-choice-input t-choice-input--brand t-choice-input--lg t-choice-input--muted-disabled" data-btn-id="main" checked disabled>
                                    <i class="fa-solid fa-masks-theater" style="color:#74b9ff;"></i>
                                    <span>打开剧场</span>
                                    <span class="t-toolbar-hint">(必选)</span>
                                </label>
                                <label class="t-toolbar-item">
                                    <input type="checkbox" class="t-toolbar-chk t-choice-input t-choice-input--brand t-choice-input--lg t-choice-input--muted-disabled" data-btn-id="settings">
                                    <i class="fa-solid fa-gear" style="color:var(--t-color-text-secondary);"></i>
                                    <span>设置</span>
                                </label>
                                <label class="t-toolbar-item">
                                    <input type="checkbox" class="t-toolbar-chk t-choice-input t-choice-input--brand t-choice-input--lg t-choice-input--muted-disabled" data-btn-id="favs">
                                    <i class="fa-solid fa-star" style="color:#ffd93d;"></i>
                                    <span>收藏夹</span>
                                </label>
                                <label class="t-toolbar-item">
                                    <input type="checkbox" class="t-toolbar-chk t-choice-input t-choice-input--brand t-choice-input--lg t-choice-input--muted-disabled" data-btn-id="scripts">
                                    <i class="fa-solid fa-scroll" style="color:var(--t-color-brand);"></i>
                                    <span>剧本管理</span>
                                </label>
                            </div>
                            <div id="t-toolbar-count" style="font-size:0.8em; color:var(--t-color-text-faint); margin-top:10px;">
                                已选择 3 / 5 个按钮
                            </div>
                        </div>
                    </div>

                </div>

                <!-- Tab 7: 主题样式 -->
                <div id="page-theme" class="t-set-page">
                    <!-- 字体设置区域 -->
                    <div style="background:#181818; padding:15px; border-radius:6px; border:1px solid var(--t-color-border); margin-bottom:20px;">
                        <div style="font-weight:bold; color:var(--t-color-accent); margin-bottom:15px;"><i class="fa-solid fa-font"></i> 全局字体设置</div>
                        <p style="font-size:0.85em; color:var(--t-color-text-muted); margin-bottom:15px;">
                            自定义插件 UI 和渲染内容的字体。<br>
                            <span style="color:var(--t-color-text-faint);">注：代码编辑器和日志保持等宽字体不受影响。</span>
                        </p>
                        
                        <div class="t-form-group" style="margin-bottom:15px;">
                            <label class="t-form-label">字体来源</label>
                            <div style="display:flex; flex-direction:column; gap:10px;">
                                <label style="cursor:pointer; display:flex; align-items:center; padding:10px; background:#222; border-radius:6px; border:2px solid ${fontSettings.source === 'default' || !fontSettings.source ? 'var(--t-color-brand)' : 'var(--t-color-border)'};" data-font-source="default">
                                    <input type="radio" name="t-font-source" value="default" ${fontSettings.source === 'default' || !fontSettings.source ? 'checked' : ''} style="margin-right:12px;">
                                    <div>
                                        <div style="color:var(--t-color-text); font-weight:bold;">🖥️ 系统默认</div>
                                        <div style="font-size:0.8em; color:var(--t-color-text-muted);">使用系统默认字体栈</div>
                                    </div>
                                </label>
                                <label style="cursor:pointer; display:flex; align-items:center; padding:10px; background:#222; border-radius:6px; border:2px solid ${fontSettings.source === 'online' ? 'var(--t-color-brand)' : 'var(--t-color-border)'};" data-font-source="online">
                                    <input type="radio" name="t-font-source" value="online" ${fontSettings.source === 'online' ? 'checked' : ''} style="margin-right:12px;">
                                    <div>
                                        <div style="color:var(--t-color-text); font-weight:bold;">🌐 在线字体</div>
                                        <div style="font-size:0.8em; color:var(--t-color-text-muted);">使用 Google Fonts 等在线服务</div>
                                    </div>
                                </label>
                                <label style="cursor:pointer; display:flex; align-items:center; padding:10px; background:#222; border-radius:6px; border:2px solid ${fontSettings.source === 'upload' ? 'var(--t-color-brand)' : 'var(--t-color-border)'};" data-font-source="upload">
                                    <input type="radio" name="t-font-source" value="upload" ${fontSettings.source === 'upload' ? 'checked' : ''} style="margin-right:12px;">
                                    <div>
                                        <div style="color:var(--t-color-text); font-weight:bold;">📁 上传字体</div>
                                        <div style="font-size:0.8em; color:var(--t-color-text-muted);">上传本地字体文件 (.woff2, .ttf)</div>
                                    </div>
                                </label>
                            </div>
                        </div>
                        
                        <!-- 在线字体选项 -->
                        <div id="t-font-online-options" style="display:${fontSettings.source === 'online' ? 'block' : 'none'}; background:var(--t-color-surface-sunken); padding:15px; border-radius:6px; margin-top:15px; border:1px solid var(--t-color-border);">
                            <div class="t-form-group" style="margin-bottom:15px;">
                                <label class="t-form-label">@import URL</label>
                                <input id="t-font-import-url" class="t-input" value="${fontSettings.import_url || ""}" placeholder="https://fonts.googleapis.com/css2?family=Noto+Sans+SC">
                                <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:5px;">
                                    从 <a href="https://fonts.google.com/" target="_blank" style="color:var(--t-color-accent);">Google Fonts</a> 复制 @import 中的 URL
                                </p>
                            </div>
                            <div class="t-form-group" style="margin-bottom:0;">
                                <label class="t-form-label">字体名称</label>
                                <input id="t-font-name-online" class="t-input" value="${fontSettings.source === 'online' ? (fontSettings.font_name || "") : ""}" placeholder="Noto Sans SC">
                                <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:5px;">
                                    字体的 font-family 名称，例如：Noto Sans SC, LXGW WenKai
                                </p>
                            </div>
                        </div>
                        
                        <!-- 上传字体选项 -->
                        <div id="t-font-upload-options" style="display:${fontSettings.source === 'upload' ? 'block' : 'none'}; background:var(--t-color-surface-sunken); padding:15px; border-radius:6px; margin-top:15px; border:1px solid var(--t-color-border);">
                            <div class="t-form-group" style="margin-bottom:15px;">
                                <label class="t-form-label">选择字体文件</label>
                                <input type="file" id="t-font-file-input" accept=".woff2,.woff,.ttf,.otf" style="display:none;">
                                <div style="display:flex; align-items:center; gap:10px;">
                                    <button id="btn-font-upload" class="t-tool-btn" style="padding:8px 15px;"><i class="fa-solid fa-upload"></i> 选择文件</button>
                                    <span id="t-font-file-name" style="color:var(--t-color-text-muted); font-size:0.9em;">${fontSettings.font_data ? '已上传字体文件' : '未选择文件'}</span>
                                </div>
                                <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:8px;">
                                    支持 .woff2 (推荐)、.woff、.ttf、.otf 格式<br>
                                    <span style="color:#f1c40f;">⚠️ 字体文件将以 Base64 存储，建议不超过 2MB</span>
                                </p>
                            </div>
                            <div class="t-form-group" style="margin-bottom:0;">
                                <label class="t-form-label">字体名称（可选）</label>
                                <input id="t-font-name-upload" class="t-input" value="${fontSettings.source === 'upload' ? (fontSettings.font_name || "") : ""}" placeholder="留空则自动命名为 TitaniaCustomFont">
                            </div>
                        </div>
                        
                        <!-- 强制覆盖选项 -->
                        <div id="t-font-force-section" style="display:${fontSettings.source !== 'default' ? 'block' : 'none'}; margin-top:15px; padding-top:15px; border-top:1px solid var(--t-color-border);">
                            <label style="cursor:pointer; display:flex; align-items:flex-start; gap:12px;">
                                <input type="checkbox" id="t-font-force-override" ${fontSettings.force_override ? 'checked' : ''} style="margin-top:3px;">
                                <div>
                                    <div style="color:#feca57; font-weight:bold;">⚡ 强制覆盖内联字体</div>
                                    <div style="font-size:0.8em; color:var(--t-color-text-muted); margin-top:3px;">
                                        开启后，自定义字体将使用 !important 覆盖模型生成的内联 font-family 样式。<br>
                                        <span style="color:var(--t-color-danger);">注意：这可能破坏模型刻意设计的特殊字体效果。</span>
                                    </div>
                                </div>
                            </label>
                        </div>
                        
                        <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:15px; padding-top:10px; border-top:1px solid var(--t-color-border);">
                            <button id="btn-font-reset" class="t-tool-btn" style="color:var(--t-color-danger);"><i class="fa-solid fa-rotate-left"></i> 恢复默认</button>
                        </div>
                    </div>
                    
                    <div style="background:#181818; padding:15px; border-radius:6px; border:1px solid var(--t-color-border); margin-bottom:20px;">
                        <div style="font-weight:bold; color:var(--t-color-brand); margin-bottom:10px;"><i class="fa-solid fa-palette"></i> 自定义 CSS 样式</div>
                        <div style="font-size:0.85em; color:var(--t-color-text-muted); line-height:1.6;">
                            在此输入自定义 CSS 代码，可以覆盖插件默认样式。<br>
                            作用范围：插件 UI（窗口、按钮等）和剧本渲染区域。<br>
                            <span style="color:#55efc4;">✨ 支持保存多个主题方案，随时切换！</span>
                        </div>
                    </div>
                    
                    <!-- CSS 主题方案管理 -->
                    <div class="t-form-group">
                        <label class="t-form-label">🎨 CSS 主题方案</label>
                        <div style="display:flex; gap:8px; margin-bottom:10px;">
                            <select id="t-css-theme-select" class="t-input" style="flex:1;"></select>
                            <button id="btn-css-theme-add" class="t-tool-btn" title="保存为新方案"><i class="fa-solid fa-plus"></i></button>
                            <button id="btn-css-theme-rename" class="t-tool-btn" title="重命名当前方案"><i class="fa-solid fa-pen"></i></button>
                            <button id="btn-css-theme-del" class="t-tool-btn" title="删除当前方案" style="color:var(--t-color-danger);"><i class="fa-solid fa-trash"></i></button>
                        </div>
                        <div id="css-theme-unsaved-hint" style="display:none; color:#feca57; font-size:0.8em; margin-bottom:8px;">
                            <i class="fa-solid fa-circle-exclamation"></i> 当前内容有修改，切换方案前请先保存
                        </div>
                    </div>
                    
                    <div class="t-form-group">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                            <label class="t-form-label" style="margin:0;">CSS 代码</label>
                            <div style="display:flex; gap:8px;">
                                <button id="btn-css-import" class="t-tool-btn" title="导入方案"><i class="fa-solid fa-file-import"></i> 导入</button>
                                <button id="btn-css-export" class="t-tool-btn" title="导出方案"><i class="fa-solid fa-file-export"></i> 导出</button>
                                <button id="btn-css-reset" class="t-tool-btn" title="清空内容" style="color:var(--t-color-danger);"><i class="fa-solid fa-trash"></i> 清空</button>
                            </div>
                        </div>
                        <textarea id="t-custom-css-input" class="t-input t-code-editor" rows="12" placeholder="/* 在此输入自定义 CSS */&#10;&#10;/* 例如：修改主窗口背景色 */&#10;.t-box {&#10;    background: #1a1a2e;&#10;}&#10;&#10;/* 修改标题颜色 */&#10;.t-title-main {&#10;    color: #ff6b6b;&#10;}"></textarea>
                        <div style="display:flex; justify-content:space-between; margin-top:8px;">
                            <span style="font-size:0.75em; color:var(--t-color-text-faint);">方案数量: <span id="css-theme-count">0</span>/10</span>
                            <span id="css-char-count" style="font-size:0.75em; color:var(--t-color-text-faint);">0 字符</span>
                        </div>
                    </div>
                    
                    <div class="t-form-group">
                        <div style="font-weight:bold; color:var(--t-color-accent); margin-bottom:10px;"><i class="fa-solid fa-lightbulb"></i> 常用选择器参考</div>
                        <div class="t-css-hints">
                            <div class="t-css-hint-item">
                                <code>.t-box</code>
                                <span>所有弹窗容器（主窗口、设置、管理器等）</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-header</code>
                                <span>弹窗标题栏</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-title-main</code>
                                <span>标题文字</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-btn</code>
                                <span>按钮基础样式</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-btn.primary</code>
                                <span>主要按钮（金色）</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-input</code>
                                <span>输入框、下拉框、文本域</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>#t-output-content</code>
                                <span>剧本渲染区域容器</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>#titania-float-btn</code>
                                <span>悬浮球</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-mgr-item</code>
                                <span>剧本管理器列表项</span>
                            </div>
                            <div class="t-css-hint-item">
                                <code>.t-fav-item</code>
                                <span>收藏列表项</span>
                            </div>
                        </div>
                    </div>
                    
                    <input type="file" id="t-css-file-input" accept=".json" style="display:none;">
                </div>

                <!-- Tab 3: 连接 -->
                <div id="page-connection" class="t-set-page">
                    ${renderApiConnectionEditorHTML({
                        ids: {
                            profileSelectId: "cfg-prof-select",
                            profileAddId: "cfg-prof-add",
                            profileDeleteId: "cfg-prof-del",
                            profileNameId: "cfg-prof-name",
                            profileMetaId: "cfg-prof-meta",
                            profileTipId: "cfg-prof-tip",
                            fieldsWrapId: "cfg-conn-fields",
                            apiUrlId: "cfg-url",
                            apiKeyId: "cfg-key",
                            modelId: "cfg-model",
                            modelModeId: "cfg-model-mode",
                            modelInputId: "cfg-model-input",
                            modelListWrapId: "cfg-model-list-wrap",
                            modelManualWrapId: "cfg-model-manual-wrap",
                            fetchModelsId: "t-btn-fetch",
                            statusId: "cfg-status",
                            urlHintId: "cfg-url-hint",
                            stUrlDisplayId: "st-url-display",
                            streamId: "cfg-stream",
                            maxTokensId: "cfg-max-tokens",
                        },
                        classes: {
                            profileSelect: "t-prof-select",
                            button: "t-tool-btn",
                            input: "t-input",
                            select: "t-input",
                        },
                        labels: {
                            profile: "切换配置方案 (Profile)",
                            apiUrl: "API Endpoint URL",
                            model: "Model Name",
                            maxTokens: "🎯 输出 Token 限制 (max_tokens)",
                        },
                        flags: {
                            showProfileName: true,
                            showDeleteProfile: true,
                            showStream: true,
                            showMaxTokens: true,
                            showManualModelInput: true,
                        },
                        values: {
                            stream: cfg.stream !== false,
                            maxTokens: cfg.max_tokens || 4096,
                            statusText: "填写 API 后可刷新模型列表",
                            maxTokensHintHtml: `<p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:5px; line-height:1.5;">
                            控制 AI 单次输出的最大 Token 数量。<br>
                            <span style="color:#55efc4;">✓ 仅对自定义 API 方案生效</span>，ST 主连接使用全局设置。<br>
                            <span style="color:#feca57;">⚠️ 设置过高可能超出模型限制导致报错</span>
                        </p>`,
                        },
                    })}
                </div>

                <!-- Tab 8: 导演模式 -->
                <div id="page-director" class="t-set-page">
                    <div style="background:#181818; padding:15px; border-radius:6px; border:1px solid var(--t-color-border); margin-bottom:20px; color:var(--t-color-text-muted); font-size:0.9em;">
                        <i class="fa-solid fa-circle-info"></i> 自定义导演指令，用于控制生成内容的风格、篇幅、视角等。支持变量：<code style="background:var(--t-color-surface-code); padding:2px 5px; border-radius:3px;">{{char}}</code> 角色名、<code style="background:var(--t-color-surface-code); padding:2px 5px; border-radius:3px;">{{user}}</code> 用户名
                    </div>
                    
                    <div class="t-form-group">
                        <label class="t-form-label">🎬 导演指令 (自由编辑)</label>
                        <textarea id="set-dir-instruction" class="t-input" rows="5" placeholder="例如：&#10;- 篇幅控制在300字左右&#10;- 使用第一人称叙事&#10;- 多描写内心活动和环境氛围&#10;- 语言风格偏向诗意文艺">${dirCfg.instruction || ""}</textarea>
                        <div style="display:flex; justify-content:space-between; margin-top:5px;">
                            <span style="font-size:0.75em; color:var(--t-color-text-faint);">此指令将作为 [Director Instructions] 添加到 Prompt 中</span>
                            <span id="dir-char-count" style="font-size:0.75em; color:var(--t-color-text-faint);">0/500</span>
                        </div>
                    </div>
                    
                    <!-- 文笔参考方案管理 -->
                    <div class="t-form-group">
                        <label class="t-form-label">📝 文笔参考方案</label>
                        <div style="display:flex; gap:8px; margin-bottom:10px;">
                            <select id="set-style-select" class="t-input" style="flex:1;"></select>
                            <button id="btn-style-add" class="t-tool-btn" title="保存为新方案"><i class="fa-solid fa-plus"></i></button>
                            <button id="btn-style-rename" class="t-tool-btn" title="重命名当前方案"><i class="fa-solid fa-pen"></i></button>
                            <button id="btn-style-del" class="t-tool-btn" title="删除当前方案" style="color:var(--t-color-danger);"><i class="fa-solid fa-trash"></i></button>
                        </div>
                        <div id="style-unsaved-hint" style="display:none; color:#feca57; font-size:0.8em; margin-bottom:8px;">
                            <i class="fa-solid fa-circle-exclamation"></i> 当前内容有修改，切换方案前请先保存
                        </div>
                        <textarea id="set-dir-style" class="t-input" rows="6" placeholder="粘贴你喜欢的文笔段落...（最多1000字）" maxlength="1000"></textarea>
                        <div style="display:flex; justify-content:space-between; margin-top:5px;">
                            <span style="font-size:0.75em; color:var(--t-color-text-faint);">方案数量: <span id="style-count">0</span>/10</span>
                            <span id="style-char-count" style="font-size:0.75em; color:var(--t-color-text-faint);">0/1000</span>
                        </div>
                    </div>
                </div>

                <!-- Tab 4: 自动化 -->
                <div id="page-automation" class="t-set-page">
                    <div class="t-form-group">
                        <label style="cursor:pointer; display:flex; align-items:center; color:var(--t-color-brand); font-weight:bold;">
                            <input type="checkbox" id="cfg-auto" ${cfg.auto_generate ? 'checked' : ''} style="margin-right:10px;">
                            开启后台自动演绎
                        </label>
                        <p style="font-size:0.8em; color:var(--t-color-text-faint); margin-top:5px; margin-left:22px;">当检测到群聊消息且不是用户发送时，有概率自动触发。</p>
                    </div>
                    <div id="auto-settings-panel" style="display:${cfg.auto_generate ? 'block' : 'none'}; padding-left:22px;">
                        <div class="t-form-group">
                            <label class="t-form-label">触发概率: <span id="cfg-chance-val">${cfg.auto_chance || 50}%</span></label>
                            <input type="range" id="cfg-chance" min="10" max="100" step="10" value="${cfg.auto_chance || 50}" style="width:100%;">
                        </div>
                        <div class="t-form-group">
                            <label class="t-form-label">抽取策略</label>
                            <select id="cfg-auto-mode" class="t-input">
                                <option value="random" ${(cfg.auto_mode || 'random') === 'random' ? 'selected' : ''}>🎲 随机抽取全部剧本 (默认)</option>
                                <option value="category" ${(cfg.auto_mode || 'random') === 'category' ? 'selected' : ''}>🎯 指定分类白名单 (自定义)</option>
                            </select>
                        </div>
                        <div id="auto-cat-container" style="display:none; background:#181818; padding:10px; border:1px solid var(--t-color-border); border-radius:6px; margin-top:10px;">
                            <div style="font-size:0.8em; color:var(--t-color-text-muted); margin-bottom:8px;">请勾选允许随机抽取的分类 (多选):</div>
                            <div id="auto-cat-list" style="max-height:150px; overflow-y:auto; display:flex; flex-direction:column; gap:5px;"></div>
                        </div>
                    </div>
                    
                    <!-- 自动续写功能 -->
                    <div style="margin-top:25px; border-top:1px solid var(--t-color-border); padding-top:20px;">
                        <div class="t-form-group">
                            <label style="cursor:pointer; display:flex; align-items:center; color:var(--t-color-accent); font-weight:bold;">
                                <input type="checkbox" id="cfg-auto-continue" ${(data.auto_continue?.enabled) ? 'checked' : ''} style="margin-right:10px;">
                                🔄 开启自动续写 (应对 API 超时截断)
                            </label>
                            <p style="font-size:0.8em; color:var(--t-color-text-faint); margin-top:5px; margin-left:22px;">
                                当检测到生成内容被截断时，自动发送续写请求拼接完整内容。
                            </p>
                        </div>
                        <div id="auto-continue-panel" style="display:${(data.auto_continue?.enabled) ? 'block' : 'none'}; padding-left:22px; background:#181818; border:1px solid var(--t-color-border); border-radius:6px; padding:15px; margin-top:10px;">
                            <div class="t-form-group">
                                <label class="t-form-label">最大续写次数</label>
                                <select id="cfg-continue-retries" class="t-input" style="width:120px;">
                                    <option value="1" ${(data.auto_continue?.max_retries || 2) === 1 ? 'selected' : ''}>1 次</option>
                                    <option value="2" ${(data.auto_continue?.max_retries || 2) === 2 ? 'selected' : ''}>2 次 (推荐)</option>
                                    <option value="3" ${(data.auto_continue?.max_retries || 2) === 3 ? 'selected' : ''}>3 次</option>
                                    <option value="5" ${(data.auto_continue?.max_retries || 2) === 5 ? 'selected' : ''}>5 次</option>
                                </select>
                                <p style="font-size:0.75em; color:#555; margin-top:5px;">超过此次数后将停止续写，显示已获取的内容。</p>
                            </div>
                            <div class="t-form-group">
                                <label class="t-form-label">截断检测模式</label>
                                <select id="cfg-continue-mode" class="t-input">
                                    <option value="html" ${(data.auto_continue?.detection_mode || 'html') === 'html' ? 'selected' : ''}>🏷️ HTML 标签检测 (推荐)</option>
                                    <option value="sentence" ${(data.auto_continue?.detection_mode || 'html') === 'sentence' ? 'selected' : ''}>📝 句子完整性检测</option>
                                    <option value="both" ${(data.auto_continue?.detection_mode || 'html') === 'both' ? 'selected' : ''}>🔍 双重检测 (更严格)</option>
                                </select>
                                <p style="font-size:0.75em; color:#555; margin-top:5px;">
                                    HTML 检测：检查标签是否闭合<br>
                                    句子检测：检查是否以完整句子结束
                                </p>
                            </div>
                            <div class="t-form-group" style="margin-bottom:0;">
                                <label style="cursor:pointer; display:flex; align-items:center;">
                                    <input type="checkbox" id="cfg-continue-indicator" ${(data.auto_continue?.show_indicator !== false) ? 'checked' : ''} style="margin-right:10px;">
                                    <span style="color:var(--t-color-text-label);">在内容中显示续写连接标记</span>
                                </label>
                            </div>
                        </div>
                    </div>
                    
                    <div class="t-form-group" style="margin-top:20px; border-top:1px solid var(--t-color-border); padding-top:15px;">
                        <label class="t-form-label">历史读取行数 (开启「读取聊天历史」时生效)</label>
                        <input type="number" id="cfg-history" class="t-input" value="${cfg.history_limit || 10}">
                    </div>
                    
                    <!-- 聊天历史提取白名单 -->
                    <div class="t-form-group" style="margin-top:15px;">
                        <label class="t-form-label">📝 聊天历史提取标签 (白名单)</label>
                        <input type="text" id="cfg-history-whitelist" class="t-input" value="${data.history_extraction?.whitelist || ""}" placeholder="例如: content, dialogue, narration">
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:5px; line-height:1.5;">
                            用逗号分隔多个标签名。只提取这些标签内的文本作为历史上下文。<br>
                            <span style="color:var(--t-color-text-muted);">留空则全文提取（移除所有 HTML 标签后的纯文本）</span><br>
                            <span style="color:#55efc4;">示例：填写 <code style="background:var(--t-color-surface-code); padding:1px 4px; border-radius:2px;">content</code> 则只提取 <code style="background:var(--t-color-surface-code); padding:1px 4px; border-radius:2px;">&lt;content&gt;...&lt;/content&gt;</code> 中的内容</span>
                        </p>
                    </div>

                    <!-- 聊天历史提取黑名单 -->
                    <div class="t-form-group" style="margin-top:15px;">
                        <label class="t-form-label">🚫 聊天历史排除标签 (黑名单)</label>
                        <textarea id="cfg-history-blacklist" class="t-input" rows="4" placeholder="每行一条规则，格式：开始标记 结束标记;&#10;例如：&#10;&lt;thinking&gt; &lt;/thinking&gt;;&#10;image### ###image;&#10;必须填写完整的成对标记，中间保留空格，行末使用英文分号。">${data.history_extraction?.blacklist || ""}</textarea>
                        <p style="font-size:0.75em; color:var(--t-color-text-faint); margin-top:5px; line-height:1.5;">
                            读取聊天历史前删除这些成对标记及其中的内容。每行一条规则，标记之间必须有空格，规则末尾必须使用英文分号 <code style="background:var(--t-color-surface-code); padding:1px 4px; border-radius:2px;">;</code>。
                        </p>
                    </div>
                </div>

                <!-- Tab 1: 提示词管理 -->
                <div id="page-prompts" class="t-set-page active">
                    <div style="background:#181818; padding:15px; border-radius:6px; border:1px solid var(--t-color-border); margin-bottom:20px;">
                        <div style="font-weight:bold; color:var(--t-color-accent); margin-bottom:8px;"><i class="fa-solid fa-list-check"></i> 提示词管理</div>
                        <div style="font-size:0.85em; color:var(--t-color-text-muted); line-height:1.6;">管理内置提示词方案和导入的 SillyTavern Chat Completion 预设。主界面的“选用预设”使用当前活动预设。</div>
                    </div>
                    <div class="t-form-group" style="background:#181818; padding:15px; border:1px solid var(--t-color-border); border-radius:6px;">
                        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                            <label class="t-form-label" style="margin:0;">查看方案</label>
                            <select id="t-prompt-view" class="t-input" style="width:auto; min-width:150px;">
                                <option value="narrative">内容优先</option>
                                <option value="visual">氛围美化</option>
                                <option value="preset">用户预设</option>
                            </select>
                            <select id="t-prompt-preset-select" class="t-input" style="width:auto; min-width:210px; display:none;"></select>
                            <button id="t-prompt-import" class="t-tool-btn" title="导入 SillyTavern Chat Completion 预设"><i class="fa-solid fa-file-import"></i> 导入预设</button>
                            <button id="t-prompt-delete" class="t-tool-btn" title="删除当前预设" style="display:none;"><i class="fa-solid fa-trash"></i> 删除</button>
                            <button id="t-prompt-reset-builtin" class="t-tool-btn" title="恢复当前内置方案默认值" style="display:none;"><i class="fa-solid fa-rotate-left"></i> 恢复默认</button>
                            <input type="file" id="t-prompt-file" accept=".json,application/json" style="display:none;">
                        </div>
                        <div id="t-prompt-entry-list" class="t-prompt-entry-list" style="margin-top:15px;"></div>
                    </div>
                </div>

                <!-- Tab 2: 数据管理 -->
                <div id="page-data" class="t-set-page">
                    <div class="t-form-group">
                        <div class="t-form-label">自定义剧本库</div>
                        <div style="background:#181818; border:1px solid var(--t-color-border); padding:20px; border-radius:6px; display:flex; align-items:center; justify-content:space-between;">
                            <div>
                                <div style="font-size:1.1em; color:var(--t-color-text); font-weight:bold;"><i class="fa-solid fa-scroll" style="color:var(--t-color-brand); margin-right:8px;"></i>剧本管理器</div>
                                <div style="font-size:0.85em; color:#777; margin-top:5px;">当前拥有自定义剧本: ${(data.user_scripts || []).length} 个</div>
                            </div>
                            <button id="btn-open-mgr" class="t-btn primary" style="padding: 8px 20px;"><i class="fa-solid fa-list-check"></i> 打开管理</button>
                        </div>
                    </div>
                    <div class="t-form-group">
                        <div class="t-form-label">已隐藏的官方预设剧本</div>
                        <div style="background:#181818; border:1px solid var(--t-color-border); padding:15px; border-radius:6px; display:flex; align-items:center; justify-content:space-between;">
                            <div><div style="font-size:1.1em; color:var(--t-color-text);">共 ${(data.disabled_presets || []).length} 个</div><div style="font-size:0.8em; color:var(--t-color-text-faint);">这些预设在列表中已被隐藏</div></div>
                            <button id="btn-restore-presets" class="t-btn" style="border:1px solid #555;" ${(data.disabled_presets || []).length === 0 ? 'disabled' : ''}>♻️ 恢复所有</button>
                        </div>
                    </div>
                </div>
                
            </div>
        </div>
        <div style="padding:15px; background:#181818; border-top:1px solid var(--t-color-border); display:flex; justify-content:flex-end;">
            <button id="t-set-save" class="t-btn primary" style="padding:0 30px;">💾 保存所有配置</button>
        </div>
    </div>`;

    $("#t-overlay").append(html);
    // src/ui/settingsWindow.js (Part 2/2)

    const mainConnectionEditor = createApiConnectionEditor({
        root: $("#t-settings-view"),
        ids: {
            profileSelectId: "cfg-prof-select",
            profileAddId: "cfg-prof-add",
            profileDeleteId: "cfg-prof-del",
            profileNameId: "cfg-prof-name",
            profileTipId: "cfg-prof-tip",
            apiUrlId: "cfg-url",
            apiKeyId: "cfg-key",
            modelId: "cfg-model",
            modelModeId: "cfg-model-mode",
            modelInputId: "cfg-model-input",
            modelListWrapId: "cfg-model-list-wrap",
            modelManualWrapId: "cfg-model-manual-wrap",
            fetchModelsId: "t-btn-fetch",
            statusId: "cfg-status",
            urlHintId: "cfg-url-hint",
            stUrlDisplayId: "st-url-display",
        },
        profiles: tempProfiles,
        activeProfileId: tempActiveId,
        showManualModelInput: true,
        autoFetchOnInput: false,
        autoFetchOnProfileSwitch: false,
        getInternalUrl: () => (typeof settings !== 'undefined' ? (settings.api_url_openai || "未知") : "未知"),
        onChange: (nextState) => {
            tempProfiles = nextState.profiles;
            tempActiveId = nextState.activeProfileId;
        },
    });
    mainConnectionEditor.bind();

    // --- Tab 切换 ---
    $(".t-set-tab-btn").on("click", function () {
        const tabName = $(this).data("tab");
        $(".t-set-tab-btn").removeClass("active"); $(this).addClass("active");
        $(".t-set-page").removeClass("active"); $(`#page-${tabName}`).addClass("active");
    });

    const saveCurrentProfileToMemory = () => {
        mainConnectionEditor.persistCurrentProfileInputs();
        const nextState = mainConnectionEditor.getState();
        tempProfiles = nextState.profiles;
        tempActiveId = nextState.activeProfileId;
    };

    // --- 预览与外观 ---
    // 动画类映射 (预览用)
    const PREVIEW_ANIM_CLASSES = {
        ripple: "p-anim-ripple",
        arc: "p-anim-arc"
    };

    // 辅助函数：将 HEX 颜色转换为带透明度的 RGBA
    const hexToRgba = (hex, opacity) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) return hex;
        const r = parseInt(result[1], 16);
        const g = parseInt(result[2], 16);
        const b = parseInt(result[3], 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
    };

    const renderPreview = () => {
        const $ball = $("#p-ball");
        const size = parseInt(tempApp.size) || 56;
        const bgOpacity = tempApp.bg_opacity !== undefined ? tempApp.bg_opacity : 100;
        const borderOpacity = tempApp.border_opacity !== undefined ? tempApp.border_opacity : 100;

        const bgColor = hexToRgba(tempApp.bg_color || "#2b2b2b", bgOpacity);
        const borderColor = hexToRgba(tempApp.border_color || "#90cdf4", borderOpacity);

        $ball.css({
            width: size + "px",
            height: size + "px",
            fontSize: Math.floor(size * 0.46) + "px",
            background: bgColor,
            borderColor: borderColor
        });

        const contentStr = typeof tempApp.content === 'string' ? tempApp.content.trim() : '';
        const hasImageDataUri = contentStr.toLowerCase().startsWith("data:image/");

        if (hasImageDataUri) {
            $ball.html(`<img src="${tempApp.content}">`);
            $("#btn-upload-card").css("background-image", `url('${tempApp.content}')`).find("i, span").hide();
        } else if (tempApp.type === 'image') {
            $ball.html('<i class="fa-solid fa-image"></i>');
            $("#btn-upload-card").css("background-image", "").find("i, span").show();
        } else {
            $ball.html(tempApp.content || "🎭");
            $("#btn-upload-card").css("background-image", "").find("i, span").show();
        }
    };

    // 播放动画预览
    const playAnimationPreview = () => {
        const $ball = $("#p-ball");
        // 移除所有动画类
        $ball.removeClass("p-notify p-anim-ripple p-anim-arc");

        // 添加当前选中的动画类
        const animClass = PREVIEW_ANIM_CLASSES[tempApp.animation] || PREVIEW_ANIM_CLASSES.ripple;
        $ball.addClass(animClass);

        // 3秒后停止
        setTimeout(() => {
            $ball.removeClass(animClass);
        }, 3000);
    };

    // 动画选择事件
    $(".t-anim-option").on("click", function () {
        const anim = $(this).data("anim");
        tempApp.animation = anim;

        // 更新选中状态
        $(".t-anim-option").removeClass("active");
        $(this).addClass("active");

        // 自动播放预览
        playAnimationPreview();
    });

    $("input[name='p-type']").on("change", function () {
        tempApp.type = $(this).val();
        $("#box-emoji").toggle(tempApp.type === 'emoji');
        $("#box-image").toggle(tempApp.type === 'image');
        renderPreview();
    });
    $("#p-size-input").on("input", function () {
        tempApp.size = $(this).val();
        $("#p-size-val").text(tempApp.size + "px");
        renderPreview();
    });
    $("#p-ui-font-scale").on("input", function () {
        tempApp.ui_font_scale = parseInt($(this).val()) || 100;
        $("#p-ui-font-scale-val").text(tempApp.ui_font_scale + "%");
    });
    $("#p-emoji-input").on("input", function () {
        tempApp.content = $(this).val();
        renderPreview();
    });
    $("#btn-upload-card").on("click", () => $("#p-file-input").click());
    $("#p-file-input").on("change", async function () {
        const file = this.files[0];
        if (!file) return;
        try {
            tempApp.content = await fileToBase64(file);
            // 上传图片后自动切到图片模式，避免 data URI 被当成文本
            tempApp.type = 'image';
            $("input[name='p-type'][value='image']").prop("checked", true);
            $("#box-emoji").hide();
            $("#box-image").show();
            renderPreview();
        } catch (e) {
            alert("Fail");
        }
    });
    $("#btn-test-anim").on("click", () => playAnimationPreview());
    $("#btn-test-notify").on("click", () => {
        const $ball = $("#p-ball");
        $ball.removeClass("p-anim-ripple p-anim-arc");
        $ball.addClass("p-notify");
        setTimeout(() => $ball.removeClass("p-notify"), 3000);
    });

    // 边框颜色选择事件
    const updateBorderColorUI = (color) => {
        tempApp.border_color = color;
        $("#p-border-color").val(color);
        $("#p-border-color-text").val(color);
        $("#p-ball").css("border-color", color);
        // 更新预设按钮高亮
        $(".t-color-preset").css("border-color", "transparent");
        $(`.t-color-preset[data-color="${color}"]`).css("border-color", "#fff");
    };

    $("#p-border-color").on("input", function () {
        updateBorderColorUI($(this).val());
    });

    $("#p-border-color-text").on("change", function () {
        const val = $(this).val().trim();
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
            updateBorderColorUI(val);
        }
    });

    $(".t-color-preset").on("click", function () {
        updateBorderColorUI($(this).data("color"));
    });

    // 初始化边框颜色高亮
    $(`.t-color-preset[data-color="${tempApp.border_color}"]`).css("border-color", "#fff");

    // 背景颜色选择事件
    const updateBgColorUI = (color) => {
        tempApp.bg_color = color;
        $("#p-bg-color").val(color);
        $("#p-bg-color-text").val(color);
        $("#p-ball").css("background", color);
        // 更新预设按钮高亮
        $(".t-bg-preset").css("border-color", "transparent");
        $(`.t-bg-preset[data-color="${color}"]`).css("border-color", "#fff");
    };

    $("#p-bg-color").on("input", function () {
        updateBgColorUI($(this).val());
    });

    $("#p-bg-color-text").on("change", function () {
        const val = $(this).val().trim();
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
            updateBgColorUI(val);
        }
    });

    $(".t-bg-preset").on("click", function () {
        updateBgColorUI($(this).data("color"));
    });

    // 初始化背景颜色高亮
    $(`.t-bg-preset[data-color="${tempApp.bg_color}"]`).css("border-color", "#fff");

    // 边框透明度滑块事件
    $("#p-border-opacity").on("input", function () {
        tempApp.border_opacity = parseInt($(this).val());
        $("#p-border-opacity-val").text(tempApp.border_opacity + "%");
        renderPreview();
    });

    // 背景透明度滑块事件
    $("#p-bg-opacity").on("input", function () {
        tempApp.bg_opacity = parseInt($(this).val());
        $("#p-bg-opacity-val").text(tempApp.bg_opacity + "%");
        renderPreview();
    });

    // --- 导演指令字符计数 ---
    const updateDirCharCount = () => {
        const len = ($("#set-dir-instruction").val() || "").length;
        $("#dir-char-count").text(`${len}/500`);
        if (len > 450) {
            $("#dir-char-count").css("color", "#ff6b6b");
        } else {
            $("#dir-char-count").css("color", "#666");
        }
    };
    $("#set-dir-instruction").on("input", updateDirCharCount);
    updateDirCharCount();

    // --- 文笔参考方案逻辑 ---
    const MAX_STYLE_PROFILES = 10;

    const renderStyleProfileUI = () => {
        const $sel = $("#set-style-select");
        $sel.empty();
        tempStyleProfiles.forEach(p => {
            $sel.append(`<option value="${p.id}" ${p.id === tempActiveStyleId ? 'selected' : ''}>${p.name}</option>`);
        });

        // 加载当前方案的内容
        const currentProfile = tempStyleProfiles.find(p => p.id === tempActiveStyleId);
        if (currentProfile) {
            $("#set-dir-style").val(currentProfile.content);
        }

        // 更新字符计数
        updateStyleCharCount();

        // 更新方案数量显示
        $("#style-count").text(tempStyleProfiles.length);

        // 控制删除按钮状态（默认方案不可删除）
        const isDefault = tempActiveStyleId === "default";
        $("#btn-style-del").prop("disabled", isDefault).css("opacity", isDefault ? 0.5 : 1);
        $("#btn-style-rename").prop("disabled", isDefault).css("opacity", isDefault ? 0.5 : 1);

        // 重置修改标记
        styleContentModified = false;
        $("#style-unsaved-hint").hide();
    };

    const updateStyleCharCount = () => {
        const len = ($("#set-dir-style").val() || "").length;
        $("#style-char-count").text(`${len}/1000`);
        if (len > 900) {
            $("#style-char-count").css("color", "#ff6b6b");
        } else {
            $("#style-char-count").css("color", "#666");
        }
    };

    const saveCurrentStyleToMemory = () => {
        const pIndex = tempStyleProfiles.findIndex(p => p.id === tempActiveStyleId);
        if (pIndex !== -1) {
            tempStyleProfiles[pIndex].content = $("#set-dir-style").val() || "";
        }
        styleContentModified = false;
        $("#style-unsaved-hint").hide();
    };

    const checkUnsavedStyleChanges = () => {
        const currentProfile = tempStyleProfiles.find(p => p.id === tempActiveStyleId);
        if (!currentProfile) return false;
        const currentContent = $("#set-dir-style").val() || "";
        return currentContent !== currentProfile.content;
    };

    // 文笔内容输入事件
    $("#set-dir-style").on("input", function () {
        updateStyleCharCount();
        const hasChanges = checkUnsavedStyleChanges();
        styleContentModified = hasChanges;
        $("#style-unsaved-hint").toggle(hasChanges);
    });

    // 切换方案事件
    $("#set-style-select").on("change", function () {
        if (styleContentModified) {
            const confirmSwitch = confirm("当前内容有未保存的修改，是否放弃修改并切换方案？");
            if (!confirmSwitch) {
                // 恢复选择
                $(this).val(tempActiveStyleId);
                return;
            }
        }
        tempActiveStyleId = $(this).val();
        renderStyleProfileUI();
    });

    // 添加新方案
    $("#btn-style-add").on("click", function () {
        if (tempStyleProfiles.length >= MAX_STYLE_PROFILES) {
            if (window.toastr) toastr.warning(`最多只能保存 ${MAX_STYLE_PROFILES} 个方案`);
            return;
        }

        const currentContent = $("#set-dir-style").val() || "";
        if (!currentContent.trim()) {
            if (window.toastr) toastr.warning("请先输入文笔参考内容");
            return;
        }

        const newName = prompt("请输入新方案的名称：", `方案 ${tempStyleProfiles.length}`);
        if (!newName || !newName.trim()) return;

        const newId = "style_" + Date.now();
        tempStyleProfiles.push({
            id: newId,
            name: newName.trim(),
            content: currentContent
        });
        tempActiveStyleId = newId;
        styleContentModified = false;
        renderStyleProfileUI();

        if (window.toastr) toastr.success(`已保存为新方案: ${newName.trim()}`);
    });

    // 重命名方案
    $("#btn-style-rename").on("click", function () {
        if (tempActiveStyleId === "default") {
            if (window.toastr) toastr.warning("默认方案不可重命名");
            return;
        }

        const currentProfile = tempStyleProfiles.find(p => p.id === tempActiveStyleId);
        if (!currentProfile) return;

        const newName = prompt("请输入新的方案名称：", currentProfile.name);
        if (!newName || !newName.trim()) return;

        currentProfile.name = newName.trim();
        renderStyleProfileUI();

        if (window.toastr) toastr.success(`方案已重命名为: ${newName.trim()}`);
    });

    // 删除方案
    $("#btn-style-del").on("click", function () {
        if (tempActiveStyleId === "default") {
            if (window.toastr) toastr.warning("默认方案不可删除");
            return;
        }

        const currentProfile = tempStyleProfiles.find(p => p.id === tempActiveStyleId);
        if (!currentProfile) return;

        if (!confirm(`确定要删除方案 "${currentProfile.name}" 吗？`)) return;

        tempStyleProfiles = tempStyleProfiles.filter(p => p.id !== tempActiveStyleId);
        tempActiveStyleId = "default";
        styleContentModified = false;
        renderStyleProfileUI();

        if (window.toastr) toastr.success("方案已删除");
    });

    // 初始化渲染
    renderStyleProfileUI();

    // --- 字体设置逻辑 ---
    // 临时存储上传的字体数据
    let tempFontData = fontSettings.font_data || "";

    // 字体来源切换
    $("input[name='t-font-source']").on("change", function () {
        const source = $(this).val();

        // 更新选项框边框样式
        $("[data-font-source]").css("border-color", "#333");
        $(`[data-font-source="${source}"]`).css("border-color", "#bfa15f");

        // 显示/隐藏对应选项
        $("#t-font-online-options").toggle(source === 'online');
        $("#t-font-upload-options").toggle(source === 'upload');

        // 显示/隐藏强制覆盖选项（仅非默认时显示）
        $("#t-font-force-section").toggle(source !== 'default');
    });

    // 字体文件上传
    $("#btn-font-upload").on("click", () => $("#t-font-file-input").click());

    $("#t-font-file-input").on("change", async function () {
        const file = this.files[0];
        if (!file) return;

        // 检查文件大小 (限制 5MB)
        if (file.size > 5 * 1024 * 1024) {
            if (window.toastr) toastr.error("字体文件过大，请选择小于 5MB 的文件");
            return;
        }

        try {
            tempFontData = await fileToBase64(file);
            $("#t-font-file-name").text(file.name).css("color", "#55efc4");
            if (window.toastr) toastr.success(`已加载字体: ${file.name}`);
        } catch (e) {
            console.error("Titania: 字体加载失败", e);
            if (window.toastr) toastr.error("字体加载失败");
        }
    });

    // 恢复默认
    $("#btn-font-reset").on("click", () => {
        if (!confirm("确定要恢复默认字体设置吗？")) return;

        // 选中默认选项
        $("input[name='t-font-source'][value='default']").prop("checked", true).trigger("change");

        // 清空输入框
        $("#t-font-import-url").val("");
        $("#t-font-name-online").val("");
        $("#t-font-name-upload").val("");
        tempFontData = "";
        $("#t-font-file-name").text("未选择文件").css("color", "#888");

        if (window.toastr) toastr.info("已恢复默认字体，请点击「保存所有配置」生效");
    });

    // --- CSS 主题方案管理逻辑 ---
    const MAX_CSS_THEMES = 10;

    const renderCssThemeUI = () => {
        const $sel = $("#t-css-theme-select");
        $sel.empty();
        tempCssThemes.forEach(p => {
            $sel.append(`<option value="${p.id}" ${p.id === tempActiveCssThemeId ? 'selected' : ''}>${p.name}</option>`);
        });

        // 加载当前方案的内容
        const currentTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        if (currentTheme) {
            $("#t-custom-css-input").val(currentTheme.css || "");
        }

        // 更新字符计数
        updateCSSCharCount();

        // 更新方案数量显示
        $("#css-theme-count").text(tempCssThemes.length);

        // 控制删除按钮状态（默认方案不可删除，但如果只剩一个方案也不可删除）
        const isDefault = tempActiveCssThemeId === "default";
        const isOnlyOne = tempCssThemes.length <= 1;
        $("#btn-css-theme-del").prop("disabled", isDefault || isOnlyOne).css("opacity", (isDefault || isOnlyOne) ? 0.5 : 1);

        // 重置修改标记
        cssThemeModified = false;
        $("#css-theme-unsaved-hint").hide();
    };

    const updateCSSCharCount = () => {
        const len = ($("#t-custom-css-input").val() || "").length;
        $("#css-char-count").text(`${len} 字符`);
    };

    const saveCurrentCssThemeToMemory = () => {
        const pIndex = tempCssThemes.findIndex(p => p.id === tempActiveCssThemeId);
        if (pIndex !== -1) {
            tempCssThemes[pIndex].css = $("#t-custom-css-input").val() || "";
        }
        cssThemeModified = false;
        $("#css-theme-unsaved-hint").hide();
    };

    const checkUnsavedCssChanges = () => {
        const currentTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        if (!currentTheme) return false;
        const currentContent = $("#t-custom-css-input").val() || "";
        return currentContent !== (currentTheme.css || "");
    };

    // CSS 内容输入事件
    $("#t-custom-css-input").on("input", function () {
        updateCSSCharCount();
        const hasChanges = checkUnsavedCssChanges();
        cssThemeModified = hasChanges;
        $("#css-theme-unsaved-hint").toggle(hasChanges);
    });

    // 切换方案事件
    $("#t-css-theme-select").on("change", function () {
        if (cssThemeModified) {
            const confirmSwitch = confirm("当前内容有未保存的修改，是否保存后再切换？\n\n点击「确定」保存并切换\n点击「取消」放弃修改并切换");
            if (confirmSwitch) {
                saveCurrentCssThemeToMemory();
            }
        }
        tempActiveCssThemeId = $(this).val();
        renderCssThemeUI();

        // 即时预览效果
        const currentTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        if (currentTheme) {
            applyCustomCSS(currentTheme.css || "");
        }
    });

    // 添加新方案
    $("#btn-css-theme-add").on("click", function () {
        if (tempCssThemes.length >= MAX_CSS_THEMES) {
            if (window.toastr) toastr.warning(`最多只能保存 ${MAX_CSS_THEMES} 个主题方案`);
            return;
        }

        const currentContent = $("#t-custom-css-input").val() || "";

        const newName = prompt("请输入新主题方案的名称：", `主题 ${tempCssThemes.length + 1}`);
        if (!newName || !newName.trim()) return;

        const newId = "css_theme_" + Date.now();
        tempCssThemes.push({
            id: newId,
            name: newName.trim(),
            css: currentContent
        });
        tempActiveCssThemeId = newId;
        cssThemeModified = false;
        renderCssThemeUI();

        if (window.toastr) toastr.success(`已保存为新主题: ${newName.trim()}`);
    });

    // 重命名方案
    $("#btn-css-theme-rename").on("click", function () {
        const currentTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        if (!currentTheme) return;

        const newName = prompt("请输入新的主题名称：", currentTheme.name);
        if (!newName || !newName.trim()) return;

        currentTheme.name = newName.trim();
        renderCssThemeUI();

        if (window.toastr) toastr.success(`主题已重命名为: ${newName.trim()}`);
    });

    // 删除方案
    $("#btn-css-theme-del").on("click", function () {
        if (tempActiveCssThemeId === "default") {
            if (window.toastr) toastr.warning("默认主题不可删除");
            return;
        }

        if (tempCssThemes.length <= 1) {
            if (window.toastr) toastr.warning("至少需要保留一个主题方案");
            return;
        }

        const currentTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        if (!currentTheme) return;

        if (!confirm(`确定要删除主题 "${currentTheme.name}" 吗？`)) return;

        tempCssThemes = tempCssThemes.filter(p => p.id !== tempActiveCssThemeId);
        tempActiveCssThemeId = tempCssThemes[0]?.id || "default";
        cssThemeModified = false;
        renderCssThemeUI();

        // 应用切换后的主题
        const newTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        if (newTheme) {
            applyCustomCSS(newTheme.css || "");
        }

        if (window.toastr) toastr.success("主题已删除");
    });

    // 初始化渲染
    renderCssThemeUI();

    // 导出 CSS 配置 (JSON 格式)
    $("#btn-css-export").on("click", () => {
        const currentTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        const cssContent = $("#t-custom-css-input").val() || "";
        const themeName = currentTheme?.name || "未命名主题";

        const exportData = {
            type: "titania_custom_css",
            version: "1.1",
            timestamp: new Date().toISOString(),
            theme_name: themeName,
            css: cssContent
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const safeFileName = themeName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_");
        a.download = `titania_theme_${safeFileName}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (window.toastr) toastr.success(`主题「${themeName}」已导出`);
    });

    // 导入 CSS 配置 (JSON 格式)
    $("#btn-css-import").on("click", () => {
        $("#t-css-file-input").click();
    });

    $("#t-css-file-input").on("change", function () {
        const file = this.files[0];
        if (!file) return;

        // 从文件名提取主题名称（移除扩展名和前缀）
        let fileBaseName = file.name.replace(/\.json$/i, "");
        // 移除常见前缀如 "titania_theme_" 和日期后缀
        fileBaseName = fileBaseName.replace(/^titania_theme_/i, "").replace(/_\d{8}$/, "");
        // 将下划线替换为空格，使名称更易读
        fileBaseName = fileBaseName.replace(/_/g, " ").trim();

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const importData = JSON.parse(e.target.result);

                // 验证格式
                if (importData.type !== "titania_custom_css") {
                    throw new Error("无效的主题配置文件格式");
                }

                // 获取导入的 CSS 和名称（优先使用文件名，其次使用文件内的 theme_name）
                const importedCSS = importData.css || "";
                const importedName = fileBaseName || importData.theme_name || "导入的主题";

                // 询问用户操作方式
                const action = confirm(`导入主题「${importedName}」\n\n点击「确定」创建为新主题\n点击「取消」覆盖当前主题`);

                if (action) {
                    // 创建新主题
                    if (tempCssThemes.length >= MAX_CSS_THEMES) {
                        if (window.toastr) toastr.warning(`已达到最大主题数量 (${MAX_CSS_THEMES})，将覆盖当前主题`);
                        // 覆盖当前主题
                        $("#t-custom-css-input").val(importedCSS);
                        updateCSSCharCount();
                        cssThemeModified = true;
                        $("#css-theme-unsaved-hint").show();
                    } else {
                        const newId = "css_theme_" + Date.now();
                        tempCssThemes.push({
                            id: newId,
                            name: importedName,
                            css: importedCSS
                        });
                        tempActiveCssThemeId = newId;
                        cssThemeModified = false;
                        renderCssThemeUI();
                        applyCustomCSS(importedCSS);
                        if (window.toastr) toastr.success(`已创建新主题「${importedName}」`);
                    }
                } else {
                    // 覆盖当前主题
                    $("#t-custom-css-input").val(importedCSS);
                    updateCSSCharCount();
                    cssThemeModified = true;
                    $("#css-theme-unsaved-hint").show();
                    applyCustomCSS(importedCSS);
                    if (window.toastr) toastr.success("已导入并覆盖当前主题内容");
                }
            } catch (err) {
                console.error("Titania: CSS 导入失败", err);
                if (window.toastr) toastr.error("导入失败：" + err.message);
            }
        };
        reader.readAsText(file);

        // 清空 input 以便重复选择同一文件
        $(this).val("");
    });

    // 清空 CSS
    $("#btn-css-reset").on("click", () => {
        if (!confirm("确定要清空当前主题的 CSS 内容吗？")) return;
        $("#t-custom-css-input").val("");
        updateCSSCharCount();
        cssThemeModified = true;
        $("#css-theme-unsaved-hint").show();
        if (window.toastr) toastr.info("已清空，请点击「保存所有配置」生效");
    });

    // --- 自动化设置逻辑 ---
    const savedCats = cfg.auto_categories || [];
    const renderAutoCatList = () => {
        const $list = $("#auto-cat-list"); $list.empty();
        const allCats = new Set(GlobalState.runtimeScripts.map(s => s.category || (s._type === 'preset' ? '官方预设' : '未分类')));
        const sortedCats = [...allCats].sort();
        if (sortedCats.length === 0) { $list.html('<div style="color:var(--t-color-text-faint);">暂无剧本</div>'); return; }
        sortedCats.forEach(cat => {
            const isChecked = savedCats.includes(cat) ? 'checked' : '';
            $list.append(`<label style="display:flex; align-items:center; cursor:pointer; padding:2px 0;"><input type="checkbox" class="auto-cat-chk" value="${cat}" ${isChecked} style="margin-right:8px;"><span style="color:var(--t-color-text-label); font-size:0.9em;">${cat}</span></label>`);
        });
    };
    const updateAutoModeUI = () => {
        const mode = $("#cfg-auto-mode").val();
        if (mode === 'category') { $("#auto-cat-container").show(); renderAutoCatList(); }
        else { $("#auto-cat-container").hide(); }
    };
    $("#cfg-auto-mode").on("change", updateAutoModeUI);
    updateAutoModeUI();
    $("#cfg-auto").on("change", function () { $("#auto-settings-panel").toggle($(this).is(":checked")); });
    $("#cfg-chance").on("input", function () { $("#cfg-chance-val").text($(this).val() + "%"); });

    // 自动续写设置事件
    $("#cfg-auto-continue").on("change", function () {
        $("#auto-continue-panel").toggle($(this).is(":checked"));
    });

    // --- 提示词管理逻辑 ---
    const renderPromptManager = () => {
        const view = $("#t-prompt-view").val() || "narrative";
        tempPromptManager.editor_view = view;
        const isPreset = view === "preset";
        const $select = $("#t-prompt-preset-select");
        $select.toggle(isPreset).empty();
        tempPromptManager.presets.forEach(preset => {
            $select.append($("<option>", { value: preset.id, text: preset.name }));
        });
        $select.val(tempPromptManager.active_preset_id);
        $("#t-prompt-delete").toggle(isPreset && !!$select.val());
        $("#t-prompt-reset-builtin").toggle(!isPreset);
        const scheme = isPreset
            ? tempPromptManager.presets.find(p => p.id === $select.val())
            : tempPromptManager.builtin[view];
        const entries = scheme ? getPresetEntrySummary(scheme) : [];
        const $list = $("#t-prompt-entry-list").empty();
        if (!scheme) {
            $list.html('<div style="color:var(--t-color-text-muted); padding:12px 0;">暂无导入的预设</div>');
            return;
        }
        // 新增条目只开放给导入的预设：内置方案有「恢复默认」，加了也会被一键清掉
        const insertLimit = isPreset ? getPresetInsertLimit(scheme) : -1;
        const appendInsertSlot = (position) => {
            if (position > insertLimit) return;
            const $slot = $(`<button type="button" class="t-prompt-insert-slot" title="在这里插入一个新条目">
                <span class="t-prompt-insert-line"></span>
                <span class="t-prompt-insert-label"><i class="fa-solid fa-plus"></i> 在此插入</span>
                <span class="t-prompt-insert-line"></span>
            </button>`);
            $slot.on("click", () => openPromptEntryEditor(scheme, null, { mode: "create", position }));
            $list.append($slot);
        };
        entries.forEach((entry, entryIndex) => {
            appendInsertSlot(entryIndex);
            const isLocked = entry.readonly === true;
            const stateLabel = isLocked ? "插件内置" : (entry.required ? "必需" : (entry.enabled ? "已启用" : "已禁用"));
            const stateIcon = (isLocked || entry.required) ? "fa-lock" : (entry.enabled ? "fa-check" : "fa-xmark");
            const $row = $(`<div class="t-prompt-entry-card ${entry.enabled ? '' : 'is-disabled'} ${isLocked ? 'is-locked' : ''} ${entry.custom ? 'is-custom' : ''}" data-entry-id="${entry.id}" draggable="${isLocked ? 'false' : 'true'}">
                <div class="t-prompt-entry-header">
                    <span class="t-prompt-entry-drag-hint" title="${isLocked ? '插件固定条目' : '拖动排序'}"><i class="fa-solid ${isLocked ? 'fa-lock' : 'fa-grip-vertical'}"></i></span>
                    <span class="t-prompt-entry-index">#${entry.index}</span>
                    <span class="t-prompt-entry-name"></span>
                    <span class="t-prompt-entry-badge"></span>
                    <div class="t-prompt-entry-actions">
                        <button type="button" class="t-prompt-entry-toggle ${entry.enabled ? 'is-enabled' : ''} ${entry.required ? 'is-required' : ''}" title="${isLocked ? '插件内置条目，不能编辑、禁用或排序' : (entry.required ? '必需条目，不能禁用' : `${stateLabel}，点击切换状态`)}" aria-label="${stateLabel}" ${entry.required ? 'disabled' : ''}><i class="fa-solid ${stateIcon}"></i><span class="t-prompt-entry-toggle-label">${stateLabel}</span></button>
                        ${entry.custom ? '<button type="button" class="t-prompt-entry-delete" title="删除这个自定义条目" aria-label="删除条目"><i class="fa-solid fa-trash"></i></button>' : ''}
                    </div>
                </div>
            </div>`);
            $row.find(".t-prompt-entry-name").text(entry.name).attr("title", entry.name);
            $row.find(".t-prompt-entry-badge")
                .text(entry.role)
                .attr("title", entry.marker ? `${entry.role} · {{${entry.marker}}}` : entry.role);
            const updateEntry = (changes) => {
                const target = scheme.entries.find(item => item.id === entry.id);
                if (!target) return;
                Object.assign(target, changes);
                renderPromptManager();
            };
            $row.find(".t-prompt-entry-toggle").on("click", function () {
                if (entry.required) return;
                updateEntry({ enabled: !entry.enabled });
            });
            $row.find(".t-prompt-entry-delete").on("click", function () {
                const index = scheme.entries.findIndex(item => item.id === entry.id);
                if (index < 0) return;
                scheme.entries.splice(index, 1);
                renderPromptManager();
            });
            $row.on("click", function (event) {
                if ($(event.target).closest("button").length) return;
                if (isLocked) return;
                openPromptEntryEditor(scheme, entry.id);
            });
            $row.on("dragstart", function (event) {
                const originalEvent = event.originalEvent;
                if (isLocked || $(event.target).closest("input, textarea, select, button").length) {
                    originalEvent?.preventDefault();
                    return;
                }
                originalEvent.dataTransfer.effectAllowed = "move";
                originalEvent.dataTransfer.setData("text/plain", entry.id);
                $(this).addClass("is-dragging");
            });
            $row.on("dragover", function (event) {
                if (isLocked) return;
                event.preventDefault();
                const originalEvent = event.originalEvent;
                const rect = this.getBoundingClientRect();
                const insertBefore = originalEvent.clientY < rect.top + rect.height / 2;
                $(this).toggleClass("is-drag-over", insertBefore || !insertBefore);
                originalEvent.dataTransfer.dropEffect = "move";
            });
            $row.on("dragleave", function (event) {
                if (event.target === this) $(this).removeClass("is-drag-over");
            });
            $row.on("drop", function (event) {
                if (isLocked) return;
                event.preventDefault();
                const originalEvent = event.originalEvent;
                const draggedId = originalEvent.dataTransfer.getData("text/plain");
                const fromIndex = scheme.entries.findIndex(item => item.id === draggedId);
                const targetIndex = scheme.entries.findIndex(item => item.id === entry.id);
                if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
                    renderPromptManager();
                    return;
                }
                const rect = this.getBoundingClientRect();
                const insertBefore = originalEvent.clientY < rect.top + rect.height / 2;
                const [moved] = scheme.entries.splice(fromIndex, 1);
                let nextIndex = scheme.entries.findIndex(item => item.id === entry.id);
                if (!insertBefore) nextIndex++;
                scheme.entries.splice(Math.max(0, nextIndex), 0, moved);
                if (scheme.type === "preset") ensureTitaniaPresetEntries(scheme);
                renderPromptManager();
            });
            $row.on("dragend", function () {
                $(this).removeClass("is-dragging is-drag-over");
            });
            $list.append($row);
        });
        appendInsertSlot(entries.length);
    };

    const openPromptEntryEditor = (scheme, entryId, options = {}) => {
        const isCreate = options.mode === "create";
        // 新建时先造一个游离条目，保存时才 splice 进方案，中途关闭不留残渣
        const entry = isCreate ? createCustomPresetEntry() : scheme?.entries?.find(item => item.id === entryId);
        if (!entry) return;
        if (!isCreate && entry.readonly === true) return;
        document.getElementById("t-prompt-editor-modal")?.remove();
        const isDynamic = entry.type === "dynamic";
        const host = document.createElement("div");
        host.id = "t-prompt-editor-modal";
        const isolatedHostStyles = {
            position: "fixed",
            inset: "0",
            display: "block",
            visibility: "visible",
            opacity: "1",
            pointerEvents: "auto",
            width: "100vw",
            height: "100dvh",
            maxWidth: "none",
            maxHeight: "none",
            margin: "0",
            padding: "0",
            border: "0",
            background: "transparent",
            overflow: "hidden",
            transform: "none",
            transition: "none",
            animation: "none",
            colorScheme: "dark"
        };
        for (const [property, value] of Object.entries(isolatedHostStyles)) {
            host.style.setProperty(property.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`), value, "important");
        }

        const shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML = `
            <style>
                :host {
                    all: initial !important;
                    position: fixed !important;
                    inset: 0 !important;
                    width: 100vw !important;
                    height: 100dvh !important;
                    color-scheme: dark;
                }
                *, *::before, *::after { box-sizing: border-box; }
                dialog {
                    position: fixed;
                    inset: 0;
                    width: 100vw;
                    height: 100dvh;
                    max-width: none;
                    max-height: none;
                    margin: 0;
                    padding: 0;
                    border: 0;
                    overflow: hidden;
                    background: transparent;
                    color: inherit;
                }
                dialog::backdrop { background: transparent; }
                .backdrop {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    background: rgba(0, 0, 0, 0.72);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                    font-size: 14px;
                    color: #eee;
                }
                .editor {
                    width: min(720px, 100%);
                    max-height: min(760px, calc(100dvh - 40px));
                    display: grid;
                    grid-template-rows: auto minmax(0, 1fr);
                    overflow: hidden;
                    background: #171717;
                    border: 1px solid #4a4a4a;
                    border-radius: 7px;
                    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
                }
                .header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    min-height: 56px;
                    padding: 12px 14px 12px 16px;
                    border-bottom: 1px solid #333;
                    background: #1c1c1c;
                }
                .title { flex: 1; min-width: 0; color: #eee; font-weight: 600; }
                .icon-button {
                    width: 34px;
                    height: 32px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                    border: 1px solid #444;
                    border-radius: 4px;
                    background: #242424;
                    color: #bbb;
                    cursor: pointer;
                }
                .icon-button svg { width: 15px; height: 15px; fill: currentColor; }
                .save { color: #55efc4; }
                .icon-button:hover, .icon-button:focus-visible { color: #fff; border-color: #90cdf4; outline: none; }
                .body {
                    min-height: 0;
                    padding: 16px;
                    overflow-y: auto;
                    overscroll-behavior: contain;
                }
                .group { margin: 0 0 14px; }
                .group.content-group { display: flex; min-height: 280px; flex-direction: column; }
                label { display: block; margin: 0 0 6px; color: #aaa; font-size: 12px; }
                input, select, textarea {
                    width: 100%;
                    margin: 0;
                    padding: 8px 10px;
                    border: 1px solid #444;
                    border-radius: 4px;
                    outline: none;
                    background: #111;
                    color: #eee;
                    font: inherit;
                }
                input, select { height: 36px; }
                textarea {
                    min-height: 280px;
                    flex: 1;
                    resize: vertical;
                    line-height: 1.45;
                    font-family: Consolas, Monaco, "Courier New", monospace;
                }
                input:focus, select:focus, textarea:focus { border-color: #90cdf4; }
                textarea:disabled { color: #777; background: #121212; border-style: dashed; }
                .runtime {
                    margin-top: 8px;
                    padding: 10px;
                    border: 1px dashed #444;
                    border-radius: 4px;
                    background: #141414;
                    color: #888;
                    font-size: 12px;
                }
                @media (max-width: 600px) {
                    .backdrop { padding: 8px; }
                    .editor { max-height: calc(100dvh - 16px); }
                    .header { min-height: 52px; padding: 10px 10px 10px 14px; }
                    .body { padding: 12px; }
                    .group.content-group { min-height: 220px; }
                    textarea { min-height: 220px; }
                }
            </style>
            <dialog aria-label="${isCreate ? '新增提示词条目' : '编辑提示词条目'}">
                <div class="backdrop">
                    <section class="editor" role="document">
                    <header class="header">
                        <span class="title">${isCreate ? '新增提示词条目' : '编辑提示词条目'}</span>
                        <button type="button" class="icon-button save" title="${isCreate ? '插入条目' : '保存条目'}" aria-label="${isCreate ? '插入条目' : '保存条目'}">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4Zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm3-10H5V5h10v4Z"/></svg>
                        </button>
                        <button type="button" class="icon-button close" title="关闭" aria-label="关闭">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18.3 5.7-1-1L12 10l-5.3-5.3-1 1L11 11l-5.3 5.3 1 1L12 12l5.3 5.3 1-1L13 11l5.3-5.3Z"/></svg>
                        </button>
                    </header>
                    <div class="body">
                        <div class="group"><label for="name">条目名称</label><input id="name" type="text"></div>
                        <div class="group"><label for="role">消息角色</label><select id="role"><option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option></select></div>
                        <div class="group content-group"><label for="content">提示词内容</label><textarea id="content" placeholder="提示词内容"></textarea>${isDynamic ? '<div class="runtime">这是运行时动态条目，实际内容由当前上下文生成。</div>' : ''}</div>
                    </div>
                    </section>
                </div>
            </dialog>`;

        const modal = shadow.querySelector("dialog");
        const nameInput = shadow.querySelector("#name");
        const roleSelect = shadow.querySelector("#role");
        const contentInput = shadow.querySelector("#content");
        nameInput.value = entry.name || "";
        roleSelect.value = entry.role || "user";
        contentInput.value = entry.content || "";
        contentInput.disabled = isDynamic;

        const close = () => {
            if (modal.open) modal.close();
            host.remove();
        };
        shadow.querySelector(".close").addEventListener("click", close);
        shadow.querySelector(".backdrop").addEventListener("click", event => {
            if (event.target === event.currentTarget) close();
        });
        modal.addEventListener("cancel", event => {
            event.preventDefault();
            close();
        });
        shadow.querySelector(".save").addEventListener("click", () => {
            entry.name = nameInput.value.trim() || entry.name || "未命名条目";
            entry.role = roleSelect.value || "user";
            if (!isDynamic) entry.content = contentInput.value;
            if (isCreate) {
                const position = Math.min(Math.max(0, options.position ?? scheme.entries.length), scheme.entries.length);
                scheme.entries.splice(position, 0, entry);
                ensureTitaniaPresetEntries(scheme);
            }
            close();
            renderPromptManager();
        });

        document.body.appendChild(host);
        modal.showModal();
        nameInput.focus();
        if (isCreate) nameInput.select();
    };
    $("#t-prompt-view").on("change", renderPromptManager);
    $("#t-prompt-preset-select").on("change", function () {
        tempPromptManager.active_preset_id = $(this).val() || "";
        renderPromptManager();
    });
    $("#t-prompt-import").on("click", () => $("#t-prompt-file").trigger("click"));
    $("#t-prompt-file").on("change", function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const raw = JSON.parse(String(reader.result || ""));
                const preset = normalizeChatCompletionPreset(raw, { name: file.name.replace(/\.json$/i, "") });
                const existing = tempPromptManager.presets.findIndex(item => item.name === preset.name);
                if (existing >= 0) preset.id = tempPromptManager.presets[existing].id;
                if (existing >= 0) tempPromptManager.presets[existing] = preset;
                else tempPromptManager.presets.push(preset);
                tempPromptManager.active_preset_id = preset.id;
                $("#t-prompt-view").val("preset");
                renderPromptManager();
                if (window.toastr) {
                    const stats = preset.import_stats;
                    const summary = stats
                        ? `已合并 ${stats.group_count} 个顺序分组：${stats.reference_count} 条引用，${stats.unique_count} 个唯一条目，导入 ${stats.imported_count} 个`
                            + (stats.duplicate_count ? `；去除 ${stats.duplicate_count} 条重复引用` : "")
                            + (stats.conflict_count ? `；${stats.conflict_count} 个状态冲突以主分组为准` : "")
                            + (stats.removed_marker_count ? `；过滤 ${stats.removed_marker_count} 个不支持标记` : "")
                            + (stats.missing_definition_count ? `；跳过 ${stats.missing_definition_count} 个缺失定义` : "")
                        : "";
                    toastr.success(summary, `已导入预设：${preset.name}`);
                }
            } catch (e) {
                if (window.toastr) toastr.error(`预设导入失败：${e?.message || e}`, "Titania");
            } finally { $(this).val(""); }
        };
        reader.readAsText(file);
    });
    $("#t-prompt-delete").on("click", () => {
        const id = tempPromptManager.active_preset_id;
        if (!id) return;
        tempPromptManager.presets = tempPromptManager.presets.filter(preset => preset.id !== id);
        tempPromptManager.active_preset_id = tempPromptManager.presets[0]?.id || "";
        renderPromptManager();
    });
    $("#t-prompt-reset-builtin").on("click", () => {
        const mode = $("#t-prompt-view").val();
        const defaults = mode === "visual"
            ? "You are a Visual Director creating an immersive HTML scene.\n\n[Process]\n1. Analyze the mood/emotion of the scenario\n2. Choose visual effects that represent the mood\n3. Generate HTML with embedded <style>\n\n[Technical Rules]\n1. Output HTML with <style> block\n2. Use CSS animations, gradients, shadows freely\n3. No markdown code blocks\n4. Language: Chinese"
            : "You are a creative engine. Output ONLY valid HTML content inside a <div> with Inline CSS. Do NOT use markdown code blocks. Language: Chinese.";
        const scheme = tempPromptManager.builtin[mode];
        if (scheme) {
            scheme.entries = [{ id: `${mode}_system`, name: "系统提示词", role: "system", type: "text", enabled: true, content: defaults }, { id: `${mode}_user`, name: "生成上下文", role: "user", type: "text", enabled: true, content: "" }];
            renderPromptManager();
        }
    });
    $("#t-prompt-view").val(tempPromptManager.editor_view || "narrative");
    renderPromptManager();

    // --- 快捷工具栏配置逻辑 ---
    // 读取现有配置
    const toolbarConfig = data.quick_toolbar || {};
    const enabledItems = toolbarConfig.enabled_items || {
        main: true,
        lore: true,
        settings: true,
        favs: false,
        scripts: false,
        recall: false
    };
    const MAX_TOOLBAR_ITEMS = 5;

    // 初始化复选框状态
    const initToolbarCheckboxes = () => {
        $(".t-toolbar-chk").each(function () {
            const btnId = $(this).data("btn-id");
            if (btnId === "main") {
                // main 按钮始终选中且禁用
                $(this).prop("checked", true).prop("disabled", true);
            } else {
                $(this).prop("checked", enabledItems[btnId] === true);
            }
        });
        updateToolbarCount();
    };

    // 更新计数显示
    const updateToolbarCount = () => {
        const count = $(".t-toolbar-chk:checked").length;
        const $countEl = $("#t-toolbar-count");
        $countEl.text(`已选择 ${count} / ${MAX_TOOLBAR_ITEMS} 个按钮`);

        // 如果达到上限，禁用未选中的复选框
        if (count >= MAX_TOOLBAR_ITEMS) {
            $(".t-toolbar-chk:not(:checked):not([data-btn-id='main'])").prop("disabled", true);
            $countEl.css("color", "#ff9f43");
        } else {
            $(".t-toolbar-chk:not([data-btn-id='main'])").prop("disabled", false);
            $countEl.css("color", "#666");
        }
    };

    // 复选框变化事件
    $(".t-toolbar-chk").on("change", function () {
        updateToolbarCount();
    });

    // 启用/禁用开关
    $("#cfg-toolbar-enabled").on("change", function () {
        $("#toolbar-settings-panel").toggle($(this).is(":checked"));
    });

    // 初始化
    initToolbarCheckboxes();

    // --- 标题栏图标配置 ---
    // 勾选决定是否上栏、拖动决定顺序；改动立即写入并重绘主窗口顶栏（若开着）。
    // 顺序以当前已选列表为准，未选中的按注册表顺序排在后面。
    let headerActionOrder = (() => {
        const active = getHeaderActions();
        const rest = HEADER_ACTION_REGISTRY.map(item => item.id).filter(id => !active.includes(id));
        return [...active, ...rest];
    })();

    const applyHeaderActions = () => {
        const selected = headerActionOrder.filter(id => $(`.t-header-action-chk[data-action-id="${id}"]`).is(":checked"));
        saveHeaderActions(selected);
        // 主窗口可能没开，函数不存在时静默跳过
        if (typeof window.refreshHeaderActions === "function") window.refreshHeaderActions();
        return selected;
    };

    const updateHeaderActionCount = () => {
        const count = $(".t-header-action-chk:checked").length;
        const $countEl = $("#p-header-actions-count");
        $countEl.text(`已选 ${count} / ${HEADER_ACTION_MAX}`);
        const full = count >= HEADER_ACTION_MAX;
        $countEl.css("color", full ? "#ff9f43" : "#666");
        // 到上限就挡住未选中的，避免用户以为选上了却被静默截断
        $(".t-header-action-chk:not(:checked)")
            .prop("disabled", full)
            .closest(".t-header-action-card")
            .toggleClass("is-blocked", full)
            .attr("title", full ? `最多 ${HEADER_ACTION_MAX} 个，取消一个再选` : "");
    };

    const renderHeaderActionCards = () => {
        const $list = $("#p-header-actions");
        if (!$list.length) return;
        const active = getHeaderActions();
        $list.empty();

        headerActionOrder.forEach(id => {
            const meta = HEADER_ACTION_REGISTRY.find(item => item.id === id);
            if (!meta) return;
            const checked = active.includes(id);
            const $card = $(`<div class="t-header-action-card" data-action-id="${id}" draggable="true">
                <span class="t-header-action-grip" title="拖动排序"><i class="fa-solid fa-grip-vertical"></i></span>
                <i class="fa-solid ${meta.icon} t-header-action-icon"></i>
                <span class="t-header-action-label"></span>
                <label class="t-header-action-switch">
                    <input type="checkbox" class="t-header-action-chk t-choice-input t-choice-input--brand" data-action-id="${id}" ${checked ? "checked" : ""}>
                </label>
            </div>`);
            $card.find(".t-header-action-label").text(meta.label);

            $card.on("dragstart", function (event) {
                const originalEvent = event.originalEvent;
                if ($(event.target).closest("input, label").length) {
                    originalEvent?.preventDefault();
                    return;
                }
                originalEvent.dataTransfer.effectAllowed = "move";
                originalEvent.dataTransfer.setData("text/plain", id);
                $(this).addClass("is-dragging");
            });
            $card.on("dragend", function () {
                $(this).removeClass("is-dragging");
                $(".t-header-action-card").removeClass("is-drag-over");
            });
            $card.on("dragover", function (event) {
                event.preventDefault();
                event.originalEvent.dataTransfer.dropEffect = "move";
                $(this).addClass("is-drag-over");
            });
            $card.on("dragleave", function (event) {
                if (event.target === this) $(this).removeClass("is-drag-over");
            });
            $card.on("drop", function (event) {
                event.preventDefault();
                const draggedId = String(event.originalEvent.dataTransfer.getData("text/plain") || "");
                const fromIndex = headerActionOrder.indexOf(draggedId);
                const targetIndex = headerActionOrder.indexOf(id);
                if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
                    renderHeaderActionCards();
                    return;
                }
                // 落在目标上半部插到它前面，下半部插到后面
                const rect = this.getBoundingClientRect();
                const insertBefore = event.originalEvent.clientY < rect.top + rect.height / 2;
                headerActionOrder.splice(fromIndex, 1);
                const base = headerActionOrder.indexOf(id);
                headerActionOrder.splice(insertBefore ? base : base + 1, 0, draggedId);
                applyHeaderActions();
                renderHeaderActionCards();
            });

            $list.append($card);
        });

        $(".t-header-action-chk").on("change", function () {
            applyHeaderActions();
            updateHeaderActionCount();
        });
        updateHeaderActionCount();
    };

    renderHeaderActionCards();

    // --- 诊断与日志逻辑 ---
    const renderLogView = () => {
        const logs = TitaniaLogger.logs;
        if (!logs || logs.length === 0) {
            $("#t-log-viewer").html('<div style="text-align:center; margin-top:100px; color:#555;">暂无日志</div>');
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
        $("#t-log-viewer").html(html);
    };

    renderLogView();
    $("#btn-refresh-log").on("click", renderLogView);
    $("#btn-export-log").on("click", () => TitaniaLogger.downloadReport());

    // --- API & 数据 ---

    $("#btn-restore-presets").on("click", function () {
        if (confirm("恢复所有预设？")) {
            const d = getExtData();
            d.disabled_presets = [];
            saveExtData();
            loadScripts();
            $(this).prop("disabled", true).text("已恢复");
        }
    });

    $("#btn-open-mgr").on("click", () => {
        document.getElementById("t-prompt-editor-modal")?.remove();
        $("#t-settings-view").remove();
        openScriptManager();
    });
    $("#t-set-close").on("click", () => {
        document.getElementById("t-prompt-editor-modal")?.remove();
        $("#t-settings-view").remove();
        // 如果主窗口存在则显示它，否则关闭整个 overlay
        const $mainView = $("#t-main-view");
        if ($mainView.length > 0) {
            $mainView.show();
        } else {
            // 从悬浮球直接打开的情况，关闭 overlay
            $("#t-overlay").remove();
        }
    });

    // --- 保存逻辑 ---
    $("#t-set-save").on("click", () => {
        saveCurrentProfileToMemory();
        saveCurrentStyleToMemory(); // 保存当前文笔方案的修改
        const selectedCats = []; $(".auto-cat-chk:checked").each(function () { selectedCats.push($(this).val()); });

        const finalCfg = {
            active_profile_id: tempActiveId, profiles: tempProfiles,
            generation_mode: cfg.generation_mode || "narrative",
            history_limit: parseInt($("#cfg-history").val()) || 10,
            stream: $("#cfg-stream").is(":checked"),
            max_tokens: parseInt($("#cfg-max-tokens").val()) || 4096,
            auto_generate: $("#cfg-auto").is(":checked"),
            auto_chance: parseInt($("#cfg-chance").val()),
            auto_mode: $("#cfg-auto-mode").val(),
            auto_categories: selectedCats
        };
        const d = getExtData();
        d.config = finalCfg;
        d.appearance = {
            type: tempApp.type,
            content: tempApp.content,
            animation: tempApp.animation || "ripple",
            size: tempApp.size || 56,
            ui_font_scale: tempApp.ui_font_scale !== undefined ? tempApp.ui_font_scale : 100,
            border_color: tempApp.border_color || "#90cdf4",
            bg_color: tempApp.bg_color || "#2b2b2b",
            border_opacity: tempApp.border_opacity !== undefined ? tempApp.border_opacity : 100,
            bg_opacity: tempApp.bg_opacity !== undefined ? tempApp.bg_opacity : 100,
            show_timer: $("#p-show-timer").is(":checked")
        };
        // 逐字段写入，避免覆盖 script_sort_mode 等其它偏好
        if (!d.ui_prefs) d.ui_prefs = {};
        d.ui_prefs.main_window_mode = $("#p-main-window-mode").val() === "legacy" ? "legacy" : "modern";
        // 顶栏图标勾选时已即时写入，这里再兜一次，跟其它设置一并落盘
        if ($(".t-header-action-chk").length) {
            d.ui_prefs.header_actions = headerActionOrder
                .filter(id => $(`.t-header-action-chk[data-action-id="${id}"]`).is(":checked"))
                .slice(0, HEADER_ACTION_MAX);
        }
        d.director = { instruction: $("#set-dir-instruction").val().trim() };

        const clampInt = (value, min, max, fallback) => {
            const n = parseInt(value, 10);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(min, Math.min(max, n));
        };
        const clampFloat = (value, min, max, fallback) => {
            const n = parseFloat(value);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(min, Math.min(max, n));
        };

        // 保存 CSS 主题方案
        saveCurrentCssThemeToMemory(); // 确保当前编辑内容被保存到内存
        d.css_themes = {
            profiles: tempCssThemes,
            active_profile_id: tempActiveCssThemeId
        };
        // 同时更新 custom_css 字段（保持向后兼容）
        const activeTheme = tempCssThemes.find(p => p.id === tempActiveCssThemeId);
        d.custom_css = activeTheme?.css || "";

        // 保存字体设置 (新格式)
        const fontSource = $("input[name='t-font-source']:checked").val() || "default";
        d.font_settings = {
            source: fontSource,
            import_url: fontSource === 'online' ? $("#t-font-import-url").val().trim() : "",
            font_name: fontSource === 'online'
                ? $("#t-font-name-online").val().trim()
                : (fontSource === 'upload' ? $("#t-font-name-upload").val().trim() : ""),
            font_data: fontSource === 'upload' ? tempFontData : "",
            force_override: fontSource !== 'default' && $("#t-font-force-override").is(":checked")
        };

        // 保存文笔方案数据
        d.style_profiles = tempStyleProfiles;
        d.active_style_id = tempActiveStyleId;

        // 保存自动续写配置
        d.auto_continue = {
            enabled: $("#cfg-auto-continue").is(":checked"),
            max_retries: parseInt($("#cfg-continue-retries").val()) || 2,
            detection_mode: $("#cfg-continue-mode").val() || "html",
            show_indicator: $("#cfg-continue-indicator").is(":checked")
        };

        // 保存聊天历史提取白名单配置
        d.history_extraction = {
            whitelist: $("#cfg-history-whitelist").val().trim(),
            blacklist: $("#cfg-history-blacklist").val().trim()
        };

        // 保存快捷工具栏配置
        const toolbarEnabledItems = {};
        $(".t-toolbar-chk").each(function () {
            const btnId = $(this).data("btn-id");
            toolbarEnabledItems[btnId] = $(this).is(":checked");
        });
        const prevEnabledItems = d.quick_toolbar?.enabled_items || {};
        toolbarEnabledItems.lore = prevEnabledItems.lore === true;
        toolbarEnabledItems.recall = prevEnabledItems.recall === true;
        toolbarEnabledItems.outline = false;
        toolbarEnabledItems.debug = false;
        d.quick_toolbar = {
            enabled: $("#cfg-toolbar-enabled").is(":checked"),
            enabled_items: toolbarEnabledItems,
            max_items: MAX_TOOLBAR_ITEMS
        };
        d.prompt_manager = tempPromptManager;

        // 保持入口开关配置（由扩展抽屉 settings.html 管理）
        const prevOutlineEntry = d.outline_entry || {};
        d.outline_entry = {
            ...prevOutlineEntry,
            enabled: prevOutlineEntry.enabled === true
        };

        const prevRewriteEntry = d.rewrite_entry || {};
        d.rewrite_entry = {
            ...prevRewriteEntry,
            enabled: prevRewriteEntry.enabled === true
        };

        saveExtData();
        document.getElementById("t-prompt-editor-modal")?.remove();
        $("#t-settings-view").remove();
        // 如果主窗口存在则显示它，否则关闭整个 overlay
        const $mainViewOnSave = $("#t-main-view");
        if ($mainViewOnSave.length > 0) {
            $mainViewOnSave.show();
        } else {
            // 从悬浮球直接打开的情况，关闭 overlay
            $("#t-overlay").remove();
        }
        createFloatingButton(); // 刷新悬浮球外观
        refreshOutlineEntryButton(); // 刷新发送区大纲入口
        refreshRewriteEntryButton(); // 刷新快捷栏改写入口
        applyCustomCSS(d.custom_css); // 应用自定义 CSS
        applyFontSettings(d.font_settings); // 应用字体设置
        applyUIFontScale(d.appearance?.ui_font_scale); // 应用 UI 字体大小
        if (window.toastr) toastr.success("设置已保存");
    });

    renderPreview();
    mainConnectionEditor.render();
}

/**
 * 应用 UI 字体缩放（不影响内容区 Shadow DOM）
 * @param {number} scalePercent - 百分比，默认 100
 */
export function applyUIFontScale(scalePercent = 100) {
    const n = Number(scalePercent);
    const clamped = Number.isFinite(n) ? Math.max(80, Math.min(130, n)) : 100;
    document.documentElement.style.setProperty('--t-ui-font-scale', (clamped / 100).toFixed(2));
}
