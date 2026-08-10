// POST /api/auth/logout
import { clearCookie } from "../../_lib/session.js";

export async function onRequestPost() {
    return new Response(JSON.stringify({ ok: true }), {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": clearCookie()
        }
    });
}
