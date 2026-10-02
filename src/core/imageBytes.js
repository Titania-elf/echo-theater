// 图片字节解析：MIME 嗅探与尺寸读取。纯函数，不依赖 DOM API、酒馆或 Cosmos。
//
// 为什么不用 createImageBitmap：它在 jsdom 与 Node 下都不存在，测试夹具跑不起来，
// 只能靠打桩糊弄，等于没测。头部解析是同步的、确定性的，在现有 vm 夹具里能真正验证。
//
// 为什么必须有嗅探：Cosmos 公开接口返回的 Blob 不带类型字段，而 validateIllustrationBlob()
// 第一步就要求 blob.type 是已知图片类型，type 为空会直接判成「仅支持 PNG、JPEG 和 WebP」。

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const WEBP_VP8_START_CODE = [0x9d, 0x01, 0x2a];

export const MIME_PNG = "image/png";
export const MIME_JPEG = "image/jpeg";
export const MIME_WEBP = "image/webp";

/** 尺寸读取默认只取前 1 MiB：PNG 与 WebP 的头部在固定小偏移，JPEG 的 SOF 也几乎总在早期。 */
export const IMAGE_PREFIX_BYTES = 1024 * 1024;

function startsWith(bytes, sequence, offset = 0) {
    if (bytes.length < offset + sequence.length) return false;
    for (let index = 0; index < sequence.length; index++) {
        if (bytes[offset + index] !== sequence[index]) return false;
    }
    return true;
}

function readUint16BE(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32BE(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint16LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LE(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function positiveSize(width, height) {
    const valid = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
    return valid ? { width, height } : null;
}

/**
 * 按魔数判断图片类型。不做宽松兜底：认不出来就返回 null，由调用方决定怎么报错。
 * @param {Uint8Array} bytes 文件头字节
 * @returns {"image/png"|"image/jpeg"|"image/webp"|null}
 */
export function sniffImageMime(bytes) {
    if (!(bytes instanceof Uint8Array)) return null;
    if (startsWith(bytes, PNG_SIGNATURE)) return MIME_PNG;
    if (startsWith(bytes, JPEG_SIGNATURE)) return MIME_JPEG;
    if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return MIME_WEBP;
    return null;
}

/** PNG：8 字节签名 + 4 字节长度 + "IHDR" 之后是宽高，各 4 字节大端。 */
function readPngSize(bytes) {
    if (bytes.length < 24) return null;
    if (!startsWith(bytes, [0x49, 0x48, 0x44, 0x52], 12)) return null;
    return positiveSize(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

/**
 * JPEG：逐个跳过段，直到 SOF 段。
 * SOF 布局为 FF Cx + 长度(2) + 精度(1) + 高(2) + 宽(2)；DHT/JPG/DAC 不是 SOF，要排除。
 */
function readJpegSize(bytes) {
    let offset = 2;
    while (offset + 3 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const marker = bytes[offset + 1];
        if (marker === 0xff) { offset += 1; continue; }
        // 无载荷标记：TEM 与 RSTn。
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        // EOI 或 SOS：压缩数据从 SOS 开始，SOF 本该已经出现过。
        if (marker === 0xd9 || marker === 0xda) return null;
        if (offset + 3 >= bytes.length) return null;
        const length = readUint16BE(bytes, offset + 2);
        if (length < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
            if (offset + 8 >= bytes.length) return null;
            return positiveSize(readUint16BE(bytes, offset + 7), readUint16BE(bytes, offset + 5));
        }
        offset += 2 + length;
    }
    return null;
}

/** WebP：按 VP8X（扩展）/ VP8L（无损）/ VP8（有损）三种块头取尺寸。 */
function readWebpSize(bytes) {
    if (bytes.length < 16) return null;
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X") {
        if (bytes.length < 30) return null;
        return positiveSize(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1);
    }
    if (chunk === "VP8L") {
        if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
        const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
        return positiveSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8 ") {
        if (bytes.length < 30 || !startsWith(bytes, WEBP_VP8_START_CODE, 23)) return null;
        return positiveSize(readUint16LE(bytes, 26) & 0x3fff, readUint16LE(bytes, 28) & 0x3fff);
    }
    return null;
}

/**
 * 读取图片宽高。认不出类型或尺寸非法时返回 null。
 * @param {Uint8Array} bytes 文件字节（或足以覆盖头部的前缀）
 * @returns {{width:number,height:number}|null}
 */
export function readImageSize(bytes) {
    if (!(bytes instanceof Uint8Array)) return null;
    const mime = sniffImageMime(bytes);
    if (mime === MIME_PNG) return readPngSize(bytes);
    if (mime === MIME_JPEG) return readJpegSize(bytes);
    if (mime === MIME_WEBP) return readWebpSize(bytes);
    return null;
}

/**
 * 嗅探 Blob 的真实类型与尺寸，并补上缺失的类型标记。
 * 返回 null 表示「不是可识别的图片」，由调用方决定报错文案。
 * @param {Blob} blob 供应方返回的原始字节
 * @returns {Promise<{blob:Blob,mimeType:string,width:number,height:number}|null>}
 */
export async function inspectImageBlob(blob) {
    if (!(blob instanceof Blob) || !blob.size) return null;
    const prefixLength = Math.min(blob.size, IMAGE_PREFIX_BYTES);
    const prefix = new Uint8Array(await blob.slice(0, prefixLength).arrayBuffer());
    const mimeType = sniffImageMime(prefix);
    if (!mimeType) return null;
    let size = readImageSize(prefix);
    if (!size && blob.size > prefixLength) {
        // 罕见情形：超长 EXIF 把 JPEG 的 SOF 挤到 1 MiB 之后。退回整份读取。
        size = readImageSize(new Uint8Array(await blob.arrayBuffer()));
    }
    if (!size) return null;
    const typed = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
    return { blob: typed, mimeType, width: size.width, height: size.height };
}
