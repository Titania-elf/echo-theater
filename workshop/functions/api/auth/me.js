// GET /api/auth/me —— 当前登录状态
import { json } from "../../_lib/util.js";
import { getAuthor } from "../../_lib/session.js";

export async function onRequestGet({ request, env }) {
    const author = await getAuthor(request, env);
    if (!author) return json({ logged_in: false });

    return json({
        logged_in: true,
        banned: !!author.banned,
        // 前端据此决定要不要显示批量导入入口。
        // 只是 UI 开关，真正的权限校验在每个 admin 接口里各做一次
        is_admin: !!env.ADMIN_DISCORD_ID && author.discord_id === String(env.ADMIN_DISCORD_ID).trim(),
        user: {
            id: author.discord_id,
            name: author.username,
            avatar: author.avatar
                ? `https://cdn.discordapp.com/avatars/${author.discord_id}/${author.avatar}.png?size=64`
                : null
        }
    });
}
