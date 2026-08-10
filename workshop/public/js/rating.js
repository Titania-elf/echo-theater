// 分级偏好：未登录默认只看 general
const KEY = "workshop_show_mature";

export const showMature = () => localStorage.getItem(KEY) === "1";

export function setShowMature(on) {
    localStorage.setItem(KEY, on ? "1" : "0");
}

/** 切换到 mature 需要一次明确确认 */
export function toggleMature() {
    if (showMature()) {
        setShowMature(false);
        return false;
    }
    const ok = confirm("将显示分级为「成人向」的内容。\n请确认你已满足所在地区的法定年龄要求。");
    if (ok) setShowMature(true);
    return ok;
}

export const filterByRating = items =>
    showMature() ? items : items.filter(s => s.rating !== "mature");
