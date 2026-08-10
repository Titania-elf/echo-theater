// GET /api/auth/login —— 跳去 Discord 授权
import { err } from "../../_lib/util.js";

export async function onRequestGet({ request, env }) {
    if (!env.DISCORD_CLIENT_ID) return err(500, "服务端未配置 Discord 应用");

    const origin = new URL(request.url).origin;

    // state 防 CSRF：随机值同时写进 cookie 和 URL，回调时比对
    const state = crypto.randomUUID();

    const auth = new URL("https://discord.com/oauth2/authorize");
    auth.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
    auth.searchParams.set("redirect_uri", `${origin}/api/auth/callback`);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "identify");   // 只要这一个，不碰 email / guilds
    auth.searchParams.set("state", state);

    return new Response(null, {
        status: 302,
        headers: {
            Location: auth.toString(),
            "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
        }
    });
}
