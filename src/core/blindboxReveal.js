// src/core/blindboxReveal.js
//
// 「盲盒解锁界面」的纯逻辑：阶段化视图模型 ＋ 解锁播报账本 ＋ 音效选择。
// 纯函数、不碰 DOM、不碰 ST 宿主、不碰音频——所以能直接被 node --test 测。
//
// 三件事分开的理由：
//   · 数据模型与判定状态机 → blindboxPlan.js（本模块只读它）
//   · 视图模型与播报账本   → 这里
//   · WebAudio 合成         → unlockChime.js（唯一的浏览器依赖，不进这里）
//
// ── 防剧透铁律（本模块的核心职责）──
// 界面上"未解锁"的东西必须**在数据层就没有内容**，不能指望渲染时记得别写出来。
// 规则：
//   · 已翻过去的事件 → 给 content / recap / spanLabel（它已经在玩家的故事里发生过了）
//   · 未翻过去的事件 → 只给下标与状态，不给内容、不给时间跨度、不给成立条件、不给笔记
//   · 节点标题与硬锚 → 只有「阶段已通关」（该节点事件全部翻过）才给
//   · 阶段是否通关按**事件**判定，不看进度下标：宽松档下模型可以把指针跳到未翻完的节点
//     之后，若按下标判"已通关"，就会把那个节点的硬锚提前泄出去。
// tests/blindboxReveal.test.mjs 里有一条"把整个视图序列化后扫机密子串"的测试守着这些。

import {
    EVENT_STATUS,
    eventMark,
    stageMark,
    addRevealMarks,
    flattenEvents,
    normalizeBlindbox,
    isEventPassed,
} from "./blindboxPlan.js";

/** 本模块的账本读法：announced=已响过音效，viewed=已做过揭晓动画。 */
function markSets(bb) {
    return {
        announced: new Set(bb.announced || []),
        viewed: new Set(bb.viewed || []),
    };
}

/** 玩家已解锁（已翻过）的事件标记列表。 */
export function getPassedMarks(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    return flattenEvents(bb)
        .filter(({ event }) => isEventPassed(event))
        .map(({ nodeIndex, eventIndex }) => eventMark(nodeIndex, eventIndex));
}

/** 已通关的阶段下标（该节点事件非空且全部翻过）。 */
export function getClearedStageIndexes(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const out = [];
    bb.nodes.forEach((node, i) => {
        if (node.events.length > 0 && node.events.every(isEventPassed)) out.push(i);
    });
    return out;
}

/**
 * 本回合有哪些"新解锁"要播报/揭晓。
 * 返回：
 *   freshMarks    新翻过、还没响过音效的事件
 *   freshStages   新通关、还没响过音效的阶段
 *   unviewedMarks / unviewedStages  还没做过揭晓动画的（横条角标看这个）
 *   backfill      true＝这是本功能上线前的老存档：调用方应静默补记，不响不动画
 */
export function resolveUnlocks(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const { announced, viewed } = markSets(bb);
    const passedMarks = getPassedMarks(bb);
    const clearedStages = getClearedStageIndexes(bb);
    const stageMarks = clearedStages.map(stageMark);

    if (bb.marksReady !== true) {
        return {
            backfill: true,
            freshMarks: [],
            freshStages: [],
            unviewedMarks: [],
            unviewedStages: [],
            passedMarks,
            clearedStages,
        };
    }
    return {
        backfill: false,
        freshMarks: passedMarks.filter((m) => !announced.has(m)),
        freshStages: stageMarks.filter((m) => !announced.has(m)),
        unviewedMarks: passedMarks.filter((m) => !viewed.has(m)),
        unviewedStages: stageMarks.filter((m) => !viewed.has(m)),
        passedMarks,
        clearedStages,
    };
}

/**
 * 补记账本。silent 补记（老存档首次接触）＝把当前所有已翻过/已通关的一次性记上，
 * 这样既不会响一串旧账，也不会让它们以后突然响。
 * 只传要追加的部分；未传的字段原样保留。
 */
export function applyRevealMarks(blindbox, { announced, viewed, marksReady } = {}) {
    const bb = normalizeBlindbox(blindbox);
    if (Array.isArray(announced) && announced.length) bb.announced = addRevealMarks(bb.announced, announced);
    if (Array.isArray(viewed) && viewed.length) bb.viewed = addRevealMarks(bb.viewed, viewed);
    if (marksReady === true) bb.marksReady = true;
    return bb;
}

/** 老存档首次接触：静默把现有进度记进账本（不响、不动画）。 */
export function backfillRevealMarks(blindbox) {
    const bb = normalizeBlindbox(blindbox);
    const u = resolveUnlocks(bb);
    return applyRevealMarks(bb, {
        announced: [...u.passedMarks, ...u.clearedStages.map(stageMark)],
        viewed: [...u.passedMarks, ...u.clearedStages.map(stageMark)],
        marksReady: true,
    });
}

/**
 * 本回合该响哪一声。**一回合最多一声**——宽松档下一回合可能翻过好几个事件，
 * 逐个响会变成一串噪音，所以阶段通关优先（它更隆重），否则退回事件音。
 * 返回 'stage' | 'event' | null。
 */
export function pickUnlockCue({ freshMarks = [], freshStages = [], config } = {}) {
    const cfg = config && typeof config === "object" ? config : {};
    if (cfg.enabled !== true) return null;
    // 阶段音效不单独给开关：静音了里程碑就等于没有音效。
    if (freshStages.length > 0) return "stage";
    // 事件解锁可以单独关掉（想只保留里程碑那一声的人很多）。
    if (freshMarks.length > 0 && cfg.cue_event !== false) return "event";
    return null;
}

/* ================================================================== *
 * 视图模型
 * ================================================================== */

/**
 * 构建阶段化视图。返回 { header, stages }，全部是可直接渲染的纯数据。
 * 每个 stage：
 *   { nodeIndex, state:'cleared'|'current'|'sealed', label, counts, isFresh, isHolding,
 *     title?, anchor?, span?,            ← 仅 cleared
 *     events:[ { key, no, status, unlocked, isTarget, isFresh, locked,
 *                content?, recap?, spanLabel?, skipReason?, dwell? } ] }
 */
export function buildRevealView(blindbox, options = {}) {
    const bb = normalizeBlindbox(blindbox);
    const { viewed } = markSets(bb);
    const u = resolveUnlocks(bb);
    // suppressFresh：预览/试渲染时不把"新解锁"标成待动画。
    // u.backfill（老存档首次接触）：全部当旧账——否则一打开面板，整面历史会集体闪一次。
    const freshAllowed = options.suppressFresh !== true && u.backfill !== true;
    const curNode = bb.progress.nodeIndex;
    const curEvent = bb.progress.eventIndex;

    const flat = flattenEvents(bb);
    const total = flat.length;
    const passed = flat.filter(({ event }) => isEventPassed(event)).length;
    const skipped = flat.filter(({ event }) => event.status === EVENT_STATUS.SKIPPED).length;

    const stages = bb.nodes.map((node, nodeIndex) => {
        const passedInNode = node.events.filter(isEventPassed).length;
        const counts = { passed: passedInNode, total: node.events.length };
        // 按事件判"通关"，不按下标（见文件头：宽松档下指针会跳过未翻完的节点）。
        const allPassed = counts.total > 0 && passedInNode === counts.total;
        // 事件都翻过、但硬锚还没落地：**还不揭晓**。硬锚描述的是下一个转折，提前亮出来
        // 等于剧透玩家马上就要经历的那一拍——这是最伤的一种剧透。等指针真的走过去了才算通关。
        const isHolding = allPassed && nodeIndex === curNode && bb.progress.awaitingAnchor === true;
        const revealed = allPassed && !isHolding;
        const state = allPassed ? "cleared" : (nodeIndex === curNode ? "current" : "sealed");
        const stageFresh = freshAllowed && revealed && !viewed.has(stageMark(nodeIndex));

        const events = node.events.map((event, eventIndex) => {
            const key = eventMark(nodeIndex, eventIndex);
            const unlocked = isEventPassed(event);
            const isTarget = nodeIndex === curNode && eventIndex === curEvent;
            const base = {
                key,
                no: String(eventIndex + 1).padStart(2, "0"),
                status: event.status,
                unlocked,
                isTarget,
                isFresh: freshAllowed && unlocked && !viewed.has(key),
            };
            if (!unlocked) {
                // 未解锁：只给"这里有一拍、以及玩家自己打了几拍"，绝不给内容。
                // 停留拍数是玩家自己的节奏信息（面板与横条早在 v2 就显示它），不算剧透。
                return {
                    ...base,
                    locked: true,
                    dwell: isTarget ? { turns: event.turns || 0, beats: event.beats || 0 } : null,
                };
            }
            return {
                ...base,
                locked: false,
                content: event.content,
                recap: event.recap || "",
                spanLabel: event.span || "",
                skipReason: event.skipReason || "",
            };
        });

        const stage = {
            nodeIndex,
            state,
            label: `阶段${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][nodeIndex] || ` ${nodeIndex + 1}`}`,
            counts,
            cleared: allPassed,
            revealed,
            isFresh: stageFresh,
            // 事件都翻过了、但硬锚还没落地：导演这几拍会收紧。这是给玩家的解释，不是剧透。
            isHolding,
            events,
        };
        // 只有真正通关（硬锚也落地了）才揭晓标题与硬锚——揭晓本身就是奖励（用户定的口径）。
        if (revealed) {
            stage.title = node.title || "";
            stage.anchor = node.anchor || "";
            stage.span = node.span || "";
        }
        return stage;
    });

    return {
        header: {
            paused: bb.directorPaused === true,
            stageIndex: curNode,
            stageCount: stages.length,
            passed,
            skipped,
            total,
            strictness: bb.strictness,
            timescale: bb.timescale || "",
            clearedStages: u.clearedStages.length,
            // 横条角标看这个：有未揭晓的事件、或有已通关但还没看过揭晓动画的阶段。
            hasUnviewed: u.unviewedMarks.length > 0 || u.unviewedStages.length > 0,
            isHolding: bb.progress.awaitingAnchor === true,
            dwell: {
                turns: stages[curNode]?.events?.[curEvent]?.dwell?.turns || 0,
                beats: stages[curNode]?.events?.[curEvent]?.dwell?.beats || 0,
            },
        },
        stages,
    };
}
