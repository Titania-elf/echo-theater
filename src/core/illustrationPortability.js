import { getExtData } from "../utils/storage.js";
import { uploadTextFile } from "../utils/userFiles.js";
import {
    ILLUSTRATION_INDEX_KEY, MAX_IMAGE_BYTES, illustrationError, illustrationHash,
    isIllustrationPath, newIllustrationId, normalizeSavedIllustration, validateIllustrationBlob,
} from "./illustrationData.js";
import {
    blobToIllustrationDataUrl, flushIllustrationWrites, readSceneIllustrations, uploadIllustrationBlob,
} from "./illustrationStore.js";

function collectPaths(value, result = new Set()) {
    if (typeof value === "string") {
        for (const match of value.matchAll(/\/user\/files\/titania-illustration-[a-zA-Z0-9-]+\.(?:png|jpg|webp)/g)) result.add(match[0]);
    } else if (Array.isArray(value)) value.forEach(item => collectPaths(item, result));
    else if (value && typeof value === "object") Object.values(value).forEach(item => collectPaths(item, result));
    return result;
}

export function replaceIllustrationPaths(value, replacements) {
    if (typeof value === "string") {
        return value.replace(/\/user\/files\/titania-illustration-[a-zA-Z0-9-]+\.(?:png|jpg|webp)/g, path => replacements[path] || path);
    }
    if (Array.isArray(value)) return value.map(item => replaceIllustrationPaths(item, replacements));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIllustrationPaths(item, replacements)]));
    return value;
}

async function loadAsset(path) {
    if (!isIllustrationPath(path)) throw illustrationError("配图路径无效。");
    const response = await fetch(path, { cache: "no-cache" });
    if (!response.ok) throw illustrationError(`配图文件读取失败（${response.status}），已停止导出以免遗漏图片。`);
    const blob = await response.blob();
    await validateIllustrationBlob(blob);
    return blob;
}

/** 输出自包含配图包；不把图片 base64 常驻 settings.json。 */
export async function exportIllustrationBackup(favorites = []) {
    await flushIllustrationWrites();
    const scenes = [];
    for (const sceneId of Object.keys(getExtData()[ILLUSTRATION_INDEX_KEY] || {})) {
        scenes.push(await readSceneIllustrations(sceneId));
    }
    const paths = collectPaths([scenes, favorites]);
    if (!scenes.length && !paths.size) return undefined;
    const assets = {};
    // 顺序读取避免大量收藏图片同时解码占满移动端内存。
    for (const path of paths) assets[path] = await blobToIllustrationDataUrl(await loadAsset(path));
    return { v: 1, scenes, assets };
}

export function decodeIllustrationDataUrl(value) {
    if (typeof value !== "string" || value.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100) throw illustrationError("备份图片过大或格式错误。");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    if (!match) throw illustrationError("备份图片格式无效。");
    const binary = atob(match[2]);
    return new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: match[1] });
}

/** 先上传所有图片/记录，再返回新的设置快照；失败不覆盖当前设置。 */
export async function restoreIllustrationBackup(bundle, data) {
    const next = structuredClone(data);
    const referenced = collectPaths(next.favs || []);
    if (!bundle) {
        if (referenced.size || Object.keys(next[ILLUSTRATION_INDEX_KEY] || {}).length) throw illustrationError("备份含配图引用但缺少图片文件，无法完整恢复。");
        delete next[ILLUSTRATION_INDEX_KEY];
        return next;
    }
    if (bundle.v !== 1 || !Array.isArray(bundle.scenes) || !bundle.assets || typeof bundle.assets !== "object" || Array.isArray(bundle.assets)) throw illustrationError("配图备份版本或结构无效。");
    const ids = new Set();
    for (const record of bundle.scenes) {
        if (record?.v !== 1 || !/^scene-[a-zA-Z0-9-]+$/.test(record.sceneId) || ids.has(record.sceneId) || !Array.isArray(record.images)) throw illustrationError("备份场景记录无效。");
        ids.add(record.sceneId);
        record.images.forEach(normalizeSavedIllustration);
        if (record.selectedId !== null && !record.images.some(image => image.id === record.selectedId)) throw illustrationError("备份缺少当前采用的图片。");
    }
    collectPaths(bundle.scenes, referenced);
    for (const path of referenced) if (!Object.hasOwn(bundle.assets, path)) throw illustrationError("备份中缺少被引用的配图，已停止恢复。");
    // 在任何写入前校验所有二进制。
    for (const [path, encoded] of Object.entries(bundle.assets)) {
        if (!isIllustrationPath(path)) throw illustrationError("备份包含不支持的图片路径。");
        await validateIllustrationBlob(decodeIllustrationDataUrl(encoded));
    }
    const replacements = {};
    for (const [path, encoded] of Object.entries(bundle.assets)) replacements[path] = await uploadIllustrationBlob(decodeIllustrationDataUrl(encoded));
    const index = {};
    for (const source of bundle.scenes) {
        const record = replaceIllustrationPaths(source, replacements);
        const file = await uploadTextFile(`titania-scene-${illustrationHash(record.sceneId)}-${newIllustrationId()}.json`, JSON.stringify(record));
        index[record.sceneId] = { file, rev: 1 };
    }
    const restored = replaceIllustrationPaths(next, replacements);
    restored[ILLUSTRATION_INDEX_KEY] = index;
    return restored;
}

/** 独立 HTML / 复制 HTML 用内嵌图片，离开酒馆后仍可显示。 */
export async function embedIllustrationsInHtml(html) {
    const replacements = {};
    for (const path of collectPaths(String(html || ""))) replacements[path] = await blobToIllustrationDataUrl(await loadAsset(path));
    return replaceIllustrationPaths(String(html || ""), replacements);
}
