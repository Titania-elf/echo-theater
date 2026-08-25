// src/config/defaults.js

export const extensionName = "Titania_Theater_Echo";
export const extensionFolderPath = `scripts/extensions/third-party/titania-theater`;

// 当前版本号 (每次更新时修改这里)
export const CURRENT_VERSION = "5.2.7";

// 旧版 Key (用于迁移检测)
export const LEGACY_KEYS = {
    CFG: "Titania_Config_v3",
    SCRIPTS: "Titania_UserScripts_v3",
    FAVS: "Titania_Favs_v3"
};

/**
 * 自动续写已下线（入口隐藏 + 运行时强制失效），不再维护。
 *
 * ── 为什么下线 ──
 * 它把一次点击放大成最多 9 次 API 请求，而触发它的截断检测有确认的误判：
 *   · 三层重试是乘算的：主生成 1 次 + 外层 max_retries(默认 2) 轮
 *     × (内层写死的 maxRetries=2 → 3 次 fetch + 5xx 非流式降级 1 次) = 9 次。
 *     内层那个 2 是写死的，用户把「最大续写次数」调成 1 也压不住。
 *   · checkHtmlTags 的栈只在栈顶匹配时 pop（helpers.js），交叉嵌套会留残渣：
 *     `<div><p>x</div></p>` 与 `<div><span><p>x</span></p></div>` 都被判成截断，
 *     而这两种形态在 AI 生成的 HTML 里极常见。
 *   · sentence 模式判「末字是汉字且不以中文标点收尾」，AI 结尾常是状态行/章节名，
 *     一律误判。both 模式取并集，误判面最大。
 * 结果是用户看到一串带「截断」字样的提示与 ⚠️ 失败提示，把它报告成
 * 「截断变得频繁」——实际是误判触发的续写在撞限流。
 *
 * ── 为什么是开关而不是删代码 ──
 * performContinuation 及其上下文构建有约 500 行，且与主动续写共用若干工具函数
 * （mergeContinuationContent / smartMergeContinuation / buildContinuationContext）。
 * 删除的波及面远大于收益，故只切断入口。
 *
 * ⚠ 这个常量是唯一的事实来源。要复活功能必须先修上面三条，
 *   只把它改成 false 会把已知缺陷原样放回去。
 *
 * ⚠ 刻意**不改**用户已存的 data.auto_continue：闸门在运行时判定，
 *   所以老用户存过 enabled: true 也不会生效，而他们的设置值原样保留 ——
 *   万一将来复活，不必让他们重新配一遍。
 */
export const AUTO_CONTINUE_RETIRED = true;

export const defaultSettings = {
    enabled: false,
    config: {
        active_profile_id: "default",
        profiles: [
            {
                id: "st_sync",
                name: "🔗 跟随 SillyTavern (主连接)",
                type: "internal",
                readonly: true
            },
            {
                id: "default",
                name: "默认自定义",
                type: "custom",
                url: "",
                key: "",
                model: "gpt-3.5-turbo"
            }
        ],
        stream: true,
        max_tokens: 4096,  // 输出 Token 限制（仅自定义 API 生效）
        auto_generate: false,
        auto_chance: 50,
        auto_mode: "follow",
        auto_categories: [],
        history_limit: 10
    },
    // ⚠ 这里刻意**没有** user_scripts —— 剧本已搬到 user/files/titania_scripts.json，
    //   settings 里只留 scripts_store 指针（见 src/core/scriptStore.js）。
    //   把它加回来会让「剧本住在设置里」这个已经不成立的印象复活；
    //   而且全新安装会因此带上一个空数组，bootstrapEmptyScriptsStore() 虽然仍能
    //   正常建store，但 settings.json 里会多一个永远不再写入的死键。
    //   所有读取点都能处理 undefined（getScripts / describeCurrentScriptsFootprint /
    //   shouldDualWrite / migrateScriptsToFiles 等一律先 Array.isArray 判定）。
    favs: [],
    history_extraction: {
        whitelist: "",
        blacklist: "",
        // 只把角色发言注入剧本生成，跳过用户楼层。
        // 只作用于剧本生成，总结和世界书提取照旧读全量历史
        ai_only: false
    },
    character_map: {},
    disabled_presets: [],
    script_stats: {},
    script_stats_meta: {
        version: 1,
        last_cleanup_at: 0
    },
    ui_prefs: {
        script_sort_mode: "smart",
        // 主界面布局: modern(新版工具箱布局) | legacy(5.1.2 经典布局)
        main_window_mode: "modern",
        // 标题栏常驻图标（最多 5 个），未列入的自动收进「更多」弹层。
        // 可选 id 见 src/ui/mainWindow/headerActions.js 的注册表
        header_actions: ["workshop", "favs"],
        // 世界书管理页：列表里不显示带「酒馆中已禁用」标记的条目。
        // 纯视图过滤，不动已保存的勾选
        wi_hide_disabled: false
    },
    appearance: {
        // ⚠ 这份清单是「保存白名单」的权威基线：settingsWindow.js 保存时会拿它比对，
        //   白名单里缺哪个字段就告警（那里的 d.appearance 是整体替换，漏了就静默丢弃）。
        //   所以这里只能列**真正在用**的字段，多一个少一个都会让那个自检失真。
        //   Phase 6c-1 清理前，这里有 5 个死字段（color_theme / color_notify /
        //   color_bg / color_icon / color_notify_bg，全库零引用，早被 border_color
        //   与 bg_color 取代），同时缺 3 个在用的（bg_color / border_opacity /
        //   bg_opacity）—— 基线两头都是错的，自检会永久误报 5 条。
        type: "emoji",
        content: "🎭",
        border_color: "#90cdf4",   // 球体边框颜色
        bg_color: "#2b2b2b",       // 球体背景色
        border_opacity: 100,
        bg_opacity: 100,
        animation: "ripple",       // 动画类型: ripple(脉冲波纹) | arc(电磁闪烁)
        size: 56,
        ui_font_scale: 100,
        ui_theme: "dark",          // 插件 UI 主题: dark | light（Phase 6c）
        show_timer: true           // 是否显示生成计时统计
    },
    director: {
        instruction: ""  // 自由编辑的导演指令
    },
    // 世界书条目筛选配置（按角色卡隔离）
    worldinfo: {
        // { "card:<avatar 去扩展名>": { "世界书名": [uid1, uid2, ...] } }
        // 键用 avatar 而非角色名：同名角色卡必须各自独立，否则会互相激活对方的世界书
        card_selections: {},
        // { "card:<avatar>": ["世界书名", ...] } 需要额外激活的书（由选中条目推导）
        card_auto_active_books: {},
        // 旧的名字键配置，保留供读取回退（仅当该名字只有一张卡时才继承）
        char_selections: {}
    },
    // 自动续写配置 (应对 API 超时截断)
    auto_continue: {
        enabled: false,           // 是否启用自动续写
        max_retries: 2,           // 最大续写次数
        detection_mode: "html",   // 检测模式: "html" | "sentence" | "both"
        show_indicator: true      // 是否在内容中显示续写标记
    },
    // 主动续写 UI 配置
    continuation_ui: {
        recent_instructions: [],
        inject_rounds_count: 3
    },

    // 自定义系统提示词配置
    custom_prompts: {
        override_enabled: false,  // 是否启用覆盖
        content_mode: "",         // 内容优先模式的自定义系统提示词
        visual_mode: ""           // 氛围美化模式的自定义系统提示词
    },
    // 统一提示词方案模型（旧 custom_prompts 字段仍保留用于兼容）
    prompt_manager: {
        version: 4,
        editor_view: "narrative",
        active_preset_id: "",
        builtin: {
            narrative: { id: "narrative", name: "内容优先", type: "builtin", entries: [] },
            visual: { id: "visual", name: "氛围美化", type: "builtin", entries: [] }
        },
        presets: []
    },
    // CSS 主题方案配置
    css_themes: {
        profiles: [
            { id: "default", name: "默认主题", css: "" }
        ],
        active_profile_id: "default"
    },
    // 快捷工具栏配置
    quick_toolbar: {
        enabled: false,  // 是否启用快捷工具栏（禁用时点击悬浮球直接打开主窗口）
        // 各按钮的启用状态，按固定顺序排列
        // 可用按钮: main(剧场), lore(设定提取), outline(故事大纲), settings(设置), favs(收藏夹), scripts(剧本管理), debug(调试), recall(记忆召回)
        enabled_items: {
            main: true,      // 打开剧场
            lore: false,     // 提取设定
            outline: false,  // 故事大纲
            settings: true,  // 设置
            favs: false,     // 收藏夹
            scripts: false,  // 剧本管理
            debug: false,    // 提示词组成窗口
            recall: false    // 记忆召回
        },
        max_items: 5  // 最多显示按钮数量
    },
    // 大纲入口按钮（注入到发送按钮旁边）
    outline_entry: {
        enabled: true,
        show_theater: true,
        show_outline_actions: true
    },
    // 小剧场注入聊天（挂在每条消息气泡的「…」菜单里）
    chat_inject: {
        enabled: true,
        visible_to_ai: true,      // 注入时默认让 AI 看到；注入后可用气泡上的眼睛图标切换
        speaker_name: "回声小剧场" // 仅界面显示用，narrator 类型不会把名字带进提示词
    },
    // 导入预设的宏求值行为
    preset_macros: {
        // 预设里的 {{setvar::}} 等写入宏默认只在本次提示词构建内有效，构建完成后还原，
        // 不写进用户的聊天存档。开启后写入照常落盘（少数依赖变量跨次留存的预设才需要）。
        persist_variables: false
    },
    // 文本改写入口（显示在故事大纲菜单中）
    rewrite_entry: {
        enabled: false,
        profile_mode: "custom",
        profile_id: "",
        api_url: "",
        api_key: "",
        model: "",
        split_mode: "sentence",
        stream_live: true,
        auto_trigger: false,
        selected_sentence_enabled: true,
        tag_whitelist: "",
        active_scheme_id: "",
        schemes: [],
        prompt_system: "你是专业中文文本改写助手。仅根据输入 targets 对命中片段改写，不新增未命中信息。保持语义一致、语气自然、连贯，并与原上下文风格一致。",
        prompt_user: "返回 JSON schema：\n{{schema}}\n唯一合法示例：\n{\"task_id\":\"rewrite_x\",\"results\":[{\"segment_id\":\"s_1\",\"rewritten_text\":\"示例文本\"}]}\n硬约束：\n1) results 条目数必须等于 targets 条目数\n2) segment_id 必须来自 targets 且不重复\n3) rewritten_text 不能为空；若无需改写则原样返回\n4) 不得输出任何 JSON 之外的内容\n\n输入数据：\n{{payload}}",
        selected_prompt_system: "你是专业中文文本改写助手的手动选句模式，专门将句子改写为白描风格。白描核心准则：用具体动作、物象、细节说话，不直述角色内心感受；克制形容词副词，以名词和动词支撑句子；删除心理概括句，转为外部可观察的行为或环境映衬；句式简洁硬朗，不虚饰不煽情。用户已选定需要改写的句子；只对输入 targets 逐条改写，不新增未选内容。改后能自然替换回原位置。",
        selected_prompt_user: "返回 JSON schema：\n{{schema}}\n唯一合法示例：\n{\"task_id\":\"rewrite_selected_x\",\"results\":[{\"segment_id\":\"s_1\",\"rewritten_text\":\"示例文本\"}]}\n硬约束：\n1) targets 是用户手动选中的句子，只改写这些句子\n2) results 条目数必须等于 targets 条目数\n3) segment_id 必须来自 targets 且不重复\n4) rewritten_text 不能为空，且应能原位替换回上下文\n5) 不得输出任何 JSON 之外的内容\n\n输入数据：\n{{payload}}",
        prompt_json_rule: "JSON格式指令（谨慎修改）：\n- 只输出 JSON，不输出解释或 markdown\n- 顶层必须包含 task_id 和 results\n- results 每项必须包含 segment_id 和 rewritten_text\n- rewritten_text 中不能出现目标命中词（anchor / matched_extra）"
    },
    // Embedding API 独立配置（用于向量化）
    embedding_config: {
        url: "",                          // API URL (如 https://api.openai.com/v1)
        key: "",                          // API Key
        model: "text-embedding-3-small",  // 默认模型
        dimensions: null,                 // 向量维度（null 表示使用模型默认值）

        // 文本清洗选项（向量化前处理）
        text_cleaning: {
            remove_html_tags: true,           // 移除 HTML 标签（保留文本内容）
            remove_style_tags: true,          // 移除 <style> 标签及其内容
            remove_thinking_tags: true,       // 移除 <thinking>/<think> 标签及内容
            remove_ooc_tags: true,            // 移除 <ooc>/<OOC> 标签及内容
            remove_system_tags: true,         // 移除 <system>/<note> 等系统标签及内容
            remove_markdown: false,           // 移除 Markdown 格式（**粗体** 等）
            remove_macro_residue: true,       // 移除宏残留 {{user}} {{char}} 等
            remove_bracket_markers: true,     // 移除方括号标记 [System] [OOC] 等
            remove_bracket_content: true,     // 移除方括号及其内容 [...] (全部)
            custom_tags_to_remove: "",        // 自定义要移除的标签（逗号分隔，如 "internal,debug"）
            min_text_length: 20               // 清洗后低于此长度的消息跳过向量化
        },

        // 自动向量化配置
        auto_vectorize: {
            enabled: false,               // 是否启用自动向量化
            batch_threshold: 5,           // 累积多少条消息后触发向量化
            notify_user: true             // 是否显示通知
        }
    },

    // 智能总结功能配置
    summarizer_config: {
        selected_profile_id: null,   // 使用哪个 Chat API 方案（复用 profiles）
        model_override: null,        // 模型覆盖
        template: "structured",      // 模板类型: structured | narrative
        use_vector_search: true      // 是否使用向量化语义检索增强
    }
};
