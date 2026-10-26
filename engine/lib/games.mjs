export const genshin = Object.freeze({
  id: 'genshin', label: '原神', theme: 'astral',
  entities: ['character', 'book', 'obc'],
  capabilities: { chat: true, research: true, growth: true, media: true },
  spoilerScopes: [], spoilerNotice: '当前资料缺少可靠的章节标注，尚未过滤剧透。',
});

/**
 * 星穹铁道（game_id = 2）
 *
 * 数据来源：星铁官方客户端解包（经 Mar-7th/StarRailRes 转储）。
 * 与原神的差别要说清楚，否则前端会以为能查到剧情：
 *   · 没有观测枢词条库（米哈游没给星铁做观测枢，我系统验证过：
 *     hoyowiki 的所有游戏段名全 404，米游社 sr/wiki 是纯客户端渲染 SPA）
 *   · 没有剧情对话文本（TextMap 拿不到），所以 chat/research 的能力不能报 true
 *   · 有的是：角色 / 光锥 / 遗器 / 材料 / 成就 / 模拟宇宙 的完整图鉴 + 图
 */
export const starrail = Object.freeze({
  id: 'starrail', label: '星穹铁道', theme: 'stellar',
  entities: ['character', 'light_cone', 'relic', 'item', 'achievement', 'simulated_event'],
  capabilities: {
    chat: false,      // 没有剧情/对话语料，硬答会编
    research: false,  // 同上，没有可引用的原文
    growth: true,     // 材料/行迹/星魂数据齐
    media: true,      // 立绘/图标齐
  },
  spoilerScopes: [],
  spoilerNotice: '星铁侧目前只有图鉴数据（角色/光锥/遗器/材料/成就/模拟宇宙），剧情文本尚未接入。',
});

export class GameRegistry {
  constructor(adapters = [genshin, starrail]) {
    this.adapters = new Map(adapters.map(a => [a.id, a]));
  }
  get(id = 'genshin') {
    const game = this.adapters.get(id);
    if (!game) throw Object.assign(new Error('该游戏尚未接入'), { status: 400, code: 'unknown_game' });
    return game;
  }
  /** 游戏 id → db 里的 game_id（games 表：1=genshin 2=starrail 3=zzz） */
  numericId(id) {
    const order = [...this.adapters.keys()];
    const i = order.indexOf(id);
    return i < 0 ? null : i + 1;
  }
  scope(owner, gameId, sessionId) {
    this.get(gameId);
    return JSON.stringify([owner, gameId, String(sessionId).slice(0, 100)]);
  }
  list() {
    // 只列 db 里 enabled=1 的（games 表是权威；这里按注册顺序对齐 game_id）
    return [...this.adapters.values()].map(({ retrieve, plan, ...meta }) => meta);
  }
}
