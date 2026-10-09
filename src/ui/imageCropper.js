// src/ui/imageCropper.js
//
// 悬浮球自定义图片的头像式裁剪器：圆形固定取景框，拖动平移、滚轮/双指/滑杆缩放，
// 确认后把取景框内的区域烘焙成一张正方形 data URI。
//
// 为什么是「烘焙」而不是存裁剪参数：存参数（scale/offset）要在 floatingBtn 的 <img>、
// 设置页预览球、上传卡片背景三处各自复现同一套 object-position/transform 数学，还要给
// appearance 加一个持久化字段。烘焙则让 appearance.content 的语义完全不变 —— 它依旧只是
// 一个 data:image/... 字符串，所有既有渲染方一行都不用改。
//
// ── 坐标系（很容易写错，改这里之前先读完）────────────────────────────
// panNatX / panNatY 存的是**图像自然像素**，不是显示像素。
//   显示像素下图片中心恒在「框宽/2 + offsetX」，于是取景框中心底下的自然点
//   u = W/2 - offsetX/k 会随缩放系数 k 漂移 —— 用户把一张脸拖到圆心后一缩放，
//   那张脸就跑掉了。换成自然像素后 u = W/2 - panNatX 与 k 无关，
//   缩放天然锚定取景框中心，不需要额外补偿。
//   代价：每次改 scale 都必须重新钳制。可见区边长 srcSize = 框宽/k 随放大而变小，
//   钳制上限 (W - srcSize)/2 随之变大；放大顶到边界后再缩小，若不重新钳制会让
//   srcX 变负 —— drawImage 会把越界的源矩形裁掉一部分再映射到目标区一角，
//   画出一条**偏心**的透明带。render() 里统一做这件事。
//   缩到「整图进圆」那一段，limit 归 0、图片自动居中，源矩形越界是**有意的**，
//   见下一节。
//
// ── 缩放范围：cover(1×) ~ 整图落进取景圆 ───────────────────────────
// scale 的基准是 cover —— 1 表示图片刚好铺满取景框（measure() 里的 baseScale），
// 打开时就是 1，预览仍然是一颗满的球。
//   下限却**不是** 1：宽高比非 1:1 的图，缩到 1 就再也缩不动了 —— cover 已经把
//   长边撑满、短边裁掉，滑块左端成了死区，用户拿到的只有「放大」。所以下限按图算：
//   整张图的对角线缩到等于取景框边长，即 min(宽,高)/对角线。
//   取景框是正方形里挖出的内切圆，只有缩到这一步，整张图才真的完整落进圆内 ——
//   而圆形悬浮球里能显示的全部正是这个圆（球是 border-radius: 50%，
//   输出又是正方的，取景圆 ≡ 球面）。再往下缩只会让图更小，到此为止。
//   缩出来那圈留白（图小于框的范围）导出后是透明的，球里透出的是球自己的背景色。

import { ensureOverlay } from "../utils/dom.js";

const OUTPUT_SIZE_DEFAULT = 512;
const OUTPUT_QUALITY_DEFAULT = 0.92;
// 缩放的基准是 cover，1 = 铺满取景框，也就是打开时的状态。
// 下限随每张图的宽高比变化，见 createSession 里的 scaleMin。
const SCALE_DEFAULT = 1;
const SCALE_MAX = 4;
// 滚轮缩放灵敏度：deltaY 经指数映射后乘到 scale 上
const WHEEL_ZOOM_RATE = 0.0015;

/** 当前打开的裁剪会话；同一时刻只允许一个 */
let activeSession = null;
/** 代次号：关闭/替换时自增，用来作废还在等待图片解码的那次打开流程 */
let sessionSeq = 0;

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 关闭当前裁剪弹窗（若有）。按「用户取消」处理，promise 以 null 结束。
 *
 * 供设置窗口的 teardown 调用：弹窗挂在 #t-overlay 上，而设置窗口关闭时
 * #t-overlay 未必被移除（主窗口还在时会被保留），不主动收就会留下一个孤儿弹窗。
 */
export function closeImageCropper() {
    shutdown(null);
}

function shutdown(result) {
    sessionSeq += 1;
    const session = activeSession;
    activeSession = null;
    if (session) session.dispose(result);
}

/**
 * 打开裁剪弹窗。
 *
 * @param {{src: string, outputSize?: number, quality?: number}} options
 *        src 可以是 object URL，也可以是 data URI。
 * @returns {Promise<string|null>} 裁剪后的 data URI；用户取消返回 null；
 *          图片无法解码时 reject（调用方负责提示，此时不会改动任何设置）。
 */
export function openImageCropper(options = {}) {
    const src = typeof options.src === "string" ? options.src : "";
    const outputSize = Math.round(clampNumber(options.outputSize, 64, 2048, OUTPUT_SIZE_DEFAULT));
    const quality = clampNumber(options.quality, 0.1, 1, OUTPUT_QUALITY_DEFAULT);

    // 上一个还开着就直接替换掉（它按「取消」结束）
    shutdown(null);
    const seq = sessionSeq;

    if (!src) return Promise.reject(new Error("没有可裁剪的图片"));

    return loadImage(src).then(
        (image) => new Promise((resolve) => {
            // 等待解码期间被 closeImageCropper() 关掉了，就不再挂弹窗
            if (seq !== sessionSeq) {
                resolve(null);
                return;
            }
            activeSession = createSession({ image, outputSize, quality, resolve });
        }),
        (error) => {
            // 期间被关掉的话不该再抛给调用方 —— 他已经在关窗了
            if (seq !== sessionSeq) return null;
            throw error;
        }
    );
}

/** 先解码再开弹窗：解码失败时不该闪一个立刻消失的空弹窗 */
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            // SVG 无固有尺寸时会走到这里；放过去会让后面的 baseScale 变成 Infinity
            if (!image.naturalWidth || !image.naturalHeight) {
                reject(new Error("这张图片没有可用的像素尺寸，请换一张"));
                return;
            }
            resolve(image);
        };
        image.onerror = () => {
            reject(new Error("无法读取这张图片，请换一张（需要浏览器能解码的常见图片格式）"));
        };
        image.src = src;
    });
}

function createSession({ image, outputSize, quality, resolve }) {
    let settled = false;

    const $modal = $(`
        <div id="t-crop-modal" class="t-dialog-overlay t-root">
            <div class="t-crop-panel t-dialog-panel" role="dialog" aria-modal="true" aria-label="裁剪图片">
                <div class="t-dialog-header">
                    <span>裁剪图片</span>
                    <span class="t-dialog-close" id="t-crop-close" role="button" tabindex="0" aria-label="取消">&times;</span>
                </div>
                <div class="t-crop-stage" id="t-crop-stage">
                    <div class="t-crop-frame"></div>
                </div>
                <p class="t-crop-hint">拖动图片调整位置，滚轮、双指或下方滑杆缩放（向左缩到底可看全整张图）</p>
                <div class="t-crop-zoom-row">
                    <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
                    <input type="range" class="t-crop-zoom" id="t-crop-zoom" min="100" max="400" step="1" value="100" aria-label="缩放">
                    <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
                </div>
                <p class="t-crop-error" id="t-crop-error" style="display:none"></p>
                <div class="t-crop-actions">
                    <button type="button" class="t-btn t-btn--ghost" id="t-crop-reset">重置</button>
                    <span class="t-crop-actions-right">
                        <button type="button" class="t-btn t-btn--ghost" id="t-crop-cancel">取消</button>
                        <button type="button" class="t-btn t-btn--primary" id="t-crop-confirm">确定</button>
                    </span>
                </div>
            </div>
        </div>
    `);

    const $stage = $modal.find("#t-crop-stage");
    const $zoom = $modal.find("#t-crop-zoom");
    const $error = $modal.find("#t-crop-error");
    const $confirm = $modal.find("#t-crop-confirm");
    const stage = $stage[0];

    // ⚠ 图片必须排在 .t-crop-frame 之前：两者都是 positioned + z-index:auto，
    //   靠 DOM 顺序决定绘制先后，挖空用的 frame 要压在上面。
    image.className = "t-crop-image";
    image.alt = "";
    image.draggable = false;
    $stage.prepend(image);

    ensureOverlay();
    $("#t-overlay").append($modal);

    const naturalW = image.naturalWidth;
    const naturalH = image.naturalHeight;
    // 缩小下限：整张图完整落进取景圆，即对角线 = 取景框边长。
    // 与 cover 基准的比值 = min(宽,高)/对角线，只由宽高比决定、与框的大小无关，
    // 所以只算这一次（measure() 里重算的那部分才是随窗口变的）。
    const scaleMin = Math.min(naturalW, naturalH) / Math.hypot(naturalW, naturalH);
    let stageSize = 0;
    let baseScale = 1;
    const state = { scale: SCALE_DEFAULT, panNatX: 0, panNatY: 0 };

    let drag = null;
    let pinch = null;

    // ── 几何 ────────────────────────────────────────────────
    function measure() {
        stageSize = stage.getBoundingClientRect().width || parseFloat(window.getComputedStyle(stage).width) || 1;
        baseScale = Math.max(stageSize / naturalW, stageSize / naturalH); // cover：图片始终铺满取景框
    }

    function metrics() {
        const k = baseScale * state.scale;
        return { k, dispW: naturalW * k, dispH: naturalH * k, srcSize: stageSize / k };
    }

    function clampPan() {
        const { srcSize } = metrics();
        const limitX = Math.max(0, (naturalW - srcSize) / 2);
        const limitY = Math.max(0, (naturalH - srcSize) / 2);
        state.panNatX = Math.min(limitX, Math.max(-limitX, state.panNatX));
        state.panNatY = Math.min(limitY, Math.max(-limitY, state.panNatY));
    }

    function render() {
        clampPan();
        const { k, dispW, dispH } = metrics();
        image.style.width = `${dispW}px`;
        image.style.height = `${dispH}px`;
        image.style.left = `${(stageSize - dispW) / 2 + state.panNatX * k}px`;
        image.style.top = `${(stageSize - dispH) / 2 + state.panNatY * k}px`;
    }

    function syncZoom() {
        $zoom.val(String(Math.round(state.scale * 100)));
    }

    function setScale(next) {
        state.scale = Math.min(SCALE_MAX, Math.max(scaleMin, next));
        render();
        syncZoom();
    }

    function reset() {
        state.scale = SCALE_DEFAULT;
        state.panNatX = 0;
        state.panNatY = 0;
        render();
        syncZoom();
    }

    // ── 拖动 / 缩放 ─────────────────────────────────────────
    function beginDrag(clientX, clientY) {
        drag = { x: clientX, y: clientY, panX: state.panNatX, panY: state.panNatY };
        $stage.addClass("is-dragging");
    }

    function moveDrag(clientX, clientY) {
        if (!drag) return;
        const { k } = metrics();
        state.panNatX = drag.panX + (clientX - drag.x) / k;
        state.panNatY = drag.panY + (clientY - drag.y) / k;
        render();
    }

    function endDrag() {
        drag = null;
        $stage.removeClass("is-dragging");
    }

    function touchDistance(a, b) {
        return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    function touchMid(a, b) {
        return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    }

    function onTouchStart(e) {
        const touches = e.touches;
        if (touches.length >= 2) {
            endDrag();
            pinch = {
                dist: touchDistance(touches[0], touches[1]),
                mid: touchMid(touches[0], touches[1]),
                scale: state.scale,
                panX: state.panNatX,
                panY: state.panNatY
            };
        } else if (touches.length === 1) {
            pinch = null;
            beginDrag(touches[0].clientX, touches[0].clientY);
        }
        // 阻止合成鼠标事件与页面滚动；舞台另有 touch-action: none 兜底
        e.preventDefault();
    }

    function onTouchMove(e) {
        const touches = e.touches;
        if (pinch && touches.length >= 2) {
            const dist = touchDistance(touches[0], touches[1]);
            const mid = touchMid(touches[0], touches[1]);
            const ratio = pinch.dist > 0 ? dist / pinch.dist : 1;
            state.scale = Math.min(SCALE_MAX, Math.max(scaleMin, pinch.scale * ratio));
            const { k } = metrics();
            // 捏合的同时按两指中点位移平移
            state.panNatX = pinch.panX + (mid.x - pinch.mid.x) / k;
            state.panNatY = pinch.panY + (mid.y - pinch.mid.y) / k;
            render();
            syncZoom();
        } else if (drag && touches.length === 1) {
            moveDrag(touches[0].clientX, touches[0].clientY);
        }
        e.preventDefault();
    }

    function onTouchEnd(e) {
        const touches = e.touches;
        if (!touches.length) {
            endDrag();
            pinch = null;
        } else if (touches.length === 1) {
            // 双指松开一根，接着用剩下那根继续拖
            pinch = null;
            beginDrag(touches[0].clientX, touches[0].clientY);
        }
        e.preventDefault();
    }

    function onWheel(e) {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
        setScale(state.scale * Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE));
    }

    function onResize() {
        // panNat 存的是自然像素，与分辨率无关：改窗口只会让取景框变大，
        // 用户当前对准的构图不会漂移。
        measure();
        render();
    }

    // ── 输出 ───────────────────────────────────────────────
    function toDataUrlSafe(canvas, mime, q) {
        try {
            return q === undefined ? canvas.toDataURL(mime) : canvas.toDataURL(mime, q);
        } catch (err) {
            // 画布被跨域资源污染时抛 SecurityError（例如 SVG 里引了外链）
            return "";
        }
    }

    function buildCroppedDataUrl() {
        const { srcSize } = metrics();
        const srcX = naturalW / 2 - state.panNatX - srcSize / 2;
        const srcY = naturalH / 2 - state.panNatY - srcSize / 2;

        const canvas = document.createElement("canvas");
        canvas.width = outputSize;
        canvas.height = outputSize;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("当前浏览器不支持 canvas，无法导出裁剪结果");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(image, srcX, srcY, srcSize, srcSize, 0, 0, outputSize, outputSize);

        // WebP 保留透明通道且体积远小于 PNG（这张图要进 settings.json）。
        // 不支持的浏览器会回落到 png，所以下面显式再要一次 png。
        let dataUrl = toDataUrlSafe(canvas, "image/webp", quality);
        if (!dataUrl.startsWith("data:image/webp")) {
            dataUrl = toDataUrlSafe(canvas, "image/png");
        }
        if (!dataUrl || dataUrl === "data:,") throw new Error("无法导出裁剪结果");
        return dataUrl;
    }

    // ── 生命周期 ────────────────────────────────────────────
    function unbind() {
        $(document).off(".titaniaCrop");
        $(window).off(".titaniaCrop");
        $stage.off(".titaniaCrop");
        $modal.off(".titaniaCrop");
        stage.removeEventListener("wheel", onWheel);
        stage.removeEventListener("touchstart", onTouchStart);
        stage.removeEventListener("touchmove", onTouchMove);
        stage.removeEventListener("touchend", onTouchEnd);
        stage.removeEventListener("touchcancel", onTouchEnd);
    }

    function finish(result) {
        if (settled) return;
        settled = true;
        if (activeSession === session) activeSession = null;
        unbind();
        $modal.remove();
        resolve(result);
    }

    function showError(message) {
        $error.text(message).css("display", "");
    }

    const session = { dispose: (result) => finish(result) };

    // ── 事件绑定 ────────────────────────────────────────────
    $stage.on("mousedown.titaniaCrop", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        beginDrag(e.clientX, e.clientY);
    });
    $(document).on("mousemove.titaniaCrop", (e) => {
        if (drag) moveDrag(e.clientX, e.clientY);
    });
    $(document).on("mouseup.titaniaCrop", () => {
        if (drag) endDrag();
    });

    // 原生监听是为了能显式声明 passive:false（jQuery 的 .on 传不了这个选项）
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("touchstart", onTouchStart, { passive: false });
    stage.addEventListener("touchmove", onTouchMove, { passive: false });
    stage.addEventListener("touchend", onTouchEnd, { passive: false });
    stage.addEventListener("touchcancel", onTouchEnd, { passive: false });
    $(window).on("resize.titaniaCrop orientationchange.titaniaCrop", onResize);

    $zoom.on("input.titaniaCrop", function () {
        setScale((parseFloat(this.value) || 100) / 100);
    });

    $modal.find("#t-crop-reset").on("click.titaniaCrop", reset);
    $modal.find("#t-crop-cancel").on("click.titaniaCrop", () => finish(null));
    $modal.find("#t-crop-close").on("click.titaniaCrop", () => finish(null));
    $modal.find("#t-crop-close").on("keydown.titaniaCrop", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            finish(null);
        }
    });

    $confirm.on("click.titaniaCrop", () => {
        try {
            finish(buildCroppedDataUrl());
        } catch (err) {
            // 导出失败就留在弹窗里让用户重试或取消，不要把 content 写坏
            showError(err?.message || "裁剪失败，请重试");
        }
    });

    // 点遮罩取消（弹窗面板自身的点击不算）
    $modal.on("click.titaniaCrop", (e) => {
        if (e.target === $modal[0]) finish(null);
    });

    $(document).on("keydown.titaniaCrop", (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            finish(null);
            return;
        }
        if (e.key === "Tab") trapTab(e);
    });

    // 把 Tab 圈在弹窗内：遮罩挡得住鼠标，挡不住键盘 ——
    // 不圈的话焦点能跑到背后设置窗口的「保存」，回车会触发 teardown。
    function trapTab(e) {
        const focusables = $modal
            .find("button, input, [tabindex]:not([tabindex='-1'])")
            .filter(":visible")
            .toArray();
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const inside = $modal[0].contains(active);
        if (e.shiftKey && (!inside || active === first)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (!inside || active === last)) {
            e.preventDefault();
            first.focus();
        }
    }

    measure();
    // 滑块左端 = 缩到整图进圆的那一格。向下取整：四舍五入到 71 会让最左一格
    // 停在 scaleMin 之上，用户把滑杆推到底也差一口气看不到整张图。
    $zoom.attr("min", String(Math.floor(scaleMin * 100)));
    reset();
    $confirm[0].focus();

    return session;
}
