// GET /api/auth/callback —— 用 code 换 token，建立本地 session
import { err, now } from "../../_lib/util.js";
import { signSession, sessionCookie } from "../../_lib/session.js";

function getCookie(request, name) {
    const raw = request.headers.get("Cookie") || "";
    for (const part of raw.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === name) return v.join("=");
    }
    return null;
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) return err(400, "缺少授权码");
    if (!state || state !== getCookie(request, "oauth_state")) {
        return err(400, "登录状态校验失败，请重新登录");
    }

    // 1. code -> access_token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            client_secret: env.DISCORD_CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: `${url.origin}/api/auth/callback`
        })
    });
    if (!tokenRes.ok) return err(502, "Discord 授权失败");
    const { access_token } = await tokenRes.json();

    // 2. 拿身份，然后就把 Discord token 丢掉，不存
    const meRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!meRes.ok) return err(502, "获取 Discord 用户信息失败");
    const me = await meRes.json();

    const ts = now();
    await env.DB.prepare(`
        INSERT INTO authors (discord_id, username, avatar, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET
            username = excluded.username,
            avatar   = excluded.avatar
    `).bind(me.id, me.global_name || me.username, me.avatar || null, ts).run();

    const token = await signSession({ sub: me.id }, env.SESSION_SECRET);

    const headers = new Headers({ Location: "/#/mine" });
    headers.append("Set-Cookie", sessionCookie(token));
    headers.append("Set-Cookie", "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    return new Response(null, { status: 302, headers });
}
