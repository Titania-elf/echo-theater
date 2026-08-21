import { getRequestHeaders } from "../../../../script.js";
import { extensionTypes } from "../../../extensions.js";
import { CURRENT_VERSION } from "../config/defaults.js";

const EXTENSION_ID = "third-party/titania-theater";
const EXTENSION_NAME = "titania-theater";
const CHANGELOG_URL = "https://raw.githubusercontent.com/Titania-elf/titania-theater/main/changelog.json";
const DISMISSED_KEY = "titania-update-dismissed";

let availableUpdate = null;
let checkSequence = 0;
let isInstalling = false;

function compareVersions(left, right) {
    const leftParts = String(left).split(".").map(Number);
    const rightParts = String(right).split(".").map(Number);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index++) {
        const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
        if (difference !== 0) return difference > 0 ? 1 : -1;
    }

    return 0;
}

function isVersion(value) {
    return /^\d+\.\d+\.\d+$/.test(String(value));
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function renderChangelogContent(content) {
    return escapeHtml(content)
        .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
}

async function fetchAvailableUpdates() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const response = await fetch(`${CHANGELOG_URL}?t=${Date.now()}`, {
            cache: "no-store",
            signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const changelog = await response.json();
        if (!changelog || typeof changelog !== "object" || Array.isArray(changelog)) {
            throw new Error("更新日志格式无效");
        }

        const versions = Object.keys(changelog)
            .filter(isVersion)
            .sort((left, right) => compareVersions(right, left));
        const latestVersion = versions[0];
        if (!latestVersion || compareVersions(latestVersion, CURRENT_VERSION) <= 0) return null;

        return {
            latestVersion,
            entries: versions
                .filter(version => compareVersions(version, CURRENT_VERSION) > 0)
                .map(version => ({ version, content: String(changelog[version] || "") }))
        };
    } finally {
        clearTimeout(timeout);
    }
}

function getExtensionType() {
    const id = Object.keys(extensionTypes).find(key => key === EXTENSION_ID || key.endsWith(`/${EXTENSION_NAME}`));
    return id ? extensionTypes[id] : "";
}

async function updateExtension() {
    const response = await fetch("/api/extensions/update", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            extensionName: EXTENSION_NAME,
            global: getExtensionType() === "global"
        })
    });

    if (!response.ok) {
        const message = (await response.text()).trim();
        if (response.status === 403) throw new Error("当前账户没有更新全局扩展的权限。");
        throw new Error(message || `更新失败（HTTP ${response.status}）`);
    }

    return response.json();
}

function setVersionBadge(hasUpdate) {
    const $badge = $("#titania-version-badge");
    if (!$badge.length) return;
    $badge
        .toggleClass("has-update", hasUpdate)
        .text(hasUpdate ? `v${CURRENT_VERSION} · 可更新` : `v${CURRENT_VERSION}`);
}

function renderUpdateCard(state, update = null, errorMessage = "") {
    const $card = $("#titania-update-card");
    if (!$card.length) return;

    const $check = $("#titania-update-check");
    const $actions = $("#titania-update-actions");
    const $error = $("#titania-update-inline-error");
    const isChecking = state === "checking";

    $card.attr("data-state", state);
    $("#titania-update-current-version").text(`v${CURRENT_VERSION}`);
    $check
        .prop("disabled", isChecking || isInstalling)
        .html(isChecking
            ? '<i class="fa-solid fa-spinner fa-spin"></i>'
            : '<i class="fa-solid fa-rotate-right"></i>');
    $error.prop("hidden", !errorMessage).text(errorMessage);

    if (state === "available" && update) {
        $("#titania-update-status").text(`发现新版本 v${update.latestVersion}`);
        $("#titania-update-latest-version").text(`v${update.latestVersion}`);
        $("#titania-update-latest-row").prop("hidden", false);
        $actions.prop("hidden", false);
        $("#titania-update-details, #titania-update-install").prop("disabled", isInstalling);
        setVersionBadge(true);
        return;
    }

    $("#titania-update-latest-row").prop("hidden", true);
    $actions.prop("hidden", true);
    setVersionBadge(false);

    if (state === "checking") {
        $("#titania-update-status").text("正在检查更新...");
    } else if (state === "error") {
        $("#titania-update-status").text("暂时无法检查更新");
    } else {
        $("#titania-update-status").text("当前已是最新版本");
    }
}

async function checkForUpdates(showDialog = false) {
    const sequence = ++checkSequence;
    renderUpdateCard("checking");

    try {
        const update = await fetchAvailableUpdates();
        if (sequence !== checkSequence) return;

        availableUpdate = update;
        if (!update) {
            renderUpdateCard("current");
            return;
        }

        renderUpdateCard("available", update);
        if (showDialog && sessionStorage.getItem(DISMISSED_KEY) !== update.latestVersion) {
            showUpdateDialog(update);
        }
    } catch (error) {
        if (sequence !== checkSequence) return;
        availableUpdate = null;
        console.warn("Titania: 更新检测失败", error);
        const message = error?.name === "AbortError"
            ? "检查更新超时，请稍后重试。"
            : `检查失败：${error?.message || "无法获取更新日志"}`;
        renderUpdateCard("error", null, message);
    }
}

function setInstallState(installing) {
    isInstalling = installing;
    $("#titania-update-check, #titania-update-details").prop("disabled", installing);
    $("#titania-update-install")
        .prop("disabled", installing)
        .html(installing
            ? '<i class="fa-solid fa-spinner fa-spin"></i> 正在更新...'
            : '<i class="fa-solid fa-download"></i> 立即更新');
    $("#titania-update-close, #titania-update-later").prop("disabled", installing);
    $("#titania-update-now")
        .prop("disabled", installing)
        .html(installing
            ? '<i class="fa-solid fa-spinner fa-spin"></i><span>正在更新...</span>'
            : '<i class="fa-solid fa-download"></i><span>立即更新</span>');
}

async function installAvailableUpdate(update) {
    if (!update || isInstalling) return;

    const $dialogError = $("#titania-update-error");
    const $inlineError = $("#titania-update-inline-error");
    $dialogError.prop("hidden", true).text("");
    $inlineError.prop("hidden", true).text("");
    setInstallState(true);

    try {
        await updateExtension();
        sessionStorage.setItem(DISMISSED_KEY, update.latestVersion);
        $("#titania-update-status").text("更新完成，正在刷新...");
        $("#titania-update-install").html('<i class="fa-solid fa-circle-check"></i> 更新完成');
        $("#titania-update-now").html('<i class="fa-solid fa-circle-check"></i><span>更新完成，正在刷新...</span>');
        setTimeout(() => location.reload(), 500);
    } catch (error) {
        console.error("Titania: 自动更新失败", error);
        const message = error?.message || "更新失败，请检查 SillyTavern 服务端日志后重试。";
        setInstallState(false);
        $dialogError.prop("hidden", false).text(message);
        $inlineError.prop("hidden", false).text(message);
    }
}

function showUpdateDialog(update) {
    if (document.getElementById("titania-update-overlay")) return;

    const entriesHtml = update.entries.map(entry => `
        <section class="titania-update-entry">
            <h3>v${escapeHtml(entry.version)}</h3>
            <div>${renderChangelogContent(entry.content)}</div>
        </section>
    `).join("");

    $("body").append(`
        <div id="titania-update-overlay" class="titania-update-overlay t-root">
            <div class="titania-update-dialog" role="dialog" aria-modal="true" aria-labelledby="titania-update-title">
                <header class="titania-update-header">
                    <div>
                        <span class="titania-update-kicker">回声工具箱更新</span>
                        <h2 id="titania-update-title">v${escapeHtml(update.latestVersion)} 已发布</h2>
                    </div>
                    <button id="titania-update-close" class="titania-update-close" type="button" aria-label="稍后更新">&times;</button>
                </header>
                <main class="titania-update-body">${entriesHtml}</main>
                <div id="titania-update-error" class="titania-update-error" role="alert" hidden></div>
                <footer class="titania-update-footer">
                    <button id="titania-update-later" class="menu_button" type="button">稍后</button>
                    <button id="titania-update-now" class="menu_button menu_button_icon" type="button">
                        <i class="fa-solid fa-download"></i><span>立即更新</span>
                    </button>
                </footer>
            </div>
        </div>
    `);

    const dismiss = () => {
        if (isInstalling) return;
        sessionStorage.setItem(DISMISSED_KEY, update.latestVersion);
        $("#titania-update-overlay").remove();
    };

    $("#titania-update-close, #titania-update-later").on("click", dismiss);
    $("#titania-update-overlay").on("click", event => {
        if (event.target.id === "titania-update-overlay") dismiss();
    });

    $("#titania-update-now").on("click", () => installAvailableUpdate(update));
}

export async function initExtensionUpdate() {
    $("#titania-update-current-version").text(`v${CURRENT_VERSION}`);
    $("#titania-update-check").off("click.titaniaUpdate").on("click.titaniaUpdate", () => {
        void checkForUpdates(false);
    });
    $("#titania-update-details").off("click.titaniaUpdate").on("click.titaniaUpdate", () => {
        if (availableUpdate) showUpdateDialog(availableUpdate);
    });
    $("#titania-update-install").off("click.titaniaUpdate").on("click.titaniaUpdate", () => {
        void installAvailableUpdate(availableUpdate);
    });

    await checkForUpdates(true);
}
