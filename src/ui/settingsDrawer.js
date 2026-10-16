// 扩展设置抽屉：分组折叠、开启数量和就地说明。功能开关仍由 entry.js 保存。
import { getExtData, saveExtData } from "../utils/storage.js";

const initializedRoots = new WeakSet();

export function refreshSettingsDrawer() {
    const root = document.getElementById("titania-settings-drawer");
    if (!root) return;

    root.querySelectorAll("[data-settings-parent]").forEach(section => {
        const control = document.getElementById(section.dataset.settingsParent);
        // 只改变显示，不清空子选项；重新开启时沿用原来的设置。
        section.hidden = control?.checked !== true;
    });
    root.querySelectorAll("[data-settings-group]").forEach(group => {
        const count = group.querySelectorAll("[data-settings-toggle]:checked").length;
        const status = group.querySelector(".titania-settings-count");
        const text = `已开启 ${count} 项`;
        if (status && status.textContent !== text) status.textContent = text;
    });
}

export function initSettingsDrawer() {
    const root = document.getElementById("titania-settings-drawer");
    if (!root) return;
    refreshSettingsDrawer();
    if (initializedRoots.has(root)) return;
    initializedRoots.add(root);

    const saved = getExtData().ui_prefs?.settings_drawer_groups;
    root.querySelectorAll("[data-settings-group]").forEach(group => {
        const id = group.dataset.settingsGroup;
        if (typeof saved?.[id] === "boolean") group.open = saved[id];
        let lastOpen = group.open;
        group.addEventListener("toggle", () => {
            // 恢复 open 属性也会触发 toggle，不把初始化当成一次用户修改。
            if (group.open === lastOpen) return;
            lastOpen = group.open;
            const data = getExtData();
            if (!data.ui_prefs || typeof data.ui_prefs !== "object") data.ui_prefs = {};
            data.ui_prefs.settings_drawer_groups = { ...data.ui_prefs.settings_drawer_groups, [id]: group.open };
            saveExtData();
        });
    });

    // 冒泡到抽屉时，各开关自己的处理器已更新关联状态（如音量为零时取消提示音勾选）。
    root.addEventListener("input", refreshSettingsDrawer);
    root.addEventListener("change", refreshSettingsDrawer);

    const setHelpOpen = (button, open) => {
        const panel = document.getElementById(button.getAttribute("aria-controls"));
        if (!panel || !root.contains(panel)) return;
        panel.hidden = !open;
        button.setAttribute("aria-expanded", String(open));
    };
    root.addEventListener("click", event => {
        const button = event.target.closest(".titania-settings-help");
        if (!button) return;
        const open = button.getAttribute("aria-expanded") !== "true";
        root.querySelectorAll('.titania-settings-help[aria-expanded="true"]').forEach(other => setHelpOpen(other, false));
        setHelpOpen(button, open);
    });
    root.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        const button = root.querySelector('.titania-settings-help[aria-expanded="true"]');
        if (!button) return;
        setHelpOpen(button, false);
        // 只在说明所在行内归还焦点，避免从其他分组把焦点拉走。
        if (button.closest(".titania-settings-item").contains(event.target)) button.focus();
        event.stopPropagation();
    });
}
