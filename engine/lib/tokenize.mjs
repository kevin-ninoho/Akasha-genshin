// 中文友好的 FTS5 二元组分词器。
//
// 背景：SQLite FTS5 的 unicode61 / porter 分词器不切分 CJK（整句当成一个 token），
// trigram 分词器又无法匹配 2 字查询（「采药」「七七」直接 0 命中）。
// 方案：把 CJK / 字母数字连续段切成「二元组」（bigram）后写入 unicode61 索引，
// 查询侧做同样切分并用短语查询（phrase）保持词序，单字查询退化为前缀匹配。

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff';
const ALNUM = '0-9a-zA-Z\\u00c0-\\u024f';
const RUN_RE = new RegExp(`[${CJK}${ALNUM}]+`, 'g');

/** 把文本切成连续的「词片段」：CJK 段、字母数字段。其余字符一律当分隔符。 */
export function segments(text) {
  if (!text) return [];
  const out = [];
  const matches = String(text).match(RUN_RE);
  if (!matches) return out;
  for (const raw of matches) {
    const seg = raw.toLowerCase();
    out.push(seg);
  }
  return out;
}

/**
 * 单个片段 -> 索引 token 列表。
 * 长度 1 的片段本身就是一个 token（供单字前缀查询命中）。
 * 长度 >= 2 的片段输出全部相邻二元组。
 */
export function segToTokens(seg) {
  const chars = Array.from(seg);
  if (chars.length === 1) return [chars[0]];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 正文 -> 写入 FTS5 tokens 列的字符串。 */
export function indexTokens(text) {
  const parts = [];
  for (const seg of segments(text)) {
    for (const t of segToTokens(seg)) parts.push(t);
  }
  return parts.join(' ');
}

/** 转义 FTS5 字符串字面量：双引号翻倍。 */
function quote(s) {
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * 用户查询 -> FTS5 MATCH 表达式。
 * - 按空白切成多个查询词，词之间是 AND（都命中才算）
 * - 每个词内部用短语查询保证二元组相邻（即原文子串匹配）
 * - 单字词退化为前缀查询 `x*`
 * 返回 null 表示该查询没有可检索内容。
 */
export function queryExpr(q) {
  if (!q) return null;
  const terms = String(q).trim().split(/\s+/).filter(Boolean);
  const groups = [];
  for (const term of terms) {
    const segs = segments(term);
    const pieces = [];
    for (const seg of segs) {
      const chars = Array.from(seg);
      if (chars.length === 1) {
        pieces.push(chars[0] + '*');
      } else {
        const toks = segToTokens(seg);
        pieces.push(quote(toks.join(' ')));
      }
    }
    if (pieces.length) groups.push(pieces.length === 1 ? pieces[0] : '(' + pieces.join(' AND ') + ')');
  }
  if (!groups.length) return null;
  return groups.length === 1 ? groups[0] : '(' + groups.join(' AND ') + ')';
}

/**
 * 在原始文本里定位关键词并生成高亮片段。
 * 二元组索引不带原文位置，所以片段由这里在原文上做子串匹配生成。
 */
export function snippet(text, q, radius = 60, maxFragments = 2) {
  if (!text) return { snippet: '', hits: 0 };
  const body = String(text).replace(/\s+/g, ' ').trim();
  const lc = body.toLowerCase();
  const terms = String(q || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
  if (!terms.length) {
    return { snippet: body.slice(0, radius * 2) + (body.length > radius * 2 ? '…' : ''), hits: 0 };
  }

  const spans = [];
  for (const term of terms) {
    let from = 0;
    while (from <= lc.length - term.length) {
      const at = lc.indexOf(term, from);
      if (at < 0) break;
      spans.push([at, at + term.length]);
      from = at + Math.max(1, term.length);
      if (spans.length > 400) break;
    }
  }
  if (!spans.length) {
    return { snippet: body.slice(0, radius * 2) + (body.length > radius * 2 ? '…' : ''), hits: 0 };
  }
  spans.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }

  const picked = [];
  for (const s of merged) {
    if (picked.length && s[0] - picked[picked.length - 1][1] < radius) {
      picked[picked.length - 1][1] = Math.min(body.length, Math.max(picked[picked.length - 1][1], s[1]));
      continue;
    }
    picked.push([Math.max(0, s[0] - radius), Math.min(body.length, s[1] + radius)]);
    if (picked.length >= maxFragments) break;
  }

  const frags = picked.map(([a, b]) => {
    let piece = body.slice(a, b);
    for (const term of terms) {
      if (!term) continue;
      const re = new RegExp(escapeRe(term), 'gi');
      piece = piece.replace(re, (m) => '\u0001' + m + '\u0002');
    }
    return (a > 0 ? '…' : '') + piece + (b < body.length ? '…' : '');
  });
  return { snippet: frags.join(' ／ '), hits: merged.length };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- 查询放宽
// 长中文问句（「往生堂是什么样的地方」）若整句切二元组后全部 AND，会直接 0 命中。
// 这里提供两级放宽手段：剥离疑问词/虚词，以及二元组 OR 查询。

/** 中文疑问词与虚词，按长度从长到短匹配剥离。 */
const STOP_ZH = [
  '是什么意思', '是什么样的', '是怎么样的', '是什么样', '是什么', '是啥', '有什么', '有哪些',
  '为什么', '怎么样', '怎么办', '怎么回事', '请问一下', '请问', '麻烦', '帮我', '告诉我',
  '介绍一下', '介绍', '说说', '讲讲', '一下', '关于', '相关', '有关', '如何', '怎么',
  '哪些', '哪个', '哪一个', '哪里', '哪儿', '什么', '谁', '多少', '是不是', '是否',
  '时候', '可以', '能够', '能不能', '有没有', '值得', '他们', '她们', '我们', '你们',
  '这个', '那个', '这些', '那些', '这里', '那里', '同时', '还有', '并且', '以及',
  '但是', '不过', '然后', '因此', '所以', '地方',
  '呢', '吗', '吧', '啊', '呀', '哦', '噢', '嗯', '的', '了', '着', '过', '是', '在',
  '有', '和', '与', '及', '或', '就', '都', '也', '还', '很', '更', '最', '把', '被',
  '给', '对', '从', '到', '地', '得', '会', '要', '能', '来', '去', '个', '些', '之',
  '其', '而', '则', '并', '等',
];

const STOP_EN = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose',
  'is', 'are', 'was', 'were', 'be', 'been', 'am', 'do', 'does', 'did',
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'for', 'with',
  'about', 'tell', 'me', 'please', 'can', 'could', 'would', 'should', 'will',
  'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those',
  'i', 'we', 'they', 'he', 'she', 'his', 'her', 'their',
]);

/**
 * 剥离疑问词与虚词，保留实体性内容。
 * 英文按空格分词精确剔除（避免「Tartaglia」被 'a' 误伤），中文按子串剥离。
 * 回退规则：结果为空则返回空串，调用方自行决定是否使用。
 */
export function stripStopwords(q) {
  const tokens = String(q || '').trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const tok of tokens) {
    if (/^[a-z0-9'’-]+$/i.test(tok)) {
      if (!STOP_EN.has(tok.toLowerCase())) out.push(tok);
      continue;
    }
    let s = tok;
    for (const w of STOP_ZH) {
      if (s.includes(w)) s = s.split(w).join(' ');
    }
    // 剥掉虚词后残留的孤立单字（「他的语音呢」-> 「他」）没有任何检索价值，
    // 但会退化成 `他*` 这样的超宽前缀查询，把完全无关角色的段落召回进来。
    // 因此只保留长度 >= 2 的片段；全被剥光则整段丢弃（此时长度 1 的原查询不受影响）。
    const kept = s.split(/\s+/).filter((f) => f.length >= 2);
    if (kept.length) out.push(kept.join(' '));
  }
  return out.join(' ').trim();
}

/**
 * 放宽查询：把所有二元组用 OR 连接（顺序无关），配合 bm25 排序做召回。
 * 用于严格短语查询 0 命中时的兜底。
 */
export function queryExprLoose(q) {
  const terms = String(q || '').trim().split(/\s+/).filter(Boolean);
  const pieces = [];
  for (const term of terms) {
    for (const seg of segments(term)) {
      const chars = Array.from(seg);
      if (chars.length === 1) {
        pieces.push(chars[0] + '*');
        continue;
      }
      for (let i = 0; i + 1 < chars.length; i++) pieces.push(quote(chars[i] + chars[i + 1]));
    }
  }
  if (!pieces.length) return null;
  return [...new Set(pieces)].join(' OR ');
}

/** 计数用：估算某段文本的检索命中数（用于排序打散）。 */
export function termCount(text, q) {
  if (!text || !q) return 0;
  const lc = String(text).toLowerCase();
  let n = 0;
  for (const t of String(q).trim().split(/\s+/).filter(Boolean)) {
    let from = 0;
    for (;;) {
      const at = lc.indexOf(t.toLowerCase(), from);
      if (at < 0) break;
      n++;
      from = at + 1;
    }
  }
  return n;
}
