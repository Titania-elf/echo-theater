// 浮层窗口注册表：同一时刻只允许存在一个插件浮层窗口。
//
// 起因：配图面板、配图设置窗、外观档案窗各自维护自己的「上一个窗口」变量，
// 于是只关得掉自己的上一份实例，互相之间毫无察觉——从面板点进设置，面板还开着；
// 再从设置点进档案管理，三个窗口叠在一起。
//
// 用法：窗口在自己的 open 里 claimFloatingWindow(close)，在 close 里
// releaseFloatingWindow(close)。claim 会先关掉当前那个。

let activeClose = null;
let displacing = false;

/**
 * 接管浮层所有权，先关掉当前已打开的那个。
 * @param {() => void} close 新窗口的关闭函数
 * @returns {() => void} 注销函数
 */
export function claimFloatingWindow(close) {
    const previous = activeClose;
    // 先接管再关上一个：上一个的 close 里会调 release，此处若还没换人，
    // 它就会把刚登记好的新窗口误注销掉。
    activeClose = close;
    if (previous && previous !== close) {
        displacing = true;
        try {
            previous();
        } catch {
            // 上一个关不掉不该挡住新窗口打开。
        } finally {
            displacing = false;
        }
    }
    return () => releaseFloatingWindow(close);
}

/**
 * 当前这次 close 是否由别的窗口「顶掉」触发，而不是用户主动关闭。
 *
 * 子窗口关闭后要回到配图面板，但如果关闭是被顶掉造成的，就不能再回面板 ——
 * 否则「顶掉 → 回面板 → 面板又顶掉 → 又回面板」会来回打乒乓。
 * @returns {boolean}
 */
export function isFloatingWindowDisplaced() {
    return displacing;
}

/** 注销自己；只有在仍是当前窗口时才清空，避免误伤后来者。 */
export function releaseFloatingWindow(close) {
    if (activeClose === close) activeClose = null;
}

/** 关闭当前浮层（供键盘 Esc 之类的全局入口使用）。 */
export function closeActiveFloatingWindow() {
    activeClose?.();
}
