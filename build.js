/**
 * Titania Theater - esbuild 打包配置
 * 
 * 使用方法：
 * 1. 安装依赖：npm install
 * 2. 打包：npm run build
 * 3. 开发模式（监听文件变化）：npm run build:watch
 * 
 * 打包后会生成 dist/index.js，替换原有的 index.js 使用
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { cssFileList } from './css/manifest.js';

// 是否监听模式
const isWatch = process.argv.includes('--watch');

// 读取所有 CSS 文件并合并。清单来自 css/manifest.js(与 dom.js 共用,修 B1)
function bundleCSS() {
    const cssDir = './css';
    const cssFiles = cssFileList();

    let combinedCSS = '/* Titania Theater - Bundled CSS */\n\n';
    const missing = [];

    for (const file of cssFiles) {
        const filePath = path.join(cssDir, file);
        if (!existsSync(filePath)) {
            missing.push(filePath);
            continue;
        }
        const content = readFileSync(filePath, 'utf-8');
        combinedCSS += `/* === ${file} === */\n${content}\n\n`;
    }

    // 原先这里是静默 skip。5.2.5 之后的目录重构把 CSS 移进了分层目录,
    // 而清单仍指向扁平路径 —— 静默 skip 让 bundleCSS() 产出了 0 行 CSS 且不报错。
    // 缺文件必须让构建立刻失败,不允许产出残缺样式的 index.js。
    if (missing.length) {
        console.error(`❌ CSS 清单与磁盘不一致,以下 ${missing.length} 个文件不存在:`);
        for (const m of missing) console.error(`   - ${m}`);
        console.error('   请修正 css/manifest.js 或补齐文件后重新构建。');
        process.exit(1);
    }

    return combinedCSS;
}


// esbuild 插件：注入 CSS
const injectCSSPlugin = {
    name: 'inject-css',
    setup(build) {
        // 拦截 dom.js 的导入，替换为内联 CSS 注入
        build.onLoad({ filter: /dom\.js$/ }, async (args) => {
            const css = bundleCSS();
            const escapedCSS = css.replace(/`/g, '\\`').replace(/\$/g, '\\$');

            return {
                contents: `
// 内联 CSS 注入（打包时自动合并）
import { extensionFolderPath } from "../config/defaults.js";

// 与 css/manifest.js 同步生成，供 ensureFeatureCss 解析分层路径
const CSS_FILES = ${JSON.stringify(cssFileList())};

export function loadCssFiles() {
    const styleId = 'titania-theater-bundled-css';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = \`${escapedCSS}\`;
    document.head.appendChild(style);
}

/** 由清单路径生成 <link> 的 id（与 src/utils/dom.js 保持一致） */
export function cssLinkId(file) {
    return \`titania-css-\${file.replace(/\\.css$/, '').replace(/\\//g, '-')}\`;
}

/**
 * 按需确保某个功能 CSS 已加载。打包模式下 CSS 已内联，但此处仍补一个后置 <link>
 * 以保持与开发模式及 5.2.5 的层叠顺序完全一致（详见 src/utils/dom.js 的说明与 B6）。
 */
export function ensureFeatureCss(fileName) {
    const file = CSS_FILES.find(p => p.endsWith(\`/\${fileName}\`));
    if (!file) {
        console.warn(\`[Titania] ensureFeatureCss: \${fileName} 不在 css/manifest.js 清单中\`);
        return;
    }
    const id = cssLinkId(file);
    if (document.getElementById(id)) return;

    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = \`\${extensionFolderPath}/css/\${file}\`;
    document.head.appendChild(link);
}

/**
 * 确保 overlay 容器存在
 * 用于支持设置窗口等可以独立于主窗口打开的场景
 */
export function ensureOverlay() {
    if ($("#t-overlay").length === 0) {
        const overlayHtml = '<div id="t-overlay" class="t-overlay"></div>';
        $("body").append(overlayHtml);
    }
    return $("#t-overlay");
}
`,
                loader: 'js'
            };
        });
    }
};

// 构建配置
const buildOptions = {
    entryPoints: ['./src/entry.js'],  // 使用独立的入口文件
    bundle: true,
    format: 'esm',
    outfile: './index.js',  // 直接输出到根目录，替换原有的 index.js

    // 外部依赖（SillyTavern 核心模块，保持原样不打包）
    external: [
        '../../../extensions.js',
        '../../../../script.js',
        '../../../world-info.js',
        '../../../power-user.js',
        '../../../custom-request.js',
        '../../../openai.js',
        '../../../macros.js',
        '../../../sse-stream.js',
        '../../../tokenizers.js',
        '../../../system-messages.js',
        '../../../RossAscends-mods.js'
    ],

    // 保留原始模块路径（相对于 dist 目录）
    alias: {
        // 这些是外部依赖，不需要别名
    },

    // 插件
    plugins: [injectCSSPlugin],

    // 不压缩，便于调试
    minify: false,

    // 生成 source map（开发时可用）
    sourcemap: isWatch ? 'inline' : false,

    // 目标环境
    target: ['es2020'],

    // banner 注释
    banner: {
        js: `/**
 * Titania Theater (回声小剧场)
 * Bundled with esbuild
 * 
 * 这是打包后的单文件版本。
 * 源代码请查看：https://github.com/Titania-elf/titania-theater
 */
`
    },

    // 日志级别
    logLevel: 'info'
};

async function build() {
    if (isWatch) {
        // 监听模式
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('👀 Watching for changes...');
    } else {
        // 单次构建
        const startTime = Date.now();

        try {
            await esbuild.build(buildOptions);

            const endTime = Date.now();
            console.log(`✅ Build completed in ${endTime - startTime}ms`);
            console.log('📦 Output: index.js (bundled)');
            console.log('');
            console.log('打包完成！index.js 已更新为单文件版本。');
            console.log('源代码保留在 src/ 目录中。');
        } catch (error) {
            console.error('❌ Build failed:', error);
            process.exit(1);
        }
    }
}

build();
