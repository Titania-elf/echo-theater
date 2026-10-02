# Cosmos Vision 公开接口需求：回声小剧场场景配图 v1

> ⚠️ **历史文档，已被取代。** Cosmos Vision 的 `dev` 分支（提交 `85e5c59 feat: 添加对外API`）交付的是另一套更薄的接口，并未按本文实现：只有 `{ version, requestPrompt, generateImage }`，没有 `getCapabilities` / `preparePrompt` / `generate`，也没有选景、`imageSource`、`model`、`presetId`、`previousScenes`、`count` 与 `stage` 进度。
>
> 小剧场已据此重做：选景回到插件自有 LLM，生图改走 `generateImage`。当前实现与约定见 [小剧场-场景配图](./小剧场-场景配图.md)。本文保留仅供追溯当时的设计意图。

状态：供两端独立开发的接口约定，2026-09-18。配套精确类型见 [cosmos-vision-public-api-v1.d.ts](./cosmos-vision-public-api-v1.d.ts)。小剧场端按本文实现；破坏性调整必须先同步这两份文件和调用方。

## 1. 交付目标与开发边界

请在 `cosmos_vision` 插件实现同一 SillyTavern 页面内可调用的 JavaScript API：`window.CosmosVision`。本任务交付公开接口、小剧场专用提示词流程、必要的设置及测试。回声小剧场端 UI、图片落盘、历史/收藏关联由另一端实现。

使用体验：用户阅读一轮完整的小剧场，点击配图 → 输入可选要求 → LLM 通读正文、选出一个适合绘画的瞬间并生成提示词 → 用户预览/修改提示词 → 调用生图 → 小剧场展示并保存图片。第一版每次请求一张图。

不得依赖聊天 DOM、`mesId`、段落 HTMLElement、Vue 组件挂载或消息短码。不得为调用方伪造聊天楼层，不写入聊天正文或 Cosmos 内联图库。复用 Cosmos 底层服务，避免复制一套生图实现。

## 2. 注册、版本和生命周期

- 公开 `window.CosmosVision`，具有 `apiVersion: '1.0'`。
- 注册时发送 `window.dispatchEvent(new CustomEvent('cosmos-vision:ready'))`。调用方也会直接检测全局对象，不能仅依赖事件。
- 插件开关、配置或就绪状态变化时可发送 `cosmos-vision:capabilities-changed`，不带密钥或整份设置。
- `getCapabilities()` 无副作用、无付费请求，返回当前能力。API 尚未初始化完可返回 `ready:false` 和中文 `reason`。
- `enabled:false` 时拒绝 prepare/generate，不绕过插件总开关。
- 保留现有全局对象中未来可能增加的其他公开成员；避免重复挂载多个实例。
- 小剧场兼容 1.x，主版本变化应升级约定。本文为 1.0 的必需字段。

## 3. 接口及调用示例

精确参数、返回类型以 `.d.ts` 为准。三个方法：

1. `getCapabilities()`：就绪情况、默认生图来源、各来源可用性与模型标识、文本长度限制、张数上限、是否支持 theater/provided 上下文。
2. `preparePrompt(request, control)`：仅调用提示词 LLM，返回可编辑 `PromptDraft`；不能启动付费图片生成。
3. `generate(request, control)`：以草稿的最终提示词生图，不再次运行选景 LLM。

```js
const cv = window.CosmosVision;
const capabilities = await cv.getCapabilities();
const controller = new AbortController();
const sceneId = 'caller-owned-stable-scene-id';
const draft = await cv.preparePrompt({
    mode: 'theater',
    imageSource: capabilities.defaultImageSource,
    theaterText: '完整的小剧场纯文本……',
    context: {
        mode: 'provided',
        source: { client: 'titania-theater', sceneId },
        participants: '',
        history: [],
    },
    specialRequest: '画两人在雨中重逢的瞬间，远景，偏冷色。',
}, {
    requestId: crypto.randomUUID(),
    signal: controller.signal,
    onProgress: event => console.log(event.stage),
});
// 调用方可以修改 draft.prompts 中的字段，不需要读取 Cosmos 私有状态。
const result = await cv.generate({ draft, count: 1 }, {
    requestId: crypto.randomUUID(),
    signal: controller.signal,
});
// result.images[0].blob 交由小剧场保存到自己的酒馆用户文件。
```

`requestId` 在每次 prepare 和 generate 分别生成。供应方返回对应的 `requestId`，进度事件不得串任务。相同 ID 的并发重复调用必须合并或明确拒绝；不能启动两次付费任务。当前页面内保留有界去重记录即可，不要求跨刷新 exactly-once。

## 4. 小剧场专用提示词

小剧场复用 Cosmos 现有的消息预设，不再单独维护一套小剧场预设：省略 `presetId` 时使用当前激活预设（默认即内置「默认预设」）。需要不同规则时由使用者在预设管理器新建并激活，或由调用方通过 `presetId` 指定本次预设。不改变日常段落配图的全局激活项。可以复用已有针对 NovelAI 各模型和 ComfyUI 的输出规则、人物格式、画风设置。

整篇正文按焦点段落口径注入内置预设的 `<main_scene>`（同时仍可按 `{{theater_text}}` 引用）；末尾输出规则说明传进来的是尚未选景的完整作品，选景任务由该输出规则与 JSON Schema 承担，因此不会沿用「焦点段落已选好」的旧语义。

自定义预设若需要选景，建议的核心规则：

> 通读完整小剧场，为其选择一个最适合绘制为单幅插图的具体瞬间。优先选择人物关系鲜明、动作或表情明确、环境可视化，并能体现故事核心情绪的画面。画面属于同一时间、同一地点；不得拼接不同事件、混合不同时间的服装状态或让全文所有人物同时出场。角色外观以提供的人物资料为依据，动态状态以选定瞬间的原文为依据。内心独白、对话型作品优先寻找承载情绪的神态、动作或环境细节，避免虚构重大情节。用户指定片段时优先围绕该片段选景。输出简短中文画面描述、连续原文摘录及适用于所选图像来源的绘画提示词。

- 一次 LLM 请求同时完成选景和提示词生成；不需要向调用方返回推理过程。
- 画面描述 `scene.summary` 一至三句话；`scene.sourceExcerpt` 必须是 `theaterText` 中连续、逐字一致的原文，避免凭空制造引用。
- 非叙事内容可以选静物/环境；无法确定有依据的画面时返回 `NO_SCENE`，不要盲目消耗图片请求。
- `previousScenes` 是此前选出的画面摘要，用户点「换个画面」时传入。优先选另一个有依据的瞬间；确实只有一个适合的瞬间时可以复用，不能杜撰。
- `specialRequest` 是仅针对本次任务的额外要求，不保存为全局规则。
- 修改 JSON Schema 和提取器，保留 `scene` 字段。既有提取器只返回正负提示词/人物提示词，直接沿用会丢失选景信息。
- 对返回字段校验；格式错误抛 `INVALID_RESPONSE`，不以空提示词继续生图。允许供应方内部有限次格式修复，但不得无限重试。

## 5. 显式上下文：必需能力

`context.mode:'provided'` 表示仅使用请求内正文、人物资料和历史，以及与聊天无关的 Cosmos 生图/提示词配置。

- 不得读取当前聊天的人物档案、世界书、历史、用户人设来静默补齐。空 `participants/history` 是合法的，表示只根据正文。
- `source.sceneId` 只用于关联和诊断，不是聊天 ID，不触发自动查询。
- 当前 `buildPromptProfilesRuntimeContent()` 会直接 `readChatProfiles()`，自动人物流程也读取当前角色/聊天；公开接口必须绕过这些隐式读取，或为它们增加明确的 override。
- 提示词条目引用、宏展开也要遵守 supplied-only 语义。引用到“当前聊天”动态资料的条目需要替换为显式资料或报 `UNSUPPORTED_CONTEXT`，不能暗中落回当前聊天。
- 依赖“当前角色/用户头像”的 ComfyUI 工作流绑定在 v1 supplied-only 请求中应报 `UNSUPPORTED_CONTEXT` 并说明原因；未来可增加显式参考图字段。不能在读旧收藏时上传当前角色头像。
- 不能为了调用临时修改全局聊天、activePresetId 或 Pinia 当前人物配置再还原；并行任务会串数据。

## 6. 提示词、设置和结果的语义

- `PromptDraft` 是可 JSON 序列化、不含密钥的普通对象，可以存储并在刷新后重新提交。
- `draft.prompts` 是已经合并正负预设、画师串等后的**最终提示词**，用户能看到真正将发送的文字；generate 不再次叠加，避免画师串和质量词重复/随机重选。
- `characterPrompts` 始终是数组。沿用现有字段 `positivePrompt/negativePrompt/position:{x,y}`；v1 坐标规范为 0–1，按供应方现有模型协议转换。
- 第一版图幅、步数、采样器、LoRA、Vibe 等继承 Cosmos 的当前配置。每次 generate 开始时取得一次配置快照，任务执行途中不能随着全局修改而改变。
- `draft.imageSource/model` 绑定准备提示词时的来源与模型。模型/工作流身份改变导致提示词不兼容时返回 `CONFIG_CHANGED`，提示重新分析，不静默套用另一种格式。
- `generate` 可以复用同一份 draft 多次，每次新请求默认使用 Cosmos 的种子策略；不承诺像素级复现。
- 返回 `images: GeneratedImage[]`，包括真实 Blob、MIME、实际宽高、可得时的种子；不能只返回临时 blob URL、远程 URL 或 base64 字符串。
- 支持 PNG/JPEG/WebP，拒绝空文件、HTML 错误页、SVG 等非约定输出。张数与 count 一致；若工作流内部产生额外图片，明确裁取，不能额外发起付费请求。
- 返回实际使用的 `draft`，以及请求 ID。仅含白名单公开字段，不返回账号、端点凭据、请求头、密钥、含认证参数的 URL、完整 resolved request。
- 本接口不写入 Cosmos 收藏/临时图库，不创建聊天短码。小剧场管理自己的图片副本。统计可以记录 `client:'titania-theater'`，但同一次生图只计一次。

## 7. 进度、取消和错误

`control.signal` 同时适用于 LLM 和图像请求。调用前已取消应立即拒绝。取消后及时 reject，`error.name='AbortError'`，可同时提供 `code:'ABORTED'`；不得再次提交结果或触发后续阶段。

无法安全取消后端计算时可以停止等待、丢弃结果，但不得声称后端停止或费用退回。ComfyUI 当前 `/interrupt` 会影响共享后端任务，不能不分归属调用；需要任务级取消，或在确认该任务独占后端执行时才中断，否则只撤销本任务等待。LLM 也不能调用会停止酒馆主聊天生成的全局取消。

并发至少保证排队和隔离；可用 `BUSY` 拒绝，不能悄悄覆盖另一个任务的状态。所有监听器、计时器在结束时释放。进度回调异常不能让已启动任务重复请求。

统一抛 `Error`，附加字符串 `code` 与可读中文 `message`。最少包含：

| code | 语义 |
|---|---|
| NOT_READY / DISABLED | API 未就绪 / 插件关闭 |
| INVALID_REQUEST / TEXT_TOO_LONG | 参数错误 / 超长度；不静默截掉后半篇 |
| UNSUPPORTED_MODE / UNSUPPORTED_CONTEXT | 不支持任务或显式上下文 |
| PROVIDER_NOT_CONFIGURED / LLM_NOT_CONFIGURED | 图像来源或提示词 LLM 未配置 |
| CONFIG_CHANGED | 草稿与当前模型/工作流不兼容 |
| NO_SCENE / INVALID_RESPONSE | 没有可选场景 / 返回解析失败 |
| BUSY / DUPLICATE_REQUEST | 资源忙 / 重复 ID 被拒绝 |
| TIMEOUT / GENERATION_FAILED / ABORTED | 超时 / 失败 / 取消 |

不要在错误信息或进度里回显密钥、完整认证头和原始请求体。远端错误只转为必要的可读信息。

## 8. 验收清单

1. 插件未加载、未就绪、关闭、单一来源缺配置时，能力检测与错误符合约定。
2. 不传 DOM、mesId，传完整文本即可 prepare → generate；图片不写回聊天。
3. 包含多个时空的小剧场只选一个瞬间，原文摘录可在输入中找到；人物提示词保留。
4. A 聊天创建请求后切到 B 聊天，或在 B 聊天为 A 收藏配图，不混入 B 的资料。
5. 调用时指定预设不会改变正常段落配图预设；普通段落生图回归通过。
6. 修改 draft 的正负/人物提示词后，实际请求使用修改值，预设不重复追加。
7. 同一 draft 可多次 generate，刷新后反序列化仍可使用；模型改变明确报错。
8. prepare 的结果是 JSON 普通对象；generate 返回真实 Blob、尺寸、种子、对应 requestId。
9. 取消准备/排队/生图，及同时运行日常生图的情况，不中断无关任务，不迟到提交。
10. 重复 requestId 不启动两次计费；超时、空图、解析失败、进度回调抛错覆盖到测试。
11. 返回对象和错误不包含凭据；公开接口不会修改用户全局预设/聊天/图库。
12. 至少用 mock 覆盖上述边界；运行 Cosmos 现有 typecheck、相关 unit tests、build。实际 NovelAI/ComfyUI 联调结果单独报告，不以 mock 成功代替真实联调。

## 9. 可复用代码与建议交付

- `src/services/prompt-llm/runtime-request.ts`：LLM 请求/路由。公开入口需提供 supplied-only runtimeContent 构建路径。
- `src/services/prompt-llm/message-preset.ts`：预设消息与宏；增加小剧场输入语义。
- `src/services/prompt-profiles/runtime.ts`：注意隐式当前聊天读取。
- `src/services/novelai/api.ts`、`src/services/comfyui/api.ts`：生图服务；注意模板重复合并、共享中断和头像绑定。
- 建议增加 `src/services/public-api/` 承载公开 DTO、校验、任务生命周期和注册，不从其他插件 import Cosmos 私有模块。
- 完成后给出：调用示例、接口版本、已通过检查、需要真实后端验证的项目。不要修改 `titania-theater` 的实现；如需调整约定先明确差异。
