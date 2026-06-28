function fmtDate(ts = Date.now()) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tashkent',
  });
}

function escapeHTML(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildUserCard(from) {
  const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || '—';
  const username = from.username ? `@${from.username}` : 'не указан';
  return (
    `👤 Имя: ${escapeHTML(fullName)}\n` +
    `🔗 Username: ${escapeHTML(username)}\n` +
    `🆔 ID: <code>${from.id}</code>\n` +
    `📅 Дата: ${fmtDate()}`
  );
}

function topicId(key) {
  const val = process.env[key];
  return val ? Number(val) : undefined;
}

async function sendToAdminGroup(bot, text, threadEnvKey) {
  const groupId = process.env.ADMIN_GROUP_ID;
  if (!groupId) {
    console.warn('ADMIN_GROUP_ID не задан в .env — уведомление не отправлено.');
    return;
  }
  const thread = topicId(threadEnvKey);

  try {
    const extra = { parse_mode: 'HTML' };
    if (thread) extra.message_thread_id = thread;
    await bot.telegram.sendMessage(groupId, text, extra);
  } catch (err) {
    if (thread) {
      console.warn(
        `Не удалось отправить в топик ${threadEnvKey} (${thread}): ${err.message}. Повтор без топика...`
      );
      try {
        await bot.telegram.sendMessage(groupId, text, { parse_mode: 'HTML' });
        return;
      } catch (err2) {
        console.error('Не удалось отправить уведомление в admin-группу:', err2.message);
        return;
      }
    }
    console.error('Не удалось отправить уведомление в admin-группу:', err.message);
  }
}

async function notifyNewUser(bot, from, message) {
  const text = `📈 НОВЫЙ ПОЛЬЗОВАТЕЛЬ\n${buildUserCard(from)}${message ? `\n📝 Текст: ${escapeHTML(message)}` : ''}`;
  await sendToAdminGroup(bot, text, 'ADMIN_TOPIC_USERS');
}

async function notifyFeedback(bot, from, message, isReport) {
  if (isReport) {
    const text = `❗ ЖАЛОБА\n${buildUserCard(from)}\n📝 Текст: ${escapeHTML(message)}`;
    await sendToAdminGroup(bot, text, 'ADMIN_TOPIC_REPORTS');
  } else {
    const text = `💡 ОТЗЫВ / ИДЕЯ\n${buildUserCard(from)}\n📝 Текст: ${escapeHTML(message)}`;
    await sendToAdminGroup(bot, text, 'ADMIN_TOPIC_IDEAS');
  }
}

async function notifyPayment(bot, from, payment) {
  const { totalAmount, planName, durationLabel, chargeId, payload } = payment;
  const text =
    `💰 НОВЫЙ ПЛАТЁЖ\n${buildUserCard(from)}\n` +
    `💳 Сумма: ${totalAmount} ⭐ Stars\n` +
    `📦 План: ${escapeHTML(planName)} — ${escapeHTML(durationLabel)}\n` +
    `🧾 Payment charge ID: <code>${escapeHTML(chargeId)}</code>\n` +
    `🧾 Invoice payload: <code>${escapeHTML(payload)}</code>`;
  await sendToAdminGroup(bot, text, 'ADMIN_TOPIC_PAYMENTS');
}

module.exports = {
  buildUserCard,
  notifyNewUser,
  notifyFeedback,
  notifyPayment,
};