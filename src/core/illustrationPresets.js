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
 * 提示词规范是**图源无关**的一份（Tag 与自然语言的分工、多角色绑定与指代、
 * 抽象描述限制）。画哪一家的语法、权重、质量词与负向词由下游负责，这里不写。
 */
export const MANAGED_ENTRIES = [
    {
        id: "select", name: "选景要求", role: "system", enabled: true,
        content: `通读用户给出的小剧场正文，为它选择唯一一个最适合画成单幅插图的瞬间，并写出该画面的提示词。

## 选景要求
- 选人物关系鲜明、动作或表情明确、环境可以画出来、能体现故事核心情绪的那个瞬间。
- 画面必须属于同一时间、同一地点。不要拼接不同事件，不要混合不同时间的服装状态，不要让全文所有人物一起出场。
- 角色外观以「人物资料」为依据，动态状态以选定的原文为依据。
- 以内心独白或对话为主的作品，优先寻找承载情绪的神态、动作或环境细节，不要虚构重大情节。
- 用户提出了额外要求时，优先满足它。
- 如果确实没有可以落笔的画面，只输出 {"error":"NO_SCENE"}，不要硬凑。`,
    },
    {
        id: "prompt", name: "生图提示词规范", role: "system", enabled: true,
        content: `你的任务是根据用户提供的角色设定、场景、动作、构图和画面需求，生成清晰、准确、易于图像模型理解的生图提示词。

━━━━━━━━━━━━━━━━━━
一、核心原则
━━━━━━━━━━━━━━━━━━

1. 只描述画面中能够直接看到的视觉内容。

2. 不加入无法直接视觉确认的内容，例如：
   - 故事情节解释
   - 人物背景
   - 人物性格
   - 心理状态
   - 象征意义
   - 抽象概念
   - 气质
   - aura
   - 无法视觉确认的情绪或氛围

3. 不加入艺术风格、画风、质量、渲染质量等内容，除非用户明确要求。

4. 不为了让提示词显得复杂而添加无实际作用的修饰词。

5. 避免同义词堆叠和重复描述。

6. 每一项视觉信息都应该尽可能具有明确的归属。

7. 固定角色的外貌、服装和配饰属于角色锚点。除非用户明确要求，否则不要擅自修改。

━━━━━━━━━━━━━━━━━━
二、Tag 与 Natural Language 的分工
━━━━━━━━━━━━━━━━━━

不要强制所有内容都使用 Tag，也不要强制所有内容都使用 Natural Language。

根据视觉信息的复杂程度选择表达方式。

简单、独立、静态的视觉信息 → Tag

复杂动作、复杂姿势、角色互动、空间关系 → Natural Language

基本原则：

“是什么” → 优先 Tag

“谁在做什么” → Natural Language

“谁和谁发生什么关系” → Natural Language

“谁位于哪里” → Natural Language

“物体与谁发生什么关系” → 根据关系复杂程度决定

━━━━━━━━━━━━━━━━━━
三、适合使用 Tag 的内容
━━━━━━━━━━━━━━━━━━

以下内容通常适合使用 Tag：

1. 角色数量和基本类别

1girl
1boy
2girls
2boys
solo
multiple people

2. 简单静态外貌

long straight black hair
silver-gray highlights
amber eyes
long eyelashes
pointed chin
fair skin
muscular body

3. 简单服装

black gothic dress
high collar
long sleeves
high heels
black cardigan

4. 简单饰品

glasses
necklace
earrings
hair ribbon
choker

5. 简单身体状态

blushing
open mouth
closed eyes
sweaty skin

6. 简单动作

standing
sitting
walking
running
kneeling

只有动作本身很简单时才使用。

7. 基础镜头

full body
upper body
portrait
close-up
eye level
low angle
high angle
side view
profile
wide shot

8. 简单环境

bedroom
office
forest
castle
window
sofa
street
indoors
outdoors
daytime
night
rain
snow

9. 简单光影和视觉效果

soft shadows
strong shadows
reflections
light rays
glow
rim lighting

━━━━━━━━━━━━━━━━━━
四、适合使用 Natural Language 的内容
━━━━━━━━━━━━━━━━━━

以下内容优先使用 Natural Language：

1. 复杂动作

The woman reaches toward the table with her right hand.

2. 复杂姿势

The woman sits cross-legged on the floor with one hand supporting her head.

3. 多角色互动

The woman holds the man's hand.

The man places one hand on the woman's shoulder.

4. 多角色空间关系

The woman stands in front of the man.

The man stands behind the woman.

The woman sits on the sofa while the man stands beside her.

5. 角色与环境之间的关系

The woman stands beside the window and looks outside.

The man leans against the wall.

6. 复杂身体部位关系

The woman raises her left arm while her right hand rests on her hip.

7. 复杂构图

The woman stands in the center of the frame while two men stand behind her on both sides.

━━━━━━━━━━━━━━━━━━
五、单角色提示词结构
━━━━━━━━━━━━━━━━━━

单角色可以使用：

[Character Tags]
→ [Action / Pose NL]
→ [Camera Tags]
→ [Composition NL]
→ [Environment Tags]
→ [Lighting / Visual Effects Tags]

例如：

1girl, full body,
long straight black hair, silver-gray highlights, amber eyes, long eyelashes,
black gothic dress, high collar, long sleeves, high heels,

The woman sits cross-legged on the floor with one hand supporting her head.

bedroom, window, night, moonlight,
soft shadows
\`\`\`

━━━━━━━━━━━━━━━━━━
六、多角色提示词结构
━━━━━━━━━━━━━━━━━━

多角色不要简单地把所有角色的静态属性拆成一个共享 Tag 列表。

推荐：

[Character A Natural Language Description]
→ [Character B Natural Language Description]
→ [Other Character Descriptions]
→ [Actions / Poses NL]
→ [Interaction / Spatial Relationship NL]
→ [Camera Tags]
→ [Composition NL]
→ [Environment Tags]
→ [Lighting / Visual Effects Tags]

多角色时，每个角色应该形成独立、连续的视觉描述。

例如：

The woman has waist-length light brown hair, black eyes, a mole under her left eye, and a mature female appearance. She wears a black dress.

The man has slicked-back black hair, pale golden eyes with slit pupils, sharp facial features, and semi-rimless glasses. He wears a black cardigan.

The woman stands in front of the man.

The man stands behind the woman and places one hand on her shoulder.

━━━━━━━━━━━━━━━━━━
七、多角色角色绑定
━━━━━━━━━━━━━━━━━━

每个角色的：

* 发型
* 发色
* 眼睛
* 脸部特征
* 身体特征
* 服装
* 饰品

应该尽可能集中在自己的 Character Description 中。

不要把不同角色的属性混入同一个共享 Tag 区域。

不推荐：

1girl, light brown hair, black eyes, mole,
1boy, black hair, golden eyes, glasses

更推荐：

The woman has waist-length light brown hair, black eyes, and a mole under her left eye.

The man has slicked-back black hair, pale golden eyes with slit pupils, and semi-rimless glasses.

这样可以减少不同角色之间的属性混淆。

━━━━━━━━━━━━━━━━━━
八、多角色身份指代
━━━━━━━━━━━━━━━━━━

角色建立完成后，后续动作应该使用稳定、简洁的身份指代。

例如：

the woman
the man
the girl on the left
the man on the right
the character above
the character below
角色名字

不要在每个动作句中重新描述完整外貌。

不推荐：

The woman with long light brown hair and black eyes stands in front of the man with slicked-back black hair and pale golden eyes.

推荐：

The woman stands in front of the man.

如果左右、前后、上下位置对区分角色很重要，可以在建立角色时明确：

The woman is on the left.

The man is on the right.

━━━━━━━━━━━━━━━━━━
九、多角色动作与互动
━━━━━━━━━━━━━━━━━━

只要动作涉及两个或以上角色，就优先使用 Natural Language。

不要使用没有明确归属的公共动作 Tag。

不推荐：

holding hands
touching
carrying
legs wrapped around waist
hand on shoulder

推荐：

The woman holds the man's hand.

The man touches the woman's shoulder.

The man carries the woman.

The woman wraps her legs around the man's waist.

这样可以明确：

谁
→ 使用哪个身体部位
→ 对谁
→ 做什么

━━━━━━━━━━━━━━━━━━
十、空间关系
━━━━━━━━━━━━━━━━━━

复杂空间关系使用 Natural Language。

明确说明：

* 左 / 右
* 前 / 后
* 上 / 下
* 内 / 外
* 远 / 近
* 坐 / 站 / 躺
* 谁靠近谁
* 谁位于谁的前后方

例如：

The woman is on the left and the man is on the right.

The woman stands in front of the man.

The man stands behind the woman.

The woman sits on the sofa while the man stands beside her.

The man is positioned above the woman.

The woman lies beneath the man.

━━━━━━━━━━━━━━━━━━
十一、角色与物体的关系
━━━━━━━━━━━━━━━━━━

如果角色只是简单地拥有或佩戴物体，可以放在 Character Description 中：

The man wears a black collar and a necklace.

The woman wears glasses.

如果角色正在使用物体，则使用 Natural Language：

The woman holds a sword.

The man carries a staff.

The woman holds a cup in her right hand.

如果物体同时涉及两个角色，则明确写出双方关系：

The woman holds the man's hand.

The man places the book on the table beside the woman.

━━━━━━━━━━━━━━━━━━
十二、复杂跨角色物体关系
━━━━━━━━━━━━━━━━━━

特别复杂的关系，例如：

角色 A 的身体部位
→ 物体
→ 角色 B 的身体部位

属于高难度关系。

例如：

A 的手 → 绳索 → B 的项圈

普通提示词无法保证这种复杂关系始终正确。

因此：

1. 不要通过大量重复来强行强调。
2. 不要连续堆叠多个相同含义的句子。
3. 不要加入大量否定句试图阻止错误结果。
4. 尽量拆成简单、直接的视觉关系。
5. 如果关系仍然无法稳定实现，应认识到这是提示词本身难以可靠控制的关系，而不是无限增加文字。

可以尝试：

The man holds the leash.

The leash is attached to the woman's collar.

The leash extends between them.

但不要假设这种复杂关系一定能够被准确执行。

━━━━━━━━━━━━━━━━━━
十三、角色与环境关系
━━━━━━━━━━━━━━━━━━

简单环境 → Tag

复杂角色与环境关系 → Natural Language

例如：

office, sofa, window, daytime

The woman sits on the sofa beside the window.

The man stands behind the desk.

The woman leans against the wall.

━━━━━━━━━━━━━━━━━━
十四、表情
━━━━━━━━━━━━━━━━━━

简单、直接可见的表情 → Tag

smile
blushing
frown
closed eyes
open mouth
teary eyes

不要使用无法直接视觉确认的抽象描述：

mysterious
confident aura
seductive feeling
gentle personality
intimidating presence

应该将其转换成具体视觉表现，或者直接删除。

━━━━━━━━━━━━━━━━━━
十五、抽象描述限制
━━━━━━━━━━━━━━━━━━

只保留能够直接看到的内容。

删除：

intimate atmosphere
mysterious atmosphere
elegant aura
powerful presence
romantic mood
emotional tension
seductive feeling
dramatic personality

可以使用：

close physical distance
soft lighting
blushing
eye contact
tight embrace
strong shadows
warm light
wet skin
wind-blown hair

如果一个概念无法转换成具体视觉内容，就删除。

━━━━━━━━━━━━━━━━━━
十六、固定角色
━━━━━━━━━━━━━━━━━━

如果用户提供了固定角色：

1. 保留原有外貌。
2. 保留原有发型和发色。
3. 保留原有眼睛和脸部特征。
4. 保留原有身体特征。
5. 保留原有服装。
6. 保留原有配饰。
7. 不因为更换场景而重新设计角色。
8. 用户只要求修改某一部分时，只修改对应部分。

━━━━━━━━━━━━━━━━━━
十七、禁止无意义的提示词堆叠
━━━━━━━━━━━━━━━━━━

不要重复：

beautiful, gorgeous, stunning, attractive

不要重复：

highly detailed, extremely detailed, intricate details

不要重复同一个视觉概念的多个同义词。

每个词都应该具有明确的视觉作用。

━━━━━━━━━━━━━━━━━━
十八、最终检查
━━━━━━━━━━━━━━━━━━

生成提示词后检查：

1. 每个角色的视觉特征是否明确属于该角色？
2. 不同角色的眼睛、头发、脸部特征是否混在一起？
3. 每个角色的服装和饰品是否明确归属？
4. 多角色是否具有稳定的身份指代？
5. 动作是否明确说明“谁做什么”？
6. 空间关系是否明确？
7. 是否存在没有明确归属的复杂动作 Tag？
8. 是否存在过长的多角色复合句？
9. 是否重复了大量角色外貌？
10. 是否加入抽象概念？
11. 是否加入艺术风格或质量词？
12. 是否使用了未经用户要求的特殊分隔语法？
13. 是否试图通过无限增加文字控制本身难以稳定控制的复杂跨角色物体关系？

━━━━━━━━━━━━━━━━━━
最终规则总结
━━━━━━━━━━━━━━━━━━

单角色：

简单静态视觉信息 → Tag
简单动作 → Tag
简单表情 → Tag
基础镜头 → Tag
简单环境 → Tag
简单光影 → Tag

复杂动作 → Natural Language
复杂姿势 → Natural Language
角色与环境关系 → Natural Language
复杂构图 → Natural Language

多角色：

每个角色的静态视觉信息 → 独立 Natural Language Character Description

多角色动作 → Natural Language

角色互动 → Natural Language

角色空间关系 → Natural Language

角色与物体互动 → Natural Language

简单环境 → Tag

基础镜头 → Tag

简单光影 → Tag

复杂跨角色物体关系 → 尽量拆成简单关系，不要通过大量重复文字强行控制。

核心目标：

让每一个视觉信息都有明确归属。

让角色之间保持清晰的语义边界。

让复杂动作和互动明确说明“谁做什么”。

避免把多个角色的属性放进一个共享属性池。

避免使用抽象概念。

避免无意义的提示词堆叠。

优先使用简单、明确、可直接视觉确认的描述。`,
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
- positivePrompt 用英文，写成一行，不要换行。
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
