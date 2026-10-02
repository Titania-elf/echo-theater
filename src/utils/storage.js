// src/utils/storage.js

// SillyTavern 核心模块导入
// 注意：这些路径在打包时会被标记为 external，保持原样
// 开发时相对路径: src/utils -> src -> titania-theater -> third-party -> extensions -> scripts
// 打包后相对路径: dist -> titania-theater -> third-party -> extensions -> scripts
import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced, saveSettings } from "../../../../script.js";
import { defaultSettings, extensionName } from "../config/defaults.js";
import { ensurePromptManager } from "../core/promptManager.js";
import { ensureCharacterProfiles } from "../core/characterProfiles.js";
import { ensureIllustrationPresets } from "../core/illustrationPresets.js";

// 获取扩展数据，如果不存在则初始化默认值
export function getExtData() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = JSON.parse(JSON.stringify(defaultSettings));
    }
    const changed = ensurePromptManager(extension_settings[extensionName]);
    const profilesChanged = ensureCharacterProfiles(extension_settings[extensionName]);
    // 选景预设的首次建立与旧「单块规范」迁移都在这里发生。
    const presetsChanged = ensureIllustrationPresets(extension_settings[extensionName]);
    if (changed || profilesChanged || presetsChanged) saveSettingsDebounced();
    return extension_settings[extensionName];
}

// 保存扩展数据 (防抖，用于常规保存)
export function saveExtData() {
    saveSettingsDebounced();
}

// 立即保存扩展数据 (不防抖，用于关键操作如备份恢复)
export async function saveExtDataImmediate() {
    try {
        await saveSettings();
        return true;
    } catch (e) {
        console.error("Titania: 立即保存失败", e);
        return false;
    }
}
