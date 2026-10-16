// 全量数据统计 —— 第一个**完全独立**的技能模块。
//
// 它不依赖 blocks.mjs 里的任何 builder，自带 run(ctx)。
// 这就是加新技能的标准形状：在本目录放一个文件，导出 run，去 index.mjs 的
// SKILLS 里加一条元数据（带 run: '<本文件>'），就完事 —— **不用碰 blocks.mjs**。
//
// 数据基础（实测）：dialogue_lines 128,828 行、voice_lines 6,951 条、
// dialogue_groups 3,863 组、story_chapters 1,025 章。全部来自观测枢。
//
// ⚠ 表结构（实测，别照直觉写）：
//   dialogue_lines   id, group_id, ord, heading, speaker, text
//                    **没有 character_id，也没有 game_id** ——
//                    角色要通过 dialogue_groups.character_id 关联，
//                    speaker 只是**名字字符串**（同一角色在不同条目写法可能不同，
//                    所以计数必须走 group 关联，不能按 speaker 分组）。
//   dialogue_groups  id, character_id, ord, quest_type, chapter, chapter_id,
//                    quest_title, quest_id, line_count
//   voice_lines      id, character_id, grp, ord, name, text

const NAME_RE = /^[\u4e00-\u9fff·A-Za-z]{1,20}$/;

/** 从问句里认出「问的是哪个角色」。
 *  先看检索层解析出的实体，再退回 buildBlocks 已算好的 char ——
 *  两条路都是「这个问句指向哪个角色」，只认一条会在实体为空时漏掉。 */
function charOf(ctx) {
  for (const e of ctx.entities || []) {
    const nm = e && (e.name || e.charName);
    if (nm && NAME_RE.test(nm)) return String(nm);
  }
  const fromChar = ctx.char && ctx.char.row && ctx.char.row.name;
  return fromChar && NAME_RE.test(fromChar) ? String(fromChar) : '';
}

/** 台词量排行（默认前 20）。按 dialogue_groups.character_id 归组。 */
function dialogueRanking(v1, limit = 20) {
  return v1.db.prepare(`
    SELECT c.name AS name, COUNT(*) AS n
    FROM dialogue_lines d
    JOIN dialogue_groups g ON g.id = d.group_id
    JOIN characters c ON c.id = g.character_id
    GROUP BY g.character_id
    ORDER BY n DESC
    LIMIT ?
  `).all(limit);
}

/** 单个角色的台词量 + 语音量 + 出场的对话组数。 */
function charCounts(v1, name) {
  const row = v1.db.prepare('SELECT id, name FROM characters WHERE name = ? AND game_id = 1').get(name);
  if (!row) return null;
  const d = v1.db.prepare(`
    SELECT COUNT(*) c FROM dialogue_lines d
    JOIN dialogue_groups g ON g.id = d.group_id
    WHERE g.character_id = ?
  `).get(row.id).c;
  const v = v1.db.prepare('SELECT COUNT(*) c FROM voice_lines WHERE character_id = ?').get(row.id).c;
  const g = v1.db.prepare('SELECT COUNT(DISTINCT quest_id) c FROM dialogue_groups WHERE character_id = ?').get(row.id).c;
  return { name: row.name, dialogues: d, voices: v, groups: g };
}

/**
 * @param {object} ctx { v1, question, char, entities }
 * @returns {object|null} stat-table 块
 */
export function run(ctx) {
  const { v1, question } = ctx;
  const s = String(question || '');
  const total = v1.db.prepare('SELECT COUNT(*) c FROM dialogue_lines').get().c;

  // 「胡桃有多少句台词」——问单个角色
  const one = /多少句|有几句|说了多少/.test(s) ? charOf(ctx) : '';
  if (one) {
    const c = charCounts(v1, one);
    if (!c) return null;
    const pct = total ? Math.round((c.dialogues / total) * 1000) / 10 : 0;
    return {
      kind: 'stat-table',
      title: `${c.name} · 台词量统计`,
      source: '米游社观测枢',
      tables: [{
        slot: '统计',
        columns: ['项目', '数量'],
        rows: [
          ['台词行数', String(c.dialogues)],
          ['占全库比例', `${pct}%`],
          ['语音条数', String(c.voices)],
          ['出场章节数', String(c.groups)],
          ['全库台词行数', String(total)],
        ],
      }],
      note: '台词行数按 dialogue_lines 逐行计；同一句在不同分支会各记一行，所以是「出现次数」不是「不重复台词数」。',
    };
  }

  // 「谁台词最多」「各角色台词量」——排行
  const rows = dialogueRanking(v1, 20);
  if (!rows.length) return null;
  const top = rows[0] && rows[0].n ? rows[0].n : 1;

  return {
    kind: 'stat-table',
    title: `台词量排行 · 前 ${rows.length} 名（全库 ${total.toLocaleString()} 行）`,
    source: '米游社观测枢',
    tables: [{
      slot: '台词量',
      columns: ['排名', '角色', '台词行数', '占比'],
      rows: rows.map((r, i) => [
        String(i + 1),
        r.name,
        String(r.n),
        `${Math.round((r.n / total) * 1000) / 10}%`,
      ]),
    }],
    // 给客户端画条形图用的（不依赖它，没有也能看）
    bars: rows.map((r) => ({ label: r.name, value: r.n, ratio: r.n / top })),
    note: '按 dialogue_lines 逐行统计，角色通过 dialogue_groups 关联。旅行者与派蒙合计约占全库 43%。',
  };
}
