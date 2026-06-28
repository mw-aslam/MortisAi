const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

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

bot.launch()
  .then(() => console.log('✅ MortisAI ishini muvaffaqiyatli yakunladi! (RU/UZ/EN, plans, payments, admin, groups)'))
  .catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));