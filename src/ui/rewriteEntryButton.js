// src/ui/rewriteEntryButton.js

import { getExtData, saveExtData } from "../utils/storage.js";
import { saveChatConditional, reloadCurrentChat, eventSource, event_types } from "../../../../script.js";
import { parseTagWhitelistInput, extractTextByWhitelist } from "../utils/chatTagWhitelist.js";
import { normalizeApiBaseUrl, normalizeRewriteCustomProfiles } from "../core/apiProfileRegistry.js";
import {
    createApiConnectionEditor,
    mapConnectionProfilesToCustomProfiles,
    mapCustomProfilesToConnectionProfiles,
    renderApiConnectionEditorHTML,
} from "./shared/apiConnectionEditor.js";

const BTN_ID = "titania-rewrite-entry-btn";
const ANCHOR_SELECTOR = "#qr--bar";
const OVERLAY_ID = "t-rewrite-overlay";
const SETTINGS_OVERLAY_ID = "t-rewrite-settings-overlay";
const LIVE_OVERLAY_ID = "t-rewrite-live-overlay";

let observerBound = false;
let docEventBound = false;
let autoTriggerBound = false;
let rewriteDecorBound = false;
let rewriteDecorTimer = null;
let autoRewriteTimer = null;
let activeRewriteAbortController = null;
let isAutoRewriting = false;
let runtimeCollapsed = false;
let lastRawResponseText = "";
let lastRawMetaText = "等待请求";
let liveResponseHistory = [];
let liveResponseHistorySeq = 0;
let lastMatchResult = null;
let lastMatchSourceText = "";
let lastDiffRows = [];
let latestSentenceUnits = [];
let selectedSentenceIds = new Set();
let inlineSelectionMessageIndex = null;
const LIVE_RESPONSE_HISTORY_MAX = 20;
const AUTO_REWRITE_DELAY_MS = 3000;
const REWRITE_TEMPERATURE = 0.8;
const REWRITE_FIX_TEMPERATURE = 0.0;
const REWRITE_MAX_TOKENS = 40000;
const REWRITE_DEFAULT_PROMPT_SYSTEM = `你是「回声文学编辑」——一位资深的中文叙事文本编辑，专精于角色扮演和小说场景的文本润色与改写。

你的工作不是机械替换词汇，而是理解作者的表达意图后，在忠实原意的前提下，用更好的句子结构重新表达。

改写哲学：
- 忠实于原文：事件、关系、情绪强度、事实信息不增不减。
- 改变结构：调整语序、主谓宾组织、从句关系，而非仅替换同义词。
- 保持声音：保留原文的语气、人称、叙事视角和情感强度。
- 融入语境：改写后的句子应能自然嵌入原文上下文，不显突兀。
- 节奏自然：中文散文的节奏感，长短句交错，避免生硬堆砌。

工作方法：
1) 先读：理解这个句子在说什么、表达了什么情绪。
2) 再诊断：这句话的"问题"是什么（重复词？句式僵硬？冗长？）。
3) 再重构：用不同的句法结构重新表达同一件事。
4) 最后检查：新句子读起来是否自然？是否保持了原意？

硬约束（必须同时满足）：
1) 禁用词：每个 target 的 matched_keywords 中的词，不得出现在 rewritten_text。
2) 句级重写：不得仅做同义词替换；必须改变句子结构（语序、主谓宾组织、短语组合、从句或并列关系至少一项变化）。
3) 长度控制：rewritten_text 建议在原句长度的 70%~150%。

如果某句在严格禁词下难以改写，也必须给出语义等价的重构句，不可返回原句。`;
const REWRITE_DEFAULT_PROMPT_USER = "返回 JSON schema：\n{{schema}}\n唯一合法示例：\n{\"task_id\":\"rewrite_x\",\"results\":[{\"segment_id\":\"s_1\",\"rewritten_text\":\"示例文本\"}]}\n\n输入 payload：\n{{payload}}\n\n执行规则（逐条）：\n1) 对每个 target 的 original_text 进行整句重写。\n2) rewritten_text 必须与 original_text 语义等价，但表达结构明显不同。\n3) results 数量必须与 targets 一致，segment_id 一一对应且不重复。\n4) 若 rewritten_text 与 original_text 仅词汇替换、句法基本一致，视为不合格，必须重写后再输出。\n5) 只输出 JSON。";
const REWRITE_DEFAULT_SELECTED_PROMPT_SYSTEM = `你是「回声文学编辑」的手动选句改写模式，专门将句子改写为白描风格。

白描手法核心准则：
- 用具体动作、物象、细节说话，不直述角色的内心感受。
- 克制形容词和副词，避免修饰泛滥；用名词和动词支撑句子。
- 删除「他感到很愤怒」「她内心充满了悲伤」这类心理概括句，改为外部可观察的行为或环境映衬。
- 句式简洁、硬朗，不虚饰，不煽情。
- 读者应能从描写中自行体会情绪，而非被告知。

改写操作：
- 忠实原意：不改变事实、人物关系、事件顺序和情绪强度。
- 白描转化：将心理直述、抽象概括、华丽修辞改写为克制、具象、可观察的表述。
- 贴合上下文：改写后的句子能原位放回原楼层，不显拼接痕迹。
- 保留叙事视角和人称。

硬约束：
1) 只处理 targets 中出现的句子，不新增 target。
2) rewritten_text 不得为空；即使原句已是白描，也给出一个不同的等价写法。
3) 只输出 JSON。`;
const REWRITE_DEFAULT_SELECTED_PROMPT_USER = "返回 JSON schema：\n{{schema}}\n唯一合法示例：\n{\"task_id\":\"rewrite_selected_x\",\"results\":[{\"segment_id\":\"s_1\",\"rewritten_text\":\"示例文本\"}]}\n\n输入 payload：\n{{payload}}\n\n执行规则：\n1) 用户已手动选择 targets，请逐条改写 original_text。\n2) 改写方向始终是白描：删除心理直述，转为可观察的动作和细节；克制修饰，用名词和动词支撑句子。\n3) 每条 rewritten_text 必须能替换回原位置，并与上下文自然衔接。\n4) 不要输出未选择的句子，不要改变 segment_id。\n5) results 数量必须与 targets 一致。\n6) 只输出 JSON。";
const REWRITE_DEFAULT_PROMPT_JSON_RULE = "JSON格式指令（谨慎修改）：\n- 只输出 JSON，不输出解释或 markdown\n- 顶层必须包含 task_id 和 results\n- results 每项必须包含 segment_id 和 rewritten_text\n- rewritten_text 必须为整句重写，禁止只做词汇替换\n- rewritten_text 中不能出现该 target 的 matched_keywords 中的词";
const REWRITE_PANEL_CSS = `
#titania-rewrite-entry-btn { margin-left: 6px; }
#titania-rewrite-entry-btn i { color: #90cdf4; }
#titania-rewrite-entry-btn:hover i { color: #b9def8; }
#t-rewrite-overlay { z-index: 30060; }
#t-rewrite-overlay .t-rewrite-window { width: min(1180px, 96vw); max-width: 96vw; max-height: 90vh; height: min(88vh, 920px); display: flex; flex-direction: column; overflow: hidden; background: rgba(19, 22, 30, 0.94); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 22px 58px rgba(0, 0, 0, 0.56); border-radius: 14px; }
#t-rewrite-overlay .t-rewrite-head { padding: 14px 18px; background: linear-gradient(180deg, rgba(18, 30, 44, 0.9) 0%, rgba(16, 22, 31, 0.85) 100%); border-bottom: 1px solid rgba(255, 255, 255, 0.09); }
#t-rewrite-overlay .t-rewrite-settings-btn i { color: #b9d8ee; }
#t-rewrite-overlay .t-rewrite-settings-btn:hover i { color: #d2e6f7; }
#t-rewrite-overlay .t-rewrite-head-text-btn { height: 32px; min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.14); color: #dbe8f4; font-size: 0.78em; font-weight: 600; letter-spacing: 0.15px; background: linear-gradient(140deg, rgba(255, 255, 255, 0.11), rgba(255, 255, 255, 0.04)); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: 0 6px 14px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.18); transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease; }
#t-rewrite-overlay .t-rewrite-head-text-btn:hover { transform: translateY(-1px); border-color: rgba(144, 205, 244, 0.5); background: linear-gradient(140deg, rgba(144, 205, 244, 0.22), rgba(255, 255, 255, 0.06)); box-shadow: 0 10px 20px rgba(17, 34, 54, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.22); }
#t-rewrite-overlay .t-rewrite-head-text-btn:active { transform: translateY(0); box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.14); }
#t-rewrite-overlay .t-rewrite-title { font-size: 1.08em; font-weight: 700; letter-spacing: 0.2px; display: flex; align-items: center; gap: 8px; }
#t-rewrite-overlay .t-rewrite-title i { color: #90cdf4; }
#t-rewrite-overlay .t-window-close { width: 32px; height: 32px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); transition: all 0.18s ease; }
#t-rewrite-overlay .t-window-close:hover { background: rgba(255, 255, 255, 0.1); border-color: rgba(144, 205, 244, 0.45); }
#t-rewrite-overlay .t-rewrite-body { flex: 1; overflow: hidden; display: grid; grid-template-columns: minmax(340px, 0.92fr) minmax(440px, 1.08fr); gap: 16px; padding: 16px; background: radial-gradient(circle at 100% 0%, rgba(144, 205, 244, 0.1) 0%, rgba(144, 205, 244, 0) 36%), radial-gradient(circle at 0% 100%, rgba(191, 161, 95, 0.08) 0%, rgba(191, 161, 95, 0) 32%), #12161d; }
#t-rewrite-overlay .t-rewrite-left, #t-rewrite-overlay .t-rewrite-right { min-height: 0; display: flex; flex-direction: column; gap: 12px; }
#t-rewrite-overlay .t-rewrite-section { border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; background: rgba(13, 19, 28, 0.78); padding: 12px; }
#t-rewrite-overlay .t-rewrite-section-title { font-size: 0.9em; font-weight: 700; color: #b8d8ee; margin-bottom: 10px; }
#t-rewrite-overlay .t-rewrite-label { display: block; font-size: 0.8em; color: #8da3b6; margin-bottom: 6px; }
#t-rewrite-overlay #t-rewrite-api-url, #t-rewrite-overlay #t-rewrite-api-key, #t-rewrite-overlay #t-rewrite-model { width: 100%; box-sizing: border-box; background: rgba(10, 15, 22, 0.9); border: 1px solid rgba(255, 255, 255, 0.12); color: #dde9f4; border-radius: 8px; padding: 9px 11px; outline: none; transition: border-color 0.18s ease, box-shadow 0.18s ease; }
#t-rewrite-overlay #t-rewrite-api-url:focus, #t-rewrite-overlay #t-rewrite-api-key:focus, #t-rewrite-overlay #t-rewrite-model:focus { border-color: rgba(144, 205, 244, 0.55); box-shadow: 0 0 0 2px rgba(144, 205, 244, 0.16); }
#t-rewrite-overlay .t-rewrite-model-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
#t-rewrite-overlay .t-rewrite-model-col { min-width: 0; }
#t-rewrite-overlay #t-rewrite-trigger { height: 36px; min-height: 36px; line-height: 1; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.14); color: #dbe8f4; font-weight: 600; transition: all 0.18s ease; white-space: nowrap; letter-spacing: 0.1px; min-width: 164px; padding: 0 16px; background: linear-gradient(135deg, rgba(144, 205, 244, 0.18), rgba(191, 161, 95, 0.16)); border-color: rgba(144, 205, 244, 0.42); justify-content: center; display: inline-flex; align-items: center; gap: 6px; }
#t-rewrite-overlay #t-rewrite-trigger:hover { background: rgba(255, 255, 255, 0.09); border-color: rgba(144, 205, 244, 0.44); }
#t-rewrite-overlay .t-rewrite-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
#t-rewrite-overlay .t-rewrite-action-hint { font-size: 0.8em; color: #90a9bc; line-height: 1.45; }
#t-rewrite-overlay .t-rewrite-footer-actions { padding: 10px 16px 14px; border-top: 1px solid rgba(255, 255, 255, 0.1); background: rgba(16, 22, 31, 0.9); }
#t-rewrite-overlay .t-rewrite-runtime-meta { display: grid; gap: 6px; font-size: 0.82em; color: #a9bfd1; }
#t-rewrite-overlay .t-rewrite-runtime-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
#t-rewrite-overlay #t-rewrite-runtime-toggle { height: 28px; min-height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.05); color: #d4e4f2; font-size: 0.76em; font-weight: 600; letter-spacing: 0.12px; }
#t-rewrite-overlay #t-rewrite-runtime-toggle:hover { border-color: rgba(144, 205, 244, 0.45); background: rgba(144, 205, 244, 0.12); }
#t-rewrite-overlay #t-rewrite-runtime-body.is-collapsed { display: none; }
#t-rewrite-overlay .t-rewrite-rule-head, #t-rewrite-settings-overlay .t-rewrite-rule-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
#t-rewrite-overlay .t-rewrite-rule-guide { font-size: 0.78em; color: #8ea5b7; margin-bottom: 8px; }
#t-rewrite-overlay .t-rewrite-split-options { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; font-size: 0.82em; color: #c5d7e5; }
#t-rewrite-overlay .t-rewrite-split-options label { display: inline-flex; align-items: center; gap: 6px; }
#t-rewrite-overlay .t-rewrite-rule-row { display: grid; grid-template-columns: auto minmax(120px, 0.45fr) auto minmax(180px, 1fr) minmax(110px, 0.35fr) auto; gap: 8px; align-items: center; }
#t-rewrite-settings-overlay .t-rewrite-rule-row { display: grid; grid-template-columns: auto minmax(130px, 0.44fr) minmax(220px, 1fr) minmax(110px, 0.32fr) auto; gap: 8px; align-items: center; }
#t-rewrite-overlay .t-rewrite-rule-and, #t-rewrite-settings-overlay .t-rewrite-rule-and { font-size: 0.8em; color: #9cb2c4; font-weight: 700; letter-spacing: 0.2px; text-align: center; min-width: 18px; }
#t-rewrite-overlay .t-rewrite-rule-no, #t-rewrite-settings-overlay .t-rewrite-rule-no { min-width: 30px; font-size: 0.78em; color: #89a3b8; }
#t-rewrite-overlay .t-rewrite-rule-del, #t-rewrite-settings-overlay .t-rewrite-rule-del { width: 34px; min-width: 34px; padding: 0; justify-content: center; }
#t-rewrite-overlay .t-rewrite-status { font-size: 0.8em; margin-top: 4px; }
#t-rewrite-overlay .t-rewrite-status.muted { color: #7f95a8; }
#t-rewrite-overlay .t-rewrite-status.ok { color: #79d9a8; }
#t-rewrite-overlay .t-rewrite-status.warn { color: #f2c27d; }
#t-rewrite-overlay .t-rewrite-status.err { color: #f08f8f; }
#t-rewrite-overlay .t-rewrite-diff-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
#t-rewrite-overlay .t-rewrite-diff-tools { display: flex; gap: 6px; flex-wrap: nowrap; }
#t-rewrite-overlay .t-rewrite-diff-body { flex: 1; min-height: 0; overflow: auto; display: grid; gap: 8px; padding-right: 2px; }
#t-rewrite-overlay .t-rewrite-match-row { border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; background: rgba(8, 13, 20, 0.8); padding: 10px; }
#t-rewrite-overlay .t-rewrite-match-row.hit { border-color: rgba(122, 203, 159, 0.4); background: linear-gradient(180deg, rgba(24, 68, 51, 0.28) 0%, rgba(14, 22, 18, 0.74) 100%); }
#t-rewrite-overlay .t-rewrite-match-row.miss { border-color: rgba(176, 188, 201, 0.28); }
#t-rewrite-overlay .t-rewrite-match-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 0.78em; color: #c5d8e8; flex-wrap: wrap; }
#t-rewrite-overlay .t-rewrite-match-tags { display: flex; flex-wrap: wrap; gap: 6px; }
#t-rewrite-overlay .t-rewrite-hit-tag { border: 1px solid rgba(122, 203, 159, 0.45); background: rgba(122, 203, 159, 0.12); color: #c2eed9; border-radius: 999px; padding: 2px 8px; font-size: 0.95em; }
#t-rewrite-overlay .t-rewrite-hit-tag.miss { border-color: rgba(189, 199, 210, 0.35); background: rgba(177, 189, 201, 0.12); color: #c8d3dd; }
#t-rewrite-overlay .t-rewrite-match-text, #t-rewrite-overlay .t-rewrite-diff-text { font-size: 0.88em; line-height: 1.5; color: #e2edf7; white-space: pre-wrap; word-break: break-word; }
#t-rewrite-overlay .t-rewrite-hit-summary { font-size: 0.82em; color: #b9d8ee; margin-bottom: 6px; }
#t-rewrite-overlay .t-rewrite-hit-source { font-size: 0.78em; color: #8da5b8; margin-bottom: 8px; }
#t-rewrite-overlay .t-rewrite-json-box { margin: 0; padding: 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(7, 11, 18, 0.9); color: #b8d8ee; max-height: 180px; overflow: auto; font-size: 0.76em; line-height: 1.45; }
#t-rewrite-overlay #t-rewrite-raw-response { max-height: 240px; min-height: 120px; white-space: pre-wrap; word-break: break-word; }
#t-rewrite-settings-overlay { z-index: 30070; }
#t-rewrite-live-overlay { z-index: 30075; }
#t-rewrite-settings-overlay .t-rewrite-settings-window { width: min(1100px, 96vw); max-width: 96vw; max-height: 92vh; height: min(90vh, 940px); display: flex; flex-direction: column; overflow: hidden; background: rgba(19, 22, 30, 0.96); border: 1px solid rgba(255, 255, 255, 0.14); box-shadow: 0 22px 58px rgba(0, 0, 0, 0.56); border-radius: 14px; }
#t-rewrite-settings-overlay .t-set-body { flex: 1; display: flex; min-height: 0; overflow: hidden; }
#t-rewrite-settings-overlay .t-set-nav { width: 180px; background: rgba(18, 24, 33, 0.9); border-right: 1px solid rgba(255, 255, 255, 0.1); padding: 10px 0; display: flex; flex-direction: column; overflow-y: auto; }
#t-rewrite-settings-overlay .t-set-tab-btn { padding: 11px 14px; color: #99adbe; cursor: pointer; transition: all 0.16s ease; font-size: 0.86em; display: flex; align-items: center; gap: 8px; border-left: 3px solid transparent; }
#t-rewrite-settings-overlay .t-set-tab-btn:hover { background: rgba(255, 255, 255, 0.05); color: #d7e7f5; }
#t-rewrite-settings-overlay .t-set-tab-btn.active { color: #b9d8ee; background: rgba(144, 205, 244, 0.16); border-left-color: rgba(144, 205, 244, 0.86); font-weight: 700; }
#t-rewrite-settings-overlay .t-set-content { flex: 1; min-width: 0; padding: 14px; overflow-y: auto; background: radial-gradient(circle at 100% 0%, rgba(144, 205, 244, 0.1) 0%, rgba(144, 205, 244, 0) 36%), radial-gradient(circle at 0% 100%, rgba(191, 161, 95, 0.08) 0%, rgba(191, 161, 95, 0) 32%), #12161d; }
#t-rewrite-settings-overlay .t-set-page { display: none; }
#t-rewrite-settings-overlay .t-set-page.active { display: block; }
#t-rewrite-settings-overlay .t-form-group { margin-bottom: 14px; padding: 12px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.12); background: linear-gradient(170deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015) 55%), rgba(10, 15, 22, 0.86); }
#t-rewrite-settings-overlay .t-form-label { display: block; color: #a9bfd1; margin-bottom: 6px; font-size: 0.82em; }
#t-rewrite-settings-overlay .t-rewrite-settings-footer { padding: 10px 14px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; justify-content: flex-end; gap: 8px; background: rgba(16, 22, 31, 0.9); }
#t-rewrite-live-overlay .t-rewrite-live-window { width: min(980px, 96vw); max-width: 96vw; max-height: 92vh; height: min(86vh, 900px); display: flex; flex-direction: column; overflow: hidden; background: rgba(19, 22, 30, 0.96); border: 1px solid rgba(255, 255, 255, 0.14); box-shadow: 0 22px 58px rgba(0, 0, 0, 0.56); border-radius: 14px; }
#t-rewrite-live-overlay .t-rewrite-live-body { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 14px; background: radial-gradient(circle at 100% 0%, rgba(144, 205, 244, 0.1) 0%, rgba(144, 205, 244, 0) 36%), radial-gradient(circle at 0% 100%, rgba(191, 161, 95, 0.08) 0%, rgba(191, 161, 95, 0) 32%), #12161d; }
#t-rewrite-live-overlay .t-rewrite-live-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
#t-rewrite-live-overlay .t-rewrite-live-meta { font-size: 0.8em; color: #8ea8bc; }
#t-rewrite-live-overlay .t-rewrite-live-stream-card { border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; padding: 10px; background: linear-gradient(170deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015) 55%), rgba(10, 15, 22, 0.84); box-shadow: 0 8px 22px rgba(0, 0, 0, 0.2); }
#t-rewrite-live-overlay .t-rewrite-live-stream-title { font-size: 0.84em; font-weight: 700; color: #c5ddee; margin-bottom: 6px; }
#t-rewrite-live-overlay .t-rewrite-live-history-card { border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 12px; padding: 10px; background: linear-gradient(170deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015) 55%), rgba(10, 15, 22, 0.84); box-shadow: 0 8px 22px rgba(0, 0, 0, 0.2); }
#t-rewrite-live-overlay .t-rewrite-live-history-title { font-size: 0.84em; font-weight: 700; color: #c5ddee; margin-bottom: 6px; }
#t-rewrite-live-overlay .t-rewrite-live-history-meta { font-size: 0.76em; color: #8ea8bc; margin-bottom: 8px; }
#t-rewrite-live-overlay .t-rewrite-live-history-list { max-height: min(28vh, 260px); overflow: auto; display: grid; gap: 8px; padding-right: 2px; }
#t-rewrite-live-overlay .t-rewrite-live-history-item { border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 9px; background: rgba(8, 13, 20, 0.82); padding: 8px; cursor: pointer; transition: border-color 0.16s ease, background 0.16s ease; }
#t-rewrite-live-overlay .t-rewrite-live-history-item:hover { border-color: rgba(144, 205, 244, 0.45); background: rgba(18, 29, 43, 0.72); }
#t-rewrite-live-overlay .t-rewrite-live-history-item.active { border-color: rgba(122, 203, 159, 0.48); background: linear-gradient(180deg, rgba(24, 68, 51, 0.3) 0%, rgba(14, 22, 18, 0.72) 100%); }
#t-rewrite-live-overlay .t-rewrite-live-history-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.75em; color: #9cb4c6; margin-bottom: 4px; }
#t-rewrite-live-overlay .t-rewrite-live-history-preview { font-size: 0.78em; line-height: 1.45; color: #d8e7f4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#t-rewrite-live-overlay .t-rewrite-live-history-empty { border: 1px dashed rgba(255, 255, 255, 0.18); border-radius: 9px; padding: 10px; text-align: center; color: #7f95a8; font-size: 0.78em; background: rgba(255, 255, 255, 0.02); }
#t-rewrite-live-overlay .t-rewrite-live-prompt-card { border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 12px; padding: 10px; background: linear-gradient(170deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015) 55%), rgba(10, 15, 22, 0.84); }
#t-rewrite-live-overlay .t-rewrite-live-prompt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
#t-rewrite-live-overlay .t-rewrite-live-prompt-title { font-size: 0.86em; font-weight: 700; color: #c5ddee; }
#t-rewrite-live-overlay .t-rewrite-live-prompt-tip { font-size: 0.74em; color: #90a7ba; margin: 4px 0 8px; }
#t-rewrite-live-overlay .t-rewrite-live-prompt-tip.warn { color: #f2c27d; }
#t-rewrite-live-overlay .t-rewrite-live-textarea { width: 100%; min-height: 78px; resize: vertical; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(7, 11, 18, 0.9); color: #dce9f4; padding: 8px 10px; font-size: 0.8em; line-height: 1.45; box-sizing: border-box; }
#t-rewrite-live-overlay #t-rewrite-live-prompt-json { min-height: 92px; }
#t-rewrite-live-overlay .t-rewrite-live-textarea:focus { outline: none; border-color: rgba(144, 205, 244, 0.55); box-shadow: 0 0 0 2px rgba(144, 205, 244, 0.16); }
#t-rewrite-live-overlay #t-rewrite-raw-response { max-height: min(34vh, 320px); min-height: 170px; }
#chat .mes .t-rewrite-auto-badge { position: absolute; right: 10px; top: 8px; z-index: 2; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: #dff0ff; background: rgba(15, 24, 35, 0.88); border: 1px solid rgba(144, 205, 244, 0.45); border-radius: 999px; padding: 3px 8px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28); background-image: linear-gradient(120deg, rgba(144, 205, 244, 0.15) 0%, rgba(191, 161, 95, 0.22) 35%, rgba(122, 203, 159, 0.2) 70%, rgba(144, 205, 244, 0.15) 100%); background-size: 220% 220%; animation: t-rewrite-badge-flow 1.4s linear infinite; }
#chat .mes .t-rewrite-auto-badge i { color: #90cdf4; animation: t-rewrite-badge-icon 0.95s ease-in-out infinite; }
#chat .mes .t-rewrite-inline-toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0 8px; font-size: 12px; }
#chat .mes .t-rewrite-inline-toolbar button { border: 1px solid rgba(144, 205, 244, 0.38); border-radius: 999px; background: rgba(15, 24, 35, 0.82); color: #dff0ff; padding: 3px 9px; line-height: 1.35; cursor: pointer; }
#chat .mes .t-rewrite-inline-toolbar button:hover { border-color: rgba(144, 205, 244, 0.65); background: rgba(34, 54, 76, 0.86); }
#chat .mes .t-rewrite-inline-toolbar button.t-rewrite-inline-confirm { border-color: rgba(122, 203, 159, 0.52); color: #d8f5e4; }
#chat .mes .t-rewrite-inline-toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
#chat .mes .t-rewrite-inline-count { color: #a9bfd1; padding: 2px 4px; }
#chat .mes .t-rewrite-select-sentence { border-radius: 5px; padding: 0 2px; cursor: pointer; transition: background-color 0.16s ease, box-shadow 0.16s ease; }
#chat .mes .t-rewrite-select-sentence:hover { background: rgba(144, 205, 244, 0.14); box-shadow: inset 0 0 0 1px rgba(144, 205, 244, 0.32); }
#chat .mes .t-rewrite-select-sentence.selected { background: rgba(122, 203, 159, 0.22); box-shadow: inset 0 0 0 1px rgba(122, 203, 159, 0.52); }
#chat .mes .t-rewrite-mark {
    position: relative;
    display: inline;
    border-radius: 5px;
    padding: 0 2px;
    margin: 0;
    border: 1px solid rgba(122, 203, 159, 0.3);
    background: linear-gradient(180deg, rgba(122, 203, 159, 0.14) 0%, rgba(122, 203, 159, 0.08) 100%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    transition: background-color 0.2s ease, border-color 0.2s ease;
    animation: t-rewrite-mark-fade-in 0.2s ease;
}
#chat .mes .t-rewrite-mark::before {
    content: "↻ 已改写";
    display: inline-block;
    margin-right: 4px;
    padding: 0 4px;
    border-radius: 999px;
    border: 1px solid rgba(122, 203, 159, 0.38);
    background: rgba(122, 203, 159, 0.16);
    color: #ccefdc;
    font-size: 10px;
    line-height: 1.45;
    letter-spacing: 0.1px;
    vertical-align: baseline;
    white-space: nowrap;
    opacity: 0.88;
}
#chat .mes .t-rewrite-mark:hover {
    border-color: rgba(122, 203, 159, 0.45);
    background: linear-gradient(180deg, rgba(122, 203, 159, 0.19) 0%, rgba(122, 203, 159, 0.12) 100%);
}

/* t-rewrite-badge-flow / t-rewrite-badge-icon / t-rewrite-mark-fade-in 三个 @keyframes
   已移至 css/01-base/keyframes.css 集中声明（规则 R6）。keyframes 是 document 级的，
   本处注入的样式仍可正常引用。原名 titania-rewrite-* 已统一为 t-* 前缀。 */

#t-rewrite-settings-overlay .t-rewrite-settings-body { flex: 1; overflow: auto; display: block; padding: 16px; background: radial-gradient(circle at 100% 0%, rgba(144, 205, 244, 0.1) 0%, rgba(144, 205, 244, 0) 36%), radial-gradient(circle at 0% 100%, rgba(191, 161, 95, 0.08) 0%, rgba(191, 161, 95, 0) 32%), #12161d; }
#t-rewrite-settings-overlay .t-rewrite-settings-grid { display: grid; gap: 14px; grid-template-columns: repeat(12, minmax(0, 1fr)); }
#t-rewrite-settings-overlay .t-rewrite-settings-card { min-height: 0; border-radius: 0; border: 1px solid rgba(255, 255, 255, 0.14); background: linear-gradient(170deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015) 55%), rgba(10, 15, 22, 0.86); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); }
#t-rewrite-settings-overlay .t-rewrite-settings-card { position: relative; overflow: hidden; }
#t-rewrite-settings-overlay .t-rewrite-settings-card::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: linear-gradient(90deg, var(--t-rewrite-accent, rgba(144, 205, 244, 0.7)) 0%, rgba(255, 255, 255, 0.05) 100%); }
#t-rewrite-settings-overlay .t-rewrite-section-title { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 12px; padding: 4px 10px; border-radius: 999px; font-size: 0.82em; letter-spacing: 0.2px; border: 1px solid var(--t-rewrite-accent-border, rgba(144, 205, 244, 0.45)); color: var(--t-rewrite-accent-text, #d9ecfb); background: linear-gradient(135deg, var(--t-rewrite-accent-bg, rgba(144, 205, 244, 0.22)) 0%, rgba(255, 255, 255, 0.03) 100%); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14); }
#t-rewrite-settings-overlay .t-rewrite-label { display: block; font-size: 0.8em; color: #8da3b6; margin: 2px 0 6px; }
#t-rewrite-settings-overlay .t-rewrite-card-api { --t-rewrite-accent: rgba(95, 183, 233, 0.9); }
#t-rewrite-settings-overlay .t-rewrite-card-stream { --t-rewrite-accent: rgba(125, 204, 161, 0.88); }
#t-rewrite-settings-overlay .t-rewrite-card-split { --t-rewrite-accent: rgba(215, 179, 95, 0.92); }
#t-rewrite-settings-overlay .t-rewrite-card-whitelist { --t-rewrite-accent: rgba(177, 149, 238, 0.88); }
#t-rewrite-settings-overlay .t-rewrite-card-rules { --t-rewrite-accent: rgba(233, 136, 136, 0.9); }
#t-rewrite-settings-overlay .t-rewrite-card-api { --t-rewrite-accent-bg: rgba(95, 183, 233, 0.18); --t-rewrite-accent-border: rgba(95, 183, 233, 0.5); --t-rewrite-accent-text: #cfe9fb; }
#t-rewrite-settings-overlay .t-rewrite-card-stream { --t-rewrite-accent-bg: rgba(125, 204, 161, 0.18); --t-rewrite-accent-border: rgba(125, 204, 161, 0.5); --t-rewrite-accent-text: #d3f3e1; }
#t-rewrite-settings-overlay .t-rewrite-card-split { --t-rewrite-accent-bg: rgba(215, 179, 95, 0.2); --t-rewrite-accent-border: rgba(215, 179, 95, 0.5); --t-rewrite-accent-text: #f4e7c8; }
#t-rewrite-settings-overlay .t-rewrite-card-whitelist { --t-rewrite-accent-bg: rgba(177, 149, 238, 0.2); --t-rewrite-accent-border: rgba(177, 149, 238, 0.52); --t-rewrite-accent-text: #e7dcff; }
#t-rewrite-settings-overlay .t-rewrite-card-rules { --t-rewrite-accent-bg: rgba(233, 136, 136, 0.2); --t-rewrite-accent-border: rgba(233, 136, 136, 0.52); --t-rewrite-accent-text: #ffdcdc; }
#t-rewrite-settings-overlay .t-rewrite-model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; }
#t-rewrite-settings-overlay .t-rewrite-profile-row { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr) auto; align-items: center; gap: 8px; }
#t-rewrite-settings-overlay #t-rewrite-settings-model { width: 100%; }
#t-rewrite-settings-overlay #t-rewrite-settings-fetch-models { align-self: center; }
#t-rewrite-settings-overlay #t-rewrite-settings-new-profile { height: 28px; min-height: 28px; padding: 0 9px; font-size: 0.78em; }
#t-rewrite-settings-overlay .t-rewrite-profile-tip { margin-top: 6px; font-size: 0.74em; color: #8da5b8; }
#t-rewrite-settings-overlay .t-rewrite-card-api { grid-column: span 8; }
#t-rewrite-settings-overlay .t-rewrite-card-split, #t-rewrite-settings-overlay .t-rewrite-card-stream { grid-column: span 4; }
#t-rewrite-settings-overlay .t-rewrite-card-whitelist { grid-column: span 4; }
#t-rewrite-settings-overlay .t-rewrite-card-rules { grid-column: span 8; }
#t-rewrite-settings-overlay .t-rewrite-split-options-vertical { flex-direction: column; align-items: flex-start; gap: 8px; }
#t-rewrite-settings-overlay .t-rewrite-debug-row-block label { display: flex; align-items: flex-start; gap: 8px; }
#t-rewrite-settings-overlay #t-rewrite-settings-rules-list { max-height: 320px; overflow: auto; padding-right: 2px; }
#t-rewrite-overlay .t-rewrite-diff-empty, #t-rewrite-overlay .t-rewrite-empty-rule { border: 1px dashed rgba(255, 255, 255, 0.2); border-radius: 8px; padding: 12px; text-align: center; color: #6f8698; background: rgba(255, 255, 255, 0.02); }
#t-rewrite-overlay .t-rewrite-diff-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
#t-rewrite-overlay .t-rewrite-diff-cell { border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 8px; padding: 10px; background: rgba(8, 13, 20, 0.8); }
#t-rewrite-overlay .t-rewrite-diff-before { border-color: rgba(224, 136, 136, 0.35); background: linear-gradient(180deg, rgba(78, 26, 31, 0.4) 0%, rgba(26, 16, 18, 0.74) 100%); }
#t-rewrite-overlay .t-rewrite-diff-after { border-color: rgba(122, 203, 159, 0.35); background: linear-gradient(180deg, rgba(24, 68, 51, 0.38) 0%, rgba(14, 22, 18, 0.74) 100%); }
#t-rewrite-overlay .t-rewrite-test-section,
#t-rewrite-overlay .t-rewrite-raw-section,
#t-rewrite-overlay .t-rewrite-right > .t-rewrite-section { min-height: 0; display: flex; flex-direction: column; }
#t-rewrite-overlay .t-rewrite-test-section { flex: 1.1; }
#t-rewrite-overlay .t-rewrite-raw-section { flex: 0.95; }
#t-rewrite-overlay .t-rewrite-right > .t-rewrite-section:last-child { flex: 1.15; }

    /* === 方案选择器 === */
    #t-rewrite-settings-overlay .t-rewrite-scheme-bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    #t-rewrite-settings-overlay .t-rewrite-scheme-label { font-size: 0.85em; color: #bccdd8; font-weight: 600; white-space: nowrap; }
    #t-rewrite-settings-overlay .t-rewrite-scheme-bar select { flex: 1; min-width: 160px; }
    #t-rewrite-settings-overlay .t-rewrite-scheme-btn { width: 30px; min-width: 30px; height: 30px; padding: 0; justify-content: center; }

    /* === 分类卡片 === */
    #t-rewrite-settings-overlay .t-rewrite-category-card {
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        background: rgba(22, 27, 36, 0.6);
        margin-bottom: 8px;
        overflow: hidden;
        transition: border-color 0.15s;
    }
    #t-rewrite-settings-overlay .t-rewrite-category-card.t-rewrite-cat-empty { opacity: 0.7; }
    #t-rewrite-settings-overlay .t-rewrite-cat-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(28, 34, 44, 0.7);
        cursor: pointer;
        user-select: none;
    }
    #t-rewrite-settings-overlay .t-rewrite-cat-head:hover { background: rgba(34, 42, 54, 0.7); }
    #t-rewrite-settings-overlay .t-rewrite-cat-caret {
        font-size: 0.7em;
        color: #8899aa;
        width: 14px;
        transition: transform 0.2s;
    }
    #t-rewrite-settings-overlay .t-rewrite-category-card.collapsed .t-rewrite-cat-caret { transform: rotate(-90deg); }
    #t-rewrite-settings-overlay .t-rewrite-category-card.collapsed .t-rewrite-cat-body { display: none; }
    #t-rewrite-settings-overlay .t-rewrite-cat-num { font-size: 0.75em; color: #6a8090; font-weight: 700; min-width: 22px; }
    #t-rewrite-settings-overlay .t-rewrite-cat-name-display {
        flex: 1;
        font-size: 0.88em;
        font-weight: 600;
        color: #cddce8;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    #t-rewrite-settings-overlay .t-rewrite-cat-head-status { font-size: 0.75em; white-space: nowrap; }
    #t-rewrite-settings-overlay .t-rewrite-cat-status-ok { color: #6a9; }
    #t-rewrite-settings-overlay .t-rewrite-cat-status-warn { color: #e88; }
    #t-rewrite-settings-overlay .t-rewrite-cat-name-warn { color: #e88; font-size: 0.78em; white-space: nowrap; }
    #t-rewrite-settings-overlay .t-rewrite-cat-body {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    #t-rewrite-settings-overlay .t-rewrite-cat-name-row { display: flex; align-items: center; gap: 8px; }
    #t-rewrite-settings-overlay .t-rewrite-cat-name-row label { font-size: 0.82em; color: #bccdd8; font-weight: 600; white-space: nowrap; }
    #t-rewrite-settings-overlay .t-rewrite-cat-name-row input { flex: 1; font-size: 0.88em; }
    #t-rewrite-settings-overlay .t-rewrite-cat-field { display: flex; flex-direction: column; gap: 4px; }
    #t-rewrite-settings-overlay .t-rewrite-cat-field label { font-size: 0.8em; color: #99aabb; font-weight: 600; }
    #t-rewrite-settings-overlay .t-rewrite-cat-field textarea { resize: vertical; min-height: 38px; font-size: 0.84em; background: rgba(15, 18, 25, 0.6); }
    #t-rewrite-settings-overlay .t-rewrite-cat-field-hint { font-size: 0.76em; color: #6a8090; font-weight: 400; }

    /* === 关键词规则 === */
    #t-rewrite-settings-overlay .t-rewrite-cat-kw-list { display: flex; flex-direction: column; gap: 4px; }
    #t-rewrite-settings-overlay .t-rewrite-kw-row { display: flex; gap: 4px; align-items: center; }
    #t-rewrite-settings-overlay .t-rewrite-kw-row input { flex: 1; font-size: 0.82em; min-width: 80px; }
    #t-rewrite-settings-overlay .t-rewrite-kw-and { font-size: 0.78em; color: #9cb2c4; font-weight: 700; white-space: nowrap; }
    #t-rewrite-settings-overlay .t-rewrite-kw-del { width: 28px; min-width: 28px; height: 28px; padding: 0; justify-content: center; }

@media (max-width: 1200px) {
    #t-rewrite-overlay .t-rewrite-window { width: min(1080px, 97vw); }
    #t-rewrite-overlay .t-rewrite-body { grid-template-columns: 1fr; overflow: auto; }
    #t-rewrite-overlay .t-rewrite-right { gap: 10px; }
}

@media (max-width: 980px) {
    #t-rewrite-settings-overlay .t-rewrite-settings-window { width: 97vw; max-height: 94vh; height: auto; }
    #t-rewrite-settings-overlay .t-set-nav { width: 156px; }
    #t-rewrite-settings-overlay .t-rewrite-settings-body { padding: 12px; }
    #t-rewrite-settings-overlay .t-rewrite-settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    #t-rewrite-settings-overlay .t-rewrite-card-api,
    #t-rewrite-settings-overlay .t-rewrite-card-rules { grid-column: span 2; }
    #t-rewrite-settings-overlay .t-rewrite-card-split,
    #t-rewrite-settings-overlay .t-rewrite-card-stream,
    #t-rewrite-settings-overlay .t-rewrite-card-whitelist { grid-column: span 1; }
    #t-rewrite-overlay .t-rewrite-window { width: 97vw; height: auto; max-height: 94vh; }
    #t-rewrite-overlay .t-rewrite-body { padding: 12px; gap: 12px; }
}

@media (max-width: 700px) {
    #t-rewrite-overlay,
    #t-rewrite-settings-overlay,
    #t-rewrite-live-overlay {
        align-items: center;
        justify-content: center;
        padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
    }

    #t-rewrite-overlay .t-rewrite-window,
    #t-rewrite-settings-overlay .t-rewrite-settings-window,
    #t-rewrite-live-overlay .t-rewrite-live-window {
        width: min(96vw, 760px);
        max-width: min(96vw, 760px);
        max-height: min(96dvh, 96vh);
        height: auto;
        border-radius: 14px;
        border-left: 1px solid rgba(255, 255, 255, 0.12);
        border-right: 1px solid rgba(255, 255, 255, 0.12);
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    #t-rewrite-overlay .t-rewrite-window {
        width: min(96vw, 780px);
        max-width: min(96vw, 780px);
    }

    #t-rewrite-overlay .t-rewrite-head,
    #t-rewrite-settings-overlay .t-rewrite-head,
    #t-rewrite-live-overlay .t-rewrite-head { padding: 12px 14px; }
    #t-rewrite-overlay .t-rewrite-title,
    #t-rewrite-settings-overlay .t-rewrite-title,
    #t-rewrite-live-overlay .t-rewrite-title { font-size: 1em; }
    #t-rewrite-overlay .t-rewrite-body,
    #t-rewrite-settings-overlay .t-rewrite-settings-body { padding: 10px; gap: 10px; }
    #t-rewrite-settings-overlay .t-set-body { flex-direction: column; }
    #t-rewrite-settings-overlay .t-set-nav {
        width: 100%;
        height: 50px;
        flex-direction: row;
        flex-wrap: nowrap;
        padding: 0;
        gap: 0;
        border-right: none;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-gutter: stable;
        -webkit-overflow-scrolling: touch;
    }
    #t-rewrite-settings-overlay .t-set-tab-btn {
        border-left: none;
        border-bottom: 3px solid transparent;
        border-radius: 0;
        border-top: none;
        border-right: none;
        border-bottom-color: transparent;
        padding: 0 14px;
        height: 50px;
        min-height: 50px;
        white-space: nowrap;
        flex: 0 0 auto;
        min-width: max-content;
        justify-content: center;
        background: transparent;
    }
    #t-rewrite-settings-overlay .t-set-tab-btn.active {
        border-bottom-color: rgba(144, 205, 244, 0.8);
        border-left-color: transparent;
        background: transparent;
    }
    #t-rewrite-settings-overlay .t-set-content { padding: 10px; }
    #t-rewrite-live-overlay .t-rewrite-live-body { padding: 10px; gap: 10px; }
    #t-rewrite-settings-overlay .t-rewrite-settings-grid { grid-template-columns: 1fr; gap: 10px; }
    #t-rewrite-settings-overlay .t-rewrite-card-api,
    #t-rewrite-settings-overlay .t-rewrite-card-split,
    #t-rewrite-settings-overlay .t-rewrite-card-stream,
    #t-rewrite-settings-overlay .t-rewrite-card-whitelist,
    #t-rewrite-settings-overlay .t-rewrite-card-rules { grid-column: span 1; }
    #t-rewrite-settings-overlay .t-rewrite-model-row { grid-template-columns: minmax(0, 1fr) auto; }
    #t-rewrite-settings-overlay .t-rewrite-profile-row { grid-template-columns: 1fr; }

    #t-rewrite-overlay .t-rewrite-actions { flex-direction: column; align-items: stretch; }
    #t-rewrite-overlay .t-rewrite-action-hint { width: 100%; }
    #t-rewrite-overlay #t-rewrite-trigger { width: 100%; min-width: 0; }
    #t-rewrite-overlay .t-rewrite-head-text-btn { height: 30px; min-height: 30px; padding: 0 10px; font-size: 0.75em; }
    #t-rewrite-overlay .t-rewrite-diff-head { gap: 8px; }
    #t-rewrite-overlay .t-rewrite-diff-row { grid-template-columns: 1fr; }

    #t-rewrite-overlay .t-rewrite-rule-row { grid-template-columns: minmax(78px, 0.52fr) auto minmax(118px, 1fr) minmax(88px, 0.45fr) auto; gap: 6px; }
    #t-rewrite-settings-overlay .t-rewrite-rule-row { grid-template-columns: minmax(84px, 0.58fr) minmax(118px, 1fr) minmax(88px, 0.42fr) auto; gap: 6px; }
    #t-rewrite-overlay .t-rewrite-rule-and,
    #t-rewrite-settings-overlay .t-rewrite-rule-and { display: block; min-width: 14px; font-size: 0.74em; }
    #t-rewrite-overlay .t-rewrite-rule-no,
    #t-rewrite-settings-overlay .t-rewrite-rule-no { display: none; }
    #t-rewrite-overlay .t-rewrite-rule-del,
    #t-rewrite-settings-overlay .t-rewrite-rule-del { width: 30px; min-width: 30px; height: 32px; min-height: 32px; }
#t-rewrite-overlay .t-rewrite-rule-anchor,
#t-rewrite-settings-overlay .t-rewrite-rule-anchor,
#t-rewrite-overlay .t-rewrite-rule-extras,
#t-rewrite-settings-overlay .t-rewrite-rule-extras { padding: 7px 8px; font-size: 0.84em; }
#t-rewrite-overlay .t-rewrite-rule-action,
#t-rewrite-settings-overlay .t-rewrite-rule-action { padding: 7px 8px; font-size: 0.84em; }
}

@media (max-width: 420px) {
    #t-rewrite-overlay .t-window-close,
    #t-rewrite-settings-overlay .t-window-close,
    #t-rewrite-live-overlay .t-window-close { width: 28px; height: 28px; border-radius: 8px; }
    #t-rewrite-overlay #t-rewrite-trigger { height: 34px; min-height: 34px; font-size: 0.84em; padding: 0 12px; }
    #t-rewrite-overlay .t-rewrite-json-box { font-size: 0.72em; }
    #t-rewrite-overlay,
    #t-rewrite-settings-overlay,
    #t-rewrite-live-overlay {
        padding: max(6px, env(safe-area-inset-top)) 6px max(6px, env(safe-area-inset-bottom));
    }
    #t-rewrite-overlay .t-rewrite-window,
    #t-rewrite-settings-overlay .t-rewrite-settings-window,
    #t-rewrite-live-overlay .t-rewrite-live-window {
        width: 97vw;
        max-width: 97vw;
        max-height: min(97dvh, 97vh);
        border-radius: 12px;
    }

    @media (max-width: 600px) {
        #t-rewrite-settings-overlay .t-rewrite-scheme-bar select { min-width: 100px; }
    }
}
`;
const REWRITE_SETTINGS_BUTTON_CSS = `
#t-rewrite-settings-overlay .t-btn,
#t-rewrite-live-overlay .t-btn {
    height: 30px;
    min-height: 30px;
    padding: 0 10px;
    border-radius: 9px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: linear-gradient(140deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.04));
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    color: #e6f1fb;
    font-size: 0.8em;
    font-weight: 600;
    letter-spacing: 0.15px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.2);
    transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background 0.16s ease;
}
#t-rewrite-settings-overlay .t-btn:hover,
#t-rewrite-live-overlay .t-btn:hover {
    transform: translateY(-1px);
    border-color: rgba(144, 205, 244, 0.55);
    background: linear-gradient(140deg, rgba(144, 205, 244, 0.22), rgba(255, 255, 255, 0.06));
    box-shadow: 0 10px 22px rgba(17, 34, 54, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.26);
}
#t-rewrite-settings-overlay .t-btn:active,
#t-rewrite-live-overlay .t-btn:active {
    transform: translateY(0);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.16);
}
#t-rewrite-live-overlay .t-btn:disabled {
    opacity: 0.58;
    cursor: not-allowed;
    transform: none;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
#t-rewrite-settings-overlay #t-rewrite-settings-fetch-models {
    min-width: 30px;
    width: 30px;
    height: 28px;
    min-height: 28px;
    padding: 0;
    justify-content: center;
}
#t-rewrite-settings-overlay #t-rewrite-settings-add-rule {
    height: 28px;
    min-height: 28px;
    padding: 0 9px;
    font-size: 0.78em;
}
#t-rewrite-settings-overlay #t-rewrite-settings-save {
    min-width: 86px;
}
#t-rewrite-settings-overlay #t-rewrite-settings-prompt-reset {
    min-width: 96px;
}
#t-rewrite-live-overlay #t-rewrite-abort {
    min-width: 86px;
}
#t-rewrite-settings-overlay .t-rewrite-settings-textarea {
    width: 100%;
    min-height: 92px;
    resize: vertical;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(7, 11, 18, 0.9);
    color: #dce9f4;
    padding: 8px 10px;
    font-size: 0.82em;
    line-height: 1.45;
    box-sizing: border-box;
}
#t-rewrite-settings-overlay #t-rewrite-settings-prompt-system {
    min-height: 84px;
}
#t-rewrite-settings-overlay #t-rewrite-settings-prompt-user {
    min-height: 120px;
}
#t-rewrite-settings-overlay #t-rewrite-settings-prompt-json {
    min-height: 96px;
}
#t-rewrite-settings-overlay #t-rewrite-settings-prompt-combined,
#t-rewrite-settings-overlay #t-rewrite-settings-selected-prompt-combined {
    min-height: 300px;
}
#t-rewrite-settings-overlay .t-window-close {
    width: 30px;
    height: 30px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: linear-gradient(145deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.05));
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.24);
}
#t-rewrite-settings-overlay .t-window-close:hover {
    border-color: rgba(144, 205, 244, 0.6);
    background: linear-gradient(145deg, rgba(144, 205, 244, 0.24), rgba(255, 255, 255, 0.07));
}
`;

function ensureRewriteCssLoaded() {
    const cssId = "titania-css-rewrite-panel-inline";
    let style = document.getElementById(cssId);

    if (!style) {
        style = document.createElement("style");
        style.id = cssId;
        style.type = "text/css";
        document.head.appendChild(style);
    }

    style.textContent = `${REWRITE_PANEL_CSS}\n${REWRITE_SETTINGS_BUTTON_CSS}`;
}

function isEnabled() {
    const data = getExtData();
    return data?.rewrite_entry?.enabled === true;
}

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function normalizeChatEndpoint(inputUrl) {
    const base = normalizeApiBaseUrl(inputUrl);
    if (!base) return "";
    if (base.endsWith("/chat/completions")) return base;
    if (base.endsWith("/v1")) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
}

function normalizeToken(s) {
    return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizePunctuation(s) {
    return String(s || "")
        .replace(/，/g, ",")
        .replace(/；/g, ";")
        .replace(/：/g, ":")
        .replace(/[\t\f\v]+/g, " ");
}

function parseCommaList(input) {
    return normalizePunctuation(input)
        .split(",")
        .map(x => normalizeToken(x))
        .filter(Boolean);
}

function uniq(arr) {
    return [...new Set(arr)];
}

function normalizeRuleAction(action) {
    const value = String(action || "").trim().toLowerCase();
    return value === "delete" ? "delete" : "rewrite";
}

function actionLabel(action) {
    return normalizeRuleAction(action) === "delete" ? "删除" : "改写";
}

function generateId(prefix) {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${ts}_${rand}`;
}

function getActiveScheme() {
    const data = ensureRewriteDataShape();
    const schemes = Array.isArray(data.schemes) ? data.schemes : [];
    const activeId = String(data.active_scheme_id || "").trim();
    if (!activeId) return null;
    return schemes.find(s => s.id === activeId) || null;
}

function getActiveSchemeCategories() {
    const scheme = getActiveScheme();
    if (!scheme || !Array.isArray(scheme.categories)) return [];
    return scheme.categories.filter(cat => String(cat.name || "").trim() && Array.isArray(cat.rules) && cat.rules.length > 0);
}

function normalizeCategory(cat) {
    return {
        id: String(cat?.id || ""),
        name: String(cat?.name || "").trim(),
        bad_example: String(cat?.bad_example || "").trim(),
        good_example: String(cat?.good_example || "").trim(),
        guidance: String(cat?.guidance || "").trim(),
        rules: (Array.isArray(cat?.rules) ? cat.rules : []).map(r => ({
            anchor: uniq(parseCommaList(r?.anchor || "").filter(Boolean)).join(", "),
            extras: uniq(parseCommaList(r?.extras || "").filter(Boolean)).join(", ")
        })).filter(r => r.anchor && r.extras)
    };
}

function normalizeScheme(scheme) {
    return {
        id: String(scheme?.id || ""),
        name: String(scheme?.name || "").trim(),
        categories: (Array.isArray(scheme?.categories) ? scheme.categories : []).map(normalizeCategory).filter(cat => cat.name)
    };
}

function ensureRewriteDataShape() {
    const data = getExtData();
    if (!data.rewrite_entry || typeof data.rewrite_entry !== "object") {
        data.rewrite_entry = {
            enabled: false,
            api_url: "",
            api_key: "",
            model: "",
            split_mode: "sentence",
            active_scheme_id: "",
            schemes: []
        };
    }

    const item = data.rewrite_entry;
    item.profile_mode = "custom";
    if (typeof item.profile_id !== "string") item.profile_id = "";
    item.custom_profiles = normalizeRewriteCustomProfiles(item.custom_profiles, item);
    if (!item.profile_id) {
        item.profile_id = item.custom_profiles[0]?.id || "";
    }
    if (!item.split_mode || !["sentence", "paragraph"].includes(item.split_mode)) item.split_mode = "sentence";
    if (typeof item.stream_live !== "boolean") item.stream_live = true;
    if (typeof item.auto_trigger !== "boolean") item.auto_trigger = false;
    if (typeof item.selected_sentence_enabled !== "boolean") item.selected_sentence_enabled = true;
    if (typeof item.tag_whitelist !== "string") item.tag_whitelist = "";
    if (typeof item.active_scheme_id !== "string") item.active_scheme_id = "";
    if (!Array.isArray(item.schemes)) item.schemes = [];
    if (typeof item.prompt_system !== "string") item.prompt_system = REWRITE_DEFAULT_PROMPT_SYSTEM;
    if (typeof item.prompt_user !== "string") item.prompt_user = REWRITE_DEFAULT_PROMPT_USER;
    if (typeof item.selected_prompt_system !== "string") item.selected_prompt_system = REWRITE_DEFAULT_SELECTED_PROMPT_SYSTEM;
    if (typeof item.selected_prompt_user !== "string") item.selected_prompt_user = REWRITE_DEFAULT_SELECTED_PROMPT_USER;
    if (typeof item.prompt_json_rule !== "string") item.prompt_json_rule = REWRITE_DEFAULT_PROMPT_JSON_RULE;

    item.schemes = item.schemes.map(normalizeScheme).filter(s => s.name);
    return item;
}

function getRewritePromptState() {
    const item = ensureRewriteDataShape();
    return {
        prompt_system: String(item.prompt_system || REWRITE_DEFAULT_PROMPT_SYSTEM),
        prompt_user: String(item.prompt_user || REWRITE_DEFAULT_PROMPT_USER),
        prompt_json_rule: String(item.prompt_json_rule || REWRITE_DEFAULT_PROMPT_JSON_RULE)
    };
}

function getSelectedRewritePromptState() {
    const item = ensureRewriteDataShape();
    return {
        prompt_system: String(item.selected_prompt_system || REWRITE_DEFAULT_SELECTED_PROMPT_SYSTEM),
        prompt_user: String(item.selected_prompt_user || REWRITE_DEFAULT_SELECTED_PROMPT_USER),
        prompt_json_rule: String(item.prompt_json_rule || REWRITE_DEFAULT_PROMPT_JSON_RULE)
    };
}

function buildCombinedPromptText(promptSystem, promptUser) {
    return [
        "[SYS]",
        String(promptSystem || "").trim(),
        "",
        "[USER]",
        String(promptUser || "").trim()
    ].join("\n");
}

function parseCombinedPromptText(text, prevState = null) {
    const raw = String(text || "").replace(/\r\n/g, "\n");
    const prev = prevState || getRewritePromptState();

    const markerRegex = /^\s*(\[SYS\]|\[USER\]|={2,}\s*SYS\s*={2,}|={2,}\s*USER\s*={2,}|SYS[:：]|USER[:：])\s*$/gim;
    const markers = [];
    let match;
    while ((match = markerRegex.exec(raw)) !== null) {
        const token = String(match[1] || "").toUpperCase();
        const type = token.includes("USER") ? "user" : "sys";
        markers.push({ type, start: match.index, end: markerRegex.lastIndex });
    }

    const firstSys = markers.find(m => m.type === "sys") || null;
    const firstUser = markers.find(m => m.type === "user") || null;

    let sys = String(prev.prompt_system || REWRITE_DEFAULT_PROMPT_SYSTEM);
    let user = String(prev.prompt_user || REWRITE_DEFAULT_PROMPT_USER);

    if (firstSys && firstUser) {
        if (firstSys.start < firstUser.start) {
            sys = raw.slice(firstSys.end, firstUser.start).trim();
            user = raw.slice(firstUser.end).trim();
        } else {
            user = raw.slice(firstUser.end, firstSys.start).trim();
            sys = raw.slice(firstSys.end).trim();
        }
    } else if (firstSys) {
        sys = raw.slice(firstSys.end).trim();
    } else if (firstUser) {
        user = raw.slice(firstUser.end).trim();
    } else if (raw.trim()) {
        user = raw.trim();
    }

    return {
        prompt_system: sys || REWRITE_DEFAULT_PROMPT_SYSTEM,
        prompt_user: user || REWRITE_DEFAULT_PROMPT_USER,
        hasMarkers: !!(firstSys || firstUser)
    };
}

function persistPromptStateFromSettings() {
    const $overlay = getSettingsOverlay();
    if (!$overlay.length) return;

    const data = getExtData();
    const prev = ensureRewriteDataShape();
    const combinedText = String($overlay.find("#t-rewrite-settings-prompt-combined").val() || "");
    const parsed = parseCombinedPromptText(combinedText, getRewritePromptState());
    const selectedCombinedText = String($overlay.find("#t-rewrite-settings-selected-prompt-combined").val() || "");
    const selectedParsed = parseCombinedPromptText(selectedCombinedText, getSelectedRewritePromptState());
    data.rewrite_entry = {
        ...prev,
        prompt_system: parsed.prompt_system,
        prompt_user: parsed.prompt_user,
        selected_prompt_system: selectedParsed.prompt_system,
        selected_prompt_user: selectedParsed.prompt_user,
        prompt_json_rule: String(prev.prompt_json_rule || REWRITE_DEFAULT_PROMPT_JSON_RULE)
    };
    saveExtData();
}

function getOverlay() {
    return $(`#${OVERLAY_ID}`);
}

function getSettingsOverlay() {
    return $(`#${SETTINGS_OVERLAY_ID}`);
}

function getLiveOverlay() {
    return $(`#${LIVE_OVERLAY_ID}`);
}

function closePanel() {
    closeSettingsPanel();
    closeLivePanel();
    getOverlay().remove();
}

function closeSettingsPanel() {
    getSettingsOverlay().remove();
}

function closeLivePanel() {
    getLiveOverlay().remove();
}

function syncRuntimeCollapseUi() {
    const $body = $("#t-rewrite-runtime-body");
    const $btn = $("#t-rewrite-runtime-toggle");
    if ($body.length) {
        $body.toggleClass("is-collapsed", runtimeCollapsed === true);
    }
    if ($btn.length) {
        $btn.text(runtimeCollapsed ? "展开" : "折叠");
    }
}

function removeButton(closePanelToo = true) {
    $(`#${BTN_ID}`).remove();
    if (closePanelToo) closePanel();
}

function setStatus(text, tone = "muted") {
    const $targets = $("#t-rewrite-status, #t-rewrite-settings-status");
    if (!$targets.length) return;
    $targets.each((_, el) => {
        $(el).removeClass("ok warn err muted").addClass(tone).text(text || "");
    });
}

function splitBySentence(text) {
    const src = String(text || "");
    if (!src.trim()) return [];

    const lines = src.split(/\r?\n/);
    const chunks = [];

    lines.forEach((line) => {
        if (!line.trim()) return;
        const arr = line.split(/(?<=[。！？!?])/u).filter(s => s.trim());
        if (arr.length === 0) {
            chunks.push(line);
        } else {
            chunks.push(...arr);
        }
    });

    return chunks;
}

function getSelectedSentenceIdSet() {
    return selectedSentenceIds instanceof Set ? selectedSentenceIds : new Set();
}

function getSelectedSentenceCount() {
    return getSelectedSentenceIdSet().size;
}

function updateInlineRewriteCount() {
    $("#chat .t-rewrite-inline-count").text(`已选 ${getSelectedSentenceCount()} 句`);
}

function setSelectedSentenceIds(ids = []) {
    selectedSentenceIds = new Set(Array.from(ids).map(id => String(id || "")).filter(Boolean));
}

function buildSentenceUnitsFromLatest(latest) {
    const sentences = splitBySentence(latest?.content || "");
    return sentences.map((text, idx) => ({
        unitIndex: idx + 1,
        segment_id: `s_${idx + 1}`,
        text: String(text || ""),
        hit: false,
        matchedCategories: []
    }));
}

function renderSentenceSelection() {
    const $list = $("#t-rewrite-sentence-list");
    const $meta = $("#t-rewrite-sentence-meta");
    if (!$list.length) return;

    const selected = getSelectedSentenceIdSet();
    if ($meta.length) {
        $meta.text(`共 ${latestSentenceUnits.length} 句，已选 ${selected.size} 句`);
    }

    if (latestSentenceUnits.length === 0) {
        $list.html('<div class="t-rewrite-diff-empty">未找到最新回复楼层，或楼层内容为空</div>');
        return;
    }

    const html = latestSentenceUnits.map((unit) => {
        const id = String(unit.segment_id || `s_${unit.unitIndex}`);
        const active = selected.has(id) ? " selected" : "";
        return `
            <button class="t-rewrite-sentence-row${active}" type="button" data-segment-id="${escapeHtml(id)}">
                <span class="t-rewrite-sentence-no">#${unit.unitIndex}</span>
                <span class="t-rewrite-sentence-text">${escapeHtml(unit.text)}</span>
            </button>
        `;
    }).join("");
    $list.html(html);
}

function refreshLatestSentenceSelection({ keepSelection = false } = {}) {
    const latest = getLatestAssistantMessageFromChat();
    const previous = keepSelection ? getSelectedSentenceIdSet() : new Set();
    latestSentenceUnits = latest ? buildSentenceUnitsFromLatest(latest) : [];
    const available = new Set(latestSentenceUnits.map(u => u.segment_id));
    setSelectedSentenceIds(Array.from(previous).filter(id => available.has(id)));
    renderSentenceSelection();
    return latest;
}

function buildSelectedSentencePayload(latest, selectedIds) {
    const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
    const evaluated = {
        sourceMode: "selected",
        splitMode: "sentence",
        unitCount: latestSentenceUnits.length,
        hitCount: selected.size,
        categoryCount: 0,
        unitResults: latestSentenceUnits.map((unit) => ({
            ...unit,
            hit: selected.has(unit.segment_id),
            matchedCategories: []
        }))
    };
    const targets = evaluated.unitResults
        .filter(unit => unit.hit)
        .map(unit => ({
            segment_id: unit.segment_id,
            original_text: unit.text,
            matched_keywords: []
        }));

    return {
        evaluated,
        request: {
            task_id: `rewrite_selected_${Date.now()}`,
            targets
        },
        hitCategoryCount: 0
    };
}

function clearInlineSentenceSelection() {
    $("#chat .t-rewrite-inline-toolbar").remove();
    $("#chat .t-rewrite-select-sentence").each((_, el) => {
        const text = document.createTextNode(el.textContent || "");
        el.replaceWith(text);
    });
    const containers = document.querySelectorAll("#chat .mes_text, #chat .message_text");
    containers.forEach(el => el.normalize());
    inlineSelectionMessageIndex = null;
    setSelectedSentenceIds([]);
}

function wrapFirstSentenceSelectionOccurrence(containerEl, unit) {
    const needle = String(unit?.text || "");
    const segmentId = String(unit?.segment_id || "");
    if (!containerEl || !needle || !segmentId) return false;

    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node || !node.nodeValue || !node.nodeValue.includes(needle)) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest(".t-rewrite-mark, .t-rewrite-select-sentence")) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const candidateNodes = [];
    let current = walker.nextNode();
    while (current) {
        candidateNodes.push(current);
        current = walker.nextNode();
    }

    for (const textNode of candidateNodes) {
        const content = textNode.nodeValue || "";
        const idx = content.indexOf(needle);
        if (idx < 0) continue;

        const right = textNode.splitText(idx);
        const tail = right.splitText(needle.length);
        const mark = document.createElement("span");
        mark.className = "t-rewrite-select-sentence";
        mark.dataset.segmentId = segmentId;
        mark.title = "点击选择/取消选择此句";
        mark.textContent = needle;
        right.replaceWith(mark);

        if (tail && tail.parentNode) tail.parentNode.normalize();
        else if (mark.parentNode) mark.parentNode.normalize();
        return true;
    }

    return false;
}

function ensureInlineRewriteToolbar(latest) {
    if (!latest) return;
    const $message = getChatMessageElementByIndex(latest.index);
    if (!$message.length) return;
    let $toolbar = $message.find(".t-rewrite-inline-toolbar").first();
    if ($toolbar.length === 0) {
        $toolbar = $(`
            <div class="t-rewrite-inline-toolbar" data-message-index="${latest.index}">
                <button class="t-rewrite-inline-start" type="button">选句改写</button>
                <button class="t-rewrite-inline-confirm" type="button" style="display:none;">确认改写</button>
                <button class="t-rewrite-inline-cancel" type="button" style="display:none;">取消</button>
                <span class="t-rewrite-inline-count" style="display:none;">已选 0 句</span>
            </div>
        `);
        const containerEl = getMessageRenderContainer($message);
        if (containerEl) $(containerEl).before($toolbar);
        else $message.prepend($toolbar);
    }
}

function refreshInlineRewriteEntry() {
    const data = ensureRewriteDataShape();
    if (!isEnabled() || data.selected_sentence_enabled === false) {
        clearInlineSentenceSelection();
        return;
    }
    $("#chat .t-rewrite-inline-toolbar").each((_, el) => {
        const messageIndex = Number($(el).attr("data-message-index"));
        if (inlineSelectionMessageIndex !== messageIndex) $(el).remove();
    });
    const latest = getLatestAssistantMessageFromChat();
    if (!latest) return;
    ensureInlineRewriteToolbar(latest);
}

function enterInlineSentenceSelection() {
    clearInlineSentenceSelection();
    const latest = getLatestAssistantMessageFromChat();
    if (!latest) {
        setStatus("未找到可改写的最新回复楼层", "warn");
        if (window.toastr) toastr.warning("未找到可改写的最新回复楼层", "文本改写");
        return;
    }

    latestSentenceUnits = buildSentenceUnitsFromLatest(latest);
    if (latestSentenceUnits.length === 0) {
        if (window.toastr) toastr.warning("最新楼层内容为空，无法选句", "文本改写");
        return;
    }

    inlineSelectionMessageIndex = latest.index;
    const $message = getChatMessageElementByIndex(latest.index);
    const containerEl = getMessageRenderContainer($message);
    if (!containerEl) return;

    unwrapRenderedRewriteMarks(containerEl);
    latestSentenceUnits.forEach(unit => wrapFirstSentenceSelectionOccurrence(containerEl, unit));
    ensureInlineRewriteToolbar(latest);
    const $toolbar = $message.find(".t-rewrite-inline-toolbar").first();
    $toolbar.find(".t-rewrite-inline-start").hide();
    $toolbar.find(".t-rewrite-inline-confirm, .t-rewrite-inline-cancel, .t-rewrite-inline-count").show();
    updateInlineRewriteCount();
}

function splitByParagraph(text) {
    return String(text || "")
        .split(/\r?\n\s*\r?\n+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function splitText(text, splitMode) {
    return splitMode === "paragraph" ? splitByParagraph(text) : splitBySentence(text);
}

function evaluateUnitAgainstRule(unitText, rule) {
    const anchorList = parseCommaList(String(rule?.anchor || ""));
    const extrasList = parseCommaList(String(rule?.extras || ""));
    if (anchorList.length === 0 || extrasList.length === 0) return false;
    const source = normalizeToken(unitText);
    const anchorHit = anchorList.some(kw => source.includes(kw));
    if (!anchorHit) return false;
    const extrasHit = extrasList.some(kw => source.includes(kw));
    return extrasHit;
}

function evaluateUnitAgainstCategory(unitText, category) {
    const rules = Array.isArray(category.rules) ? category.rules : [];
    const matchedRules = [];
    rules.forEach((rule) => {
        if (evaluateUnitAgainstRule(unitText, rule)) {
            matchedRules.push({
                anchor: String(rule.anchor || ""),
                extras: String(rule.extras || "")
            });
        }
    });
    return matchedRules;
}

function evaluateRules(payload, sourceText = null) {
    const splitMode = payload?.split_mode === "paragraph" ? "paragraph" : "sentence";
    const categories = Array.isArray(payload?.categories) ? payload.categories : [];
    const testText = String(sourceText || "");
    const units = splitText(testText, splitMode);

    const unitResults = units.map((unit, idx) => {
        const matchedCategories = [];
        categories.forEach((cat) => {
            const matchedRules = evaluateUnitAgainstCategory(unit, cat);
            if (matchedRules.length > 0) {
                matchedCategories.push({
                    categoryId: String(cat.id || ""),
                    categoryName: String(cat.name || ""),
                    matchedRules
                });
            }
        });
        return {
            unitIndex: idx + 1,
            text: unit,
            hit: matchedCategories.length > 0,
            matchedCategories
        };
    });

    const hitUnits = unitResults.filter(item => item.hit);
    const hitCategoryIds = new Set();
    hitUnits.forEach(u => u.matchedCategories.forEach(c => hitCategoryIds.add(c.categoryId)));

    return {
        splitMode,
        unitCount: unitResults.length,
        hitCount: hitUnits.length,
        categoryCount: hitCategoryIds.size,
        unitResults
    };
}

function renderDiffRows(rows = []) {
    if (Array.isArray(rows)) {
        lastDiffRows = rows.map((item) => ({
            before: String(item?.before || ""),
            after: String(item?.after || ""),
            ruleHint: String(item?.ruleHint || ""),
            action: normalizeRuleAction(item?.action)
        }));
    } else {
        lastDiffRows = [];
    }

    const $body = $("#t-rewrite-diff-body");
    if (!$body.length) return;

    if (!Array.isArray(lastDiffRows) || lastDiffRows.length === 0) {
        $body.html('<div class="t-rewrite-diff-empty">等待执行改写后展示 Diff 对比</div>');
        return;
    }

    const html = lastDiffRows.map((item, idx) => {
        const before = escapeHtml(item.before || "");
        const after = escapeHtml(item.after || "");
        const ruleHint = escapeHtml(item.ruleHint || "");
        const action = normalizeRuleAction(item.action);
        const afterLabel = action === "delete" ? "删除" : "改写";
        const afterText = action === "delete" ? "（已删除）" : after;
        return `
            <div class="t-rewrite-diff-row">
                <div class="t-rewrite-diff-cell t-rewrite-diff-before">
                    <div class="t-rewrite-diff-label">原句 #${idx + 1}${ruleHint ? ` · ${ruleHint}` : ""}</div>
                    <div class="t-rewrite-diff-text">${before}</div>
                </div>
                <div class="t-rewrite-diff-cell t-rewrite-diff-after">
                    <div class="t-rewrite-diff-label">${afterLabel} #${idx + 1}</div>
                    <div class="t-rewrite-diff-text">${afterText}</div>
                </div>
            </div>
        `;
    }).join("");

    $body.html(html);
}

function setRawResponse(text) {
    lastRawResponseText = String(text || "");
    const $targets = $("#t-rewrite-raw-response");
    if (!$targets.length) return;
    $targets.each((_, el) => {
        const $el = $(el);
        $el.text(lastRawResponseText);
        const dom = $el.get(0);
        if (dom) dom.scrollTop = dom.scrollHeight;
    });
    renderLiveHistory();
}

function setRawMeta(text) {
    lastRawMetaText = String(text || "");
    const $targets = $("#t-rewrite-raw-meta");
    if (!$targets.length) return;
    $targets.each((_, el) => {
        $(el).text(lastRawMetaText);
    });
}

function formatHistoryTime(ts) {
    if (!ts) return "-";
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function makeHistoryPreview(text, maxLen = 120) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLen) return normalized;
    return `${normalized.slice(0, maxLen)}...`;
}

function pushLiveResponseHistory({ source = "manual", phase = "主请求", model = "", stream = false, text = "" } = {}) {
    const content = String(text || "").trim();
    if (!content) return;

    liveResponseHistory.unshift({
        id: `live_resp_${Date.now()}_${liveResponseHistorySeq++}`,
        at: Date.now(),
        source: String(source || "manual"),
        phase: String(phase || "主请求"),
        model: String(model || ""),
        stream: stream === true,
        text: content,
        chars: content.length
    });

    if (liveResponseHistory.length > LIVE_RESPONSE_HISTORY_MAX) {
        liveResponseHistory = liveResponseHistory.slice(0, LIVE_RESPONSE_HISTORY_MAX);
    }

    renderLiveHistory();
}

function renderLiveHistory() {
    const $list = $("#t-rewrite-live-history-list");
    if (!$list.length) return;

    if (!Array.isArray(liveResponseHistory) || liveResponseHistory.length === 0) {
        $list.html('<div class="t-rewrite-live-history-empty">暂无历史记录，执行改写后会保留最近 20 条返回内容。</div>');
        return;
    }

    const html = liveResponseHistory.map((item) => {
        const active = String(item.text || "") === String(lastRawResponseText || "");
        const streamText = item.stream ? "流式" : "非流式";
        const modelText = item.model ? ` · ${escapeHtml(item.model)}` : "";
        return `
            <div class="t-rewrite-live-history-item ${active ? "active" : ""}" data-history-id="${escapeHtml(item.id)}">
                <div class="t-rewrite-live-history-head">
                    <span>${escapeHtml(formatHistoryTime(item.at))} · ${escapeHtml(item.source)} · ${escapeHtml(item.phase)} · ${streamText}${modelText}</span>
                    <span>${item.chars} chars</span>
                </div>
                <div class="t-rewrite-live-history-preview">${escapeHtml(makeHistoryPreview(item.text))}</div>
            </div>
        `;
    }).join("");

    $list.html(html);
}

function updateAbortBtnState(isRunning) {
    $("#t-rewrite-abort").prop("disabled", !isRunning);
}

function stripCodeFence(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    return raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
}

function extractJsonCandidate(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return raw.slice(start, end + 1).trim();
    }
    return raw;
}

function sanitizeJsonLike(text) {
    let s = String(text || "");
    s = s.replace(/[""]/g, '"').replace(/[‘’]/g, "'");
    s = s.replace(/,\s*([}\]])/g, "$1");
    s = s.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '$1"$2":');
    s = s.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, p1) => {
        return `: "${String(p1).replace(/\"/g, '"').replace(/"/g, '\\"')}"`;
    });
    return s.trim();
}

function stabilizeBrokenJson(text) {
    const raw = String(text || "");
    if (!raw) return "";

    const fixed = raw.replace(/\"([^\"]*?)\"\s*:\s*\"([\s\S]*?)(?=\n\s*\"[A-Za-z0-9_]+\"\s*:|\n\s*[}\]]|\s*}\s*$|\s*]\s*$)/g, (m, key, value) => {
        const safe = String(value)
            .replace(/\\/g, "\\\\")
            .replace(/\r?\n/g, "\\n")
            .replace(/\"/g, '\\\"');
        return `"${key}":"${safe}"`;
    });

    let out = "";
    let inString = false;
    let escaped = false;

    for (let i = 0; i < fixed.length; i += 1) {
        const ch = fixed[i];

        if (inString) {
            if (escaped) {
                out += ch;
                escaped = false;
                continue;
            }

            if (ch === "\\") {
                out += ch;
                escaped = true;
                continue;
            }

            if (ch === '"') {
                out += ch;
                inString = false;
                continue;
            }

            if (ch === "\n" || ch === "\r") {
                out += "\\n";
                continue;
            }

            out += ch;
            continue;
        }

        if (ch === '"') {
            inString = true;
        }
        out += ch;
    }

    if (inString) {
        out += '"';
    }

    out = out.replace(/,\s*([}\]])/g, "$1");

    let braceOpen = 0;
    let bracketOpen = 0;
    for (let i = 0; i < out.length; i += 1) {
        const ch = out[i];
        if (ch === "{") braceOpen += 1;
        else if (ch === "}") braceOpen = Math.max(0, braceOpen - 1);
        else if (ch === "[") bracketOpen += 1;
        else if (ch === "]") bracketOpen = Math.max(0, bracketOpen - 1);
    }

    if (bracketOpen > 0) out += "]".repeat(bracketOpen);
    if (braceOpen > 0) out += "}".repeat(braceOpen);

    return out.trim();
}

function parseRewriteJson(raw) {
    const base = extractJsonCandidate(stripCodeFence(raw));
    const candidates = [
        base,
        sanitizeJsonLike(base),
        stabilizeBrokenJson(base),
        stabilizeBrokenJson(sanitizeJsonLike(base))
    ].filter(Boolean);

    let lastErr = null;
    for (const c of candidates) {
        try {
            return JSON.parse(c);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error("Invalid JSON response");
}

function buildRewritePayload(data, sourceText) {
    const categories = getActiveSchemeCategories();
    const payload = {
        split_mode: data.split_mode || "sentence",
        categories
    };
    const evaluated = evaluateRules(payload, sourceText || "");

    const targets = [];
    const catNames = new Set();
    evaluated.unitResults.forEach((unit) => {
        if (!unit.hit) return;
        unit.matchedCategories.forEach((mc) => {
            catNames.add(mc.categoryName);
            const allKeywords = mc.matchedRules.map(r => [...parseCommaList(r.anchor), ...parseCommaList(r.extras)]).flat();
            targets.push({
                segment_id: `s_${unit.unitIndex}`,
                original_text: unit.text,
                matched_keywords: uniq(allKeywords)
            });
        });
    });

    return {
        evaluated,
        request: {
            task_id: `rewrite_${Date.now()}`,
            targets
        },
        hitCategoryCount: catNames.size
    };
}

function getLatestAssistantMessageFromChat() {
    if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return null;
    const ctx = SillyTavern.getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const whitelist = parseTagWhitelistInput(ensureRewriteDataShape().tag_whitelist || "");
    if (chat.length === 0) return null;

    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system || msg.is_hidden || msg.disabled) continue;
        const raw = String(msg.mes || msg.message || "");
        const content = extractTextByWhitelist(raw, whitelist);
        if (!content.trim()) continue;
        return { index: i, msg, content, raw };
    }

    return null;
}

function getChatMessageElementByIndex(index) {
    const $byId = $(`#chat .mes[mesid='${index}']`).last();
    if ($byId.length) return $byId;
    const $fallback = $("#chat > div.mes.reasoning.last_mes").last();
    if ($fallback.length) return $fallback;
    return $();
}

function clearAutoRewriteIndicator() {
    $("#chat .t-rewrite-auto-badge").remove();
}

function applyAutoRewriteIndicator(messageIndex) {
    clearAutoRewriteIndicator();
    const $target = getChatMessageElementByIndex(messageIndex);
    if (!$target.length) return false;

    if ($target.find(".t-rewrite-auto-badge").length === 0) {
        $target.append('<div class="t-rewrite-auto-badge"><i class="fa-solid fa-wand-magic-sparkles"></i><span>自动改写中</span></div>');
    }
    return true;
}

function stripRewriteMarkWrappers(text) {
    return String(text || "").replace(/<span\b[^>]*\bt-rewrite-mark\b[^>]*>([\s\S]*?)<\/span>/gi, "$1");
}

function normalizeRewriteMarks(input) {
    if (!Array.isArray(input)) return [];
    return input
        .map((item) => ({
            before: String(item?.before || ""),
            after: String(item?.after || "")
        }))
        .filter((item) => {
            const before = item.before.trim();
            const after = item.after.trim();
            return !!before && !!after && before !== after;
        });
}

function buildRewriteMarksFromRows(rows = []) {
    return normalizeRewriteMarks(rows.map((row) => ({
        before: String(row?.before || ""),
        after: String(row?.after || "")
    })));
}

function unwrapRenderedRewriteMarks(containerEl) {
    if (!containerEl) return;
    const marked = containerEl.querySelectorAll("span.t-rewrite-mark");
    marked.forEach((el) => {
        const text = document.createTextNode(el.textContent || "");
        el.replaceWith(text);
    });
}

function getMessageRenderContainer($message) {
    if (!$message || !$message.length) return null;
    const selectors = [".mes_text", ".message_text", ".mes_block .mes_text"];
    for (const selector of selectors) {
        const $target = $message.find(selector).first();
        if ($target.length) return $target.get(0);
    }
    return null;
}

function wrapFirstTextOccurrence(containerEl, targetText, originalText) {
    const needle = String(targetText || "");
    if (!containerEl || !needle) return false;

    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node || !node.nodeValue || !node.nodeValue.includes(needle)) {
                return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (parent.closest(".t-rewrite-mark")) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const candidateNodes = [];
    let current = walker.nextNode();
    while (current) {
        candidateNodes.push(current);
        current = walker.nextNode();
    }

    for (const textNode of candidateNodes) {
        const content = textNode.nodeValue || "";
        const idx = content.indexOf(needle);
        if (idx < 0) continue;

        const right = textNode.splitText(idx);
        const tail = right.splitText(needle.length);
        const mark = document.createElement("span");
        mark.className = "t-rewrite-mark";
        mark.title = `原句：${String(originalText || "")}`;
        mark.textContent = needle;
        right.replaceWith(mark);

        if (tail && tail.parentNode) {
            tail.parentNode.normalize();
        } else if (mark.parentNode) {
            mark.parentNode.normalize();
        }
        return true;
    }

    return false;
}

function applyRewriteMarksToMessage(index, marksInput) {
    const marks = normalizeRewriteMarks(marksInput)
        .sort((a, b) => b.after.length - a.after.length);
    const $message = getChatMessageElementByIndex(index);
    if (!$message.length) return;

    const containerEl = getMessageRenderContainer($message);
    if (!containerEl) return;

    unwrapRenderedRewriteMarks(containerEl);
    if (marks.length === 0) return;

    marks.forEach((mark) => {
        wrapFirstTextOccurrence(containerEl, mark.after, mark.before);
    });
}

function applyAllRewriteMarksFromChat() {
    if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) return;
    const ctx = SillyTavern.getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];

    chat.forEach((msg, index) => {
        const marks = normalizeRewriteMarks(msg?.extra?.titania_rewrite_marks);
        applyRewriteMarksToMessage(index, marks);
    });
    refreshInlineRewriteEntry();
}

function scheduleApplyAllRewriteMarks(delay = 80) {
    if (rewriteDecorTimer) clearTimeout(rewriteDecorTimer);
    rewriteDecorTimer = setTimeout(() => {
        applyAllRewriteMarksFromChat();
    }, delay);
}

function bindRewriteDecorationEvents() {
    if (rewriteDecorBound) return;
    rewriteDecorBound = true;
    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        scheduleApplyAllRewriteMarks(120);
        setTimeout(refreshInlineRewriteEntry, 160);
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        scheduleApplyAllRewriteMarks(120);
        setTimeout(refreshInlineRewriteEntry, 160);
    });
}

function applyRewriteToFullText(sourceText, evaluated, parsed, request = null) {
    const map = new Map((parsed?.results || []).map(r => [String(r.segment_id), String(r.rewritten_text || "")]));
    let rewritten = String(sourceText || "");
    let cursor = 0;
    let replaced = 0;

    evaluated.unitResults
        .filter(u => u.hit)
        .forEach((unit) => {
            const segmentId = `s_${unit.unitIndex}`;
            const after = map.get(segmentId);
            if (typeof after !== "string") return;
            const before = String(unit.text || "");
            if (!before) return;

            const idx = rewritten.indexOf(before, cursor);
            if (idx < 0) return;

            rewritten = `${rewritten.slice(0, idx)}${after}${rewritten.slice(idx + before.length)}`;
            cursor = idx + after.length;
            replaced += 1;
        });

    return { text: rewritten, replaced };
}

function writeBackMessageContent(targetMsg, rewrittenText) {
    const text = stripRewriteMarkWrappers(String(rewrittenText || ""));
    targetMsg.mes = text;
    targetMsg.message = text;

    if (Array.isArray(targetMsg.swipes) && targetMsg.swipes.length > 0) {
        const swipeId = Number(targetMsg.swipe_id);
        const idx = Number.isInteger(swipeId) && swipeId >= 0 && swipeId < targetMsg.swipes.length
            ? swipeId
            : (targetMsg.swipes.length - 1);
        targetMsg.swipes[idx] = text;
    }
}

function buildRewriteMessages(payload, promptState = null) {
    const schemaText = '{"task_id":"string","results":[{"segment_id":"string","rewritten_text":"string"}]}';
    const prompts = promptState || getRewritePromptState();

    let systemPrompt = String(prompts.prompt_system || REWRITE_DEFAULT_PROMPT_SYSTEM).trim() || REWRITE_DEFAULT_PROMPT_SYSTEM;
    const jsonRuleText = String(prompts.prompt_json_rule || REWRITE_DEFAULT_PROMPT_JSON_RULE).trim() || REWRITE_DEFAULT_PROMPT_JSON_RULE;
    if (systemPrompt.includes("{{json_rule}}")) {
        systemPrompt = systemPrompt.split("{{json_rule}}").join(jsonRuleText);
    } else {
        systemPrompt = `${systemPrompt}\n${jsonRuleText}`;
    }

    let userPrompt = String(prompts.prompt_user || REWRITE_DEFAULT_PROMPT_USER).trim() || REWRITE_DEFAULT_PROMPT_USER;
    userPrompt = userPrompt
        .split("{{schema}}").join(schemaText)
        .split("{{payload}}").join(JSON.stringify(payload));

    return [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
    ];
}

function buildFixJsonMessages(rawOutput, payload) {
    return [
        {
            role: "system",
            content: "你是 JSON 修复器。只输出合法 JSON，不要输出其他内容。JSON 必须使用双引号，不允许尾逗号。"
        },
        {
            role: "user",
            content: [
                "把下面内容修正成合法 JSON，且严格满足 schema：",
                '{"task_id":"string","results":[{"segment_id":"string","rewritten_text":"string"}]}',
                "必须包含键名：task_id 和 results（不能改名为 data/items/rewrites）",
                "必须与以下输入 payload 对齐（segment_id 和数量一致）：",
                JSON.stringify(payload),
                "待修复内容：",
                String(rawOutput || "")
            ].join("\n")
        }
    ];
}

function estimateMaxTokens(payload) {
    return REWRITE_MAX_TOKENS;
}

function validateRewriteResponse(parsed, payload) {
    if (!parsed || typeof parsed !== "object") {
        return { ok: false, reason: "返回不是对象" };
    }
    const taskId = String(parsed.task_id || "").trim();
    if (!taskId) return { ok: false, reason: "缺少 task_id" };
    if (!Array.isArray(parsed.results)) return { ok: false, reason: "缺少 results 数组" };

    const targets = Array.isArray(payload?.targets) ? payload.targets : [];
    if (parsed.results.length !== targets.length) {
        return { ok: false, reason: `results 数量不匹配: ${parsed.results.length}/${targets.length}` };
    }

    const targetSet = new Set(targets.map(t => t.segment_id));
    const seen = new Set();
    for (const row of parsed.results) {
        const segmentId = String(row?.segment_id || "").trim();
        const rewrittenText = String(row?.rewritten_text || "").trim();
        if (!segmentId) return { ok: false, reason: "存在空 segment_id" };
        if (!targetSet.has(segmentId)) return { ok: false, reason: `segment_id 不在输入中: ${segmentId}` };
        if (seen.has(segmentId)) return { ok: false, reason: `segment_id 重复: ${segmentId}` };
        if (!rewrittenText) return { ok: false, reason: `rewritten_text 为空: ${segmentId}` };
        seen.add(segmentId);
    }

    return { ok: true };
}

async function requestRewriteOnce(apiUrl, apiKey, model, messages, maxTokens) {
    return requestRewriteWithOptions(apiUrl, apiKey, model, messages, maxTokens, {
        temperature: REWRITE_TEMPERATURE
    });
}

function buildRewriteJsonSchema() {
    return {
        type: "json_schema",
        json_schema: {
            name: "rewrite_response",
            strict: true,
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    task_id: { type: "string" },
                    results: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                segment_id: { type: "string" },
                                rewritten_text: { type: "string" }
                            },
                            required: ["segment_id", "rewritten_text"]
                        }
                    }
                },
                required: ["task_id", "results"]
            }
        }
    };
}

function shouldFallbackWithoutSchema(status, bodyText) {
    if (status !== 400 && status !== 422) return false;
    const msg = String(bodyText || "").toLowerCase();
    return msg.includes("response_format") || msg.includes("json_schema") || msg.includes("unsupported") || msg.includes("invalid_request_error");
}

async function requestRewriteWithOptions(apiUrl, apiKey, model, messages, maxTokens, options = {}) {
    const endpoint = normalizeChatEndpoint(apiUrl);
    if (!endpoint) throw new Error("API 地址无效");

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const temperature = Number.isFinite(options.temperature) ? options.temperature : REWRITE_TEMPERATURE;
    const stream = options.stream === true;
    const signal = options.signal;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const body = {
        model,
        messages,
        stream,
        temperature,
        max_tokens: maxTokens,
        response_format: buildRewriteJsonSchema()
    };

    let res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
    });

    if (!res.ok) {
        const firstErrText = await res.text().catch(() => "");
        if (shouldFallbackWithoutSchema(res.status, firstErrText)) {
            const fallbackBody = {
                model,
                messages,
                stream,
                temperature,
                max_tokens: maxTokens
            };

            res = await fetch(endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(fallbackBody),
                signal
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
            }

            if (stream) {
                return await consumeStreamResponse(res, onProgress);
            }

            const json = await res.json();
            const content = json?.choices?.[0]?.message?.content || "";
            return String(content || "");
        }

        throw new Error(`HTTP ${res.status}: ${firstErrText.slice(0, 200)}`);
    }

    if (stream) {
        return await consumeStreamResponse(res, onProgress);
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content || "";
    return String(content || "");
}

async function consumeStreamResponse(res, onProgress) {
    if (!res.body) throw new Error("Stream Empty Body: 响应体为空");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let aggregated = "";

    const processSseLine = (rawLine) => {
        const line = String(rawLine || "").trim();
        if (!line || !line.startsWith("data:")) return;

        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;

        try {
            const json = JSON.parse(data);
            const chunk = json?.choices?.[0]?.delta?.content
                || json?.choices?.[0]?.message?.content
                || "";
            if (!chunk) return;
            aggregated += chunk;
            if (onProgress) onProgress(chunk, aggregated);
        } catch {
            // ignore malformed stream chunk
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        while (true) {
            const idx = buffer.indexOf("\n");
            if (idx < 0) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            processSseLine(line);
        }
    }

    // 某些服务端最后一个 SSE 包不会以换行结束，需手动处理残留缓冲区
    if (buffer) {
        const tailLines = buffer.split(/\r?\n/);
        tailLines.forEach((line) => processSseLine(line));
    }

    if (!aggregated.trim()) {
        throw new Error("流式返回为空");
    }
    return aggregated;
}

function normalizeRewriteResponseShape(parsed, payload) {
    const input = parsed && typeof parsed === "object" ? parsed : {};
    const taskId = String(
        input.task_id || input.taskId || payload?.task_id || `rewrite_${Date.now()}`
    ).trim();

    const list = (() => {
        if (Array.isArray(input.results)) return input.results;
        if (Array.isArray(input.data)) return input.data;
        if (Array.isArray(input.items)) return input.items;
        if (Array.isArray(input.rewrites)) return input.rewrites;
        if (Array.isArray(input.output)) return input.output;
        if (Array.isArray(input.result)) return input.result;
        if (input.result && Array.isArray(input.result.results)) return input.result.results;
        if (Array.isArray(input)) return input;
        return [];
    })();

    const results = list.map((row, idx) => {
        const segmentId = String(
            row?.segment_id || row?.segmentId || row?.target_id || row?.targetId || row?.id || ""
        ).trim() || String(payload?.targets?.[idx]?.segment_id || "");
        const rewrittenText = String(
            row?.rewritten_text || row?.rewrittenText || row?.rewrite || row?.text || row?.content || ""
        );
        return { segment_id: segmentId, rewritten_text: rewrittenText };
    });

    return {
        task_id: taskId,
        results
    };
}

function buildDiffRowsFromResults(evaluated, payload, parsed) {
    const rewrittenMap = new Map(parsed.results.map(r => [String(r.segment_id), String(r.rewritten_text || "")]));
    const targetMap = new Map(payload.targets.map(t => [t.segment_id, t]));

    return evaluated.unitResults
        .filter(u => u.hit)
        .map((u) => {
            const segmentId = `s_${u.unitIndex}`;
            const target = targetMap.get(segmentId);
            const after = rewrittenMap.get(segmentId) || u.text;
            const categoryNames = Array.isArray(u.matchedCategories)
                ? u.matchedCategories.map(c => c.categoryName).join(" | ")
                : "";
            return {
                before: u.text,
                after,
                ruleHint: categoryNames,
                action: "rewrite"
            };
        });
}

async function executeRewriteRequest({ data, latest, evaluated, request, rewriteCount, hitCategoryCount = 0, source = "manual", buttonSelector = "#t-rewrite-trigger", promptState = null }) {
    const apiUrl = String(data.api_url || "").trim();
    const apiKey = String(data.api_key || "").trim();
    const model = String(data.model || "").trim();

    if (!apiUrl) {
        setStatus("请先填写 API 地址", "warn");
        return false;
    }
    if (!model) {
        setStatus("请先选择模型", "warn");
        return false;
    }

    const maxTokens = estimateMaxTokens(request);
    const $btn = $(buttonSelector);
    const streamLive = data.stream_live === true;
    let success = false;
    $btn.prop("disabled", true);
    updateAbortBtnState(true);
    const abortController = new AbortController();
    activeRewriteAbortController = abortController;
    setRawResponse("");
    setRawMeta(streamLive ? `实时响应：流式开启（${source}）` : `实时响应：非流式（${source}）`);

    try {
        let parsed = { task_id: request.task_id, results: [] };

        setStatus(`正在请求改写（改写 ${rewriteCount} 条${hitCategoryCount ? `，命中 ${hitCategoryCount} 个分类` : ""}）...`, "muted");
        const messages = buildRewriteMessages(request, promptState || getRewritePromptState());
        let raw = await requestRewriteWithOptions(apiUrl, apiKey, model, messages, maxTokens, {
            temperature: REWRITE_TEMPERATURE,
            stream: streamLive,
            signal: abortController.signal,
            onProgress: (_chunk, all) => {
                if (streamLive) {
                    setRawResponse(all);
                }
            }
        });
        pushLiveResponseHistory({ source, phase: "主请求", model, stream: streamLive, text: raw });
        if (!streamLive) setRawResponse(raw);

        try {
            parsed = normalizeRewriteResponseShape(parseRewriteJson(raw), request);
        } catch (e) {
            const fixMessages = buildFixJsonMessages(raw, request);
            raw = await requestRewriteWithOptions(apiUrl, apiKey, model, fixMessages, maxTokens, {
                temperature: REWRITE_FIX_TEMPERATURE
            });
            pushLiveResponseHistory({ source, phase: "修复请求", model, stream: false, text: raw });
            parsed = normalizeRewriteResponseShape(parseRewriteJson(raw), request);
        }

        let valid = validateRewriteResponse(parsed, request);
        if (!valid.ok) {
            const fixMessages = buildFixJsonMessages(raw, request);
            setRawMeta("实时响应：修复请求（非流式）");
            const fixedRaw = await requestRewriteWithOptions(apiUrl, apiKey, model, fixMessages, maxTokens, {
                temperature: REWRITE_FIX_TEMPERATURE
            });
            pushLiveResponseHistory({ source, phase: "修复请求", model, stream: false, text: fixedRaw });
            setRawResponse(fixedRaw);
            parsed = normalizeRewriteResponseShape(parseRewriteJson(fixedRaw), request);
            valid = validateRewriteResponse(parsed, request);
            if (!valid.ok) throw new Error(`返回校验失败: ${valid.reason}`);
        }

        const rows = buildDiffRowsFromResults(evaluated, request, parsed);
        renderDiffRows(rows);
        const rewriteMarks = buildRewriteMarksFromRows(rows);

        const applied = applyRewriteToFullText(latest.content, evaluated, parsed, request);
        writeBackMessageContent(latest.msg, applied.text);
        if (!latest.msg.extra || typeof latest.msg.extra !== "object") latest.msg.extra = {};
        latest.msg.extra.titania_rewrite_done = true;
        latest.msg.extra.titania_rewrite_marks = rewriteMarks;
        await saveChatConditional();
        await reloadCurrentChat();
        scheduleApplyAllRewriteMarks(180);

        setStatus(`执行完成：改写 ${rewriteCount} 条，已回写第 ${latest.index + 1} 楼`, "ok");
        success = true;
    } catch (e) {
        renderDiffRows([]);
        if (e?.name === "AbortError") {
            setStatus("改写已手动终止", "warn");
        } else {
            setStatus(`改写失败: ${e.message}`, "err");
            if (source !== "auto" && window.toastr) toastr.error(e.message || "改写失败", "文本改写");
        }
    } finally {
        activeRewriteAbortController = null;
        $btn.prop("disabled", false);
        updateAbortBtnState(false);
    }

    return success;
}

async function runRewrite(options = {}) {
    persistPanelState();
    const data = ensureRewriteDataShape();

    const scheme = getActiveScheme();
    if (!scheme) {
        setStatus("请先在设置中创建并保存改写方案", "warn");
        if (window.toastr) toastr.warning("请先在设置中创建并保存改写方案", "Titania 改写");
        return;
    }

    const latest = getLatestAssistantMessageFromChat();
    if (!latest) {
        setStatus("未找到可改写的最新回复楼层", "warn");
        return;
    }

    const { evaluated, request, hitCategoryCount } = buildRewritePayload(data, latest.content);
    renderMatchResult(evaluated, latest.content);

    if (!String(latest.content || "").trim()) {
        setStatus("最新楼层内容为空，无法改写", "warn");
        return;
    }
    const rewriteTargets = Array.isArray(request.targets) ? request.targets : [];
    const rewriteCount = rewriteTargets.length;

    if (rewriteCount === 0) {
        setStatus("没有命中任何分类规则的文本单元，未执行改写", "warn");
        renderDiffRows([]);
        return;
    }

    return executeRewriteRequest({
        data,
        latest,
        evaluated,
        request,
        rewriteCount,
        hitCategoryCount,
        source: options.source || "manual",
        buttonSelector: "#t-rewrite-trigger"
    });
}

async function runSelectedSentenceRewrite() {
    persistPanelState();
    const data = ensureRewriteDataShape();
    const latest = getLatestAssistantMessageFromChat();
    if (latest) {
        latestSentenceUnits = buildSentenceUnitsFromLatest(latest);
    }

    if (!latest) {
        setStatus("未找到可改写的最新回复楼层", "warn");
        return;
    }
    if (!String(latest.content || "").trim()) {
        setStatus("最新楼层内容为空，无法改写", "warn");
        return;
    }

    const selected = getSelectedSentenceIdSet();
    if (selected.size === 0) {
        setStatus("请先选择要改写的句子", "warn");
        return;
    }

    const { evaluated, request, hitCategoryCount } = buildSelectedSentencePayload(latest, selected);
    const rewriteCount = request.targets.length;
    renderMatchResult(evaluated, latest.content);

    if (rewriteCount === 0) {
        setStatus("选择的句子已不在最新楼层中，请刷新后重选", "warn");
        renderDiffRows([]);
        return;
    }

    const success = await executeRewriteRequest({
        data,
        latest,
        evaluated,
        request,
        rewriteCount,
        hitCategoryCount,
        source: "selected",
        buttonSelector: ".t-rewrite-inline-confirm",
        promptState: getSelectedRewritePromptState()
    });

    if (success) {
        clearInlineSentenceSelection();
        refreshInlineRewriteEntry();
    }
    return success;
}

async function runManualRewrite() {
    return runRewrite({ source: "manual" });
}

async function onAutoTriggerRewrite() {
    const data = ensureRewriteDataShape();
    if (!data.auto_trigger) return;
    if (!isEnabled()) return;
    if (isAutoRewriting) return;
    if (activeRewriteAbortController) return;
    if (!getActiveScheme()) return;

    const latest = getLatestAssistantMessageFromChat();
    if (!latest || !latest.msg) return;
    if (!latest.msg.extra || typeof latest.msg.extra !== "object") latest.msg.extra = {};
    if (latest.msg.extra.titania_rewrite_done === true) return;

    const { evaluated } = buildRewritePayload(data, latest.content);
    if (!evaluated || evaluated.hitCount <= 0) return;

    if (autoRewriteTimer) {
        clearTimeout(autoRewriteTimer);
        autoRewriteTimer = null;
    }

    const targetIndex = latest.index;
    autoRewriteTimer = setTimeout(async () => {
        autoRewriteTimer = null;

        const freshData = ensureRewriteDataShape();
        if (!freshData.auto_trigger) return;
        if (!isEnabled()) return;
        if (isAutoRewriting) return;
        if (activeRewriteAbortController) return;

        const freshLatest = getLatestAssistantMessageFromChat();
        if (!freshLatest || !freshLatest.msg) return;
        if (freshLatest.index !== targetIndex) return;
        if (!freshLatest.msg.extra || typeof freshLatest.msg.extra !== "object") freshLatest.msg.extra = {};
        if (freshLatest.msg.extra.titania_rewrite_done === true) return;

        const freshEval = buildRewritePayload(freshData, freshLatest.content);
        if (!freshEval?.evaluated || freshEval.evaluated.hitCount <= 0) return;

        try {
            isAutoRewriting = true;
            applyAutoRewriteIndicator(freshLatest.index);
            if (window.toastr) toastr.info(`检测到命中规则，${AUTO_REWRITE_DELAY_MS / 1000} 秒后自动改写...`, "文本改写");
            const ok = await runRewrite({ source: "auto" });
            if (ok) {
                if (window.toastr) toastr.success("自动改写完成，已回写当前回复", "文本改写");
            } else {
                if (window.toastr) toastr.error("自动改写失败，已保留原文", "文本改写");
            }
        } finally {
            clearAutoRewriteIndicator();
            isAutoRewriting = false;
        }
    }, AUTO_REWRITE_DELAY_MS);
}

function bindAutoTriggerEvents() {
    if (autoTriggerBound) return;
    autoTriggerBound = true;

    // 自动改写只在生成结束后触发，避免流式生成尚未完成时读取到半截内容
    eventSource.on(event_types.GENERATION_ENDED, onAutoTriggerRewrite);
}

function readCategoriesFromDom() {
    const categories = [];
    $("#t-rewrite-scheme-categories-list .t-rewrite-category-card").each((_, el) => {
        const $card = $(el);
        const id = String($card.attr("data-cat-id") || "");
        const name = String($card.find(".t-rewrite-cat-name").val() || "").trim();
        const bad_example = String($card.find(".t-rewrite-cat-bad").val() || "").trim();
        const good_example = String($card.find(".t-rewrite-cat-good").val() || "").trim();
        const guidance = String($card.find(".t-rewrite-cat-guidance").val() || "").trim();
        const rules = [];
        $card.find(".t-rewrite-kw-row").each((_, kwEl) => {
            const anchor = String($(kwEl).find(".t-rewrite-kw-anchor").val() || "").trim();
            const extras = String($(kwEl).find(".t-rewrite-kw-extras").val() || "").trim();
            if (anchor && extras) rules.push({ anchor, extras });
        });
        categories.push({ id: id || generateId("cat"), name, bad_example, good_example, guidance, rules });
    });
    return categories.filter(c => c.name);
}

function renderSchemeCategoriesList(scheme) {
    const $box = $("#t-rewrite-scheme-categories-list");
    if (!$box.length) return;

    const categories = (scheme && Array.isArray(scheme.categories)) ? scheme.categories : [];

    if (categories.length === 0) {
        $box.html('<div class="t-rewrite-empty-rule">暂无分类，点击"添加分类"开始</div>');
        return;
    }

    const html = categories.map((cat, idx) => {
        const rules = Array.isArray(cat.rules) ? cat.rules : [];
        const hasContent = String(cat.name || "").trim() || String(cat.bad_example || "").trim() || String(cat.good_example || "").trim() || String(cat.guidance || "").trim() || rules.length > 0;
        const kwRows = rules.length > 0
            ? rules.map(r => `
                <div class="t-rewrite-kw-row">
                    <input class="text_pole t-rewrite-kw-anchor" type="text" value="${escapeHtml(r.anchor || "")}" placeholder="主词（逗号分隔，任一命中）">
                    <span class="t-rewrite-kw-and">与</span>
                    <input class="text_pole t-rewrite-kw-extras" type="text" value="${escapeHtml(r.extras || "")}" placeholder="附加词（逗号分隔，任一命中）">
                    <button class="t-btn t-rewrite-kw-del" type="button" title="删除此关键词规则"><i class="fa-solid fa-xmark"></i></button>
                </div>
            `).join("")
            : `<div class="t-rewrite-kw-row">
                <input class="text_pole t-rewrite-kw-anchor" type="text" value="" placeholder="主词（逗号分隔，任一命中）">
                <span class="t-rewrite-kw-and">与</span>
                <input class="text_pole t-rewrite-kw-extras" type="text" value="" placeholder="附加词（逗号分隔，任一命中）">
                <button class="t-btn t-rewrite-kw-del" type="button" title="删除"><i class="fa-solid fa-xmark"></i></button>
            </div>`;

        const nameMissing = !String(cat.name || "").trim();
        const collapsedClass = hasContent ? " collapsed" : "";
        const emptyClass = !hasContent ? " t-rewrite-cat-empty" : "";
        const statusLine = nameMissing
            ? '<span class="t-rewrite-cat-status-warn">未命名</span>'
            : `<span class="t-rewrite-cat-status-ok">${rules.length} 条规则</span>`;

        return `
            <div class="t-rewrite-category-card${emptyClass}${collapsedClass}" data-cat-idx="${idx}" data-cat-id="${escapeHtml(cat.id || "")}">
                <div class="t-rewrite-cat-head t-rewrite-cat-toggle">
                    <span class="t-rewrite-cat-caret"><i class="fa-solid fa-chevron-down"></i></span>
                    <span class="t-rewrite-cat-num">#${idx + 1}</span>
                    <span class="t-rewrite-cat-name-display">${escapeHtml(cat.name || "未命名分类")}</span>
                    <span class="t-rewrite-cat-head-status">${statusLine}</span>
                    <button class="t-btn t-rewrite-cat-del" type="button" title="删除此分类"><i class="fa-solid fa-trash"></i></button>
                </div>
                <div class="t-rewrite-cat-body">
                    <div class="t-rewrite-cat-name-row">
                        <label>分类名称</label>
                        <input class="text_pole t-rewrite-cat-name" type="text" value="${escapeHtml(cat.name || "")}" placeholder="必填，不可与同方案其他分类重名">
                        ${nameMissing ? '<span class="t-rewrite-cat-name-warn">（必填）</span>' : ''}
                    </div>
                    <div class="t-rewrite-cat-field">
                        <label>差句示例</label>
                        <textarea class="text_pole t-rewrite-cat-bad" rows="2" placeholder="输入一段不理想的写法示例">${escapeHtml(cat.bad_example || "")}</textarea>
                    </div>
                    <div class="t-rewrite-cat-field">
                        <label>优秀示例</label>
                        <textarea class="text_pole t-rewrite-cat-good" rows="2" placeholder="输入一段优秀的写法示例">${escapeHtml(cat.good_example || "")}</textarea>
                    </div>
                    <div class="t-rewrite-cat-field">
                        <label>改写指导</label>
                        <textarea class="text_pole t-rewrite-cat-guidance" rows="2" placeholder="告诉模型具体怎么改">${escapeHtml(cat.guidance || "")}</textarea>
                    </div>
                    <div class="t-rewrite-cat-field">
                        <label>关键词规则<span class="t-rewrite-cat-field-hint">（主词 AND 附加词同时命中才生效，命中任一行即归类）</span></label>
                        <div class="t-rewrite-cat-kw-list">${kwRows}</div>
                        <button class="t-btn t-rewrite-cat-add-kw" type="button"><i class="fa-solid fa-plus"></i> 添加关键词</button>
                    </div>
                </div>
            </div>
        `;
    }).join("");

    $box.html(html);
}

function renderRules(rows) {
    // kept for API compatibility， 主面板不再渲染规则列表
}

function renderSettingsRules(rows) {
    // kept for API compatibility， 设置面板使用 renderSchemeCategoriesList
}

function getRulesFromDom(containerSelector) {
    // kept for API compatibility， 使用 readCategoriesFromDom 替代
    return [];
}

function persistPanelState() {
    const $overlay = getOverlay();
    if (!$overlay.length) return;

    const data = getExtData();
    const prev = ensureRewriteDataShape();

    const readValue = (selector, fallback = "") => {
        const $el = $overlay.find(selector);
        return $el.length > 0 ? String($el.val() || "").trim() : fallback;
    };

    const readChecked = (selector, fallback = false) => {
        const $el = $overlay.find(selector);
        return $el.length > 0 ? ($el.prop("checked") === true) : fallback;
    };

    data.rewrite_entry = {
        enabled: prev.enabled === true,
        profile_mode: prev.profile_mode || "custom",
        profile_id: prev.profile_id || "",
        custom_profiles: normalizeRewriteCustomProfiles(prev.custom_profiles, prev),
        api_url: readValue("#t-rewrite-api-url", prev.api_url || ""),
        api_key: readValue("#t-rewrite-api-key", prev.api_key || ""),
        model: readValue("#t-rewrite-model", prev.model || ""),
        split_mode: readValue("input[name='t-rewrite-split-mode']:checked", prev.split_mode || "sentence"),
        active_scheme_id: prev.active_scheme_id || "",
        schemes: prev.schemes || [],
        stream_live: readChecked("#t-rewrite-stream-live", prev.stream_live === true),
        auto_trigger: prev.auto_trigger === true,
        selected_sentence_enabled: prev.selected_sentence_enabled !== false,
        tag_whitelist: prev.tag_whitelist || "",
        prompt_system: prev.prompt_system || REWRITE_DEFAULT_PROMPT_SYSTEM,
        prompt_user: prev.prompt_user || REWRITE_DEFAULT_PROMPT_USER,
        selected_prompt_system: prev.selected_prompt_system || REWRITE_DEFAULT_SELECTED_PROMPT_SYSTEM,
        selected_prompt_user: prev.selected_prompt_user || REWRITE_DEFAULT_SELECTED_PROMPT_USER,
        prompt_json_rule: prev.prompt_json_rule || REWRITE_DEFAULT_PROMPT_JSON_RULE
    };

    saveExtData();
    const categories = getActiveSchemeCategories();
    $("#t-rewrite-rule-count").text(String(categories.length));
}

function persistSettingsPanelState() {
    const $overlay = getSettingsOverlay();
    if (!$overlay.length) return;

    const data = getExtData();
    const prev = ensureRewriteDataShape();
    const rawProfileId = String($overlay.find("#t-rewrite-settings-profile-select").val() || prev.profile_id || "").trim();
    const customProfilesRaw = $overlay.data("rewriteCustomProfiles");
    const customProfiles = normalizeRewriteCustomProfiles(Array.isArray(customProfilesRaw) ? customProfilesRaw : prev.custom_profiles, prev);

    let profileId = rawProfileId || customProfiles[0]?.id || "";
    const current = customProfiles.find((p) => p.id === profileId);
    if (current) {
        current.api_url = String($overlay.find("#t-rewrite-settings-api-url").val() || "").trim();
        current.api_key = String($overlay.find("#t-rewrite-settings-api-key").val() || "").trim();
        current.model = String($overlay.find("#t-rewrite-settings-model").val() || "").trim();
        profileId = current.id;
    }

    const activeSchemeId = String($overlay.find("#t-rewrite-scheme-select").val() || prev.active_scheme_id || "").trim();
    const rulePromptParsed = parseCombinedPromptText(
        String($overlay.find("#t-rewrite-settings-prompt-combined").val() || ""),
        getRewritePromptState()
    );
    const selectedPromptParsed = parseCombinedPromptText(
        String($overlay.find("#t-rewrite-settings-selected-prompt-combined").val() || ""),
        getSelectedRewritePromptState()
    );

    data.rewrite_entry = {
        enabled: prev.enabled === true,
        profile_mode: "custom",
        profile_id: profileId,
        custom_profiles: customProfiles,
        api_url: String($overlay.find("#t-rewrite-settings-api-url").val() || "").trim(),
        api_key: String($overlay.find("#t-rewrite-settings-api-key").val() || "").trim(),
        model: String($overlay.find("#t-rewrite-settings-model").val() || "").trim(),
        split_mode: String($overlay.find("input[name='t-rewrite-settings-split-mode']:checked").val() || "sentence"),
        active_scheme_id: activeSchemeId,
        schemes: prev.schemes || [],
        stream_live: $overlay.find("#t-rewrite-settings-stream-live").prop("checked") === true,
        auto_trigger: $overlay.find("#t-rewrite-settings-auto-trigger").prop("checked") === true,
        selected_sentence_enabled: $overlay.find("#t-rewrite-settings-selected-sentence-enabled").prop("checked") === true,
        tag_whitelist: String($overlay.find("#t-rewrite-settings-tag-whitelist").val() || "").trim(),
        prompt_system: rulePromptParsed.prompt_system,
        prompt_user: rulePromptParsed.prompt_user,
        selected_prompt_system: selectedPromptParsed.prompt_system,
        selected_prompt_user: selectedPromptParsed.prompt_user,
        prompt_json_rule: String(prev.prompt_json_rule || REWRITE_DEFAULT_PROMPT_JSON_RULE)
    };

    saveExtData();
    refreshRuntimeStateView();
}

function refreshRuntimeStateView() {
    const $overlay = getOverlay();
    if (!$overlay.length) return;

    const data = ensureRewriteDataShape();
    const scheme = getActiveScheme();
    const categories = getActiveSchemeCategories();

    $overlay.find("#t-rewrite-runtime-model").text(data.model || "未设置");
    $overlay.find("#t-rewrite-runtime-split").text(data.split_mode === "paragraph" ? "按段落" : "按句子");
    $overlay.find("#t-rewrite-runtime-scheme").text(scheme ? scheme.name : "无方案");
    $overlay.find("#t-rewrite-rule-count").text(String(categories.length));
    $overlay.find("#t-rewrite-runtime-stream").text(data.stream_live === false ? "关闭" : "开启");
    $overlay.find("#t-rewrite-runtime-auto").text(data.auto_trigger ? "开启" : "关闭");
    $overlay.find("#t-rewrite-runtime-whitelist").text(data.tag_whitelist || "未设置（全文）");
}

function renderMatchResult(result, sourceText = "") {
    const normalizedSource = String(sourceText || "");
    const hasUnits = !!(result && Array.isArray(result.unitResults) && result.unitResults.length > 0);
    lastMatchResult = hasUnits ? result : null;
    lastMatchSourceText = hasUnits ? normalizedSource : "";

    const $body = $("#t-rewrite-match-body");
    if (!$body.length) return;

    if (!lastMatchResult || !Array.isArray(lastMatchResult.unitResults) || lastMatchResult.unitResults.length === 0) {
        $body.html('<div class="t-rewrite-diff-empty">等待执行改写后展示命中结果</div>');
        return;
    }

    const html = lastMatchResult.unitResults.map((item) => {
        const cls = item.hit ? "hit" : "miss";
        const tag = lastMatchResult.splitMode === "paragraph" ? "段" : "句";
        const tags = item.hit
            ? (Array.isArray(item.matchedCategories) && item.matchedCategories.length > 0
                ? item.matchedCategories.map((c) => {
                    const keywords = c.matchedRules.map(r => `${r.anchor} + ${r.extras}`).join(" | ");
                    return `<span class="t-rewrite-hit-tag">【${escapeHtml(c.categoryName)}】${escapeHtml(keywords)}</span>`;
                }).join("")
                : "<span class=\"t-rewrite-hit-tag\">用户选中</span>")
            : (lastMatchResult.sourceMode === "selected"
                ? "<span class=\"t-rewrite-hit-tag miss\">未选中</span>"
                : "<span class=\"t-rewrite-hit-tag miss\">未命中</span>");

        return `
            <div class="t-rewrite-match-row ${cls}">
                <div class="t-rewrite-match-head">
                    <div>${tag} #${item.unitIndex}</div>
                    <div class="t-rewrite-match-tags">${tags}</div>
                </div>
                <div class="t-rewrite-match-text">${escapeHtml(item.text)}</div>
            </div>
        `;
    }).join("");

    const header = `<div class="t-rewrite-hit-summary">切分 ${lastMatchResult.unitCount} 个单元，命中 ${lastMatchResult.hitCount} 个</div>`;
    const src = lastMatchSourceText ? `<div class="t-rewrite-hit-source">来源：最新回复楼层（长度 ${lastMatchSourceText.length}）</div>` : "";
    $body.html(`${header}${src}${html}`);
}

function renderPersistedRewriteViews() {
    renderMatchResult(lastMatchResult, lastMatchSourceText);
    renderDiffRows(lastDiffRows);
}

function bindPanelEvents() {
    const $overlay = getOverlay();
    if (!$overlay.length) return;

    $overlay.on("click", "#t-rewrite-close", (e) => {
        e.preventDefault();
        closePanel();
    });

    $overlay.on("click", "#t-rewrite-trigger", () => {
        runManualRewrite();
    });

    $overlay.on("click", "#t-rewrite-open-settings", (e) => {
        e.preventDefault();
        openSettingsPanel();
    });

    $overlay.on("click", "#t-rewrite-open-live", (e) => {
        e.preventDefault();
        openLivePanel();
    });

    $overlay.on("click", "#t-rewrite-runtime-toggle", (e) => {
        e.preventDefault();
        runtimeCollapsed = !runtimeCollapsed;
        syncRuntimeCollapseUi();
    });
}

function bindLivePanelEvents() {
    const $overlay = getLiveOverlay();
    if (!$overlay.length) return;

    $overlay.on("click", "#t-rewrite-live-close", (e) => {
        e.preventDefault();
        closeLivePanel();
    });

    $overlay.on("click", "#t-rewrite-abort", (e) => {
        e.preventDefault();
        if (activeRewriteAbortController) {
            activeRewriteAbortController.abort();
        }
    });

    $overlay.on("click", ".t-rewrite-live-history-item", (e) => {
        e.preventDefault();
        const id = String($(e.currentTarget).attr("data-history-id") || "").trim();
        if (!id) return;
        const item = liveResponseHistory.find((x) => x.id === id);
        if (!item) return;
        setRawResponse(item.text);
        setRawMeta(`历史记录：${formatHistoryTime(item.at)} · ${item.source} · ${item.phase}`);
    });
}

function openLivePanel() {
    closeLivePanel();

    const html = `
    <div id="${LIVE_OVERLAY_ID}" class="t-overlay t-root" aria-modal="true" role="dialog">
        <div class="t-window t-rewrite-live-window">
            <div class="t-window-header t-rewrite-head">
                <div class="t-window-title t-rewrite-title"><i class="fa-solid fa-wave-square"></i> 实时响应</div>
                <div class="t-window-controls">
                    <div class="t-window-close" id="t-rewrite-live-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>
            <div class="t-window-body t-rewrite-live-body">
                <div class="t-rewrite-live-stream-card">
                    <div class="t-rewrite-live-tools">
                        <div id="t-rewrite-raw-meta" class="t-rewrite-status muted">${escapeHtml(lastRawMetaText || "等待请求")}</div>
                        <button id="t-rewrite-abort" class="t-btn" type="button" ${activeRewriteAbortController ? "" : "disabled"}>终止</button>
                    </div>
                    <div class="t-rewrite-live-stream-title">模型实时返回</div>
                    <div class="t-rewrite-live-meta">展示最近一次改写请求的实时返回内容（支持流式滚动）。</div>
                    <pre id="t-rewrite-raw-response" class="t-rewrite-json-box">${escapeHtml(lastRawResponseText || "")}</pre>
                </div>
                <div class="t-rewrite-live-history-card">
                    <div class="t-rewrite-live-history-title">历史记录</div>
                    <div class="t-rewrite-live-history-meta">记录最近 20 条实时请求模型返回内容，点击可回看。</div>
                    <div id="t-rewrite-live-history-list" class="t-rewrite-live-history-list"></div>
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    bindLivePanelEvents();
    renderLiveHistory();
}

function bindSettingsPanelEvents(connectionEditor = null) {
    const $overlay = getSettingsOverlay();
    if (!$overlay.length) return;

    $overlay.on("click", ".t-set-tab-btn", function () {
        const tab = String($(this).data("tab") || "api");
        $overlay.find(".t-set-tab-btn").removeClass("active");
        $(this).addClass("active");
        $overlay.find(".t-set-page").removeClass("active");
        $overlay.find(`#t-rewrite-page-${tab}`).addClass("active");
    });

    $overlay.on("click", "#t-rewrite-settings-close", (e) => {
        e.preventDefault();
        closeSettingsPanel();
    });

    $overlay.on("click", "#t-rewrite-settings-save", (e) => {
        e.preventDefault();
        if (connectionEditor) {
            const nextState = connectionEditor.getState();
            $overlay.data("rewriteCustomProfiles", mapConnectionProfilesToCustomProfiles(nextState.profiles, "gpt-3.5-turbo"));
            $overlay.find("#t-rewrite-settings-profile-select").val(nextState.activeProfileId);
        }
        saveCurrentSchemeFromDom();
        persistSettingsPanelState();
        if (window.toastr) toastr.success("设置与方案已保存", "文本改写");
    });

    $overlay.on("input", "#t-rewrite-settings-prompt-combined, #t-rewrite-settings-selected-prompt-combined", () => {
        persistPromptStateFromSettings();
    });

    $overlay.on("click", "#t-rewrite-settings-prompt-reset", (e) => {
        e.preventDefault();
        $overlay.find("#t-rewrite-settings-prompt-combined").val(
            buildCombinedPromptText(REWRITE_DEFAULT_PROMPT_SYSTEM, REWRITE_DEFAULT_PROMPT_USER)
        );
        const data = getExtData();
        const prev = ensureRewriteDataShape();
        data.rewrite_entry = {
            ...prev,
            prompt_system: REWRITE_DEFAULT_PROMPT_SYSTEM,
            prompt_user: REWRITE_DEFAULT_PROMPT_USER,
            prompt_json_rule: REWRITE_DEFAULT_PROMPT_JSON_RULE
        };
        saveExtData();
        persistPromptStateFromSettings();
        if (window.toastr) toastr.success("规则提示词已恢复默认", "文本改写");
    });

    $overlay.on("click", "#t-rewrite-settings-selected-prompt-reset", (e) => {
        e.preventDefault();
        $overlay.find("#t-rewrite-settings-selected-prompt-combined").val(
            buildCombinedPromptText(REWRITE_DEFAULT_SELECTED_PROMPT_SYSTEM, REWRITE_DEFAULT_SELECTED_PROMPT_USER)
        );
        const data = getExtData();
        const prev = ensureRewriteDataShape();
        data.rewrite_entry = {
            ...prev,
            selected_prompt_system: REWRITE_DEFAULT_SELECTED_PROMPT_SYSTEM,
            selected_prompt_user: REWRITE_DEFAULT_SELECTED_PROMPT_USER,
            prompt_json_rule: REWRITE_DEFAULT_PROMPT_JSON_RULE
        };
        saveExtData();
        persistPromptStateFromSettings();
        if (window.toastr) toastr.success("选句提示词已恢复默认", "文本改写");
    });

    $overlay.on("click", "#t-rewrite-scheme-new", (e) => {
        e.preventDefault();
        const name = (window.prompt && window.prompt("请输入新方案名称：", "")) || "";
        if (!name.trim()) return;
        const data = getExtData();
        const prev = ensureRewriteDataShape();
        const schemes = [...(prev.schemes || [])];
        if (schemes.some(s => s.name === name.trim())) {
            if (window.toastr) toastr.warning("方案名称已存在", "文本改写");
            return;
        }
        const newScheme = { id: generateId("scheme"), name: name.trim(), categories: [] };
        schemes.push(newScheme);
        data.rewrite_entry = { ...prev, schemes, active_scheme_id: newScheme.id };
        saveExtData();
        refreshSettingsSchemeUI();
        if (window.toastr) toastr.success(`已创建方案「${name}」`, "文本改写");
    });

    $overlay.on("click", "#t-rewrite-scheme-rename", (e) => {
        e.preventDefault();
        const scheme = getActiveSchemeFromSettings();
        if (!scheme) { if (window.toastr) toastr.warning("请先选择方案", "文本改写"); return; }
        const name = (window.prompt && window.prompt("请输入新名称：", scheme.name)) || "";
        if (!name.trim()) return;
        const data = getExtData();
        const prev = ensureRewriteDataShape();
        const schemes = (prev.schemes || []).map(s => s.id === scheme.id ? { ...s, name: name.trim() } : s);
        data.rewrite_entry = { ...prev, schemes };
        saveExtData();
        refreshSettingsSchemeUI();
        if (window.toastr) toastr.success("方案已重命名", "文本改写");
    });

    $overlay.on("click", "#t-rewrite-scheme-delete", (e) => {
        e.preventDefault();
        const scheme = getActiveSchemeFromSettings();
        if (!scheme) { if (window.toastr) toastr.warning("请先选择方案", "文本改写"); return; }
        if (!window.confirm(`确定删除方案「${scheme.name}」吗？此操作不可撤销。`)) return;
        const data = getExtData();
        const prev = ensureRewriteDataShape();
        const schemes = (prev.schemes || []).filter(s => s.id !== scheme.id);
        const newActiveId = schemes.length > 0 ? schemes[0].id : "";
        data.rewrite_entry = { ...prev, schemes, active_scheme_id: newActiveId };
        saveExtData();
        refreshSettingsSchemeUI();
        if (window.toastr) toastr.success("方案已删除", "文本改写");
    });

    $overlay.on("change", "#t-rewrite-scheme-select", () => {
        const data = getExtData();
        const prev = ensureRewriteDataShape();
        const newId = String($overlay.find("#t-rewrite-scheme-select").val() || "").trim();
        data.rewrite_entry = { ...prev, active_scheme_id: newId };
        saveExtData();
        const schemes = prev.schemes || [];
        const scheme = schemes.find(s => s.id === newId) || null;
        renderSchemeCategoriesList(scheme);
        const $status = $overlay.find("#t-rewrite-scheme-status");
        if ($status.length) $status.text(scheme ? `激活方案「${escapeHtml(scheme.name)}」` : '无方案，请新建或选择已有方案');
    });

    $overlay.on("click", "#t-rewrite-scheme-add-category", (e) => {
        e.preventDefault();
        const scheme = getActiveSchemeFromSettings();
        if (!scheme) { if (window.toastr) toastr.warning("请先创建方案", "文本改写"); return; }
        const newCat = { id: generateId("cat"), name: "", bad_example: "", good_example: "", guidance: "", rules: [{ keywords: "" }] };
        const categories = [...(Array.isArray(scheme.categories) ? scheme.categories : []), newCat];
        renderSchemeCategoriesList({ ...scheme, categories });
    });

    $overlay.on("click", ".t-rewrite-cat-toggle", (e) => {
        if ($(e.target).is("input, textarea, select, button, .t-rewrite-cat-del, .t-rewrite-kw-del")) return;
        const $card = $(e.currentTarget).closest(".t-rewrite-category-card");
        $card.toggleClass("collapsed");
    });

    $overlay.on("click", ".t-rewrite-cat-del", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const scheme = getActiveSchemeFromSettings();
        if (!scheme) return;
        const catIdx = Number($(e.currentTarget).closest(".t-rewrite-category-card").attr("data-cat-idx"));
        const categories = (Array.isArray(scheme.categories) ? scheme.categories : []).filter((_, i) => i !== catIdx);
        renderSchemeCategoriesList({ ...scheme, categories });
    });

    $overlay.on("click", ".t-rewrite-cat-add-kw", (e) => {
        e.preventDefault();
        const $card = $(e.currentTarget).closest(".t-rewrite-category-card");
        const newRow = $(`<div class="t-rewrite-kw-row"><input class="text_pole t-rewrite-kw-anchor" type="text" value="" placeholder="主词（逗号分隔，任一命中）"><span class="t-rewrite-kw-and">与</span><input class="text_pole t-rewrite-kw-extras" type="text" value="" placeholder="附加词（逗号分隔，任一命中）"><button class="t-btn t-rewrite-kw-del" type="button" title="删除"><i class="fa-solid fa-xmark"></i></button></div>`);
        $card.find(".t-rewrite-cat-kw-list").append(newRow);
    });

    $overlay.on("click", ".t-rewrite-kw-del", (e) => {
        e.preventDefault();
        const $row = $(e.currentTarget).closest(".t-rewrite-kw-row");
        const $list = $row.closest(".t-rewrite-cat-kw-list");
        if ($list.find(".t-rewrite-kw-row").length <= 1) {
            $row.find(".t-rewrite-kw-anchor").val("");
            $row.find(".t-rewrite-kw-extras").val("");
            return;
        }
        $row.remove();
    });
}

function getActiveSchemeFromSettings() {
    const data = getExtData();
    ensureRewriteDataShape();
    const schemes = Array.isArray(data.rewrite_entry?.schemes) ? data.rewrite_entry.schemes : [];
    const activeId = String($("#t-rewrite-scheme-select").val() || data.rewrite_entry?.active_scheme_id || "").trim();
    return schemes.find(s => s.id === activeId) || null;
}

function saveCurrentSchemeFromDom() {
    const scheme = getActiveSchemeFromSettings();
    if (!scheme) { if (window.toastr) toastr.warning("请先创建方案", "文本改写"); return; }
    const categories = readCategoriesFromDom();
    const data = getExtData();
    const prev = ensureRewriteDataShape();
    const schemes = (prev.schemes || []).map(s =>
        s.id === scheme.id ? { ...s, categories } : s
    );
    data.rewrite_entry = { ...prev, schemes };
    saveExtData();
}

function refreshSettingsSchemeUI() {
    const data = getExtData();
    ensureRewriteDataShape();
    const schemes = Array.isArray(data.rewrite_entry?.schemes) ? data.rewrite_entry.schemes : [];
    const activeId = data.rewrite_entry?.active_scheme_id || "";
    const scheme = schemes.find(s => s.id === activeId) || null;

    const $select = $("#t-rewrite-scheme-select");
    if ($select.length) {
        $select.html(schemes.map(s => `<option value="${escapeHtml(s.id)}" ${s.id === activeId ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join(""));
    }
    const $status = $("#t-rewrite-scheme-status");
    if ($status.length) $status.text(scheme ? `激活方案「${escapeHtml(scheme.name)}」` : '无方案，请新建或选择已有方案');
    renderSchemeCategoriesList(scheme);
}

function openSettingsPanel() {
    closeSettingsPanel();

    const rewriteData = ensureRewriteDataShape();
    const modeSentence = rewriteData.split_mode !== "paragraph";
    const modeParagraph = rewriteData.split_mode === "paragraph";
    const customProfiles = normalizeRewriteCustomProfiles(rewriteData.custom_profiles, rewriteData);
    let activeProfileId = String(rewriteData.profile_id || "").trim();
    const fallback = customProfiles[0]?.id || "";
    const existing = customProfiles.find((p) => p.id === activeProfileId);
    activeProfileId = existing ? existing.id : fallback;

    const initProfile = customProfiles.find((p) => p.id === activeProfileId) || customProfiles[0];
    const initApiUrl = String(initProfile?.api_url || rewriteData.api_url || "");
    const promptState = getRewritePromptState();
    const selectedPromptState = getSelectedRewritePromptState();
    const schemes = Array.isArray(rewriteData.schemes) ? rewriteData.schemes : [];
    const activeScheme = schemes.find(s => s.id === rewriteData.active_scheme_id) || null;
    const schemeOptions = schemes.map(s => `<option value="${escapeHtml(s.id)}" ${s.id === (activeScheme?.id || "") ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("");

    const html = `
    <div id="${SETTINGS_OVERLAY_ID}" class="t-overlay t-root" aria-modal="true" role="dialog">
        <div class="t-window t-rewrite-settings-window">
            <div class="t-window-header t-rewrite-head">
                <div class="t-window-title t-rewrite-title"><i class="fa-solid fa-sliders"></i> 文本改写设置</div>
                <div class="t-window-controls">
                    <div class="t-window-close" id="t-rewrite-settings-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>

            <div class="t-set-body">
                <div class="t-set-nav">
                    <div class="t-set-tab-btn active" data-tab="api"><i class="fa-solid fa-plug"></i> API 连接</div>
                    <div class="t-set-tab-btn" data-tab="runtime"><i class="fa-solid fa-sliders"></i> 运行设置</div>
                    <div class="t-set-tab-btn" data-tab="prompt"><i class="fa-solid fa-file-lines"></i> 提示词管理</div>
                    <div class="t-set-tab-btn" data-tab="scheme"><i class="fa-solid fa-list-check"></i> 规则方案</div>
                </div>

                <div class="t-set-content">
                    <div id="t-rewrite-page-api" class="t-set-page active">
                        ${renderApiConnectionEditorHTML({
                            ids: {
                                profileSelectId: "t-rewrite-settings-profile-select",
                                profileAddId: "t-rewrite-settings-new-profile",
                                profileDeleteId: "t-rewrite-settings-delete-profile",
                                profileNameId: "t-rewrite-settings-profile-name",
                                profileMetaId: "t-rewrite-settings-profile-meta",
                                profileTipId: "t-rewrite-settings-profile-tip",
                                fieldsWrapId: "t-rewrite-settings-conn-fields",
                                apiUrlId: "t-rewrite-settings-api-url",
                                apiKeyId: "t-rewrite-settings-api-key",
                                modelId: "t-rewrite-settings-model",
                                fetchModelsId: "t-rewrite-settings-fetch-models",
                                statusId: "t-rewrite-settings-status",
                                urlHintId: "t-rewrite-settings-url-hint",
                                stUrlDisplayId: "t-rewrite-settings-st-url",
                            },
                            classes: {
                                input: "text_pole",
                                select: "text_pole",
                                profileSelect: "text_pole",
                                button: "t-btn",
                            },
                            labels: {
                                profile: "API 方案",
                                apiUrl: "API 地址",
                                model: "模型",
                            },
                            flags: {
                                showProfileName: true,
                                showDeleteProfile: true,
                                showStream: false,
                                showMaxTokens: false,
                            },
                            values: {
                                statusText: "填写 API 后会自动请求模型列表",
                            },
                        })}
                    </div>

                    <div id="t-rewrite-page-runtime" class="t-set-page">
                        <div class="t-form-group">
                            <label class="t-form-label">切分模式</label>
                            <div class="t-rewrite-split-options t-rewrite-split-options-vertical">
                                <label><input type="radio" name="t-rewrite-settings-split-mode" value="sentence" ${modeSentence ? "checked" : ""}> 按句子切分</label>
                                <label><input type="radio" name="t-rewrite-settings-split-mode" value="paragraph" ${modeParagraph ? "checked" : ""}> 按段落切分</label>
                            </div>
                            <div class="t-rewrite-rule-guide">匹配只在单个切分单元内完成，不跨句/段。</div>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">请求行为</label>
                            <div class="t-rewrite-debug-row t-rewrite-debug-row-block">
                                <label><input id="t-rewrite-settings-stream-live" type="checkbox" ${rewriteData.stream_live === false ? "" : "checked"}> 启用流式并显示实时响应</label>
                            </div>
                            <div class="t-rewrite-debug-row t-rewrite-debug-row-block">
                                <label><input id="t-rewrite-settings-auto-trigger" type="checkbox" ${rewriteData.auto_trigger ? "checked" : ""}> 自动触发改写（新回复生成后）</label>
                            </div>
                            <div class="t-rewrite-debug-row t-rewrite-debug-row-block">
                                <label><input id="t-rewrite-settings-selected-sentence-enabled" type="checkbox" ${rewriteData.selected_sentence_enabled === false ? "" : "checked"}> 启用楼层内选句改写</label>
                            </div>
                            <div class="t-rewrite-rule-guide">关闭后仅隐藏最新楼层内的“选句改写”入口，不影响按规则改写。</div>
                        </div>

                        <div class="t-form-group">
                            <label class="t-form-label">聊天提取白名单</label>
                            <input id="t-rewrite-settings-tag-whitelist" class="text_pole" type="text" placeholder="例如: content, dialogue, narration" value="${escapeHtml(rewriteData.tag_whitelist || "")}">
                            <div class="t-rewrite-rule-guide">仅提取白名单标签中的文本用于切分和规则匹配；留空则提取全文纯文本。</div>
                        </div>
                    </div>

                    <div id="t-rewrite-page-prompt" class="t-set-page">
                        <div class="t-form-group">
                            <div class="t-rewrite-rule-head">
                                <label class="t-form-label" style="margin-bottom:0;">规则命中提示词</label>
                                <button id="t-rewrite-settings-prompt-reset" class="t-btn" type="button">恢复默认</button>
                            </div>

                            <label class="t-form-label" for="t-rewrite-settings-prompt-combined">规则改写提示词（请保留 [SYS] 和 [USER] 标记）</label>
                            <div class="t-rewrite-rule-guide">影响“按规则改写”和自动改写；[USER] 段支持 {{schema}} / {{payload}}。</div>
                            <textarea id="t-rewrite-settings-prompt-combined" class="text_pole t-rewrite-settings-textarea" placeholder="[SYS]\n...\n\n[USER]\n...">${escapeHtml(buildCombinedPromptText(promptState.prompt_system, promptState.prompt_user))}</textarea>
                        </div>

                        <div class="t-form-group">
                            <div class="t-rewrite-rule-head">
                                <label class="t-form-label" style="margin-bottom:0;">选句改写提示词</label>
                                <button id="t-rewrite-settings-selected-prompt-reset" class="t-btn" type="button">恢复默认</button>
                            </div>

                            <label class="t-form-label" for="t-rewrite-settings-selected-prompt-combined">楼层内手动选句提示词（请保留 [SYS] 和 [USER] 标记）</label>
                            <div class="t-rewrite-rule-guide">这里只影响最新楼层内“选句改写”，不影响规则命中改写；[USER] 段支持 {{schema}} / {{payload}}。</div>
                            <textarea id="t-rewrite-settings-selected-prompt-combined" class="text_pole t-rewrite-settings-textarea" placeholder="[SYS]\n...\n\n[USER]\n...">${escapeHtml(buildCombinedPromptText(selectedPromptState.prompt_system, selectedPromptState.prompt_user))}</textarea>
                        </div>
                    </div>

                    <div id="t-rewrite-page-scheme" class="t-set-page">
                        <div class="t-form-group">
                            <div class="t-rewrite-scheme-bar">
                                <span class="t-rewrite-scheme-label">当前方案</span>
                                <select id="t-rewrite-scheme-select" class="text_pole">${schemeOptions}</select>
                                <button id="t-rewrite-scheme-new" class="t-btn t-rewrite-scheme-btn" type="button" title="新建方案"><i class="fa-solid fa-plus"></i></button>
                                <button id="t-rewrite-scheme-rename" class="t-btn t-rewrite-scheme-btn" type="button" title="重命名"><i class="fa-solid fa-pen-to-square"></i></button>
                                <button id="t-rewrite-scheme-delete" class="t-btn t-rewrite-scheme-btn" type="button" title="删除方案"><i class="fa-solid fa-trash"></i></button>
                            </div>
                            <div class="t-rewrite-rule-guide" id="t-rewrite-scheme-status" style="margin-top:4px;">${!activeScheme ? '无方案，请新建或选择已有方案' : `激活方案「${escapeHtml(activeScheme.name)}」`}</div>
                        </div>
                        <div class="t-form-group">
                            <button id="t-rewrite-scheme-add-category" class="t-btn" type="button"><i class="fa-solid fa-plus"></i> 添加分类</button>
                            <div class="t-rewrite-rule-guide" style="margin: 6px 0 4px;">每个分类包含示例和改写指导，命中句将按分类注入提示词。</div>
                            <div id="t-rewrite-scheme-categories-list"></div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="t-rewrite-settings-footer">
                <button id="t-rewrite-settings-save" class="t-btn" type="button" title="保存并应用"><i class="fa-solid fa-floppy-disk"></i> 保存</button>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    const $overlay = getSettingsOverlay();
    renderSchemeCategoriesList(activeScheme);
    const rewriteSettingsConnectionEditor = createApiConnectionEditor({
        root: $overlay,
        ids: {
            profileSelectId: "t-rewrite-settings-profile-select",
            profileAddId: "t-rewrite-settings-new-profile",
            profileDeleteId: "t-rewrite-settings-delete-profile",
            profileNameId: "t-rewrite-settings-profile-name",
            profileTipId: "t-rewrite-settings-profile-tip",
            apiUrlId: "t-rewrite-settings-api-url",
            apiKeyId: "t-rewrite-settings-api-key",
            modelId: "t-rewrite-settings-model",
            fetchModelsId: "t-rewrite-settings-fetch-models",
            statusId: "t-rewrite-settings-status",
        },
        profiles: mapCustomProfilesToConnectionProfiles(customProfiles, "gpt-3.5-turbo"),
        activeProfileId,
        profileIdPrefix: "rewrite_custom",
        autoFetchOnInput: true,
        autoFetchOnProfileSwitch: false,
        onChange: (nextState) => {
            const mapped = mapConnectionProfilesToCustomProfiles(nextState.profiles, "gpt-3.5-turbo");
            $overlay.data("rewriteCustomProfiles", mapped);
            $overlay.find("#t-rewrite-settings-profile-select").val(nextState.activeProfileId);
        },
    });
    rewriteSettingsConnectionEditor.bind();
    rewriteSettingsConnectionEditor.render();
    bindSettingsPanelEvents(rewriteSettingsConnectionEditor);

    if (initApiUrl) rewriteSettingsConnectionEditor.fetchModels(false);
}

function openPanel() {
    closePanel();
    ensureRewriteCssLoaded();

    const rewriteData = ensureRewriteDataShape();
    const scheme = getActiveScheme();
    const categories = getActiveSchemeCategories();

    const html = `
    <div id="${OVERLAY_ID}" class="t-overlay t-root" aria-modal="true" role="dialog">
        <div class="t-window t-rewrite-window">
            <div class="t-window-header t-rewrite-head">
                <div class="t-window-title t-rewrite-title"><i class="fa-solid fa-highlighter"></i> 文本改写</div>
                <div class="t-window-controls">
                    <button class="t-rewrite-head-text-btn" id="t-rewrite-open-live" type="button" title="打开实时响应">实时响应</button>
                    <div class="t-window-close t-rewrite-settings-btn" id="t-rewrite-open-settings" title="打开设置"><i class="fa-solid fa-sliders"></i></div>
                    <div class="t-window-close" id="t-rewrite-close"><i class="fa-solid fa-times"></i></div>
                </div>
            </div>

            <div class="t-window-body t-rewrite-body">
                <div class="t-rewrite-left">
                    <div class="t-rewrite-section">
                        <div class="t-rewrite-runtime-head">
                            <div class="t-rewrite-section-title">运行状态</div>
                            <button id="t-rewrite-runtime-toggle" class="t-btn" type="button">折叠</button>
                        </div>
                        <div id="t-rewrite-runtime-body" class="t-rewrite-runtime-meta">
                            <div>当前模型：<b id="t-rewrite-runtime-model">${escapeHtml(rewriteData.model || "未设置")}</b></div>
                            <div>切分模式：<b id="t-rewrite-runtime-split">${rewriteData.split_mode === "paragraph" ? "按段落" : "按句子"}</b></div>
                            <div>当前方案：<b id="t-rewrite-runtime-scheme">${scheme ? escapeHtml(scheme.name) : "无方案"}</b></div>
                            <div>分类数量：<b id="t-rewrite-rule-count">${categories.length}</b></div>
                            <div>流式显示：<b id="t-rewrite-runtime-stream">${rewriteData.stream_live === false ? "关闭" : "开启"}</b></div>
                            <div>自动触发：<b id="t-rewrite-runtime-auto">${rewriteData.auto_trigger ? "开启" : "关闭"}</b></div>
                            <div>提取白名单：<b id="t-rewrite-runtime-whitelist">${rewriteData.tag_whitelist ? escapeHtml(rewriteData.tag_whitelist) : "未设置（全文）"}</b></div>
                        </div>
                        <div id="t-rewrite-status" class="t-rewrite-status muted">改写会自动读取最新回复楼层，并回写原消息</div>
                    </div>

                </div>

                <div class="t-rewrite-right">
                    <div class="t-rewrite-section t-rewrite-test-section">
                        <div class="t-rewrite-diff-head">
                            <div class="t-rewrite-section-title">命中结果预览</div>
                        </div>
                        <div id="t-rewrite-match-body" class="t-rewrite-diff-body"></div>
                    </div>

                    <div class="t-rewrite-section">
                        <div class="t-rewrite-diff-head">
                            <div class="t-rewrite-section-title">改写结果 Diff</div>
                        </div>
                        <div id="t-rewrite-diff-body" class="t-rewrite-diff-body"></div>
                    </div>
                </div>
            </div>

            <div class="t-rewrite-footer-actions">
                <div class="t-rewrite-actions">
                    <button id="t-rewrite-trigger" class="t-btn" type="button">
                        <i class="fa-solid fa-wand-magic-sparkles"></i> 按规则改写
                    </button>
                    <span class="t-rewrite-action-hint">选句改写入口会显示在最新回复楼层内</span>
                </div>
            </div>
        </div>
    </div>`;

    $("body").append(html);
    bindPanelEvents();
    syncRuntimeCollapseUi();
    renderPersistedRewriteViews();
    refreshInlineRewriteEntry();
    setRawResponse("");
    setRawMeta("等待请求");
    updateAbortBtnState(false);
}

function togglePanel() {
    if (getOverlay().length > 0) {
        closePanel();
    } else {
        openPanel();
    }
}

function bindGlobalEvents() {
    if (docEventBound) return;
    docEventBound = true;

    $(document).on("keydown.titaniaRewritePanel", (evt) => {
        if (evt.key === "Escape") closePanel();
    });

    $(document).on("click.titaniaRewriteInline", ".t-rewrite-inline-start", (e) => {
        e.preventDefault();
        enterInlineSentenceSelection();
    });

    $(document).on("click.titaniaRewriteInline", ".t-rewrite-inline-cancel", (e) => {
        e.preventDefault();
        clearInlineSentenceSelection();
        refreshInlineRewriteEntry();
    });

    $(document).on("click.titaniaRewriteInline", ".t-rewrite-inline-confirm", (e) => {
        e.preventDefault();
        runSelectedSentenceRewrite();
    });

    $(document).on("click.titaniaRewriteInline", ".t-rewrite-select-sentence", (e) => {
        e.preventDefault();
        const $target = $(e.currentTarget);
        const id = String($target.attr("data-segment-id") || "").trim();
        if (!id) return;
        const selected = getSelectedSentenceIdSet();
        if (selected.has(id)) selected.delete(id);
        else selected.add(id);
        setSelectedSentenceIds(selected);
        $target.toggleClass("selected", selected.has(id));
        updateInlineRewriteCount();
    });
}

function ensureButton() {
    const $anchor = $(ANCHOR_SELECTOR);
    if ($anchor.length === 0) {
        removeButton(false);
        return;
    }

    let $btn = $(`#${BTN_ID}`);
    if ($btn.length === 0) {
        $btn = $(`
            <button id="${BTN_ID}" class="menu_button" type="button" title="文本改写" aria-label="文本改写">
                <i class="fa-solid fa-highlighter"></i>
            </button>
        `);
        $anchor.append($btn);
    }

    $btn.off("click.titaniaRewriteEntry").on("click.titaniaRewriteEntry", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        togglePanel();
    });
}

function syncEntryButton() {
    if (!isEnabled()) {
        clearInlineSentenceSelection();
        removeButton(true);
        return;
    }
    removeButton(false);
}

function bindDomObserver() {
    if (observerBound) return;
    observerBound = true;

    const obs = new MutationObserver(() => {
        syncEntryButton();
    });

    obs.observe(document.body, { childList: true, subtree: true });
}

export function initRewriteEntryButton() {
    ensureRewriteCssLoaded();
    bindGlobalEvents();
    bindDomObserver();
    bindAutoTriggerEvents();
    bindRewriteDecorationEvents();
    scheduleApplyAllRewriteMarks(220);
    syncEntryButton();
    refreshInlineRewriteEntry();
}

export function refreshRewriteEntryButton() {
    syncEntryButton();
    refreshInlineRewriteEntry();
}

export function openRewritePanelFromMenu() {
    if (!isEnabled()) return;
    openPanel();
}
