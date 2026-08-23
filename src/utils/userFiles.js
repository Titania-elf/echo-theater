// src/utils/userFiles.js
//
// <user>/user/files/ 的读写原语。
//
// 为什么单独一个模块
// ------------------
// 这几个函数原本是 src/core/favsStore.js 的模块私有实现（收藏搬家时写的）。
// 剧本存储要用完全同一套（同一个上传接口、同一套 base64 分块、同一个去缓存策略），
// 复制第二份就是 CLAUDE.md 记着的那类事故：CSS 文件清单曾写过两份并已漂移，
// 导致开发模式下整窗无样式。所以这里抽成共享原语，两个 store 都从这里取。
//
// 落点说明（原 favsStore.js 文件头的记录，搬到这里）：
//   · <user>/user/files 是 ST 的 USER_DIRECTORY_TEMPLATE 成员（src/constants.js:43），
//     每次启动由 ensurePublicDirectoriesExist() 保证存在（src/users.js:109）。
//   · 写盘由 ST 服务端进程完成，浏览器不直接碰文件系统，
//     因此与移动端的存储授权无关。
//   · 读取路径 /user/files/* 由 src/users.js:1081 映射到该目录。
//   · 上传是 writeFileSyncAtomic（src/endpoints/files.js:44）：同名路径原子覆写，
//     不改名、不去重，且崩溃不会留下截断文件。「整表写同一个文件」因此是安全的。

import { getRequestHeaders } from "../../../../script.js";
import { TitaniaLogger } from "../core/logger.js";

/** base64 分块大小。String.fromCharCode.apply 对十万级参数会爆栈，
 *  而实测单条收藏正文最大已达 127 KB */
const BASE64_CHUNK = 0x8000;

export function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ""));
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + BASE64_CHUNK));
    }
    return btoa(binary);
}

export function utf8ByteLength(text) {
    return new TextEncoder().encode(String(text ?? "")).length;
}

/**
 * 上传一个文本文件到 <user>/user/files/。
 * @param {string} fileName
 * @param {string} text
 * @returns {Promise<string>} 服务端返回的相对路径，形如 /user/files/xxx.json
 */
export async function uploadTextFile(fileName, text) {
    const response = await fetch("/api/files/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: fileName, data: utf8ToBase64(text) })
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`上传 ${fileName} 失败（${response.status}）${detail ? `：${detail}` : ""}`);
    }

    const payload = await response.json();
    const filePath = String(payload?.path || "").trim();
    if (!filePath) throw new Error(`上传 ${fileName} 后服务端未返回路径`);
    return filePath;
}

/**
 * 读取一个文本文件。
 *
 * 缓存处理：/user/files/* 走 res.sendFile，带 ETag/Last-Modified 但没有显式
 * Cache-Control，浏览器会按启发式规则判定新鲜度。ST 自带的 getFileAttachment()
 * 用的是 cache:"force-cache"，那会在启发式新鲜期内直接吃旧内容 ——
 * 内容被编辑过就会读到改之前的版本。这里改用 no-cache（仍能走 304）
 * 并额外挂 rev 查询串，双重保证拿到的是当前版本。
 *
 * @param {string} filePath /user/files/xxx.json
 * @param {number} [rev]
 * @returns {Promise<string>}
 */
export async function fetchTextFile(filePath, rev = 0) {
    const url = rev > 0 ? `${filePath}?rev=${encodeURIComponent(rev)}` : filePath;
    const response = await fetch(url, {
        method: "GET",
        cache: "no-cache",
        headers: getRequestHeaders()
    });

    if (!response.ok) {
        throw new Error(`读取 ${filePath} 失败（${response.status}）`);
    }
    return response.text();
}

/**
 * 删除一个文件。
 * @param {string} filePath
 * @param {{ label?: string }} [options] label 只影响失败日志的措辞
 * @returns {Promise<boolean>} 文件已不存在也算成功
 */
export async function deleteUserFile(filePath, options = {}) {
    const label = options.label || "文件";
    const target = String(filePath || "").trim();
    if (!target) return false;

    const response = await fetch("/api/files/delete", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ path: target })
    });

    if (response.status === 404) return true;
    if (!response.ok) {
        TitaniaLogger.warn(`删除${label}失败（${response.status}）：${target}`);
        return false;
    }
    return true;
}

/**
 * 批量确认文件是否真的存在于磁盘上。
 * 这是「写完回头检查」的唯一手段：上传接口返回 200 只说明请求被接受了。
 * @param {string[]} filePaths
 * @param {{ label?: string }} [options] label 只影响错误信息的措辞
 * @returns {Promise<Record<string, boolean>>}
 */
export async function verifyUserFiles(filePaths, options = {}) {
    const label = options.label || "文件";
    const urls = (Array.isArray(filePaths) ? filePaths : []).map(p => String(p || "")).filter(Boolean);
    if (urls.length === 0) return {};

    const response = await fetch("/api/files/verify", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ urls })
    });

    if (!response.ok) {
        throw new Error(`校验${label}失败（${response.status}）`);
    }
    return await response.json();
}
