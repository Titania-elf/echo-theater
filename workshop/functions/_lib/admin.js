// 管理员通道的认证。
//
// 入口在网页端（同源），所以直接复用 Discord 登录的 sid cookie，
// 不再引入长期令牌 —— 不存在的密钥不会泄露。
//
// 同源请求不需要 CORS；cookie 的 SameSite=Lax 已经挡住跨站 POST，
// CSRF 防护跟其余私有接口保持一致。
import { err } from "./util.js";
import { getAuthor } from "./session.js";

/**
 * 校验当前登录用户是不是站长。
 * @returns {Promise<{author: object} | {response: Response}>}
 *          通过返回 { author }，失败返回 { response } 可直接 return
 */
export async function requireAdmin(request, env) {
    const adminId = String(env.ADMIN_DISCORD_ID || "").trim();
    // 没配 secret 时整个通道保持关闭，避免空值意外放行
    if (!adminId) return { response: err(503, "管理员通道未启用") };

    const author = await getAuthor(request, env);
    if (!author) return { response: err(401, "请先登录") };

    if (author.discord_id !== adminId) {
        // 不告诉对方"这是管理员接口"，避免给探测者额外信息
        return { response: err(404, "接口不存在") };
    }

    return { author };
}
