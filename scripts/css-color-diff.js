#!/usr/bin/env node
/**
 * Compare color-related declarations from a full-context unified diff.
 *
 * This is a migration guard, not a visual-equivalence checker: tokenization may
 * intentionally change values, but it must not silently delete a declaration.
 */

import { parseCSS } from './lib/css-parse.js';

const COLOR_PROP = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|box-shadow|text-shadow|outline(?:-color)?|fill|stroke)$/;

const diff = await readStdin();
const missing = [];
const changed = [];

const files = parseFullContextDiff(diff);
for (const { rel, before, after } of files) {
    compareFile(rel, before, after);
}

if (changed.length) {
    console.log(`Color declarations changed: ${changed.length}`);
    for (const item of changed) {
        console.log(`  ${item.loc}  ${item.prop}: ${item.before} -> ${item.after}`);
    }
} else {
    console.log('Color declarations changed: 0');
}

if (missing.length) {
    console.error(`\nRemoved color declarations: ${missing.length}`);
    for (const item of missing) {
        console.error(`  ${item.loc}  ${item.prop}: ${item.before}`);
    }
    process.exitCode = 1;
} else {
    console.log('Removed color declarations: 0');
}

function compareFile(rel, before, after) {
    const oldRules = indexRules(parseCSS(before, rel));
    const newRules = indexRules(parseCSS(after, rel));

    for (const [key, oldRule] of oldRules) {
        const newRule = newRules.get(key);
        for (const oldDecl of oldRule.decls.filter(decl => COLOR_PROP.test(decl.prop))) {
            const newDecl = newRule?.decls.find(decl => decl.prop === oldDecl.prop);
            const loc = `${rel}:${oldRule.line} ${oldRule.selector}`;
            if (!newDecl) {
                missing.push({ loc, prop: oldDecl.prop, before: oldDecl.value });
            } else if (normalize(oldDecl.value) !== normalize(newDecl.value)) {
                changed.push({ loc, prop: oldDecl.prop, before: oldDecl.value, after: newDecl.value });
            }
        }
    }
}

function indexRules(rules) {
    const indexed = new Map();
    for (const rule of rules.filter(rule => !rule.isAtContainer && !rule.isKeyframes)) {
        const key = `${rule.atStack.join(' > ')}\n${rule.selector}`;
        const existing = indexed.get(key);
        if (existing) {
            existing.decls.push(...rule.decls);
        } else {
            indexed.set(key, { ...rule, decls: [...rule.decls] });
        }
    }
    return indexed;
}

function normalize(value) {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function readStdin() {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    return input;
}

function parseFullContextDiff(input) {
    const parsed = [];
    const sections = input.split(/^diff --git /m).slice(1);

    for (const section of sections) {
        const headerEnd = section.indexOf('\n');
        const header = section.slice(0, headerEnd);
        const match = /^a\/(.+?) b\/(.+)$/.exec(header);
        if (!match) continue;

        const rel = match[2];
        const lines = section.slice(headerEnd + 1).split('\n');
        const before = [];
        const after = [];
        let inHunk = false;

        for (const line of lines) {
            if (line.startsWith('@@ ')) {
                const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
                if (!range || range[1] !== '1' || range[2] !== '1') {
                    throw new Error(`${rel}: diff must use enough context to include the full file`);
                }
                inHunk = true;
                continue;
            }
            if (!inHunk || line === '\\ No newline at end of file') continue;
            if (line.startsWith(' ')) {
                before.push(line.slice(1));
                after.push(line.slice(1));
            } else if (line.startsWith('-')) {
                before.push(line.slice(1));
            } else if (line.startsWith('+')) {
                after.push(line.slice(1));
            }
        }

        if (inHunk) parsed.push({ rel, before: before.join('\n'), after: after.join('\n') });
    }

    if (!parsed.length) console.log('No CSS changes found in diff.');
    return parsed;
}
