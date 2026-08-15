const KEY = "titania_workshop_show_mature";

export function showMature() {
    try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function setShowMature(on) {
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* storage may be unavailable */ }
}

export function toggleMature() {
    if (showMature()) {
        setShowMature(false);
        return false;
    }
    const ok = window.confirm("即将显示标记为“成人向”的投稿，其中可能包含露骨性内容、性暗示或强烈暴力内容。\n\n请确认你已满足所在地的法定年龄要求。\n\n点击“确定”继续显示成人向内容。" );
    if (ok) setShowMature(true);
    return ok;
}

export function filterByRating(items) {
    return showMature() ? items : items.filter(item => item.rating !== "mature");
}
