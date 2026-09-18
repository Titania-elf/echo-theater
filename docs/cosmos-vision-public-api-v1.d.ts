/** 回声小剧场 / Cosmos Vision 公开接口约定 1.0。与需求文档同时维护。 */
export type ImageSource = 'novelai' | 'comfyui';
export interface CharacterPrompt {
    positivePrompt: string;
    negativePrompt: string;
    position: { x: number; y: number };
}
export interface ImagePrompts {
    /** 已合并画风、质量、画师串等预设的最终提示词，generate 不得再次叠加。 */
    positivePrompt: string;
    negativePrompt: string;
    characterPrompts: CharacterPrompt[];
}
export interface SceneSelection {
    summary: string;
    /** theaterText 中连续、逐字一致的一段原文。 */
    sourceExcerpt: string;
}
export interface PromptDraft {
    version: 1;
    imageSource: ImageSource;
    /** NovelAI 模型 ID；ComfyUI 使用稳定的工作流/模型配置标识。 */
    model: string;
    scene: SceneSelection;
    prompts: ImagePrompts;
}
export interface RequestControl {
    /** 调用方生成；不得因重复 requestId 重复扣费或启动第二个任务。 */
    requestId: string;
    signal?: AbortSignal;
    onProgress?: (event: {
        requestId: string;
        stage: 'queued' | 'analyzing' | 'generating' | 'downloading';
        message?: string;
        /** 不知道精确进度时省略。 */
        fraction?: number;
    }) => void;
}
export interface Capabilities {
    apiVersion: '1.0';
    ready: boolean;
    enabled: boolean;
    reason?: string;
    defaultImageSource: ImageSource;
    features: { theaterPrompt: boolean; providedContext: boolean };
    limits: { maxTextChars: number; maxImages: number };
    imageSources: Array<{
        id: ImageSource;
        label: string;
        ready: boolean;
        reason?: string;
        model: string;
    }>;
}
export interface PreparePromptRequest {
    mode: 'theater';
    imageSource: ImageSource;
    /** 为本次请求选用预设；省略时使用当前激活预设。不得切换全局激活预设。 */
    presetId?: string;
    theaterText: string;
    context: {
        mode: 'provided';
        /** 仅作为关联信息，不能据此读取当前聊天补充资料。 */
        source: { client: 'titania-theater'; sceneId: string };
        /** 调用方提供的人物/场景资料；允许空字符串。 */
        participants: string;
        history: string[];
    };
    specialRequest: string;
    /** 再选一个镜头时作为排除参考，第一次省略。 */
    previousScenes?: SceneSelection[];
}
export interface GenerateRequest {
    draft: PromptDraft;
    /** 第一版调用方固定传 1；供应方必须将额外输出裁到 count，不能偷偷增大批量。 */
    count: number;
}
export interface GeneratedImage {
    blob: Blob;
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
    width: number;
    height: number;
    seed?: number | string;
}
export interface GenerateResult {
    requestId: string;
    /** 实际使用的最终提示词及场景，允许服务端做必要规范化。 */
    draft: PromptDraft;
    images: GeneratedImage[];
}
export interface CosmosVisionPublicApi {
    apiVersion: '1.0';
    getCapabilities(): Capabilities | Promise<Capabilities>;
    preparePrompt(request: PreparePromptRequest, control: RequestControl): Promise<PromptDraft>;
    generate(request: GenerateRequest, control: RequestControl): Promise<GenerateResult>;
}
declare global {
    interface Window { CosmosVision?: CosmosVisionPublicApi }
}
