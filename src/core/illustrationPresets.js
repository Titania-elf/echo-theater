// 选景预设：小剧场场景配图的提示词方案。
//
// 叶子模块：不 import storage / helpers / promptManager，配置对象由调用方传入。
// 测试夹具会把 utils/storage.js 与 core/context.js 整块替换掉，保持无依赖才能被直接加载与单测。
//
// 【隔离：只跑变量宏，不跑全套宏】STscript 变量宏（setvar / getvar 等 10 条）由调用方
// 注入的 runMacros 求值 —— 预设常拿变量当「组装草稿纸」，前段条目 setvar、后段条目 getvar，
// 不求值它们整份预设就是死的。但**绝不**调用 ST 的全套宏引擎：那会连带展开
// {{char}} / {{persona}} / {{description}}，全部读**当前聊天** —— 在 B 聊天给 A 的收藏
// 配图时会把 B 的角色注进提示词。求值实现见 stVariables.js。
//
// 求值顺序：先 runMacros（只作用于预设作者自己写的文本），再展开下面四个占位符。
// 于是素材（正文、人物资料）里字面含 {{getvar::x}} 也不会被求值 —— 用户内容永远是惰性文本。
// 其余 {{...}} 一律原样保留（已核实传输层原样透传 messages，不会在下游被悄悄展开）。
//
// 【没有内置预设】预设一律由用户「导入」或「新建」产生。两种入口都会自动补上
// 「托管条目」（见 MANAGED_ENTRIES）：可改写、可停用、可排序、可单条恢复默认，但不可删除。

import { getPromptOrder } from "./promptOrder.js";

export const ILLUSTRATION_PRESETS_KEY = "illustration_presets";
export const ILLUSTRATION_PRESETS_VERSION = 2;

/** 旧的单块规范键。迁移后再删掉它。 */
export const LEGACY_SPEC_KEY = "illustration_prompt_spec";
const LEGACY_SPEC_VERSION = 1;

/** 可选占位符。素材靠它们进入提示词。 */
export const PLACEHOLDER_NAMES = ["theater_text", "participants", "special_request", "previous_scenes"];
export const THEATER_TEXT_PLACEHOLDER = "theater_text";

const PLACEHOLDER_PATTERN = /\{\{\s*([\w-]+)\s*\}\}/g;
/** 整行只有占位符时，若它们全部解析为空就连这一行一起删掉，免得留下孤立的标题。 */
const PLACEHOLDER_ONLY_LINE = /^(?:\{\{\s*[\w-]+\s*\}\}\s*)+$/;

/**
 * ST Chat Completion 预设里的上下文注入条目：它们的语义是「运行时把上下文塞进来」，
 * 选景这条链路不能有这种东西，导入时一律丢弃并计数。
 */
const ST_CONTEXT_IDENTIFIERS = new Set([
    "main", "worldInfoBefore", "worldInfoAfter", "charDescription", "charPersonality",
    "personaDescription", "scenario", "dialogueExamples", "chatHistory", "enhanceDefinitions",
]);

// ---------------------------------------------------------------------------
// 托管条目
// ---------------------------------------------------------------------------

/**
 * 导入或新建预设时自动补上的条目。
 *
 * 它们解决的是「一份酒馆预设压根不知道小剧场要怎么选景」这件事：
 * 头一条定义选景任务，接着一条是生图提示词的写法，再一条把素材带进来，
 * **输出契约放在最末** —— 末位指令的服从度最高，而 JSON 格式是整个链路最不能出错的一环。
 *
 * 提示词规范是**图源无关**的一份（正面提示词固定为 Tag 段 + NL 段，Tag 只写公共画面信息，
 * 角色外貌/服装/配饰/表情一律进各自角色的 NL 描述，多角色各自建立指代，抽象要求转译成
 * 可见事实，禁止 BREAK 与质量/风格词）。画哪一家的语法、权重、质量词与负向词由下游负责，
 * 这里不写。
 * ⚠ 它的段落结构（Tag → 换行 → NL）与下面「输出格式」里对 positivePrompt 的要求是一对，
 *   改一处必须改另一处，否则模型同时收到「必须换行」与「必须一行」两条相反的指令。
 */
export const MANAGED_ENTRIES = [
    {
        id: "select", name: "选景要求", role: "system", enabled: true,
        content: `通读用户给出的小剧场正文，为它选择唯一一个最适合画成单幅插图的瞬间，并写出该画面的提示词。

## 选景要求
- 选人物关系鲜明、动作或表情明确、环境可以画出来、能体现故事核心情绪的那个瞬间。
- **用户列出了「已经选过的画面」时，必须换一个不同的瞬间** —— 另一个同样有原文依据、同样可以落笔的画面，不要重复其中任何一个。只有正文里确实不存在第二个可以落笔的瞬间，才允许复用同一幅。
- 画面必须属于同一时间、同一地点。不要拼接不同事件，不要混合不同时间的服装状态，不要让全文所有人物一起出场。
- 角色外观以「人物资料」为依据，动态状态以选定的原文为依据。
- 以内心独白或对话为主的作品，优先寻找承载情绪的神态、动作或环境细节，不要虚构重大情节。
- 用户提出了额外要求时，优先满足它。
- 如果确实没有可以落笔的画面，只输出 {"error":"NO_SCENE"}，不要硬凑。`,
    },
    {
        id: "prompt", name: "生图提示词规范", role: "system", enabled: true,
        content: `# 通用生图提示词编写规则

## 1. 核心目标

根据用户提供的角色、场景、动作、构图、环境等需求，编写可以直接用于生图的正面提示词。

提示词必须：

- 只描述画面中能够直接看到的视觉内容
- 简洁、明确、具体
- 优先描述会直接影响画面的信息
- 避免文学化、故事化和抽象化表达
- 不为了让文字看起来丰富而加入无实际视觉作用的描述
- 不擅自改变用户已经确定的角色设定


## 2. 视觉内容原则

所有描述都必须能够通过最终画面直接观察到。

应该描述：

- 外貌
- 发型、发色
- 眼睛、瞳孔
- 五官
- 身体特征
- 服装
- 配饰
- 表情
- 动作
- 姿势
- 身体朝向
- 人物之间的互动
- 人物之间的空间位置
- 环境
- 时间
- 光线
- 阴影
- 可见物体
- 构图
- 镜头
- 色彩
- 材质
- 前景与背景关系
- 留白等可以直接视觉化的内容

不要描述：

- 人物性格
- 心理活动
- 思想
- 故事背景
- 剧情解释
- 人物关系的抽象含义
- “神秘感”“压迫感”“浪漫氛围”等抽象概念
- aura、presence 等不可直接观察的概念
- 文学化修辞
- 与画面无关的背景设定

如果用户提出的是抽象需求，应将其转换成可以直接看到的视觉事实。

例如：

“表现出温柔感”
→ 使用柔和表情、轻微微笑、柔和眼神等具体视觉信息。

“表现出压迫感”
→ 使用低机位、人物靠近镜头、强烈俯视关系、明显阴影等具体视觉信息。

如果无法转换成明确的视觉内容，则删除。


## 3. 不擅自扩写

不要为了让提示词显得完整而自行添加用户没有要求的内容。

尤其不要擅自增加：

- 新角色
- 新服装
- 新配饰
- 新道具
- 新剧情
- 新背景设定
- 人物性格
- 抽象氛围
- 风格描述
- 质量描述

如果用户只要求改变场景，就保留已经确定的角色设定。

如果用户只要求改变服装，就不要擅自改变角色外貌。

如果用户只要求改变动作，就不要重新设计整个画面。


## 4. 固定角色设定

如果用户已经提供角色锚点或固定角色：

- 保留已经确定的外貌
- 保留已经确定的服装，除非用户要求更换
- 保留已经确定的配饰，除非用户要求更换或删除
- 保留角色的关键识别特征
- 改变场景、动作、构图时不要重新设计角色

角色固定设定优先级高于后续普通场景描述。

只有用户明确要求修改时，才能改变固定设定。


## 5. 不使用风格和质量描述

不要主动添加画风、质量或渲染相关内容。

不要默认加入：

- masterpiece
- best quality
- high quality
- ultra detailed
- highly detailed
- anime style
- cinematic rendering
- professional illustration
- beautiful artwork
- vivid colors
- 等类似质量评价或风格描述

用户使用自己的模型、LoRA或其他方式控制画面风格时，提示词只负责描述画面内容。


## 6. 最终输出结构

无论单角色还是多角色，正面提示词必须固定为：

[Tag 段落]

[NL 段落]

Tag 始终位于最前面。

Tag 结束后换行，再开始 NL。

不要把 NL 和 Tag 混在一起。


## 7. Tag 的使用范围

Tag 用于描述：

- 人数
- 基础角色类别
- 镜头
- 时间
- 环境
- 简单光影
- 简单构图
- 简单独立视觉元素
- 简单动作
- 其他不需要复杂角色绑定的视觉信息

例如：

1girl, solo, full body, indoors, bedroom, nighttime, soft lighting, centered composition

例如：

2people, outdoors, daytime, street, full body, left side, right side


## 8. Tag 不负责角色绑定

不要把角色专属属性全部堆进公共 Tag。

尤其不要在多角色中把不同角色的：

- 发型
- 发色
- 眼睛
- 五官
- 身体特征
- 服装
- 配饰
- 表情

全部混合到公共 Tag 中。

这些信息应该放入对应角色自己的 NL 描述。

这样可以减少多个角色之间的特征互相污染。


## 9. 表情规则

表情统一归入 NL。

不要把角色表情放进公共 Tag。

单角色：

The woman has long black hair and amber eyes. She wears a black dress. She has slightly raised eyebrows and a small smile.

多角色：

The woman has long black hair and amber eyes. She wears a black dress. She has flushed cheeks and a small smile.

The man has short silver hair and blue eyes. He wears a black shirt. His eyebrows are furrowed and his mouth is slightly open.

表情必须和对应角色写在同一个角色描述中。

不要使用公共：

smile, blush, angry, surprised

来同时描述多个角色。


## 10. NL 的使用范围

NL 负责描述需要角色绑定或需要更复杂语义关系的内容，包括：

- 角色外貌
- 角色服装
- 角色配饰
- 角色表情
- 复杂动作
- 复杂姿势
- 身体朝向
- 多角色互动
- 角色之间的空间关系
- 角色与环境之间的关系
- 复杂构图
- 复杂身体部位关系
- 复杂物体交互


## 11. 单角色提示词

单角色时：

第一步，用 Tag 描述公共画面信息。

第二步，在 NL 中连续描述角色本身。

第三步，再描述动作、姿势、构图以及角色与环境的关系。

例如：

Tag：

1girl, solo, full body, indoors, bedroom, nighttime, soft lighting

NL：

The woman has long straight black hair, amber eyes, a slender face, and long eyelashes. She wears a black gothic dress with long sleeves and high heels. She has a slight smile. She sits on the edge of the bed with one leg crossed over the other, resting one hand beside her body while looking toward the camera.


## 12. 多角色提示词

多角色时，不要把所有角色的属性写成一个公共属性池。

每个角色必须首先拥有独立、连续的 NL 描述。

例如：

The woman has waist-length light brown hair, black eyes, and a mole under her left eye. She wears a black dress. She has flushed cheeks and a small smile.

The man has slicked-back black hair, pale golden eyes with clearly visible slit pupils, sharp facial features, and semi-rimless glasses. He wears a black cardigan. His eyebrows are slightly raised and he has a faint smirk.

角色建立完成后，再使用稳定的角色指代：

- the woman
- the man
- the girl on the left
- the boy on the right
- Xiao
- Aether
- 其他用户明确提供的角色名称

后续动作和互动中不要反复重新描述角色完整外貌。


## 13. 多角色角色绑定

每个角色的：

外貌 + 服装 + 配饰 + 表情

应该尽可能在该角色自己的连续 NL 描述中完成。

不要：

The woman has long black hair, and the man has silver hair, black eyes, glasses, and a black coat...

这种混合式描述。

应该：

The woman has long black hair and amber eyes. She wears a black dress. She has a small smile.

The man has short silver hair and pale golden eyes. He wears a black coat and glasses. His eyebrows are furrowed.


## 14. 多角色动作与互动

多角色互动统一使用 NL。

明确写出：

- 谁在做动作
- 动作作用于谁
- 谁位于哪里
- 谁面向哪里
- 身体之间的关系
- 与物体之间的关系

例如：

The woman stands behind the man and places both hands on his shoulders.

The man sits on the sofa while the woman kneels beside him.

The girl on the left holds the boy's hand.

不要使用无法明确判断动作主体的模糊表达。


## 15. 简单与复杂构图的区分

简单构图可以使用 Tag：

- centered composition
- left side
- right side
- foreground
- background
- symmetrical composition

复杂构图使用 NL。

例如：

The woman stands in the foreground on the left while the man sits farther back on the right. The woman faces the man, with her upper body turned toward him.

涉及：

- 前后距离
- 上下位置
- 多人物位置关系
- 身体朝向
- 复杂视线关系
- 多层空间关系

时，应使用 NL。


## 16. 简单与复杂动作的区分

非常简单、独立的动作可以使用 Tag：

standing
sitting
kneeling
walking

复杂动作使用 NL：

The woman sits on the floor with one knee raised and one hand resting on the raised knee.

如果动作涉及多个身体部位之间的关系，应使用 NL。


## 17. 复杂物体关系

普通物体交互可以直接使用 NL：

The woman holds a book.

The man holds the woman's hand.

复杂的跨角色物体关系需要尽量拆解成简单视觉事实。

例如：

The man holds the leash. The leash is attached to the woman's collar.

不要通过大量重复、否定和强调来试图强行解决复杂关系。

尤其是：

角色A的身体部位
→ 物体
→ 角色B的身体部位

这种复杂拓扑关系，即使文字描述正确，也可能无法被生图模型稳定执行。

因此规则的目标是：

尽可能明确地描述关系，而不是无限增加文字。


## 18. 不使用 BREAK

多角色提示词默认不要使用 BREAK 或其他特殊角色分隔符。

不要依赖：

BREAK
角色分隔线
大量括号
特殊分隔符

来强制隔离角色。

优先使用：

独立的连续 NL 角色描述
+
稳定的角色指代

来建立角色之间的对应关系。


## 19. 避免特征重复污染

不要为了强调某个角色的属性，在后续多个句子中反复重复同一个属性。

例如不要反复写：

The man has golden eyes.
The man has golden eyes.
His golden eyes...
His golden eyes...

过度重复可能导致属性扩散、融合或影响其他角色。

每个关键属性在角色建立阶段明确描述一次即可。

后续使用角色名称或稳定指代。


## 20. 处理用户的抽象要求

当用户提出：

“性感”
“温柔”
“神秘”
“压迫感”
“危险感”
“帅气”
“优雅”
“有故事感”

等无法直接作为视觉事实的要求时，不要直接把这些词塞进提示词。

应该转换成具体可见内容。

例如：

“温柔”
→ slight smile, relaxed eyebrows, soft gaze

“危险感”
→ sharp eyes, narrowed eyes, dark shadows across the face

“优雅”
→ upright posture, controlled hand position, long flowing clothing

如果无法合理转换为具体视觉信息，则不要加入。


## 21. 提示词语言

Tag 使用简洁的标签式表达。

NL 使用自然、直接、明确的英文句子。

NL 不需要文学化。

不要为了追求自然语言而写成长篇小说。

每个句子都应该具有明确的视觉作用。

如果删除一个句子不会损失任何视觉信息，则应该考虑删除。


## 22. 标签选择原则

Tag 不需要把所有能想到的标签都塞进去。

只保留：

- 能明确表达画面结构
- 能明确表达镜头
- 能明确表达环境
- 能明确表达时间
- 能明确表达光影
- 能明确表达简单构图
- 能明确表达简单动作

的标签。

避免：

- 同义词堆叠
- 无意义重复
- 抽象形容词
- 文学化标签
- 质量标签
- 风格标签


## 23. 最终检查

生成提示词前，检查：

1. 是否 Tag 位于最前面？
2. Tag 后是否换行进入 NL？
3. Tag 是否只负责公共、简单的视觉信息？
4. 角色外貌是否放在 NL？
5. 服装是否放在 NL？
6. 配饰是否放在 NL？
7. 表情是否放在对应角色的 NL？
8. 多角色是否分别建立独立的角色描述？
9. 后续是否使用稳定的角色指代？
10. 是否避免把不同角色的属性混在一起？
11. 是否没有使用 BREAK？
12. 复杂动作是否使用 NL？
13. 复杂空间关系是否使用 NL？
14. 多角色互动是否使用 NL？
15. 是否只描述可见视觉内容？
16. 是否删除了抽象、心理、故事和文学化描述？
17. 是否没有擅自改变固定角色设定？
18. 是否没有加入风格和质量词？
19. 是否存在无意义的重复？
20. 是否尽可能保持简洁？

最终提示词应该是：

**Tag 负责公共画面结构，NL 负责角色与复杂视觉关系。**

**单角色也遵守 Tag → NL。**

**多角色则在 NL 中分别建立角色，再描述角色之间的动作、互动和空间关系。**`,
    },
    {
        id: "material", name: "素材", role: "user", enabled: true,
        content: `【小剧场正文】
{{theater_text}}

{{participants}}

{{special_request}}

{{previous_scenes}}`,
    },
    {
        id: "format", name: "输出格式", role: "system", enabled: true,
        content: `## 输出格式
只输出一个 JSON 对象，不要解释，不要代码围栏：

{
  "summary": "一至三句中文画面描述",
  "sourceExcerpt": "正文中连续、逐字一致的一段原文",
  "positivePrompt": "英文生图提示词"
}

补充约束：
- positivePrompt 用英文，按上面的规范写成两段：Tag 一段，换行后接 NL 一段。这个换行在 JSON 字符串里写成 \\n，不要把 JSON 真的换行写坏。
- summary 用中文，写清「谁、在做什么、在哪」。它显示在配图面板上，也是「换个画面」时区分新旧画面的依据，所以要与这一幅画面对得上，不要写成提示词的翻译。
- sourceExcerpt 用中文，从正文里原样复制画面所依据的那几句，不要改写、不要拼接、不要加省略号。它必须能在正文里逐字找到，面板会显示出来供你核对画面选得对不对。
- 只输出这三个字段：不要再输出负向提示词或人物分段提示词。`,
    },
];

const MANAGED_BY_ID = new Map(MANAGED_ENTRIES.map(entry => [entry.id, entry]));

/** 该 id 是否是托管条目（托管条目不可删除，但有单条恢复默认）。 */
export function isManagedEntry(id) {
    return MANAGED_BY_ID.has(String(id));
}

/** 托管条目的出厂内容，供「恢复默认内容」使用。 */
export function managedEntryDefault(id) {
    const factory = MANAGED_BY_ID.get(String(id));
    return factory ? { ...factory } : null;
}

/** 造一份完整的托管条目集（导入与新建都从这里取）。 */
function materializeManagedEntries() {
    return MANAGED_ENTRIES.map(entry => ({
        id: entry.id,
        name: entry.name,
        role: entry.role,
        enabled: entry.enabled,
        content: entry.content,
        managed: true,
    }));
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function createEntryId(prefix = "entry") {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRole(value) {
    const role = String(value ?? "").trim();
    return role === "system" || role === "assistant" ? role : "user";
}

/** 新建条目，供界面使用。 */
export function createPresetEntry(overrides = {}) {
    return {
        id: createEntryId("entry"),
        name: "新条目",
        role: "system",
        enabled: true,
        content: "",
        ...overrides,
    };
}

/** 新建预设：直接带上一整套托管条目，开箱可用。 */
export function createUserPreset(name = "新预设") {
    return {
        id: createEntryId("preset"),
        name: String(name).trim() || "新预设",
        entries: materializeManagedEntries(),
    };
}

// ---------------------------------------------------------------------------
// 规范化与迁移
// ---------------------------------------------------------------------------

function normalizeEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const entry = {
        id: String(raw.id ?? "").trim() || createEntryId("entry"),
        name: String(raw.name ?? "").trim() || "未命名条目",
        role: normalizeRole(raw.role),
        enabled: raw.enabled !== false,
        content: typeof raw.content === "string" ? raw.content : "",
    };
    // managed 只认代码里存在的托管 id：手改设置塞进来的标记不算数。
    if (raw.managed === true && isManagedEntry(entry.id)) entry.managed = true;
    return entry;
}

function normalizeUserPreset(raw) {
    if (!raw || typeof raw !== "object") return null;
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(normalizeEntry).filter(Boolean);
    return {
        id: String(raw.id ?? "").trim() || createEntryId("preset"),
        name: String(raw.name ?? "").trim() || "未命名预设",
        entries,
    };
}

function normalizeState(current) {
    const presets = (Array.isArray(current?.presets) ? current.presets : []).map(normalizeUserPreset).filter(Boolean);
    const requested = String(current?.active_preset_id ?? "").trim();
    // active 指丢时回落到第一个：有预设却没有生效的那份，界面会连条目都渲染不出来。
    // 只有真的一个预设都没有才留空，界面据此走「导入 / 新建」引导。
    const active = presets.some(preset => preset.id === requested) ? requested : (presets[0]?.id || "");
    return { version: ILLUSTRATION_PRESETS_VERSION, active_preset_id: active, presets };
}

/**
 * 把旧的单块规范迁移成一份预设。
 *
 * ⚠️ 旧规范是**纯 system 文本**，素材原本由代码拼进 user 消息，所以它里面没有
 * {{theater_text}}。只搬那一段的话，新的「必须有正文占位符」守卫会在第一次选景时
 * 直接报错 —— 等于把配图功能打死。所以托管条目一并补上（其中就含素材条目）。
 */
function migrateLegacySpec(data) {
    const legacy = data?.[LEGACY_SPEC_KEY];
    // 与旧读取器口径一致：v 不匹配的陈旧数据本来就在被丢弃，不要把它复活。
    if (!legacy || typeof legacy !== "object" || legacy.v !== LEGACY_SPEC_VERSION) return null;
    const text = typeof legacy.text === "string" ? legacy.text.trim() : "";
    if (!text) return null;
    return {
        id: createEntryId("preset"),
        name: "我的选景规范",
        entries: [
            { id: createEntryId("entry"), name: "原选景规范", role: "system", enabled: true, content: text },
            ...materializeManagedEntries(),
        ],
    };
}

const ROLES = new Set(["system", "user", "assistant"]);

/**
 * 判断一份预设是否已经是规范形态。
 *
 * 只看字段的类型与取值，**不比较内容文本** —— 条目正文可能很长，
 * 逐字比对会让每次 getExtData() 都做一遍全量字符串比较。
 * managed 只认代码里存在的托管 id，手改设置塞进来的标记会在规范化时被剥掉。
 */
function isCanonicalEntry(entry) {
    return Boolean(entry) && typeof entry === "object"
        && typeof entry.id === "string" && entry.id.length > 0
        && typeof entry.name === "string" && entry.name.length > 0
        && typeof entry.content === "string"
        && typeof entry.enabled === "boolean"
        && ROLES.has(entry.role)
        && (entry.managed === undefined || (entry.managed === true && isManagedEntry(entry.id)));
}

function isCanonicalPreset(preset) {
    return Boolean(preset) && typeof preset === "object"
        && typeof preset.id === "string" && preset.id.length > 0
        && typeof preset.name === "string" && preset.name.length > 0
        && Array.isArray(preset.entries)
        && preset.entries.every(isCanonicalEntry);
}

/**
 * 规范化与迁移，返回是否发生改动。幂等：形状正确时返回 false，不触发落盘。
 * 由 utils/storage.js 的 getExtData() 调用，读取端也会防御性自调一次。
 */
export function ensureIllustrationPresets(data) {
    if (!data || typeof data !== "object") return false;
    const current = data[ILLUSTRATION_PRESETS_KEY];
    // shape 检查要连 active 一起看：它指向不存在的预设时同样得走规范化回落，
    // 否则界面会拿到 null 预设去解引用。
    const activeOk = current && typeof current.active_preset_id === "string"
        && (current.active_preset_id === ""
            ? current.presets?.length === 0
            : current.presets?.some(preset => preset?.id === current.active_preset_id));
    if (current
        && current.version === ILLUSTRATION_PRESETS_VERSION
        && Array.isArray(current.presets)
        && current.presets.every(isCanonicalPreset)
        && activeOk) return false;

    const next = normalizeState(current);
    if (!current) {
        const migrated = migrateLegacySpec(data);
        if (migrated) {
            next.presets.push(migrated);
            next.active_preset_id = migrated.id;
            // 先写新键再删旧键：中途抛错则旧键完好。
            data[ILLUSTRATION_PRESETS_KEY] = next;
            delete data[LEGACY_SPEC_KEY];
            return true;
        }
    }
    data[ILLUSTRATION_PRESETS_KEY] = next;
    return true;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

/** 全部预设（只有用户预设了——不再有内置预设）。 */
export function listPresets(data) {
    const presets = data?.[ILLUSTRATION_PRESETS_KEY]?.presets;
    return (Array.isArray(presets) ? presets : []).map(preset => ({ id: preset.id, name: preset.name }));
}

/** 当前生效的预设；没有配置或指丢时返回 null，界面据此走引导。 */
export function resolveActivePreset(data) {
    const state = data?.[ILLUSTRATION_PRESETS_KEY];
    const activeId = String(state?.active_preset_id ?? "");
    if (!activeId) return null;
    const found = (Array.isArray(state?.presets) ? state.presets : []).find(preset => preset.id === activeId);
    return found ? normalizeUserPreset(found) : null;
}

/** 是否还没配置过任何预设。 */
export function needsSetup(data) {
    return listPresets(data).length === 0;
}

// ---------------------------------------------------------------------------
// 消息构造
// ---------------------------------------------------------------------------

/**
 * 把已经选过的画面拼成「换一个不同的瞬间」那段提示。
 *
 * 取值依次回落到 positivePrompt：托管条目的「输出格式」要求模型返回 summary，
 * 但用户自写的预设、以及摘要回归之前存下的旧草稿都可能没有它。对生图这条链路来说，
 * 英文提示词比中文摘要更直接 —— 这段提示要表达的本来就只是「这一张已经画过了」，
 * 摘要为空时若不回落，整块会连同标题一起消失，「换个画面」就退化成单纯的重新选景。
 */
function formatPreviousScenes(previousScenes) {
    const list = Array.isArray(previousScenes) ? previousScenes : [];
    const lines = list
        .map(item => {
            if (typeof item === "string") return item.trim();
            return String(item?.summary || item?.sourceExcerpt || item?.positivePrompt || "").trim();
        })
        .filter(Boolean);
    return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

function blockValue(heading, value) {
    const text = String(value ?? "").trim();
    return text ? `【${heading}】\n${text}` : "";
}

function placeholderValues(request) {
    return {
        theater_text: String(request?.theaterText ?? "").trim(),
        participants: blockValue("人物资料", request?.participants),
        special_request: blockValue("本次额外要求", request?.specialRequest),
        previous_scenes: blockValue("已经选过的画面，请换一个不同的瞬间", formatPreviousScenes(request?.previousScenes)),
    };
}

/**
 * 渲染一条条目。
 *
 * 顺序固定：先变量宏，再四个占位符。
 * - 变量值里若含 {{participants}} 会被展开（作者可控）
 * - 素材里若含 {{getvar::x}} 不会被展开（宏已经跑过），用户正文不会变成执行面
 *
 * 占位符用单趟 replace 回调，不做连续多次 .replace("{{x}}", value)：
 * 后者会二次扫描刚插入的文本（正文里字面含 {{participants}} 就会再被展开），
 * 而且字符串替换会让正文里的 $& / $1 变成特殊模式。
 *
 * @param {string} template 条目原文
 * @param {object} values 四个占位符的值
 * @param {(text:string)=>string} [runMacros] 变量宏求值；由调用方注入，本模块保持叶子
 */
export function renderEntryContent(template, values, runMacros) {
    const authored = String(template ?? "");
    const source = typeof runMacros === "function" ? String(runMacros(authored) ?? "") : authored;
    const lines = source.split("\n").map(line => {
        const trimmed = line.trim();
        const onlyPlaceholders = trimmed.length > 0 && PLACEHOLDER_ONLY_LINE.test(trimmed);
        const rendered = (onlyPlaceholders ? trimmed : line).replace(PLACEHOLDER_PATTERN, (match, rawName) => {
            const name = String(rawName).toLowerCase();
            return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match;
        });
        // 整行只有占位符、且它们全部解析为空 → 这一行整体删掉，免得留下孤立标题。
        return onlyPlaceholders && rendered.trim() === "" ? null : rendered;
    }).filter(line => line !== null);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 校验预设能否用来选景。缺正文占位符或重复出现都会让结果不可用。 */
export function validatePresetForSelection(preset) {
    const enabled = (preset?.entries || []).filter(entry => entry.enabled !== false);
    const carriers = enabled.filter(entry => new RegExp(`\\{\\{\\s*${THEATER_TEXT_PLACEHOLDER}\\s*\\}\\}`, "i").test(String(entry.content ?? "")));
    if (!carriers.length) {
        return {
            ok: false,
            code: "MISSING_THEATER_TEXT",
            reason: `当前选景预设里没有 {{${THEATER_TEXT_PLACEHOLDER}}} 占位符，正文不会被送进模型。请在「${preset?.name || "当前预设"}」的素材条目里补上。`,
        };
    }
    if (carriers.length > 1) {
        return {
            ok: false,
            code: "DUPLICATE_THEATER_TEXT",
            reason: `当前选景预设里有 ${carriers.length} 条启用条目都带 {{${THEATER_TEXT_PLACEHOLDER}}}，正文会被重复发送多遍。请只保留一处。`,
        };
    }
    return { ok: true };
}

/**
 * 按当前生效的预设构造选景消息。
 *
 * 调用方要用 beginVariableSandbox() 包住整次调用：写入类变量宏会真的改 ST 的变量存储。
 * 整个过程是同步的，中间不能有 await，否则外部会观察到临时改动。
 *
 * @param {object} request theaterText / participants / specialRequest / previousScenes
 * @param {object} data 扩展设置对象
 * @param {(text:string)=>string} [runMacros] 变量宏求值（见 stVariables.js）
 * @returns {Array<{role:string,content:string}>}
 */
export function buildIllustrationMessages(request, data, runMacros) {
    const preset = resolveActivePreset(data);
    if (!preset) {
        throw Object.assign(
            new Error("还没有选景预设。打开场景配图设置，导入一份预设或新建一份。"),
            { code: "NO_PRESET" },
        );
    }
    const check = validatePresetForSelection(preset);
    if (!check.ok) {
        // 在发起任何 LLM 调用之前就拦下：否则会拿一份没有正文的提示词去出图并计费。
        throw Object.assign(new Error(check.reason), { code: check.code });
    }
    const values = placeholderValues(request);
    const messages = [];
    for (const entry of preset.entries) {
        if (entry.enabled === false) continue;
        const content = renderEntryContent(entry.content, values, runMacros);
        if (!content) continue;
        messages.push({ role: normalizeRole(entry.role), content });
    }
    return messages;
}

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------

function isContextEntry(identifier, definition) {
    if (definition?.marker === true) return true;
    return ST_CONTEXT_IDENTIFIERS.has(identifier);
}

/**
 * 读取一份 SillyTavern Chat Completion 预设，转成选景预设。
 *
 * 刻意**不复用** promptManager 的 normalizeChatCompletionPreset：那一个还会注入小剧场
 * 受管条目、按 REMOVED_MARKERS 静默丢条目、把 ST 动态标记提升成 type:"dynamic"、
 * 把空内容改写成 {{marker}} —— 那套「标记即运行时上下文占位符」的契约正是本链路不能有的。
 *
 * 酒馆预设完全不知道小剧场要怎么选景，所以末尾一律补上托管条目（见 MANAGED_ENTRIES）。
 *
 * @param {object} raw 预设 JSON
 * @param {object} [options] name 覆盖预设名
 * @returns {object} 选景预设
 */
export function readChatCompletionPreset(raw, options = {}) {
    if (!raw || typeof raw !== "object") throw new Error("预设数据无效");
    const definitions = new Map();
    for (const prompt of Array.isArray(raw.prompts) ? raw.prompts : []) {
        const identifier = String(prompt?.identifier ?? "").trim();
        if (!identifier || definitions.has(identifier)) continue;
        definitions.set(identifier, prompt);
    }
    if (!definitions.size) throw new Error("这个文件里没有可用的提示词条目");

    const { order } = getPromptOrder(raw);
    // prompt_order 缺失或为空时回退到 prompts 数组顺序 —— 否则会静默导入一个空预设。
    const sequence = order.length
        ? order.map(item => ({ identifier: String(item?.identifier ?? "").trim(), enabled: item?.enabled !== false }))
        : [...definitions.keys()].map(identifier => ({ identifier, enabled: true }));

    const entries = [];
    let droppedContextEntries = 0;
    for (const item of sequence) {
        const definition = definitions.get(item.identifier);
        if (!definition) continue;
        if (isContextEntry(item.identifier, definition)) { droppedContextEntries += 1; continue; }
        entries.push({
            id: createEntryId("st"),
            name: String(definition.name ?? "").trim() || item.identifier,
            role: normalizeRole(definition.role),
            enabled: item.enabled,
            content: typeof definition.content === "string" ? definition.content : "",
        });
    }

    const name = String(options.name ?? raw.name ?? "").trim() || "导入的预设";
    return {
        id: createEntryId("preset"),
        name,
        // 导入的是别人写的预设，末尾补上小剧场自己的那一套，否则它压根没法用来选景。
        entries: [...entries, ...materializeManagedEntries()],
        droppedContextEntries,
        importedEntries: entries.length,
    };
}

/** 导出成标准 ST Chat Completion 形状：既能回灌本插件，也能直接给酒馆用。 */
export function serializeIllustrationPreset(preset) {
    const prompts = [];
    const order = [];
    const used = new Set();
    (Array.isArray(preset?.entries) ? preset.entries : []).forEach((entry, index) => {
        let identifier = String(entry?.id ?? "").trim() || `illustration_entry_${index}`;
        while (used.has(identifier)) identifier = `${identifier}_${index}`;
        used.add(identifier);
        prompts.push({
            identifier,
            name: String(entry?.name ?? "").trim() || identifier,
            role: normalizeRole(entry?.role),
            content: typeof entry?.content === "string" ? entry.content : "",
        });
        order.push({ identifier, enabled: entry?.enabled !== false });
    });
    return {
        name: String(preset?.name ?? "").trim() || "选景预设",
        prompts,
        prompt_order: [{ character_id: 100001, order }],
    };
}

/** 形状判定：是不是可直接读取的预设文件（本插件导出的与酒馆预设形状一致，用同一个读取器）。 */
export function isChatCompletionPreset(raw) {
    return Boolean(raw && typeof raw === "object" && (Array.isArray(raw.prompts) || Array.isArray(raw.prompt_order)));
}
