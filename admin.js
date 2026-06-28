const { Markup } = require('telegraf');
const {
  isAdmin,
  setPlan,
  revokePlan,
  getEffectivePlan,
  getUsageInfo,
  getUser,
  findUserByUsername,
  getRecentUsers,
  getLang,
  setPendingAction,
  getPendingAction,
  clearPendingAction,
} = require('./db');
const { getPlanConfig } = require('./plans');
const { TEXTS } = require('./prompts');

function adminOnly(handler) {
  return async (ctx, ...args) => {
    if (!isAdmin(ctx.from.id)) return; // silently ignore for non-admins
    return handler(ctx, ...args);
  };
}

function resolveTarget(arg) {
  if (!arg) return null;
  if (arg.startsWith('@')) {
    const row = findUserByUsername(arg);
    return row ? row.user_id : null;
  }
  const id = Number(arg);
  return Number.isFinite(id) ? id : null;
}

function fmtUntil(until) {
  return until ? new Date(until).toLocaleString('ru-RU') : 'навсегда';
}

// ---- keyboards ----
function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎁 Подарить подписку', 'admin_gift')],
    [Markup.button.callback('♻️ Сбросить на Free', 'admin_revoke')],
    [Markup.button.callback('🔎 Инфо о пользователе', 'admin_userinfo')],
    [Markup.button.callback('👥 Последние пользователи', 'admin_users')],
  ]);
}

function planChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🟢 Free', 'admin_giftplan_free')],
    [Markup.button.callback('🔵 Pro', 'admin_giftplan_pro')],
    [Markup.button.callback('🚀 Max', 'admin_giftplan_max')],
    [Markup.button.callback('⬅️ Назад', 'admin_menu')],
  ]);
}

function daysChoiceKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('7 дней', 'admin_giftdays_7'),
      Markup.button.callback('30 дней', 'admin_giftdays_30'),
    ],
    [
      Markup.button.callback('90 дней', 'admin_giftdays_90'),
      Markup.button.callback('♾️ Навсегда', 'admin_giftdays_0'),
    ],
    [Markup.button.callback('⬅️ Назад', 'admin_menu')],
  ]);
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_menu')]]);
}

async function showAdminMenu(ctx) {
  clearPendingAction(ctx.from.id);
  const text = '🛠 <b>Админ-панель MortisAI</b>\n\nВыберите действие:';
  if (ctx.updateType === 'callback_query') {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...adminMenuKeyboard() });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...adminMenuKeyboard() });
  }
}

async function sendUserInfo(ctx, userId) {
  const row = getUser(userId);
  const { plan, until, isAdminUser } = getEffectivePlan(userId);
  const usage = getUsageInfo(userId);
  const cfg = getPlanConfig(plan);

  const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ') || '—';
  const username = row.username ? `@${row.username}` : 'не указан';
  const created = new Date(row.created_at).toLocaleString('ru-RU');

  const t = usage.tokens;
  const tokenLine = t.limit === Infinity ? '∞' : `${t.used}/${t.limit} (${t.percentUsed}%)`;

  await ctx.reply(
    `👤 <b>${fullName}</b> (${username})\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📅 Регистрация: ${created}\n` +
      `📦 План: <b>${cfg.name}</b>${isAdminUser ? ' (ADMIN, навечно)' : ''}\n` +
      `⏳ Действует до: ${fmtUntil(until)}\n` +
      `💬 Использовано сегодня: ${usage.used}/${usage.limit === Infinity ? '∞' : usage.limit}\n` +
      `🪙 Токены: ${tokenLine}\n` +
      `🤖 Выбранная версия: ${row.selected_model || cfg.models[0]}`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]) }
  );
}

// Notify the gifted user (best-effort — they may have blocked the bot)
async function notifyGiftedUser(ctx, userId, plan, until) {
  try {
    const lang = getLang(userId);
    const t = TEXTS[lang] || TEXTS.ru;
    const cfg = getPlanConfig(plan);
    const untilStr =
      plan === 'free'
        ? '—'
        : until
        ? new Date(until).toLocaleString(lang === 'ru' ? 'ru-RU' : lang === 'uz' ? 'uz-UZ' : 'en-US')
        : lang === 'ru' ? 'навсегда' : lang === 'uz' ? 'doim' : 'forever';

    if (plan === 'free') {
      await ctx.telegram.sendMessage(
        userId,
        t.planGranted ? t.planGranted(cfg.name, untilStr) : `Plan changed to ${cfg.name}`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.telegram.sendMessage(userId, t.giftReceived(cfg.name, untilStr), { parse_mode: 'HTML' });
    }
  } catch (e) {
    // user may have blocked the bot — ignore
  }
}

function registerAdmin(bot) {
  function recentUsersKeyboard() {
    const recent = getRecentUsers(10);
    const btns = recent.map(r => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.user_id;
      const label = `👤 ${name.slice(0, 15)} ${r.username ? '(@' + r.username + ')' : ''}`;
      return [Markup.button.callback(label, `adm_sel_${r.user_id}`)];
    });
    btns.push([Markup.button.callback('❌ Отмена', 'admin_menu')]);
    return { reply_markup: { inline_keyboard: btns } };
  }

  // /admin — main entry, now shows button menu
  bot.command('admin', adminOnly(showAdminMenu));
  bot.action('admin_menu', adminOnly(showAdminMenu));

  // ---- Gift flow: ask username -> ask plan -> ask days -> apply ----
  bot.action('admin_gift', adminOnly(async (ctx) => {
    setPendingAction(ctx.from.id, 'admin_gift_user');
    await ctx.answerCbQuery();
    await ctx.editMessageText(TEXTS.ru.adminGiftAskUser + '\n\n<i>Или выберите из недавних:</i>', {
      parse_mode: 'HTML',
      ...recentUsersKeyboard(),
    });
  }));

  bot.action('admin_revoke', adminOnly(async (ctx) => {
    setPendingAction(ctx.from.id, 'admin_revoke_user');
    await ctx.answerCbQuery();
    await ctx.editMessageText(TEXTS.ru.adminRevokeAsk + '\n\n<i>Или выберите из недавних:</i>', {
      parse_mode: 'HTML',
      ...recentUsersKeyboard(),
    });
  }));

  bot.action('admin_userinfo', adminOnly(async (ctx) => {
    setPendingAction(ctx.from.id, 'admin_userinfo_user');
    await ctx.answerCbQuery();
    await ctx.editMessageText(TEXTS.ru.adminUserInfoAsk + '\n\n<i>Или выберите из недавних:</i>', {
      parse_mode: 'HTML',
      ...recentUsersKeyboard(),
    });
  }));

  bot.action(/^adm_sel_(.+)$/, adminOnly(async (ctx) => {
    const userIdStr = ctx.match[1];
    const pending = getPendingAction(ctx.from.id);
    if (!pending) return ctx.answerCbQuery();

    const userId = resolveTarget(userIdStr);
    if (!userId) return ctx.answerCbQuery('Пользователь не найден');

    if (pending.type === 'admin_gift_user') {
      setPendingAction(ctx.from.id, 'admin_gift_plan', { target: userId });
      await ctx.answerCbQuery();
      return ctx.editMessageText(TEXTS.ru.adminGiftAskPlan(userId), {
        parse_mode: 'HTML',
        ...planChoiceKeyboard(),
      });
    }

    if (pending.type === 'admin_revoke_user') {
      revokePlan(userId);
      clearPendingAction(ctx.from.id);
      await ctx.answerCbQuery();
      return ctx.editMessageText(TEXTS.ru.adminRevokeDone(userId), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]),
      });
    }

    if (pending.type === 'admin_userinfo_user') {
      clearPendingAction(ctx.from.id);
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      return sendUserInfo(ctx, userId);
    }
  }));

  bot.action('admin_users', adminOnly(async (ctx) => {
    await ctx.answerCbQuery();
    const rows = getRecentUsers(15);
    if (!rows.length) {
      return ctx.editMessageText('Пользователей пока нет.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]),
      });
    }
    let text = '👥 <b>Последние пользователи:</b>\n\n';
    for (const row of rows) {
      const { plan, isAdminUser } = getEffectivePlan(row.user_id);
      const cfg = getPlanConfig(plan);
      const username = row.username ? `@${row.username}` : '—';
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || '—';
      text += `<code>${row.user_id}</code> — ${name} (${username}) — <b>${cfg.name}</b>${
        isAdminUser ? ' 👑' : ''
      }\n`;
    }
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]),
    });
  }));

  // Plan choice for gift
  for (const plan of ['free', 'pro', 'max']) {
    bot.action(`admin_giftplan_${plan}`, adminOnly(async (ctx) => {
      const pending = getPendingAction(ctx.from.id);
      if (!pending || pending.type !== 'admin_gift_plan') return ctx.answerCbQuery();

      const target = pending.data.target;
      await ctx.answerCbQuery();

      if (plan === 'free') {
        // Free has no duration choice — apply immediately
        revokePlan(target);
        clearPendingAction(ctx.from.id);
        await ctx.editMessageText(`✅ Пользователю <code>${target}</code> установлен план <b>Free</b>.`, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]),
        });
        await notifyGiftedUser(ctx, target, 'free', null);
        return;
      }

      setPendingAction(ctx.from.id, 'admin_gift_days', { target, plan });
      await ctx.editMessageText(TEXTS.ru.adminGiftAskDays(target, getPlanConfig(plan).name), {
        parse_mode: 'HTML',
        ...daysChoiceKeyboard(),
      });
    }));
  }

  // Days choice for gift
  for (const days of [7, 30, 90, 0]) {
    bot.action(`admin_giftdays_${days}`, adminOnly(async (ctx) => {
      const pending = getPendingAction(ctx.from.id);
      if (!pending || pending.type !== 'admin_gift_days') return ctx.answerCbQuery();

      const { target, plan } = pending.data;
      await ctx.answerCbQuery();

      const until = setPlan(target, plan, days);
      const cfg = getPlanConfig(plan);
      clearPendingAction(ctx.from.id);

      await ctx.editMessageText(TEXTS.ru.adminGiftDone(target, cfg.name, fmtUntil(until)), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]),
      });

      await notifyGiftedUser(ctx, target, plan, until);
    }));
  }

  // ---- text input handler for pending admin actions ----
  // Registered BEFORE the generic chat handler in bot.js picks up text,
  // because this returns early (does not call next()) whenever the admin
  // has a pending action — so the message never reaches the AI.
  bot.on('text', async (ctx, next) => {
    if (!isAdmin(ctx.from.id)) return next();
    const pending = getPendingAction(ctx.from.id);
    if (!pending) return next();

    const raw = ctx.message.text.trim();

    if (pending.type === 'admin_gift_user') {
      const userId = resolveTarget(raw);
      if (!userId) {
        return ctx.reply(TEXTS.ru.adminGiftNotFound, { parse_mode: 'HTML', ...cancelKeyboard() });
      }
      setPendingAction(ctx.from.id, 'admin_gift_plan', { target: userId });
      return ctx.reply(TEXTS.ru.adminGiftAskPlan(userId), {
        parse_mode: 'HTML',
        ...planChoiceKeyboard(),
      });
    }

    if (pending.type === 'admin_revoke_user') {
      const userId = resolveTarget(raw);
      if (!userId) {
        return ctx.reply('❌ Пользователь не найден. Попробуйте снова:', cancelKeyboard());
      }
      revokePlan(userId);
      clearPendingAction(ctx.from.id);
      return ctx.reply(TEXTS.ru.adminRevokeDone(userId), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ В меню', 'admin_menu')]]),
      });
    }

    if (pending.type === 'admin_userinfo_user') {
      const userId = resolveTarget(raw);
      if (!userId) {
        return ctx.reply('❌ Пользователь не найден. Попробуйте снова:', cancelKeyboard());
      }
      clearPendingAction(ctx.from.id);
      return sendUserInfo(ctx, userId);
    }

    return next();
  });

  // ---- legacy text commands kept for power users ----
  bot.command('grant', adminOnly(async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    const [target, plan, daysStr] = parts;
    const days = Number(daysStr ?? 0);

    if (!target || !['free', 'pro', 'max'].includes(plan) || Number.isNaN(days)) {
      return ctx.reply('Использование: /grant <id|@username> <free|pro|max> <days>\n(days=0 — навсегда)');
    }
    const userId = resolveTarget(target);
    if (!userId) return ctx.reply('Пользователь не найден.');

    const until = setPlan(userId, plan, days);
    const cfg = getPlanConfig(plan);
    await ctx.reply(`✅ Пользователю <code>${userId}</code> выдан план <b>${cfg.name}</b> до: <b>${fmtUntil(until)}</b>`, {
      parse_mode: 'HTML',
    });
    await notifyGiftedUser(ctx, userId, plan, until);
  }));

  bot.command('revoke', adminOnly(async (ctx) => {
    const target = ctx.message.text.trim().split(/\s+/)[1];
    if (!target) return ctx.reply('Использование: /revoke <id|@username>');
    const userId = resolveTarget(target);
    if (!userId) return ctx.reply('Пользователь не найден.');
    revokePlan(userId);
    await ctx.reply(`✅ Пользователь <code>${userId}</code> сброшен на Free.`, { parse_mode: 'HTML' });
  }));

  bot.command('userinfo', adminOnly(async (ctx) => {
    const target = ctx.message.text.trim().split(/\s+/)[1];
    if (!target) return ctx.reply('Использование: /userinfo <id|@username>');
    const userId = resolveTarget(target);
    if (!userId) return ctx.reply('Пользователь не найден.');
    await sendUserInfo(ctx, userId);
  }));

  bot.command('users', adminOnly(async (ctx) => {
    const rows = getRecentUsers(15);
    if (!rows.length) return ctx.reply('Пользователей пока нет.');
    let text = '👥 <b>Последние пользователи:</b>\n\n';
    for (const row of rows) {
      const { plan, isAdminUser } = getEffectivePlan(row.user_id);
      const cfg = getPlanConfig(plan);
      const username = row.username ? `@${row.username}` : '—';
      const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || '—';
      text += `<code>${row.user_id}</code> — ${name} (${username}) — <b>${cfg.name}</b>${
        isAdminUser ? ' 👑' : ''
      }\n`;
    }
    await ctx.reply(text, { parse_mode: 'HTML' });
  }));
}

module.exports = { registerAdmin, adminMenuKeyboard, showAdminMenu };