// 观测枢官方数据（obc_entries / obc_fts）的只读查询层。
//
// 数据由 dsh-integrations/gen-suite/tools/obc-import.mjs 导入：
//   来源 = 米游社观测枢 baike.mihoyo.com（米哈游自营）的公开接口
//   落库 = kb-workspace.sqlite 侧车可写库
//
// 这里只读，不写。分词复用 lib/tokenize.mjs，保证与主库检索一致。

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { queryExpr, snippet } from './tokenize.mjs';
// 分类中文名与 menu→kind 的唯一事实来源。
// 这张表原先是手写的，只列了 19 种；2026-10-13 补采后 menu 从 7 个变成 53 个、
// 条目从 4425 变成 16869，缺的那些就全落成了英文 slug —— 图鉴页左边的筛选条
// 显示成 `teapot 2398` `achievement 1614`，维护台和客户端的回答块标签也一样。
// 现在统一放 lib/obc-kinds.mjs，这里只做转出（server.mjs / v1-data.mjs 照旧 import 这里）。
import { obcLabel, OBC_KIND_LABEL } from './obc-kinds.mjs';
export { OBC_KIND_LABEL, obcLabel };

// ------------------------------------------------------------------ 官方原文回链
//
// 为什么必须回链：观测枢是米哈游自营的官方资料站。本产品把它的内容整理成可检索的
// 形态，如果**只吸收、不送回**，形态上就成了「替代官方来源」——这正是米哈游诉
// 「游创工坊」一案里被法院认定为侵权的理由之一（判决书：「必然导致《原神》用户流量
// 有所减少」「针对《原神》游戏产生了一定的替代效果」，2024-04 一审，判赔 200 万）。
//
// 所以每个条目都要能一键回到观测枢原文。这不只是合规动作，也是产品该有的样子：
// 用户核对原文的路径越短，越敢信你的检索结果。
//
// URL 规则：`/ys/obc/content/{entry_page_id}/detail`
//
// ✅ 2026-10-16 已验证，这条规则是对的，之前的疑虑可以放下。
//   验证方式：观测枢词条正文的 HTML 里成对出现 id / 名称 / 链接三者，例如
//     data-entry-id="837"  data-entry-name="「黄金」的指引×2"
//     data-entry-link="/ys/obc/content/837/detail?bbs_presentation_style=no_header"
//   拿这些 id 回本地库核对，同名同物（837「黄金」的指引、826「诗文」的指引、
//   823「抗争」的指引、1025 大英雄的经验、1030 精锻用魔矿 全部一致）。
//   所以**本地 obc_entries.id 与 URL 里的 id 是同一个 id 空间**。
//
//   原先那句注释写着 `data-entry-name="迪卢克" data-entry-link="/ys/obc/content/54/detail"`，
//   与「54 是安柏」对不上 —— 现在确认是那句**旧笔记写串了**，不是 URL 规则错。
//   （id=54 在本库是安柏，与 obc_recommend 表一致。）
export const OBC_SOURCE_URL_BASE = 'https://baike.mihoyo.com/ys/obc/content/';

/** 观测枢条目原文地址；id 非法时返回空串（宁可不给链接，也不给错链接）。 */
export function obcSourceUrl(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return '';
  return `${OBC_SOURCE_URL_BASE}${n}/detail`;
}


export function openObc(dataDir, { readonly = true } = {}) {
  try {
    const db = new DatabaseSync(path.join(dataDir, 'kb-workspace.sqlite'), { readOnly: readonly });
    if (hasObc(db)) return db;
    db.close();
    return null;
  } catch {
    return null;
  }
}

/** 表存在且非空才算有数据 */
export function hasObc(db) {
  try {
    const r = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='obc_entries'",
    ).get();
    if (!r) return false;
    return db.prepare('SELECT COUNT(*) AS n FROM obc_entries').get().n > 0;
  } catch {
    return false;
  }
}

export function obcStats(db) {
  const rows = db.prepare(
    'SELECT kind, COUNT(*) AS n, SUM(text_len) AS chars FROM obc_entries GROUP BY kind ORDER BY n DESC',
  ).all();
  return rows.map((r) => ({
    kind: r.kind,
    label: obcLabel(r.kind),
    count: r.n,
    chars: r.chars || 0,
  }));
}

/**
 * 列表 / 检索二合一。
 * 传 q 走 FTS（bm25 名称加权），不传则按分类分页。
 */
export function obcList(db, { kind = '', q = '', page = 1, size = 40 } = {}) {
  const lim = Math.min(Math.max(Number(size) || 40, 1), 200);
  const off = (Math.max(Number(page) || 1, 1) - 1) * lim;
  const kinds = kind ? String(kind).split(',').map((s) => s.trim()).filter(Boolean) : [];

  if (q && String(q).trim()) {
    const query = String(q).trim();
    const expr = queryExpr(query);
    const kFilter = kinds.length ? ` AND e.kind IN (${kinds.map(() => '?').join(',')})` : '';
    const kOnly = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';

    // ① 名称直配优先：词条名出现在查询里就直接给，精确同名排最前。
    //    只靠 bm25 的话，搜「钟离」会把「钟离【洞天】」顶到「钟离」前面。
    //    另外剥掉书名号再比一次：敌人词条叫「多托雷」、「公子」，直接 comparaison 匹配不上。
    const nameHits = db.prepare(
      `SELECT id, name, kind, menu_label, text_len, raw_json FROM obc_entries
        WHERE length(name) >= 2
          AND (instr(?, name) > 0 OR REPLACE(REPLACE(name,'「',''),'」','') = ?)${kOnly}
        ORDER BY (name = ? OR REPLACE(REPLACE(name,'「',''),'」','') = ?) DESC,
                 length(name) DESC LIMIT ?`,
    ).all(query, query, ...kinds, query, query, lim);

    // ② FTS 补剩下的
    let ftsRows = [];
    if (expr) {
      try {
        ftsRows = db.prepare(
          `SELECT e.id, e.name, e.kind, e.menu_label, e.text_len, e.raw_json,
                  bm25(obc_fts, 20.0, 1.0) AS score
             FROM obc_fts f JOIN obc_entries e ON e.id = f.entry_id
            WHERE obc_fts MATCH ?${kFilter}
            ORDER BY score LIMIT ?`,
        ).all(expr, ...kinds, lim + off);
      } catch { ftsRows = []; }
    }

    const seen = new Set();
    const merged = [];
    for (const r of [...nameHits, ...ftsRows]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    const total = expr
      ? (() => { try { return db.prepare(
          `SELECT COUNT(*) AS n FROM obc_fts f JOIN obc_entries e ON e.id = f.entry_id
            WHERE obc_fts MATCH ?${kFilter}`).get(expr, ...kinds).n; } catch { return merged.length; } })()
      : merged.length;

    return {
      total: Math.max(total, merged.length), page: 1, size: lim, query,
      items: merged.slice(off, off + lim).map((r) => ({
        id: r.id, name: r.name, kind: r.kind,
        label: obcLabel(r.kind),
        menuLabel: r.menu_label, chars: r.text_len,
        score: r.score == null ? null : Number(r.score.toFixed(3)),
        snippet: obcSnippet(r.raw_json, query),
        sourceUrl: obcSourceUrl(r.id),
      })),
    };
  }

  const kFilter = kinds.length ? ` WHERE kind IN (${kinds.map(() => '?').join(',')})` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM obc_entries${kFilter}`).get(...kinds).n;
  const rows = db.prepare(
    `SELECT id, name, kind, menu_label, text_len FROM obc_entries${kFilter}
      ORDER BY kind, id LIMIT ? OFFSET ?`,
  ).all(...kinds, lim, off);
  return {
    total, page: Math.max(Number(page) || 1, 1), size: lim, query: '',
    items: rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind,
      label: obcLabel(r.kind),
      menuLabel: r.menu_label, chars: r.text_len, score: null, snippet: '',
      sourceUrl: obcSourceUrl(r.id),
    })),
  };
}

/** 从 raw_json 里现算一段命中摘要（入库时没存正文，避免二次膨胀） */
function obcSnippet(rawJson, q) {
  try {
    const page = JSON.parse(rawJson);
    const text = obcText(page).slice(0, 20000);
    return snippet(text, q, 70, 1).snippet || '';
  } catch {
    return '';
  }
}

/** 把条目的 modules 抽成纯文本（列表摘要与详情都用） */
export function obcText(page) {
  const parts = [];
  const skip = new Set(['img', 'image', 'icon', 'icon_url', 'cover', 'avatar_pc', 'avatar_m',
    'gold_img', 'common_img', 'long_img', 'card_img', 'life_bg', 'energy_bg', 'audio_url',
    'link', 'bbs_url']);
  const strip = (h) => String(h)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const walk = (v, d = 0) => {
    if (d > 8 || v == null) return;
    if (typeof v === 'string') {
      const s = strip(v);
      if (s && !/^https?:\/\//.test(s) && s.length > 1) parts.push(s);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, d + 1)); return; }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) if (!skip.has(k)) walk(val, d + 1);
    }
  };
  walk(page?.modules);
  return [...new Set(parts)].join('\n');
}

/** 单条详情：返回原始 page（前端按 components 渲染）+ 纯文本 */
export function obcEntry(db, id) {
  const row = db.prepare(
    'SELECT id, name, kind, menu_label, license, module_count, text_len, updated_at, raw_json FROM obc_entries WHERE id = ?',
  ).get(id);
  if (!row) return null;
  let page = null;
  try { page = JSON.parse(row.raw_json); } catch { /* ignore */ }
  return {
    id: row.id, name: row.name, kind: row.kind,
    label: obcLabel(row.kind),
    menuLabel: row.menu_label, license: row.license,
    moduleCount: row.module_count, chars: row.text_len, updatedAt: row.updated_at,
    page,
    text: obcText(page),
  };
}

/**
 * 推荐关系（obc_recommend 表，由 tools/obc-recommend.mjs 抽取）。
 * 双向：asSource = 这个词条推荐了谁；asTarget = 谁推荐了它。
 *   角色页  -> asSource 里是「推荐武器 / 推荐圣遗物」
 *   武器/圣遗物页 -> asTarget 里是「推荐角色」
 */
export function obcRecommends(db, id) {
  if (!db || !Number.isFinite(Number(id))) return { asSource: [], asTarget: [] };
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='obc_recommend'").get();
    if (!has) return { asSource: [], asTarget: [] };
    const asSource = db.prepare(
      `SELECT slot, target_id, target_kind, target_name, target_img, reason, affix
         FROM obc_recommend WHERE src_id = ? ORDER BY slot, id`,
    ).all(Number(id));
    const asTarget = db.prepare(
      `SELECT r.slot, r.src_id, r.src_kind, r.src_name, r.reason, r.affix,
              e.icon AS src_img
         FROM obc_recommend r
         LEFT JOIN obc_entries e ON e.id = r.src_id
        WHERE r.target_id = ? ORDER BY r.slot, r.id LIMIT 60`,
    ).all(Number(id));
    return { asSource, asTarget };
  } catch {
    return { asSource: [], asTarget: [] };
  }
}
