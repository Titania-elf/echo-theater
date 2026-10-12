// src/core/unlockChime.js
//
// 盲盒解锁的两声提示音——**运行时用 WebAudio 合成**，不带任何音频文件。
//
// ── 为什么不放一个 mp3 ──
// 这个扩展没有任何音频设施：build.js 只打包 JS 并把 CSS 内联进 index.js，没有 assets 目录，
// manifest.json 也只声明了 index.js。为一个 300ms 的音效新造一套"资源文件 + 打包 + 路径拼接"
// 的机制，收益远小于成本（还得赌 CSP 与相对路径）。合成的好处是零资源、零网络、可调音高，
// 而且两个提示音能写成同一个和声家族里的两个长度版本。
//
// ── 两个提示音 ──
//   事件解锁（chime）：C6 → G6，一个纯五度。**刻意只有两个音**——三个音往上走就是手机通知音了。
//   阶段通关（fanfare）：C6 → E6 → G6 → C7 的琶音，音更长、尾巴更亮，顶音压得比其它音低
//                        （不然最高的那个音最扎耳），另加一个 2.76× 的分音做钟感。
//   两条都是 C 大调、后者的前两个音就是前者 → 阶段通关听起来就是"同一句话说得更完整"。
//
// ── 自动播放策略（最容易踩的坑）──
// 解锁发生在 GENERATION_ENDED 之后，那**不是**用户手势。浏览器会把 AudioContext 挂成
// suspended：此时排队音符不会立刻响，而是等 context 恢复后**一起炸出来**。所以：
//   · 懒创建、单例（浏览器对同时存在的 AudioContext 数量有上限）；
//   · initUnlockSound() 在首次 pointerdown 时就 resume 一次（entry.js 里挂上）；
//   · 每次播放前检查 ctx.state === 'running'，不是 running 就只 resume 不排音符——
//     宁可这一声没有，也不要攒着以后一起响。

import { getExtData, saveExtData } from "../utils/storage.js";
import { TitaniaLogger } from "./logger.js";

/** 提示音设置：新顶层块（**别塞进 director**——settingsWindow 保存时会把那个对象整个换掉）。 */
const SOUND_KEY = "blindbox_reveal";

export const UNLOCK_SOUND_DEFAULTS = Object.freeze({
    enabled: true,
    volume: 30,       // 0–100；平方律映射到增益，30 已经不轻
    cue_event: true,  // 事件解锁的那一声可以单独关（只留里程碑的人很多）
});

/** 音量档位：面板底部那个按钮循环这几档（关 → 轻 → 中 → 响）。 */
export const UNLOCK_VOLUME_STEPS = Object.freeze([0, 30, 60, 90]);

export function getUnlockSoundConfig() {
    const raw = getExtData()?.[SOUND_KEY];
    const cfg = raw && typeof raw === "object" ? raw : {};
    const vol = Number(cfg.volume);
    return {
        enabled: cfg.enabled !== false, // 老用户没这个键 → 默认开
        volume: Number.isFinite(vol) ? Math.min(100, Math.max(0, Math.floor(vol))) : UNLOCK_SOUND_DEFAULTS.volume,
        cue_event: cfg.cue_event !== false,
    };
}

export function setUnlockSound(patch) {
    const data = getExtData();
    const prev = data[SOUND_KEY] && typeof data[SOUND_KEY] === "object" ? data[SOUND_KEY] : {};
    data[SOUND_KEY] = { ...UNLOCK_SOUND_DEFAULTS, ...prev, ...(patch || {}) };
    saveExtData();
    return getUnlockSoundConfig();
}

/** 面板底部按钮用：在档位之间循环，返回新的设置。 */
export function cycleUnlockVolume() {
    const cfg = getUnlockSoundConfig();
    if (cfg.enabled === false) return setUnlockSound({ enabled: true, volume: UNLOCK_VOLUME_STEPS[1] });
    const idx = UNLOCK_VOLUME_STEPS.indexOf(cfg.volume);
    const next = UNLOCK_VOLUME_STEPS[(idx < 0 ? 1 : idx + 1) % UNLOCK_VOLUME_STEPS.length];
    if (next === 0) return setUnlockSound({ enabled: false });
    return setUnlockSound({ enabled: true, volume: next });
}

/** 档位文案（面板按钮 / 设置提示共用）。 */
export function describeUnlockVolume(cfg = getUnlockSoundConfig()) {
    if (cfg.enabled === false || cfg.volume <= 0) return "已关闭";
    if (cfg.volume <= 35) return "轻";
    if (cfg.volume <= 70) return "中";
    return "响";
}

/* ------------------------------------------------------------------ *
 * 音频图：全页一个，懒建
 * ------------------------------------------------------------------ */

const CUES = {
    // 事件解锁：纯五度，短。peak 略低于 fanfare。
    chime: {
        gain: 1,
        notes: [
            { freq: 1046.5, at: 0.0, dur: 0.8, peak: 0.16 },  // C6
            { freq: 1568.0, at: 0.07, dur: 0.9, peak: 0.16 }, // G6
        ],
    },
    // 阶段通关：琶音 + 钟感分音，长尾。顶音压低。
    fanfare: {
        gain: 0.85,
        notes: [
            { freq: 1046.5, at: 0.0, dur: 1.6, peak: 0.16, bloom: true },  // C6
            { freq: 1318.5, at: 0.09, dur: 1.6, peak: 0.15, bloom: true }, // E6
            { freq: 1568.0, at: 0.18, dur: 1.6, peak: 0.14, bloom: true }, // G6
            { freq: 2093.0, at: 0.30, dur: 1.7, peak: 0.10, bloom: true }, // C7
        ],
    },
};

let ctx = null;
let master = null;
let graphFailed = false;
let resumeArmed = false;

function audioContextCtor() {
    if (typeof window === "undefined") return null;
    return window.AudioContext || window.webkitAudioContext || null;
}

function ensureGraph() {
    if (graphFailed) return null;
    if (ctx) return ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) {
        graphFailed = true;
        return null;
    }
    try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 0;

        // 总线上挂一个低通，削掉正弦叠加出来的那点毛刺感。
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 5200;

        const dry = ctx.createGain();
        dry.gain.value = 0.82;

        master.connect(lp);
        lp.connect(dry);
        dry.connect(ctx.destination);

        // 两个固定延迟抽头当"空间感"：比 ConvolverNode 便宜，也比合成脉冲响应好听。
        // createStereoPanner 在老 WebView 里可能没有 —— 有就左右分开，没有就退回普通增益。
        [[0.09, 0.18, -0.35], [0.17, 0.12, 0.35]].forEach(([time, wet, pan]) => {
            const delay = ctx.createDelay(1);
            delay.delayTime.value = time;
            const damp = ctx.createBiquadFilter();
            damp.type = "lowpass";
            damp.frequency.value = 3000;
            const g = ctx.createGain();
            g.gain.value = wet;
            lp.connect(delay);
            delay.connect(damp);
            damp.connect(g);
            if (typeof ctx.createStereoPanner === "function") {
                const p = ctx.createStereoPanner();
                p.pan.value = pan;
                g.connect(p);
                p.connect(ctx.destination);
            } else {
                g.connect(ctx.destination);
            }
        });
        return ctx;
    } catch (e) {
        graphFailed = true;
        ctx = null;
        master = null;
        TitaniaLogger.warn("解锁提示音初始化失败（已静默关闭）", e);
        return null;
    }
}

/** 首次用户手势时恢复音频上下文。幂等；由 entry.js 在初始化时挂上。 */
export function initUnlockSound() {
    if (resumeArmed || typeof document === "undefined") return;
    resumeArmed = true;
    const unlock = () => {
        try {
            const c = ensureGraph();
            if (c && c.state === "suspended") c.resume().catch(() => {});
        } catch (e) { /* 静默 */ }
        document.removeEventListener("pointerdown", unlock, true);
        document.removeEventListener("keydown", unlock, true);
    };
    document.addEventListener("pointerdown", unlock, true);
    document.addEventListener("keydown", unlock, true);
}

/** 单个音：正弦谐波堆 + 三角波起音（木槌感），线性起音避免爆音，指数衰减收尾。 */
function playNote(c, target, { freq, at = 0, dur = 0.8, peak = 0.16, bloom = false }) {
    const t0 = c.currentTime + 0.01 + at;
    const parts = [
        { ratio: 1, level: 1, type: "sine" },
        { ratio: 2, level: 0.18, type: "sine" },
        { ratio: 3, level: 0.07, type: "sine" },
    ];
    if (bloom) parts.push({ ratio: 2.76, level: 0.05, type: "sine" });

    parts.forEach(({ ratio, level, type }) => {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.value = freq * ratio;
        const top = peak * level;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(top, t0 + 0.007);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(target);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
    });

    // 起音瞬态：3ms 冲上去、60ms 掉下来的三角波，给"敲了一下"的那点定义度。
    const mallet = c.createOscillator();
    const mg = c.createGain();
    mallet.type = "triangle";
    mallet.frequency.value = freq;
    mg.gain.setValueAtTime(0.0001, t0);
    mg.gain.linearRampToValueAtTime(peak * 0.08, t0 + 0.003);
    mg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    mallet.connect(mg);
    mg.connect(target);
    mallet.start(t0);
    mallet.stop(t0 + 0.09);
}

/**
 * 播一个提示音。kind: 'event' | 'stage'。
 * 环境不支持、被静音、音量 0、上下文没跑起来 —— 一律安静地什么都不做。
 */
export function playUnlockCue(kind, options = {}) {
    const cfg = options.config || getUnlockSoundConfig();
    if (cfg.enabled === false || cfg.volume <= 0) return false;
    const cueName = kind === "stage" ? "fanfare" : "chime";
    const cue = CUES[cueName];
    if (!cue) return false;

    const c = ensureGraph();
    if (!c) return false;
    try {
        // 上下文没跑起来就别排音符：排了会在恢复的瞬间一起炸出来。
        if (c.state !== "running") {
            c.resume?.().catch(() => {});
            return false;
        }
        // 平方律：人对响度的感觉更接近平方，线性的 30% 听起来仍然很响。
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setValueAtTime((cfg.volume / 100) ** 2 * 0.6 * cue.gain, c.currentTime);
        cue.notes.forEach((note) => playNote(c, master, note));
        return true;
    } catch (e) {
        TitaniaLogger.warn("解锁提示音播放失败（已忽略）", e);
        return false;
    }
}

/** 设置里的"试听"：先事件音、后阶段音，隔 400ms，一次听完两档。 */
export function previewUnlockCues() {
    const ok = playUnlockCue("event");
    setTimeout(() => playUnlockCue("stage"), 420);
    return ok;
}
