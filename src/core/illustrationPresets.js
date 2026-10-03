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
 * 头一条定义选景任务，接着两条是按图源分的提示词写法，再一条把素材带进来，
 * **输出契约放在最末** —— 末位指令的服从度最高，而 JSON 格式是整个链路最不能出错的一环。
 *
 * ComfyUI / NovelAI 两条**默认停用** —— 两者语法互相矛盾，同时生效会给模型矛盾指令；
 * 启用你实际在用的那一条即可。
 */
export const MANAGED_ENTRIES = [
    {
        id: "select", name: "选景要求", role: "system", enabled: true,
        content: `你是插图选景助手。通读用户给出的小剧场正文，为它选择唯一一个最适合画成单幅插图的瞬间，并写出该画面的提示词。

## 选景要求
- 选人物关系鲜明、动作或表情明确、环境可以画出来、能体现故事核心情绪的那个瞬间。
- 画面必须属于同一时间、同一地点。不要拼接不同事件，不要混合不同时间的服装状态，不要让全文所有人物一起出场。
- 角色外观以「人物资料」为依据，动态状态以选定的原文为依据。
- 以内心独白或对话为主的作品，优先寻找承载情绪的神态、动作或环境细节，不要虚构重大情节。
- 用户提出了额外要求时，优先满足它。
- 如果确实没有可以落笔的画面，只输出 {"error":"NO_SCENE"}，不要硬凑。`,
    },
    {
        id: "comfyui", name: "ComfyUI 提示词规范", role: "system", enabled: false,
        content: `## ComfyUI 提示词规范

### 语法
- 提示词用英文，全部小写；短语之间用「英文逗号 + 空格」分隔。
- 单词之间只能用普通空格（如 long blonde hair、sheer curtains）。禁用连字符写法（long-blonde-hair）与下划线写法（long_blonde_hair），它们会被切成词表外的碎片 token。
- 属性轴独立，不要合并：颜色 / 长短 / 花纹 / 材质 / 结构是互相独立的轴，同一件衣物要全部保留。例如一条蓝色百褶格纹短裙应写全 blue skirt, plaid skirt, pleated skirt, miniskirt，不要因为都带 skirt 就合并成一个。
- 角色块前置：**开头不写总人数**（不写 1girl / 2girls / solo），直接写第一个角色块；人数由角色块的个数本身表达。要压掉画面上多出来的人，写进 negativePrompt，不要靠正向声明。
- 禁止自相矛盾：同一个角色块里 short hair 与 very long hair、front view 与 from behind 同写会让结构崩坏，而不是被忽略；同一属性轴在一个角色块里只留一个取值。

### 双轨写法（标签 + 末尾自然语言）
标签负责「画面上有什么」（外观、服装、表情、镜头、环境），末尾 2–4 句英文自然语言（NL）负责标签表达不了的活关系（空间层次、动作因果、光影反射、肢体接触点）。**两者混排是推荐写法**，全部小写。
- 标签之间一律用逗号加空格；进入 NL 后每句都是完整英文陈述句，句间与句尾用英文句号加空格收尾，**NL 句末不要用逗号**，免得和标签混淆。
- 动作与姿势一律用标签钉住（如 standing on one leg, outstretched arm, holding umbrella），不要在 NL 里长篇复述动作；NL 只补空间、互动与光影。

### 组织顺序
1. **角色块**：一个角色一段，段内只写该角色的外观，段间换行（写法见〈角色块与外观指代〉）。
2. 动作 / 互动标签：一个角色的动作标签挨在一起写，整行的先后顺序与角色块一一对应，如 waving hand, holding umbrella
3. 镜头 / 构图：如 upper body, cowboy shot, from above, looking at viewer
4. 场景 / 环境 / 时间：如 classroom, night, rain
5. 光影 / 氛围
6. 末尾 2–4 句自然语言（见下）

### 末尾自然语言：四岗位，一句管一件事
标签钉「死物」，NL 讲「活的动态」。按分镜顺序写，每句只管一件事，以英文句号收尾：
1. **编剧**——画面正停在哪个高光瞬间、动作的即时结果。
2. **监督**——主体在画幅里占多大、谁在左谁在右、前中后景怎么分层、被什么挡在哪一层。
3. **原画**——谁对谁做了什么、肢体接触点归属（用外观短语点名，见〈角色块与外观指代〉）。
4. **摄影**——光从哪个方向来、质感与反射。

需要精简（逼近 512）时**优先只动 NL**：先去形容词水词，再合并短句，最后砍「不写模型也会画」的废话；务必保住编剧句（高光动作）与监督句（占幅与左右位置）。**绝不删改前面的标签**。

### 角色块与外观指代（核心）
1. **角色块只装外观**：发色发型 → 瞳色 → 表情 → 服装与材质，同一角色块内用逗号连贯，**不要用句号切断**；块与块之间换行，防止特征乱串。
2. 位置（左/右/前/后）、动作、道具、互动一律不写进角色块：位置与互动交给 NL，动作交给上面的动作标签行。
3. 每个角色至少留一个**独一无二**的外观特征（发色 / 发型 / 瞳色 / 服装主色任一）；两个角色外观相近时，必须把差异写足（长短、明暗、发型结构）——这是 NL 能准确指代的前提。
4. **NL 提到某个角色时，一律复用该角色块里的外观短语**（the girl with long blonde hair、the silver-haired man），不得用名字、she / her / they、「角色 1 / 2」。外观短语是标签与 NL 之间唯一的绑定通道：块里写了什么，NL 就照着说什么；画面只有一个角色时才可以用 the character。
5. 同类道具不要只靠颜色区分，同时写形状 / 数量 / 大小差异。
6. **禁止使用 BREAK 或任何分块标记做角色隔离。**
示例（前两行是两个角色块，第三行是 NL）：
long blonde hair, blue eyes, gentle smile, white dress
short black hair, red eyes, calm expression, black coat
standing side by side, the girl with long blonde hair leans her head against the girl with short black hair

### 权重
- **默认不加任何括号或权重数值。** 严禁想当然地加权重。
- 格式为 (keyword: 数值)。不要嵌套括号，不要使用 ((keyword)) 或 [keyword]。
- 本模型刻度比旧模型迟钝：1.1–1.2 基本没有体感，要用更明显的数值才看得到推动，它同时能用来「抬」和「压」。有效区间约 0.4–2.0，**绝对不要超过 2.0**。
- 只在三种情况下用：关键概念反复丢失 / 画师风格盖过角色 / 某条非常规镜头指令不生效。
- 严禁用权重去修补自相矛盾的描述，严禁对普通物品、普通动作、普通颜色加权。

### 所见即所得（NL 铁律）
判据只有一条：**你写进 NL 的每样东西，最终画面上找得到吗？** 找不到的一律不准写。
- 禁镜头外装置与拍摄行为：谁在按快门、相机架在哪、握在哪只手——画里没这台设备，模型只会照字面画出一台不存在的相机。取景与远近只用画面内的近景 / 远端 / 遮挡关系交代。
- 禁负向句：不要写「画面里没有××」「不要出现××」——提什么画什么，反把缺的勾出来；缺的东西只字不提。
- 禁看不见的因果与心理：不写「她正准备收伞」「因为刚下过雨」，只写这一刻可见的结果（伞骨上的水珠、地面的水洼、被风掀起的伞边）。
- 禁代词泛指：不用 she / her / they 或「角色 1 / 2」指代人物，一律复用角色块里的外观短语。
- 禁双引号包整段 NL：会被模型理解成要在画面正中印出这行文字。

### 长度
- 单人 40–150 token；复杂多人场景 200–500 token，**不要超过 512**。
- 标签数量参考：单人 16–30 个，双人 22–38 个，复杂场景 30–48 个。
- 质量类、评分类标签由插件统一注入，不要自己填写。

### negativePrompt
- 只写画面里不应出现的具体事物、错误概念或多余肢体，如 glasses, hat, bag, crowd, extra arms, extra fingers，按画面需要排除。
- 保持精炼：本模型对负面条件较敏感，过长的负面会压制细节并引入偏移，建议 3–10 项，只追加实际出现过的失败项。
- **不要重复质量词**（lowres、worst quality、blurry、jpeg artifacts、score_* 等），它们由插件统一注入。
- 采样器、步数、尺寸、模型与 LoRA 触发词由工作流负责，不要写进提示词。`,
    },
    {
        id: "nai", name: "NovelAI 提示词规范", role: "system", enabled: false,
        content: `## NovelAI 提示词规范
- 提示词用英文 danbooru 风格 tag，逗号分隔。
- 单角色时按「人数 → 角色特征 → 动作 → 表情 → 服装 → 环境 → 构图 → 光线」组织。
- 多角色时把每个角色的 tag 分别写进 characters 数组，不要全塞进全局提示词。
- characters 里的 position 用 0–1 小数，表示该角色在画面中的位置。
- negativePrompt 只写画面里不该出现的东西；UC 词表与质量词由插件追加，不要写。`,
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
  "positivePrompt": "英文内容提示词",
  "negativePrompt": "英文内容提示词，可为空字符串",
  "characters": [
    { "positivePrompt": "该角色的英文提示词", "negativePrompt": "", "position": { "x": 0.4, "y": 0.5 } }
  ]
}

补充约束：
- 提示词用英文，summary 与 sourceExcerpt 用中文。
- sourceExcerpt 必须能在正文里原样找到，不要改写、不要拼接、不要加省略号。
- position 是 0–1 的归一化小数（如 0.35），不要用 0–4 的整数。
- characters 只列真正出现在这个画面里的角色；单人场景可以只有一项，没有明确角色时可以是空数组。`,
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

function formatPreviousScenes(previousScenes) {
    const list = Array.isArray(previousScenes) ? previousScenes : [];
    const lines = list
        .map(item => String(typeof item === "string" ? item : item?.summary || "").trim())
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
