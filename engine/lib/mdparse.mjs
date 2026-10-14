// 轻量 markdown 解析：只处理 ambr-kb 实际用到的子集（标题 / 表格 / 引用 / 列表 / 段落）。
// 解析结果落库为结构化 block 数组，前端直接渲染，保证与原文一致且无需在前端写 markdown 引擎。

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** 扫出所有标题节点，返回 { lines, nodes: [{level,title,line}] }。 */
export function parseHeadings(md) {
  const lines = String(md).split(/\r?\n/);
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) nodes.push({ level: m[1].length, title: m[2].trim(), line: i });
  }
  return { lines, nodes };
}

/** 取某个标题下的正文行（到下一个节点为止）。 */
export function sectionLines(lines, nodes, idx) {
  const start = nodes[idx].line + 1;
  const end = idx + 1 < nodes.length ? nodes[idx + 1].line : lines.length;
  return lines.slice(start, end);
}

/** 找出某个 H2 标题（level===2）的节点下标，找不到返回 -1。 */
export function findH2(nodes, titlePrefix) {
  return nodes.findIndex((n) => n.level === 2 && n.title.startsWith(titlePrefix));
}

/** 从某个节点出发，取所有 level===level 的子节点的 (node, index)。 */
export function childrenOf(nodes, idx, level) {
  const out = [];
  for (let i = idx + 1; i < nodes.length; i++) {
    if (nodes[i].level <= (level - 1)) break;
    if (nodes[i].level === level) out.push(i);
  }
  return out;
}

/** markdown 正文 -> 结构化 block 数组。 */
export function toBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let para = [];
  let quote = [];
  let item = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ t: 'p', x: para.join('\n').trim() });
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      blocks.push({ t: 'q', x: quote.join('\n').trim() });
      quote = [];
    }
  };
  const flushItem = () => {
    if (item !== null) {
      blocks.push({ t: 'li', x: item.trim() });
      item = null;
    }
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushItem();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flushAll();
      blocks.push({ t: 'h', lv: h[1].length, x: h[2].trim() });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushItem();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      flushQuote();
      flushItem();
      item = li[1];
      continue;
    }
    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushAll();
      blocks.push({ t: 'hr', x: '' });
      continue;
    }
    if (item !== null) {
      item += '\n' + line.trim();
      continue;
    }
    flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

/** 解析表格（给定以 `|` 开头的行），返回二维数组，首行为表头。 */
export function parseTable(rows) {
  const out = [];
  for (const row of rows) {
    const t = row.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue; // 分隔行
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    out.push(cells);
  }
  return out;
}

/** 从 block 数组里提取「字段 -> 内容」字典（用于基础档案表）。 */
export function tableToRecord(rows) {
  const rec = {};
  for (const r of rows) if (r.length >= 2) rec[r[0]] = r[1];
  return rec;
}

/** 去掉行内 markdown 标记，得到纯文本（用于检索与摘要）。 */
export function inlineToPlain(s) {
  return String(s ?? '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\u0001|\u0002/g, '')
    .trim();
}

/** block 数组 -> 纯文本（检索用）。 */
export function blocksToPlain(blocks) {
  return blocks
    .map((b) => (b.t === 'hr' ? '' : inlineToPlain(b.x)))
    .filter(Boolean)
    .join('\n');
}

/** 从 markdown 表格行里抽字段；输入是原始行数组。 */
export function tableFromLines(lines) {
  return parseTable(lines.filter((l) => l.trim().startsWith('|')));
}

/** 大字（★）转稀有度数值。 */
export function rarityOf(s) {
  if (!s) return null;
  const n = (String(s).match(/★/g) || []).length;
  return n || null;
}
