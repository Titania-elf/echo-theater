// 自签 session：Discord 只用来确认身份，之后一律用我们自己的 cookie
// 格式是紧凑型 JWT（HS256），不引第三方库

const enc = new TextEncoder();
const SESSION_DAYS = 30;

function b64url(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
    const pad = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function hmacKey(secret) {
    return crypto.subtle.importKey(
        "raw", enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false, ["sign", "verify"]
    );
}

export async function signSession(payload, secret) {
    const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    const body = b64url(enc.encode(JSON.stringify({ ...payload, exp })));
    const data = `${header}.${body}`;
    const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
    return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(token, secret) {
    if (!token || token.split(".").length !== 3) return null;
    const [header, body, sig] = token.split(".");
    const ok = await crypto.subtle.verify(
        "HMAC", await hmacKey(secret),
        b64urlDecode(sig), enc.encode(`${header}.${body}`)
    );
    if (!ok) return null;
    try {
        const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
        if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
    } catch {
        return null;
    }
}

export function sessionCookie(token) {
    // 前后端同域，Lax 就够；HttpOnly 让前端 JS 拿不到，降低 XSS 影响面
    return `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = () =>
    "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

/** OAuth 登录后只允许回到站内 hash 路由，避免把登录接口变成开放重定向。 */
export function normalizeReturnHash(value) {
    const target = String(value || "").trim();
    if (!target.startsWith("#/") || target.length > 512 || /[\r\n]/.test(target)) return "#/";
    return target;
}

function readCookie(request, name) {
    const raw = request.headers.get("Cookie") || "";
    for (const part of raw.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === name) return v.join("=");
    }
    return null;
}

/**
 * 取当前登录作者。返回 null 表示未登录，返回 {banned:true} 表示已被封禁。
 * 每次都查库是有意的：封人后立刻生效，不用等 session 过期。
 */
export async function getAuthor(request, env) {
    const payload = await verifySession(readCookie(request, "sid"), env.SESSION_SECRET);
    if (!payload?.sub) return null;

    const row = await env.DB
        .prepare("SELECT discord_id, username, avatar, banned FROM authors WHERE discord_id = ?")
        .bind(payload.sub)
        .first();

    return row || null;
}
