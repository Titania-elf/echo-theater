// GET /api/auth/callback —— 用 code 换 token，建立本地 session
import { err, now } from "../../_lib/util.js";
import { normalizeReturnHash, signSession, sessionCookie } from "../../_lib/session.js";

function getCookie(request, name) {
    const raw = request.headers.get("Cookie") || "";
    for (const part of raw.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === name) return v.join("=");
    }
    return null;
}

function getReturnTo(request) {
    try {
        return normalizeReturnHash(decodeURIComponent(getCookie(request, "oauth_return") || ""));
    } catch {
        return "#/";
    }
}

function finishLogin(location, token = null) {
    const headers = new Headers({ Location: location });
    if (token) headers.append("Set-Cookie", sessionCookie(token));
    headers.append("Set-Cookie", "oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    headers.append("Set-Cookie", "oauth_return=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    return new Response(null, { status: 302, headers });
}

function loginFailure(returnTo, code = "failed") {
    return finishLogin(`/?auth_error=${encodeURIComponent(code)}${returnTo}`);
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const returnTo = getReturnTo(request);

    if (!state || state !== getCookie(request, "oauth_state")) {
        return err(400, "登录状态校验失败，请重新登录");
    }
    if (!code) {
        return loginFailure(returnTo, url.searchParams.get("error") === "access_denied" ? "cancelled" : "failed");
    }

    // 1. code -> access_token
    let tokenRes;
    try {
        tokenRes = await fetch("https://discord.com/api/oauth2/token", {
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
    } catch {
        return loginFailure(returnTo);
    }
    if (!tokenRes.ok) return loginFailure(returnTo);

    let accessToken;
    try {
        ({ access_token: accessToken } = await tokenRes.json());
    } catch {
        return loginFailure(returnTo);
    }
    if (!accessToken) return loginFailure(returnTo);

    // 2. 拿身份，然后就把 Discord token 丢掉，不存
    let meRes;
    try {
        meRes = await fetch("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
    } catch {
        return loginFailure(returnTo);
    }
    if (!meRes.ok) return loginFailure(returnTo);

    let me;
    try {
        me = await meRes.json();
    } catch {
        return loginFailure(returnTo);
    }
    if (!me?.id || !me?.username) return loginFailure(returnTo);

    const ts = now();
    await env.DB.prepare(`
        INSERT INTO authors (discord_id, username, avatar, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET
            username = excluded.username,
            avatar   = excluded.avatar
    `).bind(me.id, me.global_name || me.username, me.avatar || null, ts).run();

    const token = await signSession({ sub: me.id }, env.SESSION_SECRET);

    return finishLogin(`/${returnTo}`, token);
}
