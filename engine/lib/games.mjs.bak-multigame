export const genshin = Object.freeze({
  id: 'genshin', label: '原神', theme: 'astral',
  entities: ['character', 'book', 'obc'],
  capabilities: { chat: true, research: true, growth: true, media: true },
  spoilerScopes: [], spoilerNotice: '当前资料缺少可靠的章节标注，尚未过滤剧透。',
});
export class GameRegistry {
  constructor(adapters = [genshin]) {
    this.adapters = new Map(adapters.map(a => [a.id, a]));
  }
  get(id = 'genshin') {
    const game = this.adapters.get(id);
    if (!game) throw Object.assign(new Error('该游戏尚未接入'), { status: 400, code: 'unknown_game' });
    return game;
  }
  scope(owner, gameId, sessionId) {
    this.get(gameId);
    return JSON.stringify([owner, gameId, String(sessionId).slice(0, 100)]);
  }
  list() { return [...this.adapters.values()].map(({ retrieve, plan, ...meta }) => meta); }
}
