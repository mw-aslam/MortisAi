const { Markup } = require('telegraf');
const { STAR_PACKAGES, GROUP_ACCESS_STARS, getPlanConfig } = require('./plans');
const { setPlan, activateGroup, getLang } = require('./db');
const { notifyPayment } = require('./notifications');
const { TEXTS } = require('./prompts');

function premiumKeyboard(lang = 'ru') {
  const t = TEXTS[lang] || TEXTS.ru;
  const buttons = Object.entries(STAR_PACKAGES).map(([key, pkg]) => {
    const label = t.packages && t.packages[key] ? t.packages[key] : pkg.label;
    return [Markup.button.callback(label, `buy_${key}`)];
  });
  return Markup.inlineKeyboard(buttons);
}

function groupActivateKeyboard(lang = 'ru') {
  return Markup.inlineKeyboard([
    [Markup.button.callback(TEXTS[lang].groupActivateButton, 'buy_group_access')],
  ]);
}

function durationLabel(days) {
  if (!days || days === 0) return 'навсегда';
  if (days % 30 === 0) return `${days / 30} мес.`;
  if (days % 7 === 0) return `${days / 7} нед.`;
  return `${days} дн.`;
}

async function sendInvoiceForPackage(ctx, packageKey) {
  const pkg = STAR_PACKAGES[packageKey];
  if (!pkg) return ctx.answerCbQuery('Тариф не найден.');

  const cfg = getPlanConfig(pkg.plan);
  await ctx.answerCbQuery();
  await ctx.replyWithInvoice({
    title: `MortisAI ${cfg.name} — ${durationLabel(pkg.days)}`,
    description: `Доступ к плану "${cfg.name}" на ${durationLabel(pkg.days)}.`,
    payload: packageKey, // identifies which package was bought
    provider_token: '', // empty for Telegram Stars
    currency: 'XTR',
    prices: [{ label: `${cfg.name} (${durationLabel(pkg.days)})`, amount: pkg.stars }],
  });
}

async function sendGroupActivationInvoice(ctx) {
  const lang = getLang(ctx.from.id);
  const t = TEXTS[lang];
  await ctx.answerCbQuery();
  await ctx.replyWithInvoice({
    title: t.groupInvoiceTitle,
    description: t.groupInvoiceDesc,
    payload: `group_access_${ctx.chat.id}`,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: t.groupInvoiceTitle, amount: GROUP_ACCESS_STARS }],
  });
}

function registerBuyActions(bot) {
  for (const key of Object.keys(STAR_PACKAGES)) {
    bot.action(`buy_${key}`, async (ctx) => {
      try {
        await sendInvoiceForPackage(ctx, key);
      } catch (err) {
        console.error('Invoice error:', err.message);
        await ctx.answerCbQuery('Ошибка при создании счёта.');
      }
    });
  }

  bot.action('buy_group_access', async (ctx) => {
    try {
      await sendGroupActivationInvoice(ctx);
    } catch (err) {
      console.error('Group invoice error:', err.message);
      await ctx.answerCbQuery('Ошибка при создании счёта.');
    }
  });
}

// pre_checkout_query — always approve
function registerPreCheckout(bot) {
  bot.on('pre_checkout_query', async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error('pre_checkout_query error:', err.message);
    }
  });
}

// Applies a package purchase: sets the plan, notifies admin group, replies to user.
async function applyPayment(bot, ctx, packageKey, totalAmount, chargeId) {
  const pkg = STAR_PACKAGES[packageKey];
  if (!pkg) {
    console.error('Unknown invoice payload:', packageKey);
    return;
  }

  const until = setPlan(ctx.from.id, pkg.plan, pkg.days);
  const cfg = getPlanConfig(pkg.plan);

  await notifyPayment(bot, ctx.from, {
    totalAmount,
    planName: cfg.name,
    durationLabel: durationLabel(pkg.days),
    chargeId,
    payload: packageKey,
  });

  const until_str = until ? new Date(until).toLocaleDateString('ru-RU') : 'навсегда';
  await ctx.reply(
    `✅ Оплата получена!\nВаш план: <b>${cfg.name}</b>\nДействует до: <b>${until_str}</b>`,
    { parse_mode: 'HTML' }
  );
}

// Applies a group activation purchase
async function applyGroupActivation(bot, ctx, chatId, totalAmount, chargeId) {
  activateGroup(chatId, ctx.chat?.title, ctx.from.id);
  const lang = getLang(ctx.from.id);

  await notifyPayment(bot, ctx.from, {
    totalAmount,
    planName: `Group access (${ctx.chat?.title || chatId})`,
    durationLabel: 'forever',
    chargeId,
    payload: `group_access_${chatId}`,
  });

  await ctx.reply(TEXTS[lang].groupActivated, { parse_mode: 'HTML' });
}

// successful_payment — apply plan / group activation + notify admin group
function registerSuccessfulPayment(bot) {
  bot.on('message', async (ctx, next) => {
    const payment = ctx.message?.successful_payment;
    if (!payment) return next();

    const payload = payment.invoice_payload;

    if (payload.startsWith('group_access_')) {
      const chatId = ctx.chat.id; // invoice was sent in the group chat
      await applyGroupActivation(
        bot,
        ctx,
        chatId,
        payment.total_amount,
        payment.telegram_payment_charge_id
      );
      return;
    }

    await applyPayment(
      bot,
      ctx,
      payload,
      payment.total_amount,
      payment.telegram_payment_charge_id
    );
  });
}

// /testpay <pro_week|pro_month|max_month> — simulate a successful payment
// without a real invoice, for testing notifications and plan changes.
function registerTestPay(bot) {
  bot.command('testpay', async (ctx) => {
    const key = ctx.message.text.trim().split(/\s+/)[1] || 'pro_week';
    if (!STAR_PACKAGES[key]) {
      return ctx.reply(
        `Доступные пакеты: ${Object.keys(STAR_PACKAGES).join(', ')}\nПример: /testpay pro_week`
      );
    }
    const pkg = STAR_PACKAGES[key];
    await applyPayment(bot, ctx, key, pkg.stars, `TEST_${Date.now()}`);
  });
}

function registerPayments(bot) {
  registerBuyActions(bot);
  registerPreCheckout(bot);
  registerSuccessfulPayment(bot);
  registerTestPay(bot);
}

module.exports = {
  registerPayments,
  premiumKeyboard,
  groupActivateKeyboard,
  durationLabel,
};