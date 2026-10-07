// 自动配图：小剧场正文生成完成后，自动跑一次「选景 → 生图 → 保存」。
//
// 【只认「新一轮」】判据是 api.js 的 generationSource === "manual"，也就是用户点
// 「单次演绎」或「重演」发起的那种生成。主动续写（user_continuation）、队列生成
// （queue）、ST 事件触发的自动演绎（同为 queue）、以及预览（preview）都不触发 ——
// 后两者是无人看着的连续生成，跟着配图会一口气烧掉多张图的额度。
// ⚠ 队列与自动演绎共用 "queue" 这一个字符串（api.js 靠 queueState.isRunning 区分），
//   所以二者在这里被一视同仁地排除。这不是漏了，是刻意的。
//
// 【默认关闭】开关是 settings 里的 illustration_auto.enabled，默认 false。
//   读端一律 `=== true` 兜底：老用户没有这个键时勾选框自然是未勾，不需要迁移。
//
// 【这里不做任何 UI】本模块刻意只依赖 core 与 utils：
//   不 import api.js / state.js / 任何 src/ui/*，也不碰 GlobalState。
//   一是测试夹具不加载那几个模块（import 了就加载不起来），二是避免循环依赖。
//   面板唯一需要的东西是 getAutoIllustrationJob()（只查不推，见它的注释）。

import { getExtData } from "../utils/storage.js";
import { getCharacterCardKey } from "./context.js";
import { buildPromptTextFromTheater } from "./chatInjector.js";
import { composeProfileBlock, matchCharacterProfiles, readCharacterProfiles } from "./characterProfiles.js";
import { detectIllustrationBackend, generateTheaterIllustration } from "./cosmosVisionBridge.js";
import { resolveActiveBackendId } from "./illustrationBackends/registry.js";
import { resolveActivePreset, validatePresetForSelection } from "./illustrationPresets.js";
import { selectIllustrationScene } from "./illustrationScene.js";
import { readSceneIllustrations, saveGeneratedIllustrations } from "./illustrationStore.js";
import {
    createIllustrationTarget, formatIllustrationError, illustrationError, normalizeIllustrationDraft,
} from "./illustrationData.js";

export const ILLUSTRATION_AUTO_KEY = "illustration_auto";

/** job.status 的三段文案。面板接管时直接显示在状态行上。 */
const AUTO_STATUS = {
    selecting: "自动配图：正在通读正文、选择画面…",
    generating: "自动配图：正在生成图片…",
    saving: "自动配图：正在保存配图…",
};

/**
 * 唯一一个「正在跑」的自动任务。刻意是**单槽位**而不是按 sceneId 的集合：
 * 连点两次单次演绎是两个不同的 sceneId，集合拦不住，而它们会并发打同一个连接、
 * 各付一次选景与生图的钱。宁可少配一轮（给一条 toastr 说明），也不无声地并发花钱。
 */
let activeJob = null;

/** 供配图面板接管：面板打开时若这一轮正在自动配图，就把它显示成自己的任务（可看进度、可取消）。 */
export function getAutoIllustrationJob(sceneId) {
    const key = String(sceneId || "");
    if (!activeJob || !key || activeJob.sceneId !== key) return null;
    return activeJob;
}

/**
 * 该不该为这一轮自动配图。纯函数，把所有「跳过」的理由定死在一处，
 * 于是每条理由都能直接变成一句 toastr，也便于穷举测试。
 *
 * @returns {{ok:boolean, reason?:string, silent?:boolean}}
 *   silent 表示「跳过但不必打扰用户」（例如这一轮已经有图了）。
 */
export function shouldAutoIllustrate({ source, enabled, content, hasImages, busy } = {}) {
    if (!enabled) return { ok: false, silent: true };
    // 判据是 source 而不是 silent：将来给某条 silent=true 的路径补上显式 source，这里仍然对。
    if (source !== "manual") return { ok: false, silent: true };
    if (!String(content || "").trim()) return { ok: false, silent: true };
    if (hasImages) return { ok: false, silent: true };
    if (busy) {
        return { ok: false, reason: "自动配图：上一张还在生成，这一轮先跳过（想补图请在配图面板里手动配）。" };
    }
    return { ok: true };
}

function notify(kind, message) {
    if (!window.toastr) return;
    const fn = window.toastr[kind] || window.toastr.info;
    if (typeof fn === "function") fn.call(window.toastr, message, "Titania Echo");
}

/**
 * 自动配图的入口。**同步返回，绝不抛**。
 *
 * ⚠ 它由 api.js 的成功路径直接调用，抛出去会把一次已经成功的演绎拖进 catch 变成「失败」。
 *   所以同步段整个包在 try/catch 里，异步段自己 catch —— 宁可配不上图，也不能污染主流程。
 *
 * @param {object} options
 * @param {string} options.source api.js 的 generationSource
 * @param {string} options.generationId 本轮的生成 ID（sceneId 的散列输入之一）
 * @param {string} options.scriptId
 * @param {string} options.scriptName
 * @param {string} options.content 必须是 pushSceneToHistory 收到的那个 finalOutput 原文
 *   （sceneId = hash([generationId, scriptId, content])，面板读的是同一份；传别的形状会让
 *   两边算出的 sceneId 对不上，表现为「图存下来了但面板里看不到」）
 */
export function maybeAutoIllustrate({ source, generationId, scriptId, scriptName, content } = {}) {
    try {
        const data = getExtData();
        const enabled = data?.[ILLUSTRATION_AUTO_KEY]?.enabled === true;
        // 先过一次「不看记录也能定」的判据（开关 / 是不是新一轮 / 正文是否为空）：
        // 这三条挡掉绝大多数调用，而它们只有 shouldAutoIllustrate 一份实现 ——
        // 别在这里另写一遍 if，那样两处判据迟早会分叉。
        if (!shouldAutoIllustrate({ source, enabled, content }).ok) return;

        // ⚠ cardKey 必须在这一刻同步取：它是「当前聊天」的身份，之后 await 期间切了聊天
        //   也不该改变这次匹配的依据（跨聊天隔离铁律）。
        const cardKey = getCharacterCardKey();
        const target = createIllustrationTarget({ content, generationId, scriptId, scriptName, cardKey });

        // 造 target 之前没法查「已有图」，所以判定分两段：先查记录，再走完整判据。
        // null 表示记录读不出来（损坏 / 文件丢了）—— 那时接着往下跑也是白花钱，
        // 最后一定卡在保存上，所以直接跳过并说一声。
        void readSceneIllustrations(target.sceneId)
            .then(record => (record?.images?.length || 0) > 0, () => null)
            .then(hasImages => {
                if (hasImages === null) {
                    notify("warning", "自动配图跳过：这一轮的配图记录读不出来，请打开配图面板重试。");
                    return;
                }
                const verdict = shouldAutoIllustrate({
                    source, enabled, content: target.content, hasImages, busy: Boolean(activeJob),
                });
                if (!verdict.ok) {
                    if (verdict.reason) notify("info", verdict.reason);
                    return;
                }
                startAutoJob(target, data);
            });
    } catch (error) {
        // 造 target 失败（正文空、缺 generationId 之类）只记日志，不打扰用户。
        console.warn("[Titania] 自动配图未能启动：", error?.message || error);
    }
}

/** 起一个自动任务并占住槽位。调用方已确认判据通过。 */
function startAutoJob(target, data) {
    const job = {
        sceneId: target.sceneId,
        kind: "auto",
        status: AUTO_STATUS.selecting,
        phase: "running",
        controller: new AbortController(),
        error: null,
    };
    activeJob = job;
    job.promise = runAutoJob(job, target, data)
        .catch(error => {
            job.error = error;
            // 取消不是失败：用户在面板里点了「取消等待」才可能走到这儿，措辞要如实。
            const aborted = error?.name === "AbortError" || error?.code === "ABORTED" || error?.code === "aborted";
            if (aborted) notify("info", "自动配图已取消。");
            else notify("warning", `自动配图失败：${formatIllustrationError(error)}`);
        })
        .finally(() => {
            // 只有槽位仍是自己时才清：中途可能已被取消、或已被新的任务接管。
            if (activeJob === job) activeJob = null;
        });
    return job;
}

async function runAutoJob(job, target, data) {
    const { signal } = job.controller;
    /** 被取消时统一在这里收口：给一条提示并停下，别让后面的步骤接着花钱。 */
    const cancelled = () => {
        if (!signal.aborted) return false;
        notify("info", "自动配图已取消。");
        return true;
    };

    // 1) 预检生图后端 —— 必须在花任何钱之前。选景要调一次 LLM，后端没装好的话那次调用纯属浪费。
    const backendId = resolveActiveBackendId(data);
    const state = detectIllustrationBackend(backendId);
    if (!state.ready) throw illustrationError(state.reason);

    // 2) 预检选景预设。刻意不调 buildIllustrationMessages —— 它会跑变量沙箱并渲染整份消息，
    //    而这里只需要「能不能用」这个结论。两条文案与那边保持一致。
    const preset = resolveActivePreset(data);
    if (!preset) throw illustrationError("还没有选景预设。打开场景配图设置，导入一份预设或新建一份。", "NO_PRESET");
    const check = validatePresetForSelection(preset);
    if (!check.ok) throw illustrationError(check.reason, check.code);

    // 3) 素材。人物外观档案按「角色卡身份 + 正文触发词」自动带入 —— 与面板的 applyAutoProfiles
    //    同一口径，只是面板那份与勾选态（profileIds / profileBlocks）耦合，无法直接复用。
    const theaterText = buildPromptTextFromTheater(target.content);
    const participants = matchCharacterProfiles(readCharacterProfiles(data), {
        cardKey: target.cardKey,
        text: theaterText,
    }).map(composeProfileBlock).filter(Boolean).join("\n\n");

    // 4) 选景 → 生图 → 保存。与面板的编排同形（面板那份还要处理过程图、待保存与重试，
    //    这里是一次性的，失败就整轮作废）。
    job.phase = "selecting";
    job.status = AUTO_STATUS.selecting;
    let draft = await selectIllustrationScene(
        { theaterText, participants, specialRequest: "", previousScenes: [] },
        { signal },
    );
    if (cancelled()) return;
    // 选景期间用户可能换了后端设置：提示词是后端无关的，所以按当前设置重新盖章即可。
    const currentBackend = resolveActiveBackendId(getExtData());
    if (draft.backend !== currentBackend) draft = normalizeIllustrationDraft({ ...draft, backend: currentBackend });

    job.phase = "generating";
    job.status = AUTO_STATUS.generating;
    const result = await generateTheaterIllustration(draft, { signal });
    if (cancelled()) return;

    job.phase = "saving";
    job.status = AUTO_STATUS.saving;
    await saveGeneratedIllustrations(target.sceneId, {
        draft,
        images: result.images,
        seed: result.seed,
        createdAt: Date.now(),
    });

    // 5) 收尾：只有这一条 toastr。面板的图库会自己读到这张图。
    const count = result.images.length;
    notify("info", `自动配图完成：已为本轮保存 ${count} 张，在配图面板的图库里查看。`);
}
