// src/ui/floatingBtn.js

import { getExtData, saveExtData } from "../utils/storage.js";
import { GlobalState } from "../core/state.js";
import { openMainWindow } from "./mainWindow.js";
// 移除静态导入，改为动态导入以避免启动时阻塞
// import { showLoreReviewWindow } from "./loreReviewWindow.js";
import { openSettingsWindow } from "./settingsWindow.js";
// 移除静态导入，改为动态导入以避免启动时阻塞
// import { openRecallPanel } from "./memoryRecallPanel.js";

// 侧边菜单状态
let slideMenuVisible = false;

const FLOAT_POSITION_STORAGE_KEY = "titania-theater:float-position:v1";
const FLOAT_POSITION_MARGIN = 8;
const FLOAT_POSITION_MOBILE_BREAKPOINT = 768;
const FLOAT_POSITION_DEFAULT_LEFT = 20;
const FLOAT_POSITION_DEFAULT_TOP = 100;
// 半隐藏时允许移出视口的比例：0.5 = 最多藏一半
const FLOAT_TUCK_RATIO = 0.5;
let floatResizeTimer = null;

// 拖拽每帧都要读这个开关，而 getExtData() 内部会跑 ensurePromptManager（构造默认对象、
// 遍历 presets，甚至可能触发保存），放进热路径会明显掉帧。因此缓存到模块变量，
// 只在创建悬浮球和设置变更时刷新。
let floatTuckEnabled = true;

function refreshFloatTuckCache() {
    try {
        floatTuckEnabled = getExtData()?.appearance?.edge_tuck !== false;
    } catch (e) {
        floatTuckEnabled = true;
    }
    return floatTuckEnabled;
}

function getFloatingPositionMode() {
    return window.innerWidth <= FLOAT_POSITION_MOBILE_BREAKPOINT ? "mobile" : "desktop";
}

function getFloatingPositionData() {
    try {
        const parsed = JSON.parse(localStorage.getItem(FLOAT_POSITION_STORAGE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
        return {};
    }
}

function getFloatingPositionBounds(size) {
    const safeSize = Math.max(1, Number(size) || 56);
    const minLeft = FLOAT_POSITION_MARGIN;
    const minTop = FLOAT_POSITION_MARGIN;
    const maxLeft = Math.max(minLeft, window.innerWidth - safeSize - FLOAT_POSITION_MARGIN);
    const maxTop = Math.max(minTop, window.innerHeight - safeSize - FLOAT_POSITION_MARGIN);

    return {
        minLeft,
        minTop,
        maxLeft,
        maxTop,
        travelX: Math.max(0, maxLeft - minLeft),
        travelY: Math.max(0, maxTop - minTop)
    };
}

/**
 * 实际可停放范围。纵向始终留边距；横向在开启半隐藏时以视口边缘为基准放宽，
 * 使最深处恰好藏起 FLOAT_TUCK_RATIO 比例的球宽。
 * 注意这里不能写成 bounds.minLeft - overhang：那样 8px 边距会吃掉同等的隐藏量。
 * 球是 position: fixed，负 left 不会带出横向滚动条。
 * 与 getFloatingPositionBounds 的区别：后者是存储比例的固定参照系，不随开关变化，
 * 这样切换半隐藏时已存的位置含义不会漂移。
 */
function getFloatingPositionLimits(size) {
    const safeSize = Math.max(1, Number(size) || 56);
    const bounds = getFloatingPositionBounds(size);
    if (!floatTuckEnabled) {
        return { minLeft: bounds.minLeft, maxLeft: bounds.maxLeft, minTop: bounds.minTop, maxTop: bounds.maxTop };
    }

    // 以视口边缘为基准：left = -hidden 时左侧正好藏起 hidden 像素
    const hidden = safeSize * FLOAT_TUCK_RATIO;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

    return {
        minLeft: -hidden,
        maxLeft: Math.max(-hidden, viewportWidth - safeSize + hidden),
        minTop: bounds.minTop,
        maxTop: bounds.maxTop
    };
}

function clampFloatingPosition(left, top, size) {
    const limits = getFloatingPositionLimits(size);
    return {
        left: Math.max(limits.minLeft, Math.min(limits.maxLeft, Number(left) || 0)),
        top: Math.max(limits.minTop, Math.min(limits.maxTop, Number(top) || 0))
    };
}

function saveFloatingPosition(btn, size) {
    if (!btn?.length) return;

    try {
        const rect = btn[0].getBoundingClientRect();
        const bounds = getFloatingPositionBounds(size);
        const position = clampFloatingPosition(rect.left, rect.top, size);
        const data = getFloatingPositionData();

        // 以 getFloatingPositionBounds 为参照系存占比，不随半隐藏开关变化。
        // 半隐藏时球停在视口外，占比会略微超出 [0,1]，这里不做截断，
        // 由读取端按当时的开关状态钳制。
        data[getFloatingPositionMode()] = {
            x: bounds.travelX > 0 ? (position.left - bounds.minLeft) / bounds.travelX : 0,
            y: bounds.travelY > 0 ? (position.top - bounds.minTop) / bounds.travelY : 0
        };

        localStorage.setItem(FLOAT_POSITION_STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.warn("Titania: 保存悬浮球位置失败", e);
    }
}

function applyFloatingPosition(btn, size) {
    if (!btn?.length) return;

    const saved = getFloatingPositionData()[getFloatingPositionMode()];
    const hasSavedPosition = Number.isFinite(saved?.x) && Number.isFinite(saved?.y);
    const bounds = getFloatingPositionBounds(size);

    if (hasSavedPosition) {
        // 存的是参照系占比，可能因半隐藏略微超出 [0,1]；
        // 还原为像素后按当前开关状态钳制，关闭半隐藏时会自动收回可视区。
        const position = clampFloatingPosition(
            bounds.minLeft + saved.x * bounds.travelX,
            bounds.minTop + saved.y * bounds.travelY,
            size
        );
        btn.css({ left: `${position.left}px`, top: `${position.top}px`, right: "auto" });
        return;
    }

    // 当前设备类型没有保存记录时使用默认位置，避免桌面与移动端相互继承像素坐标。
    const position = clampFloatingPosition(FLOAT_POSITION_DEFAULT_LEFT, FLOAT_POSITION_DEFAULT_TOP, size);
    btn.css({ left: `${position.left}px`, top: `${position.top}px`, right: "auto" });
}

/**
 * 半隐藏开关切换后重新钳制位置：关闭时把露在视口外的球收回来。
 * 球不存在时静默返回，这样设置面板不必关心悬浮球当前是否显示。
 */
export function refreshFloatingTuck() {
    refreshFloatTuckCache();

    const btn = $("#titania-float-btn");
    if (!btn.length) return;

    // 读实际渲染尺寸，用户可能在外观设置里改过球的大小
    const size = btn.outerWidth() || parseInt(getExtData()?.appearance?.size) || 56;
    const rect = btn[0].getBoundingClientRect();
    const position = clampFloatingPosition(rect.left, rect.top, size);

    btn.css({ transition: "none", left: `${position.left}px`, top: `${position.top}px`, right: "auto" });
    saveFloatingPosition(btn, size);
    updateTimerPosition();
}

export function destroyFloatingButton() {
    $(document).off(".titaniaFloatDrag");
    $(window).off(".titaniaFloatPosition");
    if (floatResizeTimer) {
        clearTimeout(floatResizeTimer);
        floatResizeTimer = null;
    }

    hideSlideMenu();
    $("#titania-float-btn").remove();
    $("#titania-timer").remove();
}

// 快捷工具栏按钮定义（固定顺序）
const TOOLBAR_BUTTONS = [
    {
        id: "main",
        title: "打开剧场",
        icon: "fa-solid fa-masks-theater",
        cssClass: "main",
        handler: () => openMainWindow()
    },
    {
        id: "outline",
        title: "故事大纲",
        icon: "fa-solid fa-list-check",
        cssClass: "outline",
        handler: async () => {
            const { openStoryOutlineWindow } = await import("./storyOutlineWindow.js");
            openStoryOutlineWindow();
        }
    },
    {
        id: "settings",
        title: "设置",
        icon: "fa-solid fa-gear",
        cssClass: "settings",
        handler: () => openSettingsWindow()
    },
    {
        id: "favs",
        title: "收藏夹",
        icon: "fa-solid fa-star",
        cssClass: "favs",
        handler: async () => {
            const { openFavsWindow } = await import("./favsWindow.js");
            // 需要先打开主窗口，因为收藏夹依赖主窗口的 overlay
            const { ensureOverlay } = await import("../utils/dom.js");
            ensureOverlay();
            openFavsWindow();
        }
    },
    {
        id: "scripts",
        title: "剧本管理",
        icon: "fa-solid fa-scroll",
        cssClass: "scripts",
        handler: async () => {
            const { openScriptManager } = await import("./scriptManager.js");
            const { ensureOverlay } = await import("../utils/dom.js");
            ensureOverlay();
            openScriptManager();
        }
    },
    {
        id: "debug",
        title: "提示词审查",
        icon: "fa-solid fa-bug",
        cssClass: "debug",
        handler: async () => {
            const { showDebugInfo } = await import("./debugWindow.js");
            const { ensureOverlay } = await import("../utils/dom.js");
            ensureOverlay();
            showDebugInfo();
        }
    }
];

/**
 * 检查快捷工具栏是否启用
 * @returns {boolean} 是否启用
 */
function isToolbarEnabled() {
    const settings = getExtData();
    const toolbarConfig = settings.quick_toolbar || {};
    return toolbarConfig.enabled === true;
}

/**
 * 获取已启用的工具栏按钮列表
 * @returns {Array} 启用的按钮定义数组
 */
function getEnabledToolbarButtons() {
    const settings = getExtData();
    const toolbarConfig = settings.quick_toolbar || {};
    const enabledItems = toolbarConfig.enabled_items || {
        main: true,
        outline: false,
        model: false,
        settings: true,
        favs: false,
        scripts: false,
        debug: false
    };
    const maxItems = toolbarConfig.max_items || 5;

    // 按固定顺序过滤出已启用的按钮
    const enabledButtons = TOOLBAR_BUTTONS.filter(btn => enabledItems[btn.id] === true);

    // 限制最大数量
    return enabledButtons.slice(0, maxItems);
}

/**
 * 处理悬浮球点击事件
 * 根据快捷工具栏启用状态决定行为（不再阻止生成时打开窗口）
 */
function handleFloatingButtonClick() {
    // 根据工具栏设置决定行为（无论是否正在生成）
    if (isToolbarEnabled()) {
        // 启用快捷工具栏：展开子菜单
        toggleSlideMenu();
    } else {
        // 禁用快捷工具栏：直接打开主窗口
        openMainWindow();
    }
}

/**
 * 显示横向图标菜单（多功能菜单）
 */
export function showSlideMenu() {
    if (slideMenuVisible) return;

    const $btn = $("#titania-float-btn");
    if (!$btn.length) return;

    const btnRect = $btn[0].getBoundingClientRect();
    const btnSize = $btn.outerWidth() || 56;

    // 判断悬浮球在屏幕左侧还是右侧
    const isOnLeft = btnRect.left < window.innerWidth / 2;

    // 创建遮罩（用于点击外部关闭）
    const backdrop = $(`<div id="titania-menu-backdrop" class="t-root"></div>`);

    // 动态构建菜单内容（横向图标栏，无文字标签）
    // 不再根据生成状态切换，始终显示功能按钮
    const enabledButtons = getEnabledToolbarButtons();
    const menuContent = enabledButtons.map(btn => `
        <div class="t-menu-icon-btn ${btn.cssClass}" data-btn-id="${btn.id}" title="${btn.title}">
            <i class="${btn.icon}"></i>
        </div>
    `).join('');

    // 创建横向菜单容器
    const slideMenu = $(`
        <div id="titania-slide-menu" class="t-horizontal t-root">
            ${menuContent}
        </div>
    `);

    // 横向菜单定位：与悬浮球垂直居中，水平排列在侧边
    const gap = 10;
    const menuTop = btnRect.top + btnSize / 2;

    if (isOnLeft) {
        // 悬浮球在左侧，菜单向右展开
        slideMenu.css({
            left: (btnRect.right + gap) + "px",
            top: menuTop + "px",
            transform: "translateY(-50%)"
        });
    } else {
        // 悬浮球在右侧，菜单向左展开
        slideMenu.css({
            right: (window.innerWidth - btnRect.left + gap) + "px",
            top: menuTop + "px",
            transform: "translateY(-50%)"
        });
    }

    $("body").append(backdrop);
    $("body").append(slideMenu);

    // 延迟添加 show 类以触发动画
    requestAnimationFrame(() => {
        backdrop.addClass("show");
        slideMenu.addClass("show");
        // 依次显示图标按钮
        slideMenu.find(".t-menu-icon-btn").each(function (index) {
            setTimeout(() => $(this).addClass("show"), index * 40);
        });
    });

    slideMenuVisible = true;

    // 绑定事件
    const bindClick = ($el, handler) => {
        $el.on("click touchend", function (e) {
            e.preventDefault();
            e.stopPropagation();
            handler(e);
        });
    };

    // 动态绑定工具栏按钮事件
    slideMenu.find(".t-menu-icon-btn[data-btn-id]").each(function () {
        const btnId = $(this).data("btn-id");
        const btnDef = TOOLBAR_BUTTONS.find(b => b.id === btnId);
        if (btnDef && btnDef.handler) {
            bindClick($(this), async () => {
                hideSlideMenu();
                await btnDef.handler();
            });
        }
    });

    // 点击遮罩关闭菜单
    bindClick(backdrop, () => {
        hideSlideMenu();
    });
}

/**
 * 隐藏侧边滑出菜单
 */
export function hideSlideMenu() {
    const $menu = $("#titania-slide-menu");
    const $backdrop = $("#titania-menu-backdrop");

    $menu.removeClass("show");
    $backdrop.removeClass("show");

    setTimeout(() => {
        $menu.remove();
        $backdrop.remove();
    }, 300);

    slideMenuVisible = false;
}

/**
 * 切换侧边菜单显示状态
 */
export function toggleSlideMenu() {
    if (slideMenuVisible) {
        hideSlideMenu();
    } else {
        showSlideMenu();
    }
}

/**
 * 显示中止按钮（兼容旧接口，现在不自动显示，改为点击展开）
 */
export function showCancelButton() {
    // 新逻辑：不再自动显示，改为用户点击悬浮球时展开侧边菜单
    // 保留空函数以保持 API 兼容性
}

/**
 * 隐藏中止按钮
 */
export function hideCancelButton() {
    hideSlideMenu();
}

/**
 * 启动悬浮球计时器并开始加载动画
 */
export function startTimer() {
    // 检查是否启用计时器显示
    const settings = getExtData();
    const app = settings.appearance || {};

    GlobalState.timerStartTime = Date.now();

    // 添加加载动画类
    const $btn = $("#titania-float-btn");
    const animClass = getCurrentAnimationClass();
    $btn.addClass("t-loading " + animClass);

    if (app.show_timer === false) return; // 用户关闭了计时功能

    // 显示计时器元素并更新位置
    const $timer = $("#titania-timer");
    $timer.addClass("show").text("0.0");
    updateTimerPosition();

    // 清除可能存在的旧计时器
    if (GlobalState.timerInterval) {
        clearInterval(GlobalState.timerInterval);
    }

    // 启动新计时器，每 100ms 更新一次
    GlobalState.timerInterval = setInterval(() => {
        const elapsed = (Date.now() - GlobalState.timerStartTime) / 1000;
        $timer.text(elapsed.toFixed(1));
    }, 100);
}

/**
 * 停止悬浮球计时器并移除加载动画
 */
export function stopTimer() {
    if (GlobalState.timerInterval) {
        clearInterval(GlobalState.timerInterval);
        GlobalState.timerInterval = null;
    }

    // 计算最终耗时
    const elapsed = Date.now() - GlobalState.timerStartTime;
    GlobalState.lastGenerationTime = elapsed;

    // 移除加载动画类
    const $btn = $("#titania-float-btn");
    $btn.removeClass("t-loading t-anim-ripple t-anim-arc");

    // 检查是否启用计时器显示
    const settings = getExtData();
    const app = settings.appearance || {};
    if (app.show_timer === false) return; // 用户关闭了计时功能

    // 显示最终结果，2秒后淡出
    const $timer = $("#titania-timer");
    $timer.text((elapsed / 1000).toFixed(1)).addClass("done");

    setTimeout(() => {
        $timer.removeClass("show done");
    }, 2000);
}

/**
 * 更新计时器位置（跟随悬浮球）
 */
function updateTimerPosition() {
    const $btn = $("#titania-float-btn");
    const $timer = $("#titania-timer");

    if (!$btn.length || !$timer.length) return;

    const btnRect = $btn[0].getBoundingClientRect();
    const timerWidth = $timer.outerWidth() || 40;
    const timerHeight = $timer.outerHeight() || 20;
    const gap = 6; // 元素间距

    // 计时器水平居中对齐悬浮球
    const left = btnRect.left + (btnRect.width / 2) - (timerWidth / 2);

    // 计时器直接在悬浮球上方（侧边菜单不影响计时器位置）
    const top = btnRect.top - timerHeight - gap;

    $timer.css({
        left: Math.max(5, left) + "px",
        top: Math.max(5, top) + "px"
    });
}

// 动画类型映射（仅保留脉冲波纹和电磁闪烁）
export const ANIMATION_CLASSES = {
    ripple: "t-anim-ripple",
    arc: "t-anim-arc"
};

/**
 * 获取当前动画类型
 */
function getCurrentAnimationClass() {
    const settings = getExtData();
    const app = settings.appearance || {};
    const animationType = app.animation || "ripple";
    return ANIMATION_CLASSES[animationType] || ANIMATION_CLASSES.ripple;
}

/**
 * 创建/刷新悬浮球
 */
export function createFloatingButton() {
    destroyFloatingButton();
    $("#titania-float-style").remove();

    // 检查开关（getExtData() 返回的即 extension_settings[extensionName]）
    const settings = getExtData();
    if (settings.enabled !== true) {
        return;
    }

    const app = settings.appearance || { type: "emoji", content: "🎭", size: 56, animation: "ripple", border_color: "#90cdf4", bg_color: "#2b2b2b", border_opacity: 100, bg_opacity: 100 };
    const size = parseInt(app.size) || 56;
    const animationType = app.animation || "ripple";
    const borderColor = app.border_color || "#90cdf4";
    const bgColor = app.bg_color || "#2b2b2b";
    const borderOpacity = app.border_opacity !== undefined ? app.border_opacity : 100;
    const bgOpacity = app.bg_opacity !== undefined ? app.bg_opacity : 100;
    const rawAppContent = typeof app.content === "string" ? app.content.trim() : "";
    const isImageDataUri = rawAppContent.toLowerCase().startsWith("data:image/");

    // 旧配置兼容：内容是图片但类型被错误保存为 emoji 时自动修正
    if (isImageDataUri && app.type !== "image") {
        app.type = "image";
        if (!settings.appearance) {
            settings.appearance = app;
        }
        saveExtData();
    }

    // 辅助函数：将 HEX 颜色转换为带透明度的 RGBA
    const hexToRgba = (hex, opacity) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!result) return hex;
        const r = parseInt(result[1], 16);
        const g = parseInt(result[2], 16);
        const b = parseInt(result[3], 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity / 100})`;
    };

    // 计算带透明度的颜色
    const borderColorRgba = hexToRgba(borderColor, borderOpacity);
    const bgColorRgba = hexToRgba(bgColor, bgOpacity);

    // 1. 创建悬浮球元素（优先根据内容判定是否图片）
    const btnText = app.content ?? "🎭";
    const btnContent = isImageDataUri
        ? `<img src="${app.content}">`
        : `<span style="position:relative; z-index:2;">${btnText}</span>`;

    const btn = $(`<div id="titania-float-btn" class="t-root" data-animation="${animationType}">${btnContent}</div>`);

    // 2. 创建计时器元素
    const timer = $(`<div id="titania-timer" class="t-root">0.0s</div>`);

    // 3. 应用动态尺寸、边框颜色和背景颜色（带透明度）
    btn.css({
        "--t-size": `${size}px`,
        "--t-border-color": borderColor,
        "--t-border-color-rgba": borderColorRgba,
        "--t-bg-color": bgColorRgba,
        "--t-border-opacity": borderOpacity / 100,
        "--t-bg-opacity": bgOpacity / 100
    });

    $("body").append(btn);
    $("body").append(timer);

    refreshFloatTuckCache();
    applyFloatingPosition(btn, size);

    // 3. 拖拽逻辑 (修正边界计算)
    let isDragging = false, startX, startY, initialLeft, initialTop;

    btn.on("touchstart mousedown", function (e) {
        isDragging = false;
        const evt = e.type === 'touchstart' ? e.originalEvent.touches[0] : e;
        startX = evt.clientX; startY = evt.clientY;
        const rect = this.getBoundingClientRect(); initialLeft = rect.left; initialTop = rect.top;
        $(this).css({ "transition": "none", "transform": "none" });
    });

    $(document).on("touchmove.titaniaFloatDrag mousemove.titaniaFloatDrag", function (e) {
        if (startX === undefined) return;
        const evt = e.type === 'touchmove' ? e.originalEvent.touches[0] : e;
        if (Math.abs(evt.clientX - startX) > 5 || Math.abs(evt.clientY - startY) > 5) isDragging = true;
        let l = initialLeft + (evt.clientX - startX), t = initialTop + (evt.clientY - startY);
        const position = clampFloatingPosition(l, t, size);
        btn.css({ left: position.left + "px", top: position.top + "px", right: "auto" });

        // 拖动时同步更新计时器位置
        updateTimerPosition();
    });

    // 分离点击和拖拽逻辑
    // 仅在 btn 上监听 touchend/mouseup 处理点击
    btn.on("touchend mouseup", function (e) {
        if (startX === undefined) return;

        // 如果发生了拖拽
        if (isDragging) {
            isDragging = false;
            startX = undefined;
            // 停在松手的位置，不做吸附
            saveFloatingPosition(btn, size);
            hideSlideMenu();
            return;
        }

        // 如果没有拖拽，视为点击
        startX = undefined;

        // 阻止事件冒泡，防止触发 document 上的其他逻辑
        e.stopPropagation();
        // 在移动端防止触发 click
        if (e.type === 'touchend') e.preventDefault();

        btn.removeClass("t-notify");
        handleFloatingButtonClick();
    });

    // document 上的监听仅用于处理拖拽过程中的释放（如果鼠标移出了按钮）
    $(document).on("touchend.titaniaFloatDrag mouseup.titaniaFloatDrag touchcancel.titaniaFloatDrag", function () {
        if (startX === undefined) return;

        if (isDragging) {
            saveFloatingPosition(btn, size);
            hideSlideMenu();
        }

        startX = undefined;
        isDragging = false;
    });

    // 窗口缩放或横竖屏切换后，按当前设备类型保存的比例恢复并校正边界。
    $(window).on("resize.titaniaFloatPosition orientationchange.titaniaFloatPosition", function () {
        if (floatResizeTimer) clearTimeout(floatResizeTimer);
        floatResizeTimer = setTimeout(() => {
            floatResizeTimer = null;
            applyFloatingPosition(btn, size);
            hideSlideMenu();
        }, 120);
    });
}
