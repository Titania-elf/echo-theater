// src/core/state.js

const FAVORITABLE_RESULT_STATUSES = new Set(["success", "partial", "aborted", "legacy"]);
const CONTINUABLE_RESULT_STATUSES = new Set(["success", "partial", "aborted", "legacy"]);

function isFavoritableStatus(status) {
    return FAVORITABLE_RESULT_STATUSES.has(String(status || ""));
}

// 统一管理运行时的全局变量
export const GlobalState = {
    isGenerating: false,
    abortController: null,     // 中断控制器 (AbortController 实例)
    runtimeScripts: [],        // 加载好的剧本列表 (预设 + 自定义)
    lastGeneratedContent: "",  // 上一次生成的结果 HTML
    currentGenerationResult: null, // 当前生成结果的状态化快照
    lastUsedScriptId: "",      // 上一次用户手动选择的剧本 ID (用于 UI 显示)
    lastGeneratedScriptId: "", // 上一次生成内容对应的剧本 ID (可能是后台自动生成的)
    lastUsedModelName: "",     // 上一次生成使用的模型名称
    lastFavId: null,           // 当前内容对应的收藏 ID（null 表示未收藏）
    currentCategoryFilter: "ALL", // 当前的分类筛选器状态
    generationMode: "narrative", // 生成模式: "narrative"(内容优先) | "visual"(氛围美化)
    useHistoryAnalysis: false, // 是否读取聊天历史（默认关闭）
    skipWorldBookCheck: false, // 跳过世界书空检查（本次会话内有效）
    skipInteractiveHint: false, // 跳过互动内容提示弹窗（本次会话内有效）

    // 计时器相关
    timerStartTime: 0,         // 计时开始时间戳
    timerInterval: null,       // 计时器 interval ID
    lastGenerationTime: 0,     // 上次生成耗时 (毫秒)

    // 显示层状态 (用于分离显示与生成)
    displayState: {
        isViewingHistory: false,      // 是否正在查看历史（非最新）
        currentViewIndex: -1,         // 当前查看的历史索引 (-1 表示查看最新/实时)
        lockedContent: null,          // 锁定显示的内容（用户切换历史时）
        lockedScriptId: null,         // 锁定显示的剧本ID
        lockedScriptName: null,       // 锁定显示的剧本名称
        lockedGenerationId: null      // 锁定内容的生成ID（续写时用于定位所属世系）
    },

    // 流式生成缓存 (后台生成时暂存)
    streamingCache: {
        content: "",                  // 正在生成的内容
        scriptId: null,               // 正在生成的剧本ID
        scriptName: null,             // 正在生成的剧本名称
        isActive: false               // 是否有活跃的流式生成
    },

    // 自动续写相关
    continuation: {
        isActive: false,       // 是否正在进行续写
        retryCount: 0,         // 当前续写次数
        originalContent: "",   // 原始内容（未被截断前）
        accumulatedContent: "", // 累积的完整内容
        // 优化：保存原始请求上下文，确保续写连贯性
        originalPrompt: "",    // 原始剧本的 prompt
        characterName: "",     // 角色名
        userName: ""           // 用户名
    },

    // 主动续写分支历史（当前页面会话内有效）
    continuationRuntime: {
        chatId: "",
        byScript: {}
    },

    // 剧场历史记录队列
    sceneHistory: {
        items: [],             // 历史记录数组，每项 { content, scriptId, scriptName, timestamp, isRead }
        currentIndex: -1,      // 当前查看的索引 (-1 表示没有历史)
        maxItems: 5            // 最多保留的历史记录数量
    },

    // 生成内容统计信息
    contentStats: {
        totalChars: 0,         // 总字符数
        chineseChars: 0,       // 中文字符数
        tokens: 0,             // Token 数量
        isEstimated: true      // Token 是否为估算值
    },

    // 队列生成状态
    queueState: {
        enabled: false,        // 队列模式是否激活
        mode: "random",        // 队列模式: "random"(随机抽取) | "manual"(手动选择)
        count: 3,              // 随机模式下的生成数量
        categoryFilter: "ALL", // 分类筛选
        manualItems: [],       // 手动模式下选择的剧本ID列表
        interval: 2,           // 生成间隔（秒）
        isRunning: false,      // 队列是否正在运行
        currentIndex: 0,       // 当前生成到第几个
        totalCount: 0,         // 总任务数
        completedCount: 0,     // 已完成数
        failedCount: 0,        // 失败数
        results: []            // 生成结果记录 { scriptId, scriptName, success, error? }
    },

    // UI 视图状态
    uiFlags: {
        isFavsOpen: false      // 收藏管理器是否打开
    },

    // 提示词构包追踪（用于提示词实时组成窗口）
    promptTrace: {
        traces: [],            // 最近生成记录（最新在前）
        activeTraceId: null,   // 当前正在构建的 trace ID
        maxItems: 30           // 最多保留条数
    }
};

function clonePromptTraceData(data) {
    return JSON.parse(JSON.stringify(data));
}

function getPromptTraceRecord(traceId) {
    return GlobalState.promptTrace.traces.find(t => t.id === traceId) || null;
}

/**
 * 创建新的提示词构包追踪
 * @param {object} meta - 追踪元数据
 * @returns {string} traceId
 */
export function createPromptTrace(meta = {}) {
    const traceId = `trace_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const trace = {
        id: traceId,
        startedAt: Date.now(),
        endedAt: null,
        status: "running", // running | success | failed | aborted
        source: meta.source || "manual",
        mode: meta.mode || "narrative",
        scriptId: meta.scriptId || "",
        scriptName: meta.scriptName || "未知剧本",
        profile: meta.profile || "",
        model: meta.model || "",
        extraMeta: clonePromptTraceData(meta.extraMeta || {}),
        stages: [],
        finalMessages: null,
        error: null
    };

    GlobalState.promptTrace.traces.unshift(trace);
    while (GlobalState.promptTrace.traces.length > GlobalState.promptTrace.maxItems) {
        GlobalState.promptTrace.traces.pop();
    }

    GlobalState.promptTrace.activeTraceId = traceId;
    return traceId;
}

/**
 * 添加构包阶段记录
 * @param {string} traceId
 * @param {string} stage
 * @param {object} payload
 */
export function appendPromptTraceStage(traceId, stage, payload = {}) {
    const trace = getPromptTraceRecord(traceId);
    if (!trace) return;

    trace.stages.push({
        at: Date.now(),
        stage: stage || "unknown",
        payload: clonePromptTraceData(payload)
    });
}

/**
 * 记录最终发送 messages
 * @param {string} traceId
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} meta
 */
export function setPromptTraceFinalMessages(traceId, messages, meta = {}) {
    const trace = getPromptTraceRecord(traceId);
    if (!trace) return;

    trace.finalMessages = {
        messages: clonePromptTraceData(messages || []),
        meta: clonePromptTraceData(meta)
    };
}

/**
 * 结束追踪
 * @param {string} traceId
 * @param {"success"|"failed"|"aborted"} status
 * @param {object} details
 */
export function finishPromptTrace(traceId, status = "success", details = {}) {
    const trace = getPromptTraceRecord(traceId);
    if (!trace) return;

    trace.status = status;
    trace.endedAt = Date.now();
    trace.error = details?.error || null;

    if (GlobalState.promptTrace.activeTraceId === traceId) {
        GlobalState.promptTrace.activeTraceId = null;
    }
}

/**
 * 获取提示词追踪列表（深拷贝）
 * @returns {Array}
 */
export function getPromptTraceList() {
    return clonePromptTraceData(GlobalState.promptTrace.traces);
}

/**
 * 获取指定追踪记录（深拷贝）
 * @param {string} traceId
 * @returns {object|null}
 */
export function getPromptTraceById(traceId) {
    const trace = getPromptTraceRecord(traceId);
    return trace ? clonePromptTraceData(trace) : null;
}

/**
 * 重置续写状态
 */
export function resetContinuationState() {
    GlobalState.continuation = {
        isActive: false,
        retryCount: 0,
        originalContent: "",
        accumulatedContent: "",
        originalPrompt: "",
        characterName: "",
        userName: ""
    };
}

/**
 * 将新生成的剧场添加到历史队列
 * @param {string} content - 生成的 HTML 内容
 * @param {string} scriptId - 剧本 ID
 * @param {string} scriptName - 剧本名称
 */
export function pushSceneToHistory(content, scriptId, scriptName, metadata = {}) {
    const history = GlobalState.sceneHistory;
    const generationId = String(metadata.generationId || `generation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const status = metadata.status || "success";

    // 创建新的历史记录项
    const newItem = {
        content: content,
        scriptId: scriptId,
        scriptName: scriptName || "未知剧本",
        status,
        generationId,
        timestamp: Date.now(),
        isRead: false,  // 新生成的默认未读
        favId: null     // 该记录对应的收藏 ID（null 表示未收藏）
    };

    // 添加到队列开头（最新的在前面）
    history.items.unshift(newItem);

    // 如果超出最大数量，移除最旧的
    while (history.items.length > history.maxItems) {
        history.items.pop();
    }

    // 重置当前索引到最新的记录
    history.currentIndex = 0;

    // 同步更新 lastGeneratedContent 和 lastGeneratedScriptId
    GlobalState.lastGeneratedContent = content;
    GlobalState.lastGeneratedScriptId = scriptId;
    GlobalState.currentGenerationResult = {
        generationId,
        content: String(content || ""),
        scriptId: String(scriptId || ""),
        scriptName: String(scriptName || "场景"),
        status,
        canFavorite: isFavoritableStatus(status),
        canContinue: CONTINUABLE_RESULT_STATUSES.has(status),
        error: metadata.error || null,
        timestamp: Date.now()
    };
    GlobalState.lastFavId = null; // 新生成的内容默认未收藏

    console.log(`[Titania] 剧场历史已更新: ${history.items.length} 条记录`);
}

export function setCurrentGenerationResult(result = {}) {
    const status = result.status || "failed";
    GlobalState.currentGenerationResult = {
        generationId: String(result.generationId || `generation_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        content: String(result.content || ""),
        scriptId: String(result.scriptId || ""),
        scriptName: String(result.scriptName || "场景"),
        status,
        canFavorite: isFavoritableStatus(status),
        canContinue: CONTINUABLE_RESULT_STATUSES.has(status),
        error: result.error || null,
        timestamp: Number(result.timestamp) || Date.now()
    };
    GlobalState.lastGeneratedContent = GlobalState.currentGenerationResult.content;
    GlobalState.lastGeneratedScriptId = GlobalState.currentGenerationResult.scriptId;
    return GlobalState.currentGenerationResult;
}

export function getCurrentGenerationResult() {
    const display = GlobalState.displayState;
    if (display.isViewingHistory && display.currentViewIndex >= 0) {
        const item = GlobalState.sceneHistory.items[display.currentViewIndex];
        if (item) {
            const status = item.status || "legacy";
            return {
                generationId: String(item.generationId || ""),
                content: String(item.content || ""),
                scriptId: String(item.scriptId || ""),
                scriptName: String(item.scriptName || "场景"),
                status,
                canFavorite: isFavoritableStatus(status),
                canContinue: CONTINUABLE_RESULT_STATUSES.has(status),
                error: item.error || null,
                timestamp: Number(item.timestamp) || 0
            };
        }
    }
    if (GlobalState.streamingCache.isActive) {
        return {
            generationId: "",
            content: String(GlobalState.streamingCache.content || ""),
            scriptId: String(GlobalState.streamingCache.scriptId || ""),
            scriptName: String(GlobalState.streamingCache.scriptName || "场景"),
            status: "running",
            canFavorite: false,
            canContinue: false,
            error: null,
            timestamp: Date.now()
        };
    }
    if (GlobalState.currentGenerationResult) return GlobalState.currentGenerationResult;
    if (GlobalState.lastGeneratedContent) {
        return {
            generationId: "",
            content: String(GlobalState.lastGeneratedContent),
            scriptId: String(GlobalState.lastGeneratedScriptId || ""),
            scriptName: "场景",
            status: "legacy",
            canFavorite: true,
            canContinue: true,
            error: null,
            timestamp: 0
        };
    }
    return null;
}

export function isFavoriteEligible(result = getCurrentGenerationResult()) {
    return Boolean(result?.canFavorite && String(result.content || "").trim());
}

/**
 * 获取当前查看的历史记录
 * @returns {object|null} 当前记录项或 null
 */
export function getCurrentHistoryItem() {
    const history = GlobalState.sceneHistory;
    if (history.currentIndex < 0 || history.currentIndex >= history.items.length) {
        return null;
    }
    return history.items[history.currentIndex];
}

/**
 * 导航到上一个历史记录（更旧的）
 * @returns {boolean} 是否成功导航
 */
export function navigateToPrevHistory() {
    const history = GlobalState.sceneHistory;
    if (history.currentIndex < history.items.length - 1) {
        history.currentIndex++;
        syncCurrentHistoryToState();
        return true;
    }
    return false;
}

/**
 * 导航到下一个历史记录（更新的）
 * @returns {boolean} 是否成功导航
 */
export function navigateToNextHistory() {
    const history = GlobalState.sceneHistory;
    if (history.currentIndex > 0) {
        history.currentIndex--;
        syncCurrentHistoryToState();
        return true;
    }
    return false;
}

/**
 * 将当前历史记录同步到全局状态
 */
function syncCurrentHistoryToState() {
    const item = getCurrentHistoryItem();
    if (item) {
        setCurrentGenerationResult({ ...item, status: item.status || "legacy" });
        GlobalState.lastFavId = item.favId || null; // 从历史记录中恢复收藏状态

        // 标记为已读
        item.isRead = true;
    }
}

/**
 * 将收藏 ID 同步到当前查看的历史记录项
 * @param {number|null} favId - 收藏 ID（null 表示取消收藏）
 */
export function syncFavIdToCurrentHistory(favId) {
    const display = GlobalState.displayState;
    const history = GlobalState.sceneHistory;

    // 确定当前正在查看的历史索引
    const effectiveIndex = display.isViewingHistory ? display.currentViewIndex : history.currentIndex;

    if (effectiveIndex >= 0 && effectiveIndex < history.items.length) {
        history.items[effectiveIndex].favId = favId;
    }
}

/**
 * 标记当前记录为已读
 */
export function markCurrentAsRead() {
    const item = getCurrentHistoryItem();
    if (item) {
        item.isRead = true;
    }
}

/**
 * 获取未读记录数量
 * @returns {number} 未读数量
 */
export function getUnreadCount() {
    return GlobalState.sceneHistory.items.filter(item => !item.isRead).length;
}

/**
 * 清空历史记录
 */
export function clearSceneHistory() {
    GlobalState.sceneHistory.items = [];
    GlobalState.sceneHistory.currentIndex = -1;
}

/**
 * 获取历史记录导航状态
 * @returns {{ hasPrev: boolean, hasNext: boolean, current: number, total: number }}
 */
export function getHistoryNavState() {
    const history = GlobalState.sceneHistory;
    return {
        hasPrev: history.currentIndex < history.items.length - 1,
        hasNext: history.currentIndex > 0,
        current: history.items.length > 0 ? history.currentIndex + 1 : 0,
        total: history.items.length
    };
}

/**
 * 重置队列生成状态
 */
export function resetQueueState() {
    GlobalState.queueState.isRunning = false;
    GlobalState.queueState.currentIndex = 0;
    GlobalState.queueState.totalCount = 0;
    GlobalState.queueState.completedCount = 0;
    GlobalState.queueState.failedCount = 0;
    GlobalState.queueState.results = [];
}

/**
 * 初始化队列任务
 * @param {string[]} scriptIds - 要生成的剧本ID列表
 */
export function initQueueTasks(scriptIds) {
    GlobalState.queueState.isRunning = true;
    GlobalState.queueState.currentIndex = 0;
    GlobalState.queueState.totalCount = scriptIds.length;
    GlobalState.queueState.completedCount = 0;
    GlobalState.queueState.failedCount = 0;
    GlobalState.queueState.results = [];
}

/**
 * 记录队列任务结果
 * @param {string} scriptId - 剧本ID
 * @param {string} scriptName - 剧本名称
 * @param {boolean} success - 是否成功
 * @param {string} [error] - 错误信息（可选）
 */
export function recordQueueResult(scriptId, scriptName, success, error = null) {
    GlobalState.queueState.results.push({
        scriptId,
        scriptName,
        success,
        error,
        timestamp: Date.now()
    });

    if (success) {
        GlobalState.queueState.completedCount++;
    } else {
        GlobalState.queueState.failedCount++;
    }
    GlobalState.queueState.currentIndex++;
}

/**
 * 获取队列进度状态
 * @returns {{ current: number, total: number, completed: number, failed: number, isRunning: boolean }}
 */
export function getQueueProgress() {
    const q = GlobalState.queueState;
    return {
        current: q.currentIndex,
        total: q.totalCount,
        completed: q.completedCount,
        failed: q.failedCount,
        isRunning: q.isRunning
    };
}

/**
 * 设置历史记录最大容量
 * @param {number} maxItems - 最大记录数
 */
export function setHistoryMaxItems(maxItems) {
    GlobalState.sceneHistory.maxItems = maxItems;
    // 如果当前记录超过新的最大值，移除多余的
    while (GlobalState.sceneHistory.items.length > maxItems) {
        GlobalState.sceneHistory.items.pop();
    }
}

// ========== 显示层状态管理 (用于分离显示与生成) ==========

/**
 * 锁定显示内容（用户切换到历史记录时）
 * @param {number} historyIndex - 历史索引
 */
export function lockDisplayToHistory(historyIndex) {
    const history = GlobalState.sceneHistory;
    if (historyIndex < 0 || historyIndex >= history.items.length) return;

    const item = history.items[historyIndex];
    GlobalState.displayState.isViewingHistory = true;
    GlobalState.displayState.currentViewIndex = historyIndex;
    GlobalState.displayState.lockedContent = item.content;
    GlobalState.displayState.lockedScriptId = item.scriptId;
    GlobalState.displayState.lockedScriptName = item.scriptName;
    GlobalState.displayState.lockedGenerationId = item.generationId || null;

    // 标记为已读
    item.isRead = true;

    console.log(`[Titania] 显示层锁定到历史 #${historyIndex + 1}`);
}

/**
 * 锁定显示到不属于场景历史队列的持久化内容。
 * @param {string} content
 * @param {string} scriptId
 * @param {string} scriptName
 * @param {string} generationId 对应续写轮次的生成ID，续写时用于定位所属世系
 */
export function lockDisplayToContent(content, scriptId, scriptName = "场景", generationId = "") {
    GlobalState.displayState.isViewingHistory = true;
    GlobalState.displayState.currentViewIndex = -1;
    GlobalState.displayState.lockedContent = String(content || "");
    GlobalState.displayState.lockedScriptId = String(scriptId || "");
    GlobalState.displayState.lockedScriptName = String(scriptName || "场景");
    GlobalState.displayState.lockedGenerationId = String(generationId || "") || null;
}

/**
 * 解锁显示内容（返回实时/最新状态）
 */
export function unlockDisplay() {
    GlobalState.displayState.isViewingHistory = false;
    GlobalState.displayState.currentViewIndex = -1;
    GlobalState.displayState.lockedContent = null;
    GlobalState.displayState.lockedScriptId = null;
    GlobalState.displayState.lockedScriptName = null;
    GlobalState.displayState.lockedGenerationId = null;

    console.log(`[Titania] 显示层已解锁，返回实时状态`);
}

/**
 * 检查是否应该渲染流式内容到UI
 * @returns {boolean} 如果用户正在查看历史，返回false；否则返回true
 */
export function shouldRenderStreamToUI() {
    return !GlobalState.displayState.isViewingHistory;
}

/**
 * 获取当前应该显示的内容
 * generationId 与续写轮次共用同一个值，续写时据此判定当前内容属于哪条世系。
 * @returns {{ content: string, scriptId: string, scriptName: string, isLive: boolean, generationId: string }}
 */
export function getCurrentDisplayContent() {
    const display = GlobalState.displayState;

    // 如果锁定了历史内容，返回锁定的内容
    if (display.isViewingHistory && display.lockedContent) {
        return {
            content: display.lockedContent,
            scriptId: display.lockedScriptId,
            scriptName: display.lockedScriptName,
            isLive: false,
            generationId: String(display.lockedGenerationId || "")
        };
    }

    // 如果有正在进行的流式生成，返回缓存内容
    if (GlobalState.streamingCache.isActive && GlobalState.streamingCache.content) {
        return {
            content: GlobalState.streamingCache.content,
            scriptId: GlobalState.streamingCache.scriptId,
            scriptName: GlobalState.streamingCache.scriptName,
            isLive: true,
            generationId: ""
        };
    }

    // 否则返回最新的历史记录
    return {
        content: GlobalState.lastGeneratedContent,
        scriptId: GlobalState.lastGeneratedScriptId,
        scriptName: GlobalState.runtimeScripts.find(s => s.id === GlobalState.lastGeneratedScriptId)?.name || "场景",
        isLive: false,
        generationId: String(GlobalState.currentGenerationResult?.generationId || "")
    };
}

// ========== 流式生成缓存管理 ==========

/**
 * 开始流式生成缓存
 * @param {string} scriptId - 剧本ID
 * @param {string} scriptName - 剧本名称
 */
export function startStreamingCache(scriptId, scriptName) {
    GlobalState.streamingCache.content = "";
    GlobalState.streamingCache.scriptId = scriptId;
    GlobalState.streamingCache.scriptName = scriptName;
    GlobalState.streamingCache.isActive = true;
}

/**
 * 更新流式生成缓存内容
 * @param {string} content - 当前累积的内容
 */
export function updateStreamingCache(content) {
    GlobalState.streamingCache.content = content;
}

/**
 * 结束流式生成缓存
 */
export function endStreamingCache() {
    GlobalState.streamingCache.isActive = false;
    // 注意：不清空 content，因为可能还需要用于最终渲染
}

/**
 * 清空流式生成缓存
 */
export function clearStreamingCache() {
    GlobalState.streamingCache.content = "";
    GlobalState.streamingCache.scriptId = null;
    GlobalState.streamingCache.scriptName = null;
    GlobalState.streamingCache.isActive = false;
}

/**
 * 获取增强的历史导航状态（包含显示层信息）
 * @returns {{ hasPrev: boolean, hasNext: boolean, current: number, total: number, isViewingHistory: boolean, hasNewContent: boolean }}
 */
export function getEnhancedHistoryNavState() {
    const history = GlobalState.sceneHistory;
    const display = GlobalState.displayState;
    const streaming = GlobalState.streamingCache;

    // 计算实际的导航索引
    const effectiveIndex = display.isViewingHistory ? display.currentViewIndex : history.currentIndex;

    return {
        hasPrev: effectiveIndex < history.items.length - 1,
        hasNext: effectiveIndex > 0 || (display.isViewingHistory && streaming.isActive),
        current: history.items.length > 0 ? effectiveIndex + 1 : 0,
        total: history.items.length + (streaming.isActive ? 1 : 0), // 如果正在生成，虚拟增加一个"位置"
        isViewingHistory: display.isViewingHistory,
        hasNewContent: streaming.isActive && display.isViewingHistory // 正在生成且用户在看历史
    };
}

/**
 * 设置收藏管理器打开状态
 * @param {boolean} isOpen
 */
export function setFavsWindowOpen(isOpen) {
    GlobalState.uiFlags.isFavsOpen = isOpen === true;
}

/**
 * 是否需要暂停流式内容的 UI 渲染
 * @returns {boolean}
 */
export function shouldSuspendStreamUiRendering() {
    return GlobalState.uiFlags.isFavsOpen === true;
}
