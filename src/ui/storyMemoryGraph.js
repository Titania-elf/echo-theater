// 故事记忆的关系图。
//
// 只做「数据结构 → 布局 → HTML」，不碰宿主、不引第三方图库：
// 人物来自关系标题里的「甲 → 乙」，伏笔作为另一种节点；
// 伏笔正文提到人物名时连一条虚线。点击高亮由 storyMemoryWindow 处理。

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const RELATION_ARROW = /\s*(?:→|⟶|->|—>|⇒|➜)\s*/;

/** 把「林岚 → 顾舟」拆成两个人名；无法拆分时整段作为左名。 */
export function relationNames(title) {
    const text = String(title || '').trim();
    if (!text) return ['', ''];
    const parts = text.split(RELATION_ARROW).map(part => part.trim()).filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts.slice(1).join(' → ')];
    return [text, ''];
}

/**
 * 从记忆里抽出关系图。
 * 人物按关系条数、更新时间排序；伏笔按状态与更新时间排序。
 * 节点数量有上限，避免手机上的长聊天把图挤成一团。
 */
export function buildMemoryGraph(memory, options = {}) {
    const maxCharacters = Math.max(1, Math.floor(Number(options.maxCharacters) || 12));
    const maxThreads = Math.max(0, Math.floor(Number(options.maxThreads) || 12));

    const characters = new Map();
    const edges = [];
    const edgeKeys = new Set();
    for (const item of memory?.relationships || []) {
        const [left, right] = relationNames(item.title);
        for (const name of [left, right].filter(Boolean)) {
            const node = characters.get(name) || { id: `c:${name}`, kind: 'character', name, count: 0, updatedAt: 0 };
            node.count += 1;
            node.updatedAt = Math.max(node.updatedAt, item.updatedAt || 0);
            characters.set(name, node);
        }
        if (left && right && left !== right) {
            const key = [left, right].sort().join('\u0000');
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push({ a: `c:${left}`, b: `c:${right}`, kind: 'relationship', id: item.id });
            }
        }
    }

    const characterNodes = [...characters.values()]
        .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
        .slice(0, maxCharacters);
    const characterIds = new Set(characterNodes.map(node => node.id));

    const statusRank = { open: 0, progress: 1, resolved: 2 };
    const allThreads = (memory?.threads || []).map(item => {
        const status = ['open', 'progress', 'resolved'].includes(item.status) ? item.status : 'open';
        return {
            id: `t:${item.id}`, kind: 'thread', status,
            title: String(item.title || '未命名'),
            text: `${item.title || ''}\n${item.body || ''}`,
            updatedAt: item.updatedAt || 0,
        };
    }).sort((a, b) => (statusRank[a.status] - statusRank[b.status]) || (b.updatedAt - a.updatedAt) || a.title.localeCompare(b.title));
    const threadNodes = allThreads.slice(0, maxThreads);
    const threadIds = new Set(threadNodes.map(node => node.id));

    const links = [];
    const linkKeys = new Set();
    for (const thread of threadNodes) {
        for (const character of characterNodes) {
            if (!thread.text.includes(character.name)) continue;
            const key = `${thread.id}\u0000${character.id}`;
            if (linkKeys.has(key)) continue;
            linkKeys.add(key);
            links.push({ a: thread.id, b: character.id, kind: 'mention' });
        }
    }

    return {
        nodes: [...characterNodes, ...threadNodes],
        edges: edges.filter(edge => characterIds.has(edge.a) && characterIds.has(edge.b)),
        links: links.filter(link => threadIds.has(link.a) && characterIds.has(link.b)),
        truncated: {
            characters: Math.max(0, characters.size - characterNodes.length),
            threads: Math.max(0, allThreads.length - threadNodes.length),
        },
    };
}

/** 选中某个节点后，应该聚焦哪些人物名。 */
export function graphFocusNames(memory, selected) {
    const value = String(selected || '');
    if (value.startsWith('c:')) return [value.slice(2)];
    if (!value.startsWith('t:')) return [];
    const id = value.slice(2);
    const thread = (memory?.threads || []).find(item => item.id === id);
    if (!thread) return [];
    const text = `${thread.title || ''}\n${thread.body || ''}`;
    return buildMemoryGraph(memory).nodes
        .filter(node => node.kind === 'character' && text.includes(node.name))
        .map(node => node.name);
}

/** 渲染 SVG 关系图。节点带 data-node，供窗口层做点击聚焦。 */
export function renderMemoryGraph(memory, options = {}) {
    const graph = buildMemoryGraph(memory, options);
    if (!graph.nodes.length) {
        return '<div class="t-memory-graph-empty"><i class="fa-solid fa-diagram-project"></i><p>人物关系和伏笔出现后，这里会画出它们之间的联系。</p></div>';
    }

    const width = 820;
    const height = 360;
    const cx = width / 2;
    const cy = height / 2;
    const radius = graph.nodes.length === 1 ? 0 : 132;
    graph.nodes.forEach((node, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / graph.nodes.length;
        node.x = cx + radius * Math.cos(angle);
        node.y = cy + radius * Math.sin(angle);
        node.cos = Math.cos(angle);
        node.sin = Math.sin(angle);
    });
    const positions = new Map(graph.nodes.map(node => [node.id, node]));
    const selected = String(options.selected || '');
    const adjacent = new Set(selected ? [selected] : []);
    const edges = [
        ...graph.edges.map(edge => ({ ...edge, cls: 'is-relationship' })),
        ...graph.links.map(edge => ({ ...edge, cls: 'is-mention' })),
    ];
    for (const edge of edges) {
        if (edge.a === selected) adjacent.add(edge.b);
        if (edge.b === selected) adjacent.add(edge.a);
    }

    const edgeHtml = edges.map(edge => {
        const a = positions.get(edge.a);
        const b = positions.get(edge.b);
        if (!a || !b) return '';
        const active = !!selected && (edge.a === selected || edge.b === selected);
        const dim = !!selected && !active;
        return `<line class="t-memory-graph-edge ${edge.cls}${active ? ' is-active' : ''}${dim ? ' is-dimmed' : ''}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"></line>`;
    }).join('');

    const nodeHtml = graph.nodes.map(node => {
        const isSelected = node.id === selected;
        const dim = !!selected && !adjacent.has(node.id);
        const classes = [
            't-memory-graph-node',
            node.kind === 'character' ? 'is-character' : `is-thread is-${node.status}`,
            isSelected ? 'is-selected' : '',
            dim ? 'is-dimmed' : '',
        ].filter(Boolean).join(' ');
        const label = node.kind === 'character' ? node.name : node.title;
        const chars = [...label];
        const shortLabel = chars.slice(0, 10).join('') + (chars.length > 10 ? '…' : '');
        const anchor = node.cos > 0.3 ? 'start' : node.cos < -0.3 ? 'end' : 'middle';
        const offset = node.kind === 'character' ? 27 : 21;
        const lx = (node.x + node.cos * offset).toFixed(1);
        const ly = (node.y + node.sin * offset + 4).toFixed(1);
        const glyph = node.kind === 'character'
            ? ([...node.name][0] || '?')
            : node.status === 'resolved' ? '✓' : node.status === 'progress' ? '…' : '?';
        const nodeRadius = node.kind === 'character' ? 18 : 11;
        return `<g class="${classes}" data-node="${escape(node.id)}" tabindex="0" role="button" aria-label="${escape(label)}"><title>${escape(label)}</title><circle cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${nodeRadius}"></circle><text class="t-memory-graph-initial" x="${node.x.toFixed(1)}" y="${(node.y + 4).toFixed(1)}" text-anchor="middle">${escape(glyph)}</text><text class="t-memory-graph-label" x="${lx}" y="${ly}" text-anchor="${anchor}">${escape(shortLabel)}</text></g>`;
    }).join('');

    const truncated = graph.truncated.characters || graph.truncated.threads
        ? `<p class="t-memory-graph-hint">图中只显示最相关的节点${graph.truncated.characters ? `，还有 ${graph.truncated.characters} 个人物未画出` : ''}${graph.truncated.threads ? `，还有 ${graph.truncated.threads} 个伏笔未画出` : ''}。</p>`
        : '';
    return `<div class="t-memory-graph">
        <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="人物关系与伏笔关系图">${edgeHtml}${nodeHtml}</svg>
        <div class="t-memory-graph-legend"><span><i class="t-memory-legend-node is-character"></i>人物</span><span><i class="t-memory-legend-node is-thread"></i>伏笔</span><span><i class="t-memory-legend-edge is-relationship"></i>关系</span><span><i class="t-memory-legend-edge is-mention"></i>涉及</span></div>
        ${truncated}
    </div>`;
}
