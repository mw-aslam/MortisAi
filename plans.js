// ─── Model versiyalari: nom, harorat (temperature), uslub tavsifi ─────────
// Har bir model boshqacha "shaxsiyat"ga ega bo'lishi uchun temperature va
// system-prompt qo'shimchasi shu yerda belgilanadi (ai.js va prompts.js
// shulardan foydalanadi).
const MODEL_INFO = {
  'llama-3.1-8b-instant': {
    version: 'MortisAI 2.5',
    emoji: '🟢',
    tagline: 'tezkor',
    temperature: 0.7,
    style:
      'Javoblaring qisqa, tez va aniq bo\'lsin. Ortiqcha tafsilotlarga ' +
      'berilmasdan, eng muhim narsani darhol ayt. Sodda til ishlat.',
  },
  'llama-3.3-70b-versatile': {
    version: 'MortisAI 3.0',
    emoji: '🔵',
    tagline: 'yaxshilangan',
    temperature: 0.65,
    style:
      'Javoblaring muvozanatli bo\'lsin: aniq, lekin yetarli tushuntirish ' +
      'bilan. Kerak bo\'lsa misollar keltir.',
  },
  'meta-llama/llama-4-scout-17b-16e-instruct': {
    version: 'MortisAI 4.0',
    emoji: '🟣',
    tagline: 'kuchli',
    temperature: 0.6,
    style:
      'Chuqur va tizimli javob ber. Murakkab mavzularni bosqichma-bosqich ' +
      'tushuntir, lekin suvni ko\'paytirma. Tasvirlarni ham puxta tahlil qil.',
  },
  'openai/gpt-oss-120b': {
    version: 'MortisAI 5.0',
    emoji: '🟠',
    tagline: 'eng kuchli',
    temperature: 0.55,
    style:
      'Ekspert darajasida, juda puxta va har tomonlama javob ber. ' +
      'Kod bo\'lsa — barcha edge-case\'larni hisobga ol. Tahlil chuqur bo\'lsin, ' +
      'lekin tartibli va o\'qish oson bo\'lsin.',
  },
  'qwen/qwen3-32b': {
    version: 'MortisAI 6.0',
    emoji: '🔴',
    tagline: 'top reasoning',
    temperature: 0.5,
    style:
      'Murakkab mantiqiy fikrlash talab qiladigan vazifalarda qadam-baqadam ' +
      'mulohaza yuritib, faqat shundan keyin yakuniy javobni ber. Xatolarsiz, ' +
      'tekshirilgan va eng yuqori aniqlikdagi javob ber. Bu eng kuchli versiya — ' +
      'shunga yarasha chuqur va ishonchli bo\'l.',
  },
};

const PLANS = {
  free: {
    name: 'Free',
    dailyLimit: 15,
    dailyTokens: 20000,
    historyLimit: 6,
    models: [
      'llama-3.1-8b-instant',
    ],
  },
  pro: {
    name: 'Pro',
    dailyLimit: 100,
    dailyTokens: 300000,
    historyLimit: 20,
    models: [
      'llama-3.3-70b-versatile',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'openai/gpt-oss-120b',
      'llama-3.1-8b-instant',
    ],
  },
  max: {
    name: 'Max',
    dailyLimit: Infinity,
    dailyTokens: 5000000,
    historyLimit: 40,
    models: [
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'openai/gpt-oss-120b',
      'llama-3.1-8b-instant',
    ],
  },
};

const STAR_PACKAGES = {
  pro_week:  { plan: 'pro', days: 7,  stars: 50, label: '💎 Pro — 1 hafta (50 ⭐)' },
  pro_month: { plan: 'pro', days: 30, stars: 150, label: '💎 Pro — 1 oy (150 ⭐)' },
  max_month: { plan: 'max', days: 30, stars: 300, label: '👑 Max — 1 oy (300 ⭐)' },
};

const GROUP_ACCESS_STARS = 15;

function getPlanConfig(plan) {
  return PLANS[plan] || PLANS.free;
}

function getModelInfo(model) {
  return (
    MODEL_INFO[model] || {
      version: model,
      emoji: '⚪',
      tagline: '',
      temperature: 0.6,
      style: '',
    }
  );
}

module.exports = {
  PLANS,
  STAR_PACKAGES,
  GROUP_ACCESS_STARS,
  MODEL_INFO,
  getPlanConfig,
  getModelInfo,
};