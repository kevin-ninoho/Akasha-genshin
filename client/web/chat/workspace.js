(function () {
  'use strict';
  let gameId = 'genshin';
  const cache = new Map(), versions = new Map(), pending = new Map(), committed = new Map();
  const timers = new Map(), waiters = new Map();
  let queue = Promise.resolve();
  const status = text => {
    const el = document.getElementById('save-state');
    if (el) { el.textContent = text; el.classList.toggle('save-error', text.includes('失败')); }
  };
  async function api(url, body, options = {}) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(url + sep + 'gameId=' + encodeURIComponent(gameId), body === undefined ? options : {
      ...options, method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const e = new Error(j.error?.message || j.message || '服务不可用，请检查本机连接'); e.status = res.status; throw e;
    }
    return res.json();
  }
  function key(kind, id) { return gameId + '/' + kind + '/' + id; }
  async function get(kind, id, fallback = null) {
    const j = await api('/v1/workspace/' + kind + '/' + id);
    versions.set(key(kind, id), j?.revision || 0);
    cache.set(key(kind, id), j?.data ?? fallback);
    committed.set(key(kind,id),JSON.stringify(j?.data ?? fallback));
    return j?.data ?? fallback;
  }
  async function list(kind) {
    const j = await api('/v1/workspace/' + kind);
    j.items.forEach(x => { versions.set(key(kind, x.id), x.revision); cache.set(key(kind, x.id), x.data);committed.set(key(kind,x.id),JSON.stringify(x.data)); });
    return j.items;
  }
  function put(kind, id, data) {
    const k = key(kind, id), capturedGame = gameId;
    const snapshot = JSON.parse(JSON.stringify(data));
    const signature=JSON.stringify(snapshot);
    cache.set(k, snapshot);
    if(signature===committed.get(k)&&!pending.has(k))return Promise.resolve({id,revision:versions.get(k)||0,data:snapshot});
    pending.set(k, { kind, id, data: snapshot }); status('正在保存…');
    const promise=new Promise((resolve,reject)=>{if(!waiters.has(k))waiters.set(k,[]);waiters.get(k).push({resolve,reject});});
    clearTimeout(timers.get(k));timers.set(k,setTimeout(()=>flush(k,capturedGame),250));
    return promise;
  }
  function flush(k,capturedGame) {
    clearTimeout(timers.get(k));timers.delete(k);
    const action=queue.catch(()=>{}).then(async()=>{
      if(gameId!==capturedGame)throw new Error('游戏已切换，保存暂停');
      while(pending.has(k)){
        const item=pending.get(k),signature=JSON.stringify(item.data);
        const j=await api('/v1/workspace/'+item.kind+'/'+item.id,{revision:versions.get(k)||0,data:item.data});
        versions.set(k,j.revision);committed.set(k,signature);
        if(pending.get(k)===item){pending.delete(k);const list=waiters.get(k)||[];waiters.delete(k);list.forEach(w=>w.resolve(j));}
      }
      status(pending.size?'仍有更改待保存':'已保存到本机');
    }).catch(e=>{const list=waiters.get(k)||[];waiters.delete(k);list.forEach(w=>w.reject(e));status('保存失败 · '+e.message+' · 点击重试');});
    queue=action;
  }
  async function retry() {
    for(const timer of timers.values())clearTimeout(timer);const jobs=[];
    for(const [k,p] of pending){const game=k.split('/')[0];if(game!==gameId)continue;const promise=new Promise((resolve,reject)=>{if(!waiters.has(k))waiters.set(k,[]);waiters.get(k).push({resolve,reject});});jobs.push(promise);flush(k,gameId);}
    await Promise.all(jobs);
  }
  async function remove(kind, id) {
    await api('/v1/workspace/' + kind + '/' + id, { delete: true, revision: versions.get(key(kind, id)) || 0 });
    cache.delete(key(kind, id)); versions.delete(key(kind, id));
  }
  async function init() {
    const migration = await get('preferences', 'migration', {});
    const history = await get('conversations', 'history', []);
    if (!migration.legacyV1 && history.length === 0) {
      let old = [];
      try { old = JSON.parse(localStorage.getItem('dsh-chat-front/conversations/v1') || '[]'); } catch { /* untouched original */ }
      if (Array.isArray(old) && old.length) {
        old.forEach(c => { c.gameId = 'genshin'; (c.messages || []).forEach(m => { if (m.blocksDropped) m.migrationNote = '旧版本已舍弃此卡片，可重新提问恢复'; }); });
        await Promise.all(old.filter(c=>/^[\w-]{1,100}$/.test(c.id)).map(c=>put('conversations','chat-'+c.id,c)));
        const verified = await Promise.all(old.filter(c=>/^[\w-]{1,100}$/.test(c.id)).map(c=>get('conversations','chat-'+c.id)));
        if (verified.some((c,i)=>JSON.stringify(c)!==JSON.stringify(old.filter(x=>/^[\w-]{1,100}$/.test(x.id))[i]))) throw new Error('旧会话迁移核验失败，原记录仍保留');
        await put('conversations', 'history', old.filter(c=>/^[\w-]{1,100}$/.test(c.id)).map(({id,title,at})=>({id,title,at})));
      }
      const roster = localStorage.getItem('akasha.roster.v1');
      if (roster) {
        let r; try { r = JSON.parse(roster); } catch { /* leave original */ }
        if (r?.chars?.length) await put('growth', 'legacy-roster', { title: '原有角色计划', roster: r.chars, target: { level: r.targetLevel || 90 }, inventory: {}, checked: {} });
      }
      await put('preferences', 'migration', { legacyV1: true, at: Date.now(), originalRetained: true });
    }
    status('已保存到本机');
  }
  window.AkashaStore = { api, get, list, put, remove, retry, init, get gameId() { return gameId; },
    peek(kind, id, fallback) { return cache.get(key(kind, id)) ?? fallback; },
    async switchGame(id) {
      await queue;
      if (pending.size) throw new Error('请先保存当前更改');
      const { games } = await api('/v1/games');
      if (!games.some(g => g.id === id)) throw new Error('该游戏尚未接入');
      gameId = id; cache.clear(); versions.clear();
    },
    async loadConversations() {
      const index=await get('conversations','history',[]);
      const rows=await Promise.all(index.filter(x=>x?.id).map(x=>get('conversations','chat-'+x.id)));
      return rows.filter(Boolean);
    },
    async saveConversations(rows) {
      const index=rows.map(({id,title,at})=>({id,title,at}));
      await Promise.all([...rows.map(row=>put('conversations','chat-'+row.id,row)),put('conversations','history',index)]);
    },
    async removeConversation(id) {
      if(!versions.has(key('conversations','chat-'+id)))await get('conversations','chat-'+id);
      if(versions.has(key('conversations','chat-'+id)))await remove('conversations','chat-'+id);
    },
  };
  window.addEventListener('beforeunload', e => { if (pending.size) { e.preventDefault(); e.returnValue = ''; } });
})();
