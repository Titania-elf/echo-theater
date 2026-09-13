// src/ui/outlineEntryButton.js

import { getExtData } from "../utils/storage.js";

const BTN_ID = "titania-outline-entry-btn";
const ANCHOR_SELECTOR = "#send_but";
const MENU_ID = "titania-outline-entry-menu";
const SCENE_PLANS_KEY = "story_outline_plans";
const SCENE_SOURCE_PLAN_KEY = "story_outline_scene_source_plan_id";
let observerBound = false;

function isEnabled() {
    const data = getExtData();
    return data?.outline_entry?.enabled === true;
}

function removeButton() {
    $(`#${BTN_ID}`).remove();
    closeMenu();
}

function closeMenu() {
    $(`#${MENU_ID}`).remove();
    $(document).off("mousedown.titaniaOutlineMenu");
    $(window).off("resize.titaniaOutlineMenu");
    $(window).off("scroll.titaniaOutlineMenu");
}

function getSavedPlanCount() {
    const data = getExtData();
    const plans = data?.[SCENE_PLANS_KEY];
    return Array.isArray(plans) ? plans.length : 0;
}

function hasSceneSourcePlan() {
    const data = getExtData();
    return typeof data?.[SCENE_SOURCE_PLAN_KEY] === "string" && data[SCENE_SOURCE_PLAN_KEY].trim().length > 0;
}

function getEnabledFeatureList(data) {
    const toolbarItems = data?.quick_toolbar?.enabled_items || {};
    const showTheater = data?.outline_entry?.show_theater === true;
    const showOutlineActions = data?.outline_entry?.show_outline_actions === true;
    const rewriteEnabled = data?.rewrite_entry?.enabled === true;
    const features = [];
    if (showTheater) features.push("theater");
    if (showOutlineActions) features.push("outline_actions");
    if (rewriteEnabled) features.push("rewrite");
    return features;
}

async function openFeatureDirect(featureKey, canOpenScenes) {
    switch (featureKey) {
        case "theater": {
            const { openMainWindow } = await import("./mainWindow.js");
            openMainWindow();
            return;
        }
        case "outline_actions": {
            const { openStoryOutlineWindow } = await import("./storyOutlineWindow.js");
            openStoryOutlineWindow();
            return;
        }
        case "rewrite": {
            const { openRewritePanelFromMenu } = await import("./rewriteEntryButton.js");
            openRewritePanelFromMenu();
            return;
        }
        default:
            return;
    }
}

async function tryOpenSingleFeatureDirect() {
    const data = getExtData();
    if (data?.outline_entry?.enabled !== true) return false;

    const features = getEnabledFeatureList(data);
    if (features.length !== 1) return false;

    const hasPlans = getSavedPlanCount() > 0;
    const hasSource = hasSceneSourcePlan();
    const canOpenScenes = hasPlans && hasSource;
    await openFeatureDirect(features[0], canOpenScenes);
    return true;
}

async function openMenu($btn) {
    // 菜单样式已迁至 css/04-features/outline-entry-menu.css，随插件 CSS 一同加载，
    // 不再需要运行时注入（原 ensureMenuStyle()）。
    closeMenu();

    const data = getExtData();
    const rewriteEnabled = data?.rewrite_entry?.enabled === true;
    const showTheater = data?.outline_entry?.show_theater === true;
    const showOutlineActions = data?.outline_entry?.show_outline_actions === true;
    const hasPlans = getSavedPlanCount() > 0;
    const hasSource = hasSceneSourcePlan();
    const canOpenScenes = hasPlans && hasSource;
    const menuHtml = `
    <div id="${MENU_ID}" role="menu" aria-label="故事大纲入口">
        ${showOutlineActions ? `<button class="t-outline-entry-item" id="t-outline-entry-open-scenes" role="menuitem" ${canOpenScenes ? "" : "disabled"}>
            <i class="fa-solid fa-clapperboard"></i> 剧情推进
        </button>` : ""}
        ${showTheater ? `<button class="t-outline-entry-item" id="t-outline-entry-open-theater" role="menuitem">
            <i class="fa-solid fa-masks-theater"></i> 回声小剧场
        </button>` : ""}
        ${showOutlineActions ? `<button class="t-outline-entry-item" id="t-outline-entry-open-outline" role="menuitem">
            <i class="fa-solid fa-list-check"></i> 生成大纲
        </button>` : ""}
        ${rewriteEnabled ? '<button class="t-outline-entry-item" id="t-outline-entry-open-rewrite" role="menuitem"><i class="fa-solid fa-highlighter"></i> 文本改写</button>' : ''}
        ${hasPlans ? (hasSource ? "" : '<div class="t-outline-entry-tip">请先在方案页选择剧情推进来源方案</div>') : '<div class="t-outline-entry-tip">请先保存至少一个方案</div>'}
    </div>`;

    $("body").append(menuHtml);
    const $menu = $(`#${MENU_ID}`);
    const rect = $btn[0].getBoundingClientRect();
    const menuWidth = $menu.outerWidth() || 180;
    const menuHeight = $menu.outerHeight() || 120;
    let left = rect.right - menuWidth;
    let top = rect.top - menuHeight - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
    top = Math.max(8, top);
    $menu.css({ left: `${left}px`, top: `${top}px` });

    if (showOutlineActions) {
        $("#t-outline-entry-open-outline").on("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
            const { openStoryOutlineWindow } = await import("./storyOutlineWindow.js");
            openStoryOutlineWindow();
        });

        $("#t-outline-entry-open-scenes").on("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!canOpenScenes) return;
            closeMenu();
            const { openSceneHubWindow } = await import("./storyOutlineWindow.js");
            openSceneHubWindow();
        });
    }

    if (showTheater) {
        $("#t-outline-entry-open-theater").on("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
            const { openMainWindow } = await import("./mainWindow.js");
            openMainWindow();
        });
    }

    $("#t-outline-entry-open-rewrite").on("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        const { openRewritePanelFromMenu } = await import("./rewriteEntryButton.js");
        openRewritePanelFromMenu();
    });

    setTimeout(() => {
        $(document).on("mousedown.titaniaOutlineMenu", (evt) => {
            if ($(evt.target).closest(`#${MENU_ID}, #${BTN_ID}`).length > 0) return;
            closeMenu();
        });
    }, 0);
    $(window).on("resize.titaniaOutlineMenu scroll.titaniaOutlineMenu", closeMenu);
}

function bindClick($btn) {
    $btn.off("click").on("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if ($(`#${MENU_ID}`).length > 0) {
            closeMenu();
            return;
        }
        const openedDirectly = await tryOpenSingleFeatureDirect();
        if (openedDirectly) return;
        await openMenu($btn);
    });

    $btn.off("keydown").on("keydown", async (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        if ($(`#${MENU_ID}`).length > 0) {
            closeMenu();
            return;
        }
        const openedDirectly = await tryOpenSingleFeatureDirect();
        if (openedDirectly) return;
        await openMenu($btn);
    });
}

function ensureButton() {
    const $anchor = $(ANCHOR_SELECTOR);
    if ($anchor.length === 0) {
        removeButton();
        return;
    }

    let $btn = $(`#${BTN_ID}`);
    if ($btn.length === 0) {
        $btn = $(`
            <div id="${BTN_ID}" class="interactable" role="button" tabindex="0" title="回声工具箱菜单" aria-label="回声工具箱菜单">
                <i class="fa-solid">&#xf518;</i>
            </div>
        `);
        $anchor.after($btn);
    }

    bindClick($btn);
}

function syncEntryButton() {
    if (!isEnabled()) {
        removeButton();
        return;
    }
    ensureButton();
}

function bindDomObserver() {
    if (observerBound) return;
    observerBound = true;

    const obs = new MutationObserver(() => {
        syncEntryButton();
    });

    obs.observe(document.body, { childList: true, subtree: true });
}

export function initOutlineEntryButton() {
    bindDomObserver();
    syncEntryButton();
}

export function refreshOutlineEntryButton() {
    syncEntryButton();
}
