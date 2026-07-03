const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const { askAI, analyzeImage, askAIFromVoice, getKeysStatus } = require('./ai');
const {
  clearSession,
  getLang,
  setLang,
  getRecentMessages,
  ensureUser,
  checkAndIncrementUsage,
  getTokenUsageInfo,
  getUsageInfo,
  getSelectedModel,
  setSelectedModel,
  getEffectivePlan,
  isGroupActivated,
  isAdmin,
  setPendingAction,
  getPendingAction,
  clearPendingAction,
} = require('./db');
const { TEXTS } = require('./prompts');
const { getPlanConfig, getModelInfo } = require('./plans');
const { registerPayments, premiumKeyboard, groupActivateKeyboard } = require('./payments');
const { registerAdmin } = require('./admin');
const { notifyNewUser, notifyFeedback } = require('./notifications');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

function stripHTML(text) {
  return text
    .replace(/<b>([\s\S]*?)<\/b>/g, '$1')
    .replace(/<i>([\s\S]*?)<\/i>/g, '$1')
    .replace(/<code>([\s\S]*?)<\/code>/g, '$1')
    .replace(/<pre>([\s\S]*?)<\/pre>/g, '$1')
    .replace(/<[^>]+>/g, '');
}

function escapeHTML(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mainKeyboard(userId) {
  const lang = getLang(userId) || 'ru';
  const t = TEXTS[lang].menu;
  const layout = [
    [t.history, t.model],
    [t.premium, t.lang],
    [t.feedback, t.report],
    [t.clear, t.help],
  ];
  if (isAdmin(userId)) {
    layout.push(['🛠 Admin']);
  }
  return Markup.keyboard(layout).resize();
}

function langInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback("🇺🇿 O'zbekcha", 'lang_uz')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')],
  ]);
}

// ---- Model version display (sourced from plans.js MODEL_INFO) ----
const ALL_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-120b',
  'qwen/qwen3-32b',
];

function modelLabel(model, lang) {
  const info = getModelInfo(model);
  const tagline = (TEXTS[lang] && TEXTS[lang].modelTaglines && TEXTS[lang].modelTaglines[model]) || info.tagline;
  return `${info.emoji} ${info.version} — ${tagline}`;
}

function modelKeyboard(userId) {
  const lang = getLang(userId);
  const { plan } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  const current = getSelectedModel(userId);

  const buttons = ALL_MODELS.map((model) => {
    const label = modelLabel(model, lang);
    const allowed = cfg.models.includes(model);
    const marker = model === current ? ' ✅' : '';
    const text = allowed ? `${label}${marker}` : `${label} 🔒`;
    return [Markup.button.callback(text, `model_${encodeURIComponent(model)}`)];
  });

  return Markup.inlineKeyboard(buttons);
}

// ---- middleware: ensure user exists, notify on first /start ----
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const isNew = ensureUser(ctx.from);
    if (isNew) {
      try {
        await notifyNewUser(bot, ctx.from);
      } catch (e) {
        console.error('notifyNewUser failed:', e);
      }
    }
  }
  return next();
});

async function sendChunk(ctx, text, extra = {}) {
  try {
    await ctx.replyWithHTML(text, extra);
  } catch {
    try {
      await ctx.reply(stripHTML(text), extra);
    } catch (e) {
      console.error('sendChunk failed:', e.message);
    }
  }
}

function formatCodeBlocks(text) {
  if (!text) return text;
  return text
    .replace(/```([a-zA-Z0-9_\-+]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      lang = lang ? ` class="language-${lang.trim()}"` : '';
      return `<pre><code${lang}>${escapeHTML(code)}</code></pre>`;
    })
    .replace(/`([^`]+)`/g, (match, code) => {
      return `<code>${escapeHTML(code)}</code>`;
    });
}

async function sendLongMessage(ctx, text, extra = {}) {
  const MAX = 3800;
  if (text.length <= MAX) {
    return sendChunk(ctx, formatCodeBlocks(text), extra);
  }

  const parts = text.split(/(```[\s\S]*?```)/g);
  let current = '';
  const chunks = [];

  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (!part) continue;

    if (i % 2 === 0) {
      const paragraphs = part.split('\n\n');
      for (let j = 0; j < paragraphs.length; j++) {
        const para = paragraphs[j];
        const next = current ? `${current}${j===0 ? '' : '\n\n'}${para}` : para;
        if (next.length > MAX) {
           if (current) chunks.push(current);
           current = para;
        } else {
           current = next;
        }
      }
    } else {
      if (current.length + part.length > MAX) {
        if (current) chunks.push(current);
        if (part.length > MAX) {
          chunks.push(part.substring(0, MAX) + '\n```');
          current = '```\n' + part.substring(MAX);
        } else {
          current = part;
        }
      } else {
        current += part;
      }
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await sendChunk(ctx, formatCodeBlocks(chunks[i]), isLast ? extra : {});
  }
}

async function sendWithLoading(ctx, fn, extra = {}) {
  const lang = getLang(ctx.from.id);
  const loader = await ctx.reply('⏳');
  try {
    const reply = await fn();
    await ctx.telegram.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    const isPrivate = ctx.chat.type === 'private';
    await sendLongMessage(ctx, reply, {
      ...(isPrivate ? { reply_markup: mainKeyboard(ctx.from.id).reply_markup } : {}),
      ...extra,
    });
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    console.error('Handler error:', err.message);
    const t = TEXTS[lang];
    if (err.status === 429) {
      await ctx.reply(t.limit);
    } else {
      await ctx.reply(t.error);
    }
  }
}

async function checkLimitOrNotify(ctx) {
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const t = TEXTS[lang];

  const tokenInfo = getTokenUsageInfo(userId);
  if (tokenInfo.limit !== Infinity && tokenInfo.remaining <= 0) {
    const { plan } = getEffectivePlan(userId);
    const cfg = getPlanConfig(plan);
    const resetTimeStr = new Date(tokenInfo.resetAt).toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', timeZone: 'Asia/Tashkent' });
    await ctx.reply(t.tokenLimitReached(cfg.name, resetTimeStr), {
      parse_mode: 'HTML',
      ...premiumKeyboard(lang),
    });
    return false;
  }

  const result = checkAndIncrementUsage(userId);
  if (!result.allowed) {
    const cfg = getPlanConfig(result.plan);
    const resetTimeStr = new Date(result.resetAt).toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', timeZone: 'Asia/Tashkent' });
    await ctx.reply(t.dailyLimitReached(cfg.name, resetTimeStr), {
      parse_mode: 'HTML',
      ...premiumKeyboard(lang),
    });
    return false;
  }
  return true;
}

// ---- group helpers ----
function isGroupChat(ctx) {
  return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
}

async function requireGroupActivation(ctx) {
  if (isAdmin(ctx.from.id)) return true;

  const lang = getLang(ctx.from.id);
  if (!isGroupActivated(ctx.chat.id)) {
    await ctx.reply(TEXTS[lang].groupNotActivated, {
      parse_mode: 'HTML',
      ...groupActivateKeyboard(lang),
    });
    return false;
  }
  return true;
}

function isAddressedToBot(ctx) {
  const msg = ctx.message;
  const me = ctx.botInfo?.username;
  if (!msg) return false;

  if (msg.reply_to_message?.from?.id === ctx.botInfo?.id) return true;
  if (me && msg.text && msg.text.toLowerCase().includes(`@${me.toLowerCase()}`)) return true;
  if (me && msg.caption && msg.caption.toLowerCase().includes(`@${me.toLowerCase()}`)) return true;

  return false;
}

function stripMention(text, username) {
  if (!username) return text;
  const re = new RegExp(`@${username}`, 'gi');
  return text.replace(re, '').trim();
}

bot.start(async (ctx) => {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  try {
    await ctx.replyWithHTML(t.welcome(ctx.from?.first_name), mainKeyboard(ctx.from.id));
  } catch {
    await ctx.reply('Hello! I am MortisAI.', mainKeyboard(ctx.from.id));
  }
});

async function doClear(ctx) {
  clearSession(ctx.from.id);
  const lang = getLang(ctx.from.id);
  await ctx.reply(TEXTS[lang].cleared, mainKeyboard(ctx.from.id));
}
bot.command('clear', doClear);

async function doHelp(ctx) {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  try {
    await ctx.replyWithHTML(t.help, mainKeyboard(ctx.from.id));
  } catch {
    await ctx.reply('/start /clear /history /premium /model /feedback /report /help', mainKeyboard(ctx.from.id));
  }
}
bot.command('help', doHelp);

// ---- Premium / plans ----
async function doPremium(ctx) {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  const usage = getUsageInfo(ctx.from.id);
  await ctx.replyWithHTML(t.premiumIntro(usage), premiumKeyboard(lang));
}
bot.command('premium', doPremium);

// ---- Model selection ----
async function doModel(ctx) {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  const current = getSelectedModel(ctx.from.id);
  const { plan } = getEffectivePlan(ctx.from.id);
  const cfg = getPlanConfig(plan);
  await ctx.reply(t.modelChooseTitle(modelLabel(current), cfg.name), {
    parse_mode: 'HTML',
    ...modelKeyboard(ctx.from.id),
  });
}
bot.command('model', doModel);

bot.action(/^model_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const t = TEXTS[lang];
  const model = decodeURIComponent(ctx.match[1]);

  const { plan } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);

  if (!cfg.models.includes(model)) {
    await ctx.answerCbQuery(t.modelLocked, { show_alert: true });
    return;
  }

  setSelectedModel(userId, model);
  await ctx.answerCbQuery('✅');
  await ctx.editMessageText(t.modelSet(modelLabel(model)), { parse_mode: 'HTML' });
});

// ---- Feedback / Report (button-driven via pending state) ----
async function doFeedbackPrompt(ctx) {
  const lang = getLang(ctx.from.id);
  setPendingAction(ctx.from.id, 'user_feedback');
  await ctx.reply(TEXTS[lang].feedbackPrompt, mainKeyboard(ctx.from.id));
}
async function doReportPrompt(ctx) {
  const lang = getLang(ctx.from.id);
  setPendingAction(ctx.from.id, 'user_report');
  await ctx.reply(TEXTS[lang].reportPrompt, mainKeyboard(ctx.from.id));
}

bot.command('feedback', async (ctx) => {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  const text = ctx.message.text.replace(/^\/feedback(@\w+)?\s*/i, '').trim();
  if (!text) return doFeedbackPrompt(ctx);
  await notifyFeedback(bot, ctx.from, text, false);
  await ctx.reply(t.feedbackSent);
});

bot.command('report', async (ctx) => {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  const text = ctx.message.text.replace(/^\/report(@\w+)?\s*/i, '').trim();
  if (!text) return doReportPrompt(ctx);
  await notifyFeedback(bot, ctx.from, text, true);
  await ctx.reply(t.reportSent);
});

// ---- History viewer ----
async function showHistory(ctx) {
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const t = TEXTS[lang];
  const rows = getRecentMessages(userId, 10);

  if (!rows.length) {
    await ctx.reply(t.historyEmpty, mainKeyboard(ctx.from.id));
    return;
  }

  let text = t.historyTitle;
  for (const row of rows) {
    const who = row.role === 'user' ? t.you : t.bot;
    let content = row.content;
    if (content.length > 300) content = content.slice(0, 300) + '…';
    content = escapeHTML(stripHTML(content));
    const date = new Date(row.created_at);
    const time = date.toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-US', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    text += `<b>${who}</b> <i>(${time})</i>\n${content}\n\n`;
  }

  await sendLongMessage(ctx, text, { reply_markup: mainKeyboard(ctx.from.id).reply_markup });
}
bot.command('history', showHistory);

// ---- Language ----
bot.command('lang', async (ctx) => {
  const lang = getLang(ctx.from.id);
  await ctx.reply(TEXTS[lang].chooseLang, langInlineKeyboard());
});

const LANG_NAMES = { ru: '🇷🇺 Русский', uz: "🇺🇿 O'zbekcha", en: '🇬🇧 English' };

for (const code of ['ru', 'uz', 'en']) {
  bot.action(`lang_${code}`, async (ctx) => {
    setLang(ctx.from.id, code);
    await ctx.answerCbQuery(`${LANG_NAMES[code]} ✅`);
    await ctx.editMessageText(TEXTS[code].langChanged);
    await ctx.reply(TEXTS[code].welcome(ctx.from?.first_name), {
      parse_mode: 'HTML',
      ...mainKeyboard(ctx.from.id),
    });
  });
}

// ---- Reply-keyboard buttons (private chats only) ----
// Match against ALL languages' labels so switching language doesn't break
// a keyboard still showing on screen from before the switch.
function inAllLangs(getter) {
  return ['ru', 'uz', 'en'].map((l) => getter(TEXTS[l]));
}

bot.hears(inAllLangs((t) => t.menu.clear), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return doClear(ctx);
});

bot.hears(inAllLangs((t) => t.menu.help), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return doHelp(ctx);
});

bot.hears(inAllLangs((t) => t.menu.history), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return showHistory(ctx);
});

bot.hears(inAllLangs((t) => t.menu.lang), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const lang = getLang(ctx.from.id);
  await ctx.reply(TEXTS[lang].chooseLang, langInlineKeyboard());
});

bot.hears(inAllLangs((t) => t.menu.premium), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return doPremium(ctx);
});

bot.hears(inAllLangs((t) => t.menu.model), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return doModel(ctx);
});

bot.hears(inAllLangs((t) => t.menu.feedback), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return doFeedbackPrompt(ctx);
});

bot.hears(inAllLangs((t) => t.menu.report), async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  return doReportPrompt(ctx);
});

// ---- Admin commands & admin "pending text" interceptor ----
// IMPORTANT: registered BEFORE the generic chat 'text' handler below.
// Telegraf runs middlewares/handlers in registration order, so admin's
// bot.on('text', ...) (which calls next() when there's no pending admin
// action) gets first refusal on every text message from an admin.
registerAdmin(bot);

// ---- Text (generic chat with the AI) ----
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  let text = ctx.message.text;

  // admin button click handler
  if (text === '🛠 Admin' && isAdmin(ctx.from.id)) {
    const { showAdminMenu } = require('./admin');
    if (typeof showAdminMenu === 'function') {
       await ctx.deleteMessage().catch(() => {});
       return await showAdminMenu(ctx);
    }
  }

  if (text.startsWith('/')) return; // unknown commands ignored

  // Pending feedback/report capture (private chats only)
  if (ctx.chat.type === 'private') {
    const pending = getPendingAction(userId);
    if (pending && (pending.type === 'user_feedback' || pending.type === 'user_report')) {
      clearPendingAction(userId);
      const lang = getLang(userId);
      const t = TEXTS[lang];
      const isReport = pending.type === 'user_report';
      await notifyFeedback(bot, ctx.from, text, isReport);
      await ctx.reply(isReport ? t.reportSent : t.feedbackSent, mainKeyboard(ctx.from.id));
      return;
    }
  }

  if (isGroupChat(ctx)) {
    if (!(await requireGroupActivation(ctx))) return;
    if (!isAddressedToBot(ctx)) return; // only respond to mentions/replies in groups
    text = stripMention(text, ctx.botInfo?.username);
    if (!text) return;
  }

  if (!(await checkLimitOrNotify(ctx))) return;

  await ctx.sendChatAction('typing');
  
  let contextText = text;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urls = text.match(urlRegex);
  if (urls) {
    try {
      const urlToFetch = urls[0];
      const res = await axios.get(urlToFetch, { timeout: 5000 });
      let pageText = res.data;
      if (typeof pageText === 'string') {
        pageText = pageText.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                           .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                           .replace(/<[^>]+>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();
        if (pageText.length > 3000) pageText = pageText.substring(0, 3000);
        contextText = `[User provided link content:\n${pageText}]\n\n${text}`;
      }
    } catch (err) {
      console.log('Failed to fetch URL:', err.message);
    }
  }

  await sendWithLoading(ctx, () => askAI(userId, contextText), isGroupChat(ctx) ? { reply_to_message_id: ctx.message.message_id } : {});
});

// ---- Photo ----
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const caption = ctx.message.caption || '';

  if (isGroupChat(ctx)) {
    if (!(await requireGroupActivation(ctx))) return;
    if (!isAddressedToBot(ctx)) return;
  }

  if (!(await checkLimitOrNotify(ctx))) return;

  await ctx.sendChatAction('typing');
  await sendWithLoading(
    ctx,
    async () => {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const link = await ctx.telegram.getFileLink(photo.file_id);
      const res = await axios.get(link.href, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(res.data).toString('base64');
      return analyzeImage(userId, base64, 'image/jpeg', stripMention(caption, ctx.botInfo?.username));
    },
    isGroupChat(ctx) ? { reply_to_message_id: ctx.message.message_id } : {}
  );
});

// ---- Voice / audio ----
bot.on(['voice', 'audio'], async (ctx) => {
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const fileObj = ctx.message.voice || ctx.message.audio;

  if (isGroupChat(ctx)) {
    if (!(await requireGroupActivation(ctx))) return;
    if (!isAddressedToBot(ctx) && !ctx.message.reply_to_message) return;
  }

  if (!(await checkLimitOrNotify(ctx))) return;

  await ctx.sendChatAction('typing');
  const loader = await ctx.reply(TEXTS[lang].voiceProcessing);

  try {
    const link = await ctx.telegram.getFileLink(fileObj.file_id);
    const res = await axios.get(link.href, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    const { transcript, reply } = await askAIFromVoice(userId, buffer);

    await ctx.telegram.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});

    const labels = {
      ru: '🎙 <i>Распознано:</i>',
      uz: '🎙 <i>Tushunildi:</i>',
      en: '🎙 <i>Transcribed:</i>',
    };
    const prefix = transcript ? `${labels[lang]} ${escapeHTML(transcript)}\n\n` : '';
    const isPrivate = ctx.chat.type === 'private';

    await sendLongMessage(ctx, prefix + reply, {
      ...(isPrivate ? { reply_markup: mainKeyboard(ctx.from.id).reply_markup } : {}),
      ...(isGroupChat(ctx) ? { reply_to_message_id: ctx.message.message_id } : {}),
    });
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    console.error('Voice handler error:', err.message);
    await ctx.reply(TEXTS[lang].error);
  }
});

// ---- Documents ----
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const lang = getLang(userId);
  const doc = ctx.message.document;
  const defaultCaptions = {
    ru: 'Найди все ошибки и проблемы в этом файле.',
    uz: 'Bu fayldagi barcha xato va muammolarni topib bering.',
    en: 'Find all bugs and problems in this file.',
  };

  if (isGroupChat(ctx)) {
    if (!(await requireGroupActivation(ctx))) return;
    if (!isAddressedToBot(ctx)) return;
  }

  const caption = ctx.message.caption || defaultCaptions[lang] || defaultCaptions.ru;

  if (doc.file_size > 2 * 1024 * 1024) {
    return ctx.reply(TEXTS[lang].fileTooLarge);
  }

  if (!(await checkLimitOrNotify(ctx))) return;

  await ctx.sendChatAction('typing');
  await sendWithLoading(
    ctx,
    async () => {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      const res = await axios.get(link.href, { responseType: 'text' });
      const prompt = `${stripMention(caption, ctx.botInfo?.username)}\n\nFile: ${doc.file_name}\n<pre>${res.data}</pre>`;
      return askAI(userId, prompt);
    },
    isGroupChat(ctx) ? { reply_to_message_id: ctx.message.message_id } : {}
  );
});

// ---- Payments (Stars) ----
registerPayments(bot);

// ---- API status (admin only) ----
bot.command('status', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const statuses = getKeysStatus();
  const planLabels = { free: 'рџџў FREE', pro: 'рџ”µ PRO', max: 'рџљЂ MAX' };
  const pools = {};
  for (const k of statuses) {
    if (!pools[k.pool]) pools[k.pool] = [];
    pools[k.pool].push(k);
  }

  let text = 'рџ“Љ <b>MortisAI вЂ” API holati</b>\n\n';
  for (const [planName, keys] of Object.entries(pools)) {
    const totalReqs = keys.reduce((s, k) => s + k.totalRequests, 0);
    const totalToks = keys.reduce((s, k) => s + k.totalTokens, 0);

    text += `${planLabels[planName] || planName} pool вЂ” ${keys.length} ta key\n`;
    text += `Jami: ${totalReqs} so'rov | ${totalToks.toLocaleString()} token\n`;

    for (const k of keys) {
      text += `\n<b>${k.label}</b>`;
      if (k.errors429 > 0) text += ` вљ пёЏ ${k.errors429}x 429`;
      text += '\n';

      if (!k.modelStats.length) {
        text += '   Hali ishlatilmagan\n';
      } else {
        for (const ms of k.modelStats) {
          const filled = Math.min(10, Math.round(ms.pct / 10));
          const bar = 'в–€'.repeat(filled) + 'в–‘'.repeat(10 - filled);
          text += `<code>[${bar}]</code> ${ms.version}: ${ms.pct}% (${ms.tokens.toLocaleString()}/${ms.limit.toLocaleString()}) вЏ±пёЏ${ms.resetIn}s\n`;
        }
      }
    }
    text += '\n';
  }

  await ctx.replyWithHTML(text.trim());
});

module.exports = bot;
