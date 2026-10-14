// 原神知识库 · 生成模型适配层
//
// 只认一种协议：OpenAI 兼容的 /v1/chat/completions（流式）。
// 这样同一份代码可以接：llama.cpp 的 llama-server、Ollama、vLLM、LM Studio、
// 以及火山方舟 / DeepSeek / 智谱 等云服务 —— 换 provider 只改一处配置文件。
//
// 没有可用模型时，provider = 'extractive'：不生成，直接把检索结果整理成人能读的摘要。
// 这不是占位符，是真实的降级模式，保证「检索 → 展示 → 引用跳转」这条链路始终可用。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  provider: 'auto',                      // auto | openai | extractive
  baseUrl: 'http://127.0.0.1:8080/v1',   // llama-server 默认 8080；Ollama 用 http://127.0.0.1:11434/v1
  apiKey: '',                            // 本地服务留空；云服务填 key
  model: 'koboldcpp/Qwen2.5-7B-Instruct-Q4_K_M',                             // 留空则自动取 /models 的第一项
  temperature: 0.55,
  topP: 0.9,
  maxTokens: 8192,
  timeoutMs: 180000,
  thinking: null,                        // 思考型模型开关：{type:'disabled'} 关思考；null = 用服务端默认
  extraBody: null,                       // 额外透传给 /chat/completions 的字段（厂商私有参数放这里）
};

export function configPath(dir) {
  return process.env.KB_LLM_CONFIG_PATH || path.join(dir, 'llm.config.json');
}

export function loadConfig(dir) {
  const p = configPath(dir);
  let fileCfg = {};
  try {
    if (fs.existsSync(p)) {
      // 记事本/PowerShell 保存的 JSON 常带 UTF-8 BOM，JSON.parse 会直接报错，这里先剥掉
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      fileCfg = JSON.parse(raw);
    }
  } catch (err) {
    console.error('[chat] 模型配置无法读取，已使用本地默认配置。');
  }
  const cfg = { ...DEFAULT_CONFIG, ...fileCfg };
  // 环境变量可临时覆盖，便于换模型不用改文件
  if (process.env.KB_LLM_BASE_URL) cfg.baseUrl = process.env.KB_LLM_BASE_URL;
  if (process.env.KB_LLM_MODEL) cfg.model = process.env.KB_LLM_MODEL;
  if (process.env.KB_LLM_API_KEY) cfg.apiKey = process.env.KB_LLM_API_KEY;
  if (process.env.KB_LLM_PROVIDER) cfg.provider = process.env.KB_LLM_PROVIDER;
  cfg.baseUrl = String(cfg.baseUrl).replace(/\/+$/, '');
  return cfg;
}

/**
 * 把主配置和可选的 fallback 配置拼成一条降级链：主模型 → 备用模型。
 *
 * 「随时保持在线」靠的是换一个**真模型**接着答，而不是退回原文摘录 ——
 * 摘录不是回答，用户要的是答案。所以链上每一环都是能生成的模型。
 *
 * llm.config.json 里写成：
 *   "fallback": { "baseUrl": "http://127.0.0.1:8080/v1", "model": "...", "timeoutMs": 300000 }
 * 不写 fallback 就只有一环。
 *
 * @returns {Array<{role:'primary'|'fallback', cfg:object, model:string}>}
 */
export function loadChain(dir) {
  const cfg = loadConfig(dir);
  const chain = [{ role: 'primary', cfg, model: cfg.model }];
  const fb = cfg.fallback;
  if (fb && typeof fb === 'object' && !Array.isArray(fb)) {
    const merged = { ...cfg, ...fb };
    delete merged.fallback;
    merged.baseUrl = String(merged.baseUrl).replace(/\/+$/, '');
    // 备用链路跟主链路完全一样就没意义，跳过
    if (merged.baseUrl !== cfg.baseUrl || merged.model !== cfg.model) {
      chain.push({ role: 'fallback', cfg: merged, model: merged.model });
    }
  }
  return chain;
}

export function saveConfig(dir, patch) {
  const cfg = { ...loadConfig(dir), ...patch };
  fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return cfg;
}

function headers(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

/**
 * 决定这次请求是否附带思考开关。
 * - think === true  -> {type:'enabled'}
 * - think === false -> {type:'disabled'}
 * - think 未指定     -> 用 cfg.thinking（可为 null = 不下发）
 */
export function resolveThinking(cfg, think) {
  if (think === true) return { type: 'enabled' };
  if (think === false) return { type: 'disabled' };
  const t = cfg && cfg.thinking;
  if (!t) return null;
  if (typeof t === 'string') return { type: t };
  if (typeof t === 'object') return t;
  return null;
}

async function withTimeout(cfg, fn) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** 探测 OpenAI 兼容端点是否活着，返回模型列表（空数组=不可用）。 */
export async function probe(cfg) {
  try {
    const res = await withTimeout({ ...cfg, timeoutMs: Math.min(cfg.timeoutMs, 6000) }, (signal) =>
      fetch(`${cfg.baseUrl}/models`, { headers: headers(cfg), signal })
    );
    if (!res.ok) return { ok: false, status: res.status, models: [] };
    const body = await res.json().catch(() => null);
    const models = (body && body.data ? body.data : [])
      .map((m) => m && m.id).filter(Boolean);
    return { ok: true, status: res.status, models };
  } catch (err) {
    return { ok: false, status: 0, models: [], error: err.message };
  }
}

/** 决定这次请求到底用哪个 provider。 */
export async function resolveProvider(cfg) {
  if (cfg.provider === 'extractive') return { provider: 'extractive', reason: '配置指定检索模式' };
  const p = await probe(cfg);
  if (p.ok) {
    const model = cfg.model || p.models[0] || '';
    return { provider: 'openai', model, models: p.models, reason: '已连接本地/远程 OpenAI 兼容服务' };
  }
  if (cfg.provider === 'openai') {
    return {
      provider: 'openai', model: cfg.model,
      reason: '无法连接已配置的生成模型，请检查模型服务。',
      unreachable: true,
    };
  }
  return {
    provider: 'extractive',
    reason: '未检测到生成模型，已降级为检索模式。',
  };
}

/**
 * 流式生成。返回 async generator，逐段 yield 文本增量。
 * 事件类型：
 *   {type:'delta',    text}  —— 回答正文增量
 *   {type:'thinking', text}  —— 思考链增量（思考型模型才会有，前端可折叠展示）
 *   {type:'finish',   reason}
 *   {type:'end',      text}  —— 正文全量
 * @param {object} cfg 配置
 * @param {Array<{role:string,content:string}>} messages
 * @param {{model?:string, signal?:AbortSignal, think?:boolean}} opts
 *        think=true 强制开思考；think=false 强制关思考；留空则用 cfg.thinking
 */
export async function* streamChat(cfg, messages, opts = {}) {
  const model = opts.model || cfg.model;
  const payload = {
    model,
    messages,
    stream: true,
    temperature: cfg.temperature,
    top_p: cfg.topP,
    max_tokens: cfg.maxTokens,
  };

  // 思考开关：请求级 think 覆盖配置里的 thinking
  const thinking = resolveThinking(cfg, opts.think);
  if (thinking) payload.thinking = thinking;

  // 厂商私有参数透传（例如方舟的 thinking、通义的 enable_search 等）
  if (cfg.extraBody && typeof cfg.extraBody === 'object' && !Array.isArray(cfg.extraBody)) {
    for (const [k, v] of Object.entries(cfg.extraBody)) {
      if (v !== undefined) payload[k] = v;
    }
  }
  // Explicit request-level choice wins over vendor defaults, including recovery.
  if (opts.think !== undefined) {
    payload.thinking = resolveThinking(cfg, opts.think);
    if ('enable_thinking' in payload) payload.enable_thinking = opts.think;
    if (payload.chat_template_kwargs && typeof payload.chat_template_kwargs === 'object') {
      payload.chat_template_kwargs = { ...payload.chat_template_kwargs, enable_thinking: opts.think };
    }
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(payload),
    signal: AbortSignal.any([AbortSignal.timeout(cfg.timeoutMs || 180000), ...(opts.signal ? [opts.signal] : [])]),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`生成服务返回 HTTP ${res.status}，请检查模型配置或稍后重试。`);
  }
  if (!res.body) throw new Error('生成服务没有返回流式响应体');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let full = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      // 兼容两种流派：delta.content（标准）与 delta.reasoning_content（思考型模型）
      const piece = delta.content || '';
      if (piece) { full += piece; yield { type: 'delta', text: piece }; }
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      if (reasoning) yield { type: 'thinking', text: reasoning };
      if (choice.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
    }
  }

  // 收尾：把剩余 buffer 里可能的最后一行 data 处理掉
  const tail = buf.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data && data !== '[DONE]') {
      try {
        const json = JSON.parse(data);
        const piece = json.choices && json.choices[0] && json.choices[0].delta
          && json.choices[0].delta.content;
        if (piece) { full += piece; yield { type: 'delta', text: piece }; }
      } catch { /* 忽略不完整的尾部 */ }
    }
  }

  yield { type: 'end', text: full };
}
