import { mapRewriteUnits, prepareSourcePatch, applySourcePatches } from './textRewritePatch.js';
import { collectRewriteTextGroups, locateRewriteRange, buildRewriteDomChanges, rewriteDomStillMatches, applyRewriteDomChanges, rollbackRewriteDomChanges } from '../ui/textRewriteDom.js';

function chatKey(ctx) {
    return JSON.stringify([ctx?.chatId, ctx?.groupId, ctx?.characters?.[ctx?.characterId]?.avatar]);
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const commitsInFlight = new WeakSet();

function sourceFields(message) {
    const fields = [];
    for (const key of ['mes', 'message']) if (own(message, key)) fields.push({ object: message, key, original: message[key] });
    const swipe = message.swipe_id;
    if (Array.isArray(message.swipes) && message.swipes.length) {
        const index = Number(swipe);
        if (swipe == null || !Number.isInteger(index) || index < 0 || index >= message.swipes.length) return { fields, reason: '当前 swipe 编号无效' };
        fields.push({ object: message.swipes, key: index, original: message.swipes[index] });
        if (own(message.swipe_info?.[index]?.extra, 'display_text')) fields.push({ object: message.swipe_info[index].extra, key: 'display_text', original: message.swipe_info[index].extra.display_text, cache: true });
    }
    if (own(message.extra, 'display_text')) fields.push({ object: message.extra, key: 'display_text', original: message.extra.display_text, cache: true });
    return { fields, reason: '' };
}

export function captureRewriteTarget(ctx, index, projection, container) {
    const message = ctx.chat[index];
    const snapshot = sourceFields(message);
    return {
        ctx, key: chatKey(ctx), chat: ctx.chat, metadata: ctx.chatMetadata, index, message, projection, container,
        swipe: message.swipe_id, swipes: message.swipes, swipeInfo: message.swipe_info, extra: message.extra,
        fields: snapshot.fields, reason: snapshot.reason,
    };
}

export function rewriteTargetStillMatches(target, current, expectedSource = target.projection.raw) {
    if (!current || current.chat !== target.chat || current.chatMetadata !== target.metadata || chatKey(current) !== target.key ||
        current.chat[target.index] !== target.message || target.message.swipe_id !== target.swipe ||
        target.message.swipes !== target.swipes || target.message.swipe_info !== target.swipeInfo) return false;
    const snapshot = sourceFields(target.message);
    return !snapshot.reason && snapshot.fields.length === target.fields.length && snapshot.fields.every((field, i) =>
        field.object === target.fields[i].object && field.key === target.fields[i].key &&
        field.original === (target.fields[i].cache && target.fields[i].original == null ? target.fields[i].original : expectedSource));
}

export async function persistRewriteTarget(target, rewritten, host) {
    if (!rewriteTargetStillMatches(target, host.getContext(), rewritten)) throw new Error('聊天或原文已变化');
    const ctx = target.ctx;
    const group = ctx.groupId != null && ctx.groupId !== '';
    const character = ctx.characters?.[ctx.characterId];
    if (!ctx.chatId || (!group && !character?.avatar)) throw new Error('当前聊天无法确认保存结果');
    await host.save();
    if (!rewriteTargetStillMatches(target, host.getContext(), rewritten)) throw new Error('保存期间聊天或原文已变化');
    const response = await host.fetch(group ? '/api/chats/group/get' : '/api/chats/get', {
        method: 'POST', headers: host.getHeaders(), cache: 'no-store',
        body: JSON.stringify(group ? { id: ctx.chatId } : { ch_name: character.name, file_name: ctx.chatId, avatar_url: character.avatar }),
    });
    if (!response.ok) throw new Error('聊天回读失败');
    const saved = await response.json();
    const offset = Array.isArray(saved) && own(saved[0], 'chat_metadata') ? 1 : 0;
    const message = Array.isArray(saved) ? saved[target.index + offset] : null;
    const fields = message ? sourceFields(message) : { fields: [], reason: '未找到保存的楼层' };
    if (fields.reason || fields.fields.length !== target.fields.length || fields.fields.some((field, i) =>
        field.key !== target.fields[i].key || field.original !== (target.fields[i].cache && target.fields[i].original == null ? target.fields[i].original : rewritten))) throw new Error('楼层补丁未成功保存');
    if (!rewriteTargetStillMatches(target, host.getContext(), rewritten)) throw new Error('回读期间聊天或原文已变化');
}

/** Commit only patches which passed both source and display preflight. No render fallback. */
export async function commitRewritePatches(target, units, replacements, options) {
    const mapped = mapRewriteUnits(target.projection, units);
    const entries = mapped.filter(unit => replacements.has(unit.unitIndex)).map(unit => ({
        unitIndex: unit.unitIndex, before: unit.text, after: replacements.get(unit.unitIndex), status: 'preview', reason: '', unit,
    }));
    const failAll = reason => {
        for (const entry of entries) entry.reason = reason;
        return { entries, applied: 0, preview: entries.length, reason };
    };
    const busy = options.isGenerating?.();
    if (busy) return failAll('酒馆正在生成，请结束生成后重试');
    if (commitsInFlight.has(target.chat)) return failAll('上一批补丁仍在保存，请稍后重试');
    if (target.reason) return failAll(target.reason);
    if (target.fields.some(field => !(field.cache && field.original == null) && field.original !== target.projection.raw)) return failAll('消息原文、swipe 或独立显示缓存不一致，需要专用适配');
    if (!rewriteTargetStillMatches(target, options.getContext())) return failAll('聊天、swipe 或原文已变化，本次结果仅保留预览');
    if (!target.container?.isConnected || options.getContainer() !== target.container) return failAll('当前楼层显示已变化或尚未挂载，仅保留预览');
    const groups = collectRewriteTextGroups(target.container, target.projection.whitelist);
    const plans = [];
    for (const entry of entries) {
        if (entry.after === entry.before) { entry.status = 'unchanged'; entry.reason = '结果与原文相同'; continue; }
        const patch = prepareSourcePatch(entry.unit, entry.after);
        if (patch.reason) { entry.reason = patch.reason; continue; }
        if (patch.before === patch.replacement) { entry.status = 'unchanged'; entry.reason = '结果与原文相同'; continue; }
        const range = locateRewriteRange(groups, target.projection, patch);
        if (range.reason) { entry.reason = range.reason; continue; }
        entry.after = patch.replacement;
        plans.push({ patch, range, entry });
    }
    if (!plans.length) return { entries, applied: 0, preview: entries.filter(entry => entry.status === 'preview').length };
    const changes = buildRewriteDomChanges(plans);
    const rewritten = applySourcePatches(target.projection.raw, plans.map(plan => plan.patch));
    if (!rewriteTargetStillMatches(target, options.getContext()) || options.getContainer() !== target.container || !rewriteDomStillMatches(target.container, changes)) return failAll('写回前原文或显示已变化，仅保留预览');
    const writes = target.fields.filter(field => !(field.cache && field.original == null)).map(field => ({ ...field, after: rewritten, had: true }));
    const previousExtra = target.message.extra;
    const hadExtra = own(target.message, 'extra');
    if (!previousExtra || typeof previousExtra !== 'object') target.message.extra = {};
    const metadata = target.message.extra;
    const metadataPatch = { [options.action === 'delete' ? 'titania_delete_done' : 'titania_rewrite_done']: true };
    if (options.action !== 'delete') metadataPatch.titania_rewrite_marks = plans.map(plan => ({ before: plan.entry.before, after: plan.entry.after }));
    for (const [key, after] of Object.entries(metadataPatch)) writes.push({ object: metadata, key, original: metadata[key], had: own(metadata, key), after });
    commitsInFlight.add(target.chat);
    try {
        // All mutations happen synchronously after the final preflight.
        for (const write of writes) write.object[write.key] = write.after;
        applyRewriteDomChanges(changes);
        try {
            await options.persist(target, rewritten);
        } catch (cause) {
            // Roll back only our still-current values; a later user edit wins.
            for (const write of writes) if (write.object[write.key] === write.after &&
                (write.object !== target.message || target.message.swipe_id === target.swipe)) {
                if (write.had) write.object[write.key] = write.original;
                else delete write.object[write.key];
            }
            if (previousExtra !== metadata && target.message.extra === metadata && !Object.keys(metadata).length) {
                if (hadExtra) target.message.extra = previousExtra;
                else delete target.message.extra;
            }
            rollbackRewriteDomChanges(changes);
            let restoreError = '';
            if (rewriteTargetStillMatches(target, options.getContext()) && options.restore) {
                try { await options.restore(target); }
                catch (restoreCause) { restoreError = `；原文恢复的保存也未能确认：${restoreCause.message || restoreCause}`; }
            }
            return failAll(`保存未能确认，已撤回本次仍未变化的补丁：${cause.message || cause}${restoreError}`);
        }
        for (const plan of plans) { plan.entry.status = 'applied'; plan.entry.reason = '已安全写回'; }
        let notificationError = '';
        try { await options.notify?.(target); }
        catch (cause) { notificationError = String(cause.message || cause); }
        return { entries, applied: plans.length, preview: entries.filter(entry => entry.status === 'preview').length, notificationError };
    } finally { commitsInFlight.delete(target.chat); }
}
