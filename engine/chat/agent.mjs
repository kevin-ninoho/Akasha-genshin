// 原神知识库 · 对话编排
//
// 一次对话的完整链路：
//   用户问题 -> 实体/意图识别 -> 分区检索 -> 资料组装 -> 生成（或降级检索模式）
//   -> 流式吐出 -> 附带可跳转的引用来源
//
// 会话状态只放在内存里（本地单用户工具，不需要落库）：
//   - history：最近若干轮问答，用于代词/省略（「他的语音呢」）
//   - lastEntities：上一轮提到的角色，用于承接

import { createRetriever, assembleContext, DEFAULT_BUDGET } from './retrieve.mjs';
import { buildMessages, extractiveAnswer } from './prompt.mjs';
import { loadConfig, loadChain, resolveProvider, streamChat } from './llm.mjs';
import { corpusRevision } from '../lib/corpus-revision.mjs';

const MAX_SESSIONS = 200;
const HISTORY_TURNS = 3;        // 保留最近 3 轮
const HISTORY_MSG_MAX = 900;    // 单条历史消息截断

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把底层报错压成一句能给用户看的话，别把整个堆栈糊到界面上。 */
function briefErr(err) {
  const m = String((err && err.message) || err || '未知错误');
  return m.length > 120 ? m.slice(0, 120) + '…' : m;
}

const sessions = new Map();

function sessionOf(id) {
  const key = String(id || 'default');
  let s = sessions.get(key);
  if (!s) {
    s = { id: key, history: [], lastEntities: [], updatedAt: Date.now() };
    sessions.set(key, s);
    // 简单的容量控制：超了就丢最旧的
    if (sessions.size > MAX_SESSIONS) {
      let oldest = null;
      for (const [k, v] of sessions) if (!oldest || v.updatedAt < oldest[1].updatedAt) oldest = [k, v];
      if (oldest) sessions.delete(oldest[0]);
    }
  }
  return s;
}

export function resetSession(id) {
  sessions.delete(String(id || 'default'));
}

export function sessionCount() {
  return sessions.size;
}

/**
 * 执行一次对话，返回 async generator（事件流）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir chat 模块所在目录（用于读 llm.config.json）
 * @param {{sessionId:string, message:string, budget?:number, think?:boolean, signal?:AbortSignal}} input
 */
export async function* runChat(db, dir, input) {
  const started = Date.now();
  const question = String(input.message || '').trim();
  if (!question) {
    yield { type: 'error', message: '问题不能为空' };
    return;
  }

  const session = sessionOf(input.sessionId);
  // 只传 obcDb。以前这里传的是 (db, input.storyDb, input.obcDb)，
  // 但 retrieve.mjs 的 createRetriever 早就从 (db, storyDb, obcDb) 收敛成了
  // (db, obcDb)——《日月全事》移除后 storyDb 不再需要。多传一个参数的结果是
  // obcDb 收到 null，观测枢那条通路整个失效（表现：书籍类引用点不出官方链接）。
  const retriever = getRetriever(db, input.obcDb);
  const budget = Number.isFinite(input.budget) ? input.budget : DEFAULT_BUDGET;

  // ---------------------------------------------------------- 检索
  let result;
  try {
    result = retriever.retrieve(question, {
      inherited: session.lastEntities,
      // 预算是给检索器分人头用的：问题里点十来个角色时，它按人头分摊正文长度，
      // 保证每个实体都进得了 assembleContext 的预算（见 retrieve.mjs 的多实体分摊）。
      budget,
    });
  } catch (err) {
    yield { type: 'error', message: `检索失败：${err.message}` };
    return;
  }

  const ctx = assembleContext(result.sources, budget);

  // 联网兜底结果（由 serve-client 在「库内检索为空」时预先搜好传进来）。
  // 拼在知识库上下文**后面**，并且带着明确的「这是网络内容」提示，
  // 让模型知道哪些可回溯、哪些不可回溯。没传就完全不影响原行为。
  if (input.webContext) {
    ctx.text = String(ctx.text || '') + '\n\n' + String(input.webContext);
  }

  if (result.entities.length) session.lastEntities = result.entities;

  yield {
    type: 'meta',
    entities: result.entities,
    scopes: result.scopes,
    keywords: result.keywords,
    // 覆盖回报：识别到哪些条目、哪些取到了资料、哪些没取到。
    // 客户端可以拿它显示「这次查了谁」，提示词用它挡住「知识库里没有 X」。
    coverage: result.coverage,
    sourceCount: ctx.kept.length,
    contextChars: ctx.chars,
    retrievalMs: Date.now() - started,
  };
  yield { type: 'sources', sources: ctx.kept };

  // ---------------------------------------------------------- 生成
  //
  // 「随时保持在线，不要降级」的落地方式：
  //   主模型重试 → 换备用**真模型** → 两条都不行才退回检索模式。
  // 摘录不是回答，用户要的是答案，所以链上每一环都必须是能生成的模型。
  //
  // 一条硬约束：一旦已经向客户端吐过正文，就绝不再重试、也不再补内容 ——
  // 客户端手里已经有半截正文了，再补一段只会拼成前后矛盾的怪物。
  const cfg = loadConfig(dir);
  const chain = loadChain(dir);
  const resolved = await resolveProvider(cfg);

  yield {
    type: 'provider',
    provider: resolved.provider,
    model: resolved.model || '',
    reason: resolved.reason,
  };

  let answer = '';
  let reasoning = '';
  let emitted = false;        // 是否已经吐过正文（决定还能不能重试 / 换链路）
  let used = null;            // 真正出字的那条链路
  let lastErr = null;
  let finalProvider = resolved.provider;
  let forceNoThinking = false;
  let attemptCount = 0;
  let failed = false;

  // 检索模式的分块吐字，保持前端体验一致
  function* streamExtractive() {
    finalProvider = 'extractive';
    answer = extractiveAnswer(question, ctx.kept, { entities: result.entities, coverage: result.coverage });
    const step = 120;
    for (let i = 0; i < answer.length; i += step) {
      if (input.signal && input.signal.aborted) break;
      yield { type: 'delta', text: answer.slice(i, i + step) };
    }
  }

  if (resolved.provider === 'extractive') {
    // 配置里显式写了 provider: extractive —— 这是用户的选择，不是故障降级
    yield* streamExtractive();
  } else {
    // input.blockHint 由调用方（serve-client 的 /v1/chat）在闸门放行后、生成开始前写入：
    // 那时已经知道界面要展示哪些结构化块，据此告诉模型「别复述」。
    // coverage 同理：把「谁被识别到、谁没取到资料」摆在资料后面，挡住「知识库里没有 X」。
    const messages = buildMessages(question, ctx.text, session.history, {
      blockHint: input.blockHint,
      coverage: result.coverage,
    });
    for (let li = 0; li < chain.length && !used && !input.signal?.aborted; li++) {
      const link = chain[li];
      const attempts = link.role === 'primary' ? 3 : 2;
      for (let a = 0; a < attempts; a++) {
        const tAttempt = Date.now();
        let attemptReasoning = '';
        const retry = attemptCount++ > 0;
        try {
          for await (const ev of streamChat(link.cfg, messages, {
            model: link.model,
            think: forceNoThinking ? false : input.think,
            signal: input.signal,
          })) {
            if (ev.type === 'delta') { emitted = true; answer += ev.text; yield ev; }
            else if (ev.type === 'thinking') {
              attemptReasoning += ev.text;
              if (!retry) { reasoning += ev.text; yield ev; }
            }
            else if (ev.type === 'end') answer = ev.text || answer;
          }
          if (!String(answer).trim()) {
            if (attemptReasoning.length) forceNoThinking = true;
            const err = new Error('生成服务结束但未返回回答正文');
            err.code = 'EMPTY_ANSWER';
            throw err;
          }
          used = link;
          break;
        } catch (err) {
          lastErr = err;
          if (input.signal && input.signal.aborted) break;
          if (emitted) break;                          // 已经吐字：不能再重试
          // 只重试「秒失败」——连接被拒、DNS 挂了、立刻 5xx。
          // 如果这一次已经耗掉真时间（多半是上游卡住），再等一轮只会让用户干等，
          // 直接翻到备用链路更划算。
          if (err.code !== 'EMPTY_ANSWER' && Date.now() - tAttempt > 15000) break;
          if (a + 1 < attempts) await sleep(400 * (a + 1));
        }
      }
      if (used || emitted || input.signal?.aborted) break;
      if (li + 1 < chain.length) {
        yield {
          type: 'provider',
          provider: 'openai',
          model: chain[li + 1].model || '',
          reason: `${link.role === 'primary' ? '主模型' : '备用模型'}不可用（${briefErr(lastErr)}），已切换到备用链路`,
        };
      }
    }

    if (!used) {
      if (emitted || input.signal?.aborted) {
        // 吐字之后才断的：补摘录只会把答案拼花，只能如实报错让用户重问
        finalProvider = 'interrupted';
        failed = true;
        yield { type: 'error', message: `生成中断：${briefErr(lastErr)}。请重试。` };
      } else {
        // 所有生成链路都没出字 —— 最后的兜底，明确标记成检索模式
        yield {
          type: 'provider',
          provider: 'extractive',
          model: '',
          reason: `所有生成模型均不可用（${briefErr(lastErr)}），已退回检索模式`,
        };
        yield* streamExtractive();
      }
    }
  }

  if (!String(answer).trim()) {
    failed = true;
    yield { type: 'error', message: input.signal?.aborted ? '生成已停止' : '没有取得可用的回答正文，请重试。' };
  }

  // ---------------------------------------------------------- 收尾
  if (!failed) {
    session.history.push({ role: 'user', content: question.slice(0, HISTORY_MSG_MAX) });
    session.history.push({ role: 'assistant', content: String(answer).slice(0, HISTORY_MSG_MAX) });
  }
  const keep = HISTORY_TURNS * 2;
  if (session.history.length > keep) session.history = session.history.slice(-keep);
  session.updatedAt = Date.now();

  yield {
    type: 'done',
    // 报真正干活的 provider，不是「本来打算用的那个」——这两者以前会对不上
    provider: finalProvider,
    model: used ? used.model || '' : '',
    degraded: finalProvider === 'extractive' || !String(answer).trim(),
    failed,
    answer,
    reasoningChars: reasoning.length,
    elapsedMs: Date.now() - started,
  };
}

// retriever 需要 db 才能建索引，按进程缓存一份。
// obcDb 是侧车库连接（观测枢官方图鉴），没有时传 null，观测枢那一路会自动跳过。
// 缓存键必须带上它，否则先建的那份（obcDb 为 null）会把后来的连接吃掉 ——
// 这一点在本文件里踩过：参数从 3 个收敛到 2 个时调用方没跟着改，obcDb 一直是 null。
let cached = null;
let cachedKey = '';
function getRetriever(db, obcDb = null) {
  const key = `${obcDb ? 1 : 0}:${corpusRevision()}`;
  if (!cached || cachedKey !== key) {
    cached = createRetriever(db, obcDb);
    cachedKey = key;
  }
  return cached;
}

export function invalidateRetriever() {
  cached = null;
}
