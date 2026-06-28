const Groq = require('groq-sdk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SYSTEM_PROMPT } = require('./prompts');
const { getHistory, addMessage, getLang, getSelectedModel, getEffectivePlan, addTokenUsage } = require('./db');
const { getPlanConfig, getModelInfo } = require('./plans');

// ─── Model versiya nomlari (foydalanuvchiga ko'rinadigan) ─────────────────
const MODEL_VERSIONS = {
  'llama-3.1-8b-instant':                      'MortisAI 2.5',
  'llama-3.3-70b-versatile':                   'MortisAI 3.0',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'MortisAI 4.0',
  'openai/gpt-oss-120b':                       'MortisAI 5.0',
  'qwen/qwen3-32b':                            'MortisAI 6.0',
};

// ─── Groq TPM limitlari (free tier) ──────────────────────────────────────
const MODEL_TPM = {
  'llama-3.1-8b-instant':                      14400,
  'llama-3.3-70b-versatile':                   12000,
  'meta-llama/llama-4-scout-17b-16e-instruct': 30000,
  'openai/gpt-oss-120b':                        6000,
  'qwen/qwen3-32b':                            12000,
};

// ─── Key pool parser ──────────────────────────────────────────────────────
// .env:
//   GROQ_API_KEY_FREE=key1,key2
//   GROQ_API_KEY_PRO=key3,key4,key5,key6
//   GROQ_API_KEY_MAX=key7,key8,key9,key10
function parseKeys(envVar, poolName) {
  return (process.env[envVar] || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((key, i) => ({
      label: `${poolName}#${i + 1}`,
      client: new Groq({ apiKey: key }),
      modelUsage: {},
      totalRequests: 0,
      totalTokens: 0,
      errors429: 0,
    }));
}

const KEY_POOLS = {
  free: parseKeys('GROQ_API_KEY_FREE', 'free'),
  pro:  parseKeys('GROQ_API_KEY_PRO',  'pro'),
  max:  parseKeys('GROQ_API_KEY_MAX',  'max'),
};

const MODEL_KEY_COUNTS = {
  'llama-3.1-8b-instant': 2,
  'llama-3.3-70b-versatile': 4,
  'meta-llama/llama-4-scout-17b-16e-instruct': 6,
  'openai/gpt-oss-120b': 8,
  'qwen/qwen3-32b': 10,
  'whisper-large-v3-turbo': 10,
};

const _modelCursors = {};

function allKeysFlat() {
  return [...KEY_POOLS.max, ...KEY_POOLS.pro, ...KEY_POOLS.free];
}

function poolForModel(model) {
  const allKeys = allKeysFlat();
  if (!allKeys.length) throw new Error('Hech qanday Groq API key topilmadi! .env ni tekshiring.');
  const count = MODEL_KEY_COUNTS[model] || 2;
  const pool = allKeys.slice(0, Math.min(count, allKeys.length));
  
  if (_modelCursors[model] === undefined) _modelCursors[model] = 0;
  return { pool, cp: model };
}

// ─── Token hisob ──────────────────────────────────────────────────────────
function recordUsage(keyObj, model, usage) {
  if (!usage) return 0;
  const tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  keyObj.totalRequests += 1;
  keyObj.totalTokens   += tokens;
  const now = Date.now();
  if (!keyObj.modelUsage[model]) {
    keyObj.modelUsage[model] = { tokens: 0, resetAt: now + 60_000 };
  }
  const mu = keyObj.modelUsage[model];
  if (now >= mu.resetAt) { mu.tokens = 0; mu.resetAt = now + 60_000; }
  mu.tokens += tokens;
  return tokens;
}

function getModelUsagePct(keyObj, model) {
  const mu = keyObj.modelUsage[model];
  if (!mu || Date.now() >= mu.resetAt) return 0;
  return Math.min(100, Math.round((mu.tokens / (MODEL_TPM[model] || 14400)) * 100));
}

function getKeysStatus() {
  const result = [];
  for (const [planName, pool] of Object.entries(KEY_POOLS)) {
    for (const k of pool) {
      const now = Date.now();
      const modelStats = Object.entries(k.modelUsage).map(([model, mu]) => {
        const limit = MODEL_TPM[model] || 14400;
        const tokens = now >= mu.resetAt ? 0 : mu.tokens;
        return {
          model,
          version: MODEL_VERSIONS[model] || model,
          tokens,
          limit,
          pct: Math.min(100, Math.round((tokens / limit) * 100)),
          resetIn: Math.max(0, Math.round((mu.resetAt - now) / 1000)),
        };
      });
      result.push({
        pool: planName,
        label: k.label,
        totalRequests: k.totalRequests,
        totalTokens: k.totalTokens,
        errors429: k.errors429,
        modelStats,
      });
    }
  }
  return result;
}

// ─── Groq call ────────────────────────────────────────────────────────────
const VISION_MODEL  = 'meta-llama/llama-4-scout-17b-16e-instruct';
const WHISPER_MODEL = 'whisper-large-v3-turbo';

async function callGroqForUser(userId, baseMessages) {
  const { plan } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  const preferred = getSelectedModel(userId);
  const modelOrder = [preferred, ...cfg.models.filter((m) => m !== preferred)];

  // baseMessages[0] is a placeholder system message; we rebuild it per-model
  // below so each model gets its own style/temperature.
  const lang = getLang(userId);
  const historyTail = baseMessages.slice(1);

  let lastErr;
  for (const model of modelOrder) {
    const info = getModelInfo(model);
    const { pool, cp } = poolForModel(model);
    const start = _modelCursors[cp] % pool.length;
    const ordered = [...pool.slice(start), ...pool.slice(0, start)];
    _modelCursors[cp] = (start + 1) % pool.length;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT(lang, info.style) },
      ...historyTail,
    ];

    for (const keyObj of ordered) {
      if (getModelUsagePct(keyObj, model) >= 95) {
        console.log(`[${keyObj.label}] ${MODEL_VERSIONS[model] || model}: TPM 95% — o'tkazildi`);
        continue;
      }
      try {
        const isReasoningModel = model === 'qwen/qwen3-32b';
        const res = await keyObj.client.chat.completions.create({
          model,
          messages,
          max_tokens: 4096,
          temperature: info.temperature,
          top_p: 0.95,
          // Qwen3 is a hybrid reasoning model — "hidden" strips the <think>
          // chain-of-thought from the visible answer so users only see the
          // final, polished response (the thinking still happens server-side).
          ...(isReasoningModel ? { reasoning_format: 'hidden' } : {}),
        });
        const tokens = recordUsage(keyObj, model, res.usage);
        addTokenUsage(userId, tokens);
        const content = res.choices[0]?.message?.content || '⚠️ No response.';
        return { content, modelUsed: model };
      } catch (err) {
        lastErr = err;
        if (err.status === 429) {
          keyObj.errors429 += 1;
          const limit = MODEL_TPM[model] || 14400;
          if (!keyObj.modelUsage[model]) {
            keyObj.modelUsage[model] = { tokens: limit, resetAt: Date.now() + 60_000 };
          } else {
            keyObj.modelUsage[model].tokens = limit;
            keyObj.modelUsage[model].resetAt = Date.now() + 60_000;
          }
          console.log(`[${keyObj.label}] ${MODEL_VERSIONS[model] || model}: 429 — keyingisiga o'tyapman...`);
          continue; // try next key for the SAME model first
        }
        if (err.status === 413 || err.status === 503) { continue; }
        throw err;
      }
    }
    // all keys exhausted for this model — fall through to next model in order
  }
  throw lastErr || new Error('Barcha keylar band.');
}

// ─── askAI ────────────────────────────────────────────────────────────────
async function askAI(userId, userMessage) {
  addMessage(userId, 'user', userMessage);
  const { content: reply } = await callGroqForUser(userId, [
    { role: 'system', content: '' }, // placeholder, rebuilt per-model in callGroqForUser
    ...getHistory(userId),
  ]);
  addMessage(userId, 'assistant', reply);
  return reply;
}

// ─── analyzeImage ─────────────────────────────────────────────────────────
async function analyzeImage(userId, base64Image, mimeType, caption) {
  const lang = getLang(userId);
  const prompts = {
    ru: 'Проанализируй это изображение подробно. Если это код — найди ВСЕ ошибки и дай полный исправленный код. Если это скриншот ошибки — объясни причину и дай решение. Если это просто фото — опиши, что видишь, и при необходимости дай полезный совет.',
    uz: "Bu rasmni batafsil tahlil qiling. Agar kod bo'lsa — barcha xatolarni topib, to'liq tuzatilgan kodni bering. Agar xatolik skrinshoti bo'lsa — sababini va yechimini tushuntiring. Oddiy rasm bo'lsa — nima ko'rinayotganini tasvirlab, foydali maslahat bering.",
    en: "Analyze this image in detail. If it's code — find ALL bugs and give the complete fixed code. If it's an error screenshot — explain the cause and the fix. If it's a regular photo — describe what you see and give useful insight if relevant.",
  };
  const prompt = caption || prompts[lang] || prompts.ru;
  addMessage(userId, 'user', `[Image] ${caption || 'analyze'}`);

  const { plan } = getEffectivePlan(userId);
  const { pool } = poolForModel(VISION_MODEL);
  const visionInfo = getModelInfo(VISION_MODEL);

  let lastErr;
  for (const keyObj of pool) {
    try {
      const res = await keyObj.client.chat.completions.create({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT(lang, visionInfo.style) },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
              { type: 'text', text: prompt },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: visionInfo.temperature,
      });
      const tokens = recordUsage(keyObj, VISION_MODEL, res.usage);
      addTokenUsage(userId, tokens);
      const reply = res.choices[0]?.message?.content || '⚠️ Could not analyze.';
      addMessage(userId, 'assistant', reply);
      return reply;
    } catch (err) {
      lastErr = err;
      if (err.status === 429) { keyObj.errors429 += 1; continue; }
      if (err.status === 413) {
        const msgs = {
          ru: '⚠️ Лимит. Попробуйте через минуту.',
          uz: "⚠️ Limit. Bir daqiqadan keyin urinib ko'ring.",
          en: '⚠️ Limit reached. Try again in a minute.',
        };
        return msgs[lang] || msgs.ru;
      }
      throw err;
    }
  }
  const msgs = {
    ru: '⚠️ Все ключи перегружены. Попробуйте через минуту.',
    uz: "⚠️ Barcha kalitlar band. Bir daqiqadan keyin urinib ko'ring.",
    en: '⚠️ All keys rate-limited. Try again in a minute.',
  };
  return msgs[lang] || msgs.ru;
}

// ─── transcribeAudio ──────────────────────────────────────────────────────
async function transcribeAudio(buffer, filename = 'voice.ogg') {
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${filename}`);
  fs.writeFileSync(tmpPath, buffer);
  const { pool } = poolForModel(WHISPER_MODEL);
  let lastErr;
  for (const keyObj of pool) {
    try {
      const tr = await keyObj.client.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: WHISPER_MODEL,
      });
      keyObj.totalRequests += 1;
      fs.unlink(tmpPath, () => {});
      return tr.text || '';
    } catch (err) {
      lastErr = err;
      if (err.status === 429) { keyObj.errors429 += 1; continue; }
      fs.unlink(tmpPath, () => {});
      throw err;
    }
  }
  fs.unlink(tmpPath, () => {});
  throw lastErr || new Error('All keys unavailable for transcription.');
}

async function askAIFromVoice(userId, buffer) {
  const text = await transcribeAudio(buffer);
  if (!text.trim()) {
    const lang = getLang(userId);
    const msgs = {
      ru: '⚠️ Не удалось распознать голос.',
      uz: "⚠️ Ovozni tushunib bo'lmadi.",
      en: '⚠️ Could not understand the voice message.',
    };
    return { transcript: '', reply: msgs[lang] || msgs.ru };
  }
  const reply = await askAI(userId, text);
  return { transcript: text, reply };
}

module.exports = { askAI, analyzeImage, askAIFromVoice, transcribeAudio, getKeysStatus, MODEL_VERSIONS };