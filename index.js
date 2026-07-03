const path = require('path');
const dns = require('dns');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Railway (va ko'plab hosting platformalari) IPv6 marshrutini to'liq qo'llab-quvvatlamaydi,
// bu esa tashqi API'larga (Groq) ulanishda "Premature close" xatosiga sabab bo'ladi.
// IPv4'ni ustuvor qilish bu muammoni oldini oladi.
dns.setDefaultResultOrder('ipv4first');

const REQUIRED_ENV = ['TELEGRAM_TOKEN', 'GROQ_API_KEY_FREE'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing: ${key}`);
    process.exit(1);
  }
}

if (!process.env.ADMIN_GROUP_ID) {
  console.warn('⚠️ ADMIN_GROUP_ID not set — admin notifications will be skipped.');
}
if (!process.env.ADMIN_IDS) {
  console.warn('⚠️ ADMIN_IDS not set — no user will have free Max access.');
}

const bot = require('./bot');

console.log('🤖 MortisAI starting...');

async function startBot(retriesLeft = 5) {
  try {
    await bot.launch();
    console.log('✅ MortisAI ishini muvaffaqiyatli yakunladi! (RU/UZ/EN, plans, payments, admin, groups)');
  } catch (err) {
    console.error('❌ Error:', err.message);
    // 409 = eski nusxa hali Telegram bilan ulanishni bo'shatmagan — kutib qayta urinamiz,
    // shu bilan darhol qayta ishga tushib, cheksiz aylanma (crash-loop) hosil qilishning oldini olamiz.
    if (err.message && err.message.includes('409') && retriesLeft > 0) {
      console.log(`409 conflict — 10 soniyadan keyin qayta urinaman (${retriesLeft} ta urinish qoldi)...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return startBot(retriesLeft - 1);
    }
    process.exit(1);
  }
}

startBot();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));