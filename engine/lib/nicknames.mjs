import { ALIASES } from './domain.mjs';
import { shortNameAtOk } from './names.mjs';

export const NICKNAMES = Object.freeze({
  雷神: '雷电将军', 影: '雷电将军', 雷电影: '雷电将军',
  帝君: '钟离', 摩拉克斯: '钟离', 岩王爷: '钟离',
  温神: '温迪', 草王: '纳西妲', 小草神: '纳西妲',
  水龙王: '那维莱特', 龙王: '那维莱特', 散兵: '流浪者',
});
// Focalors' divinity and Furina's humanity are distinct entities in lore.
export const ENTITY_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries({ ...ALIASES, ...NICKNAMES }).filter(([alias]) => alias !== '芙卡洛斯')
));

export function canonicalizeNames(text) {
  let result = String(text || '');
  for (const [alias, name] of Object.entries(ENTITY_ALIASES).sort((a, b) => b[0].length - a[0].length)) {
    let at = result.indexOf(alias);
    while (at >= 0) {
      if (alias.length > 1 || shortNameAtOk(result, at, alias.length)) {
        result = result.slice(0, at) + name + result.slice(at + alias.length);
        at = result.indexOf(alias, at + name.length);
      } else at = result.indexOf(alias, at + alias.length);
    }
  }
  return result;
}
