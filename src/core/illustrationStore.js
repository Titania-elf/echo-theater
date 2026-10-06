import { getExtData, saveExtDataImmediate } from "../utils/storage.js";
import { fetchTextFile, uploadTextFile, deleteUserFile } from "../utils/userFiles.js";
import { getRequestHeaders } from "../../../../script.js";
import {
    ILLUSTRATION_INDEX_KEY, illustrationError, illustrationExtension, illustrationHash,
    newIllustrationId, normalizeSavedIllustration, validateIllustrationBlob,
} from "./illustrationData.js";

const writes = new Map();
const cache = new Map();
let writeTail = Promise.resolve();

function pointer(sceneId) { return getExtData()[ILLUSTRATION_INDEX_KEY]?.[sceneId]; }

export async function readSceneIllustrations(sceneId) {
    const ref = pointer(sceneId);
    if (!ref) return { v: 1, sceneId, selectedId: null, images: [] };
    const key = `${ref.file}:${ref.rev}`;
    if (cache.has(key)) return structuredClone(cache.get(key));
    if (!/^\/user\/files\/titania-scene-[a-zA-Z0-9-]+\.json$/.test(ref.file)) throw illustrationError("配图记录路径无效。");
    const record = JSON.parse(await fetchTextFile(ref.file, ref.rev));
    if (record?.v !== 1 || record.sceneId !== sceneId || !Array.isArray(record.images)) throw illustrationError("配图记录损坏，已停止写入以保护原数据。");
    record.images = record.images.map(normalizeSavedIllustration);
    if (record.selectedId !== null && !record.images.some(image => image.id === record.selectedId)) throw illustrationError("当前配图记录不完整。");
    cache.set(key, structuredClone(record));
    return record;
}

export function selectedIllustration(record) {
    return record?.images?.find(image => image.id === record.selectedId) || null;
}

function mutateScene(sceneId, mutate) {
    // 各场景共享 settings 中的索引，指针提交也需要串行。
    const previous = writeTail;
    const operation = previous.catch(() => {}).then(async () => {
        const record = await readSceneIllustrations(sceneId);
        mutate(record);
        const oldPointer = pointer(sceneId);
        const rev = (Number(oldPointer?.rev) || 0) + 1;
        // 每次不可变文件，设置指针保存失败时原记录仍可读。
        const fileName = `titania-scene-${illustrationHash(sceneId)}-${newIllustrationId()}.json`;
        const file = await uploadTextFile(fileName, JSON.stringify(record));
        const data = getExtData();
        data[ILLUSTRATION_INDEX_KEY] ||= {};
        data[ILLUSTRATION_INDEX_KEY][sceneId] = { file, rev };
        if (!await saveExtDataImmediate()) {
            if (oldPointer) data[ILLUSTRATION_INDEX_KEY][sceneId] = oldPointer;
            else delete data[ILLUSTRATION_INDEX_KEY][sceneId];
            throw illustrationError("图片已生成，但配图记录保存失败。请点击重试保存。", "SAVE_FAILED");
        }
        cache.set(`${file}:${rev}`, structuredClone(record));
        // 回收被本次改写取代的旧记录文件。
        // 位置刻意在**指针提交成功之后**：saveExtDataImmediate 失败时上面已经回滚指针并
        // 抛错，那条路径根本走不到这里 —— 提前删就会把仍在使用的记录删掉。
        // 删失败只留孤儿（占空间、不可读），绝不影响本次保存，所以吞掉。
        if (oldPointer?.file && oldPointer.file !== file) {
            try { await deleteUserFile(oldPointer.file, { label: "场景记录" }); } catch { /* 见上 */ }
        }
        window.dispatchEvent(new CustomEvent("titania:illustrations-changed", { detail: { sceneId } }));
        return record;
    });
    writes.set(sceneId, operation);
    writeTail = operation.catch(() => {});
    void operation.finally(() => { if (writes.get(sceneId) === operation) writes.delete(sceneId); }).catch(() => {});
    return operation;
}

export function blobToIllustrationDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("图片读取失败。"));
        reader.readAsDataURL(blob);
    });
}

export async function uploadIllustrationBlob(blob, id = newIllustrationId()) {
    await validateIllustrationBlob(blob);
    const name = `titania-illustration-${id}.${illustrationExtension(blob.type)}`;
    const dataUrl = await blobToIllustrationDataUrl(blob);
    const response = await fetch("/api/files/upload", {
        method: "POST", headers: getRequestHeaders(),
        body: JSON.stringify({ name, data: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
    });
    if (!response.ok) throw illustrationError(`图片保存失败（${response.status}），可以重试保存。`, "SAVE_FAILED");
    const payload = await response.json();
    if (payload.path !== `/user/files/${name}`) throw illustrationError("图片保存后返回了意外的文件路径。", "SAVE_FAILED");
    return payload.path;
}

/**
 * 保存一批生成的图片，采用第一张。
 *
 * 必须成批保存：mutateScene 每次都会写一份新的不可变记录文件并落一次设置，
 * 逐张调用会让一次多图生成产生 N 次记录写入。返回张数由后端自己决定
 * （Cosmos 按它的 imageCount，柏宝绘一次一张），所以多图是常态而非例外。
 *
 * pending.images[i].id 与 .filePath 在重试保存时保持不变，避免反复上传同一张图。
 */
export async function saveGeneratedIllustrations(sceneId, pending) {
    const items = Array.isArray(pending?.images) ? pending.images : [];
    if (!items.length) throw illustrationError("没有可保存的图片。", "SAVE_FAILED");

    const saved = [];
    for (const item of items) {
        item.id ||= newIllustrationId();
        item.filePath ||= await uploadIllustrationBlob(item.blob, item.id);
        saved.push(normalizeSavedIllustration({
            id: item.id,
            filePath: item.filePath,
            width: item.width,
            height: item.height,
            draft: pending.draft,
            // 后端报回来的实际种子（柏宝绘会给，Cosmos 不给）。存下来才能照原样复现这一张。
            seed: pending.seed,
            createdAt: pending.createdAt || Date.now(),
        }));
    }

    const adoptedId = saved[0].id;
    return mutateScene(sceneId, record => {
        for (const image of saved) {
            if (!record.images.some(existing => existing.id === image.id)) record.images.push(image);
        }
        record.selectedId = adoptedId;
    });
}

/** 单张保存：转发到批量版本，并把 id/filePath 回写到 pending 本身以保持旧调用方的契约。 */
export async function saveGeneratedIllustration(sceneId, pending) {
    try {
        return await saveGeneratedIllustrations(sceneId, { ...pending, images: [pending.image] });
    } finally {
        // 保存失败时也要回写：重试保存靠这两个字段复用已上传的字节。
        pending.id = pending.image.id;
        pending.filePath = pending.image.filePath;
    }
}

export function selectSceneIllustration(sceneId, imageId, savedImage = null) {
    return mutateScene(sceneId, record => {
        if (savedImage && savedImage.id === imageId && !record.images.some(image => image.id === imageId)) {
            record.images.push(normalizeSavedIllustration(savedImage));
        }
        if (imageId !== null && !record.images.some(image => image.id === imageId)) throw illustrationError("找不到这张配图。");
        record.selectedId = imageId;
    });
}

export async function flushIllustrationWrites() {
    await Promise.all([...writes.values()]);
}

/**
 * 删除若干张已保存的配图：先从记录里摘掉并修好 selectedId，再删掉不再被任何场景
 * 记录或收藏引用的图片文件。
 *
 * ⚠ targets 用 `{id, filePath}[]` 而不是 `id[]`：面板里那个对象可能来自 loadTarget
 *   注入的收藏快照，只存在于内存副本里，mutateScene 重读记录时根本看不到它。
 *   带着路径过来，即使记录里没有它也仍能把文件删掉（同 selectSceneIllustration
 *   的 savedImage 先例）。
 *
 * 三步的**顺序是承重的**（理由同 favsStore.removeFavsByIds：宁可留孤儿，也不要留悬空指针）：
 *   ① 先改记录 —— mutateScene 指针提交失败会回滚并抛错，那时一个文件都还没删
 *   ② 再算引用 —— 必须晚于 ①，此刻当前记录已不再引用它们，答案才正确
 *   ③ 最后删字节 —— 仍被引用的跳过，失败如实上报
 *
 * @param {string} sceneId
 * @param {Array<{id:string, filePath:string}>} targets
 * @param {object} [options]
 * @param {(paths:string[]) => Promise<Iterable<string>>} [options.collectReferenced]
 *   由调用方注入的引用查询（见 illustrationReferences.js）。**缺省时保守地把全部路径
 *   当成仍被引用 —— 只删记录、不删任何文件**：忘了接线宁可留孤儿文件，也不能毁掉收藏。
 * @returns {Promise<{record:object,removedIds:string[],removedPaths:string[],deletedFiles:string[],keptReferenced:string[],failedFiles:string[]}>}
 */
export async function deleteSceneIllustrations(sceneId, targets, options = {}) {
    const list = (Array.isArray(targets) ? targets : []).filter(target => target && target.id);
    if (!list.length) throw illustrationError("没有要删除的配图。", "INVALID_ARGS");
    const removeIds = new Set(list.map(target => String(target.id)));

    const record = await mutateScene(sceneId, current => {
        current.images = current.images.filter(image => !removeIds.has(String(image.id)));
        // ⚠ selectedId 必须在**同一次** mutate 里修好：readSceneIllustrations 见到
        //   「selectedId 非空却没有对应图片」会抛「当前配图记录不完整」，
        //   整条场景记录随之不可读 —— 画廊、主界面按钮、导出、备份会一起坏。
        //   接到剩余第一张；一张不剩就置空（等于「暂不展示配图」）。
        if (current.selectedId !== null && !current.images.some(image => image.id === current.selectedId)) {
            current.selectedId = current.images.length ? current.images[0].id : null;
        }
    });

    const paths = [...new Set(list.map(target => String(target.filePath || "")).filter(Boolean))];
    const referenced = typeof options.collectReferenced === "function"
        ? new Set(await options.collectReferenced(paths))
        : new Set(paths);

    const deletedFiles = [], keptReferenced = [], failedFiles = [];
    for (const path of paths) {
        if (referenced.has(path)) { keptReferenced.push(path); continue; }
        // deleteUserFile 从不抛；它把「本来就不存在」也算成功。
        if (await deleteUserFile(path, { label: "配图文件" })) deletedFiles.push(path);
        else failedFiles.push(path);
    }
    return { record, removedIds: [...removeIds], removedPaths: paths, deletedFiles, keptReferenced, failedFiles };
}
