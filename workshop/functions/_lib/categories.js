/**
 * 工坊投稿的固定分类。
 *
 * 分类按「最终生成的内容形式」划分；题材、风格和关系等细节交给标签。
 * 前端选项和服务端白名单都从这里读取，避免两边逐渐不一致。
 */
export const SCRIPT_CATEGORIES = Object.freeze([
    {
        value: "番外剧情",
        description: "补充场景、角色支线、后日谈等剧情内容"
    },
    {
        value: "互动玩法",
        description: "带选项、按钮、小游戏或其他互动机制"
    },
    {
        value: "贴吧/论坛体",
        description: "贴吧、论坛、社区帖子及楼层回复"
    },
    {
        value: "调查问卷",
        description: "调查表、采访、心理测试或问答内容"
    },
    {
        value: "捡手机对话",
        description: "私聊、群聊、短信或社交软件对话"
    },
    {
        value: "其他",
        description: "暂时无法归入以上形式的内容"
    }
]);

const SCRIPT_CATEGORY_VALUES = new Set(SCRIPT_CATEGORIES.map(item => item.value));

export const isScriptCategory = value => SCRIPT_CATEGORY_VALUES.has(value);
