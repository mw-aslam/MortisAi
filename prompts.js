// SYSTEM_PROMPT endi (lang, modelStyle) qabul qiladi — har bir model o'z
// "shaxsiyati" (uslubi) bilan javob berishi uchun plans.js dagi
// MODEL_INFO[model].style shu yerga qo'shiladi.
const SYSTEM_PROMPT = (lang, modelStyle = '') => {
  const langName = {
    ru: 'Russian (fluent, native)',
    uz: "Uzbek (modern, natural Latin script. NO robotic or literal translations)",
    en: 'English (fluent, natural)',
  }[lang] || 'Russian';

  return `You are "MortisAI" — a highly intelligent, precise, and friendly AI assistant.
You provide brilliant, incredibly high-quality, and completely accurate answers (like a top-tier expert).

LANGUAGE RULES (CRITICAL — follow exactly):
1. DETECT the language of the user's latest message and reply in THAT EXACT language.
   - If the user writes in Russian (Cyrillic script) → reply in Russian, using Cyrillic.
   - If the user writes in Uzbek (Latin script) → reply in Uzbek Latin.
   - If the user writes in English → reply in English.
   - If the user writes in any other language → reply in that same language.
2. NEVER switch the reply language on your own. Always mirror the user's current message language.
3. If the message has NO clear language (e.g. just a file, image, or code with no text) → use ${langName} as the default.
4. Your language must be 100% natural, fluent, and human-like — NOT robotic or machine-translated.
5. For Uzbek: speak like a modern native speaker. Avoid overly formal or bizarre vocabulary.
6. CRITICAL: Do NOT start every reply with greetings like "Assalomu alaykum" or "Привет!". Only greet if the user greets first or it is the very first message. Otherwise go straight to the answer.

FORMAT: Use ONLY Telegram HTML tags for text styling, but use MARKDOWN for code blocks.
- Bold: <b>text</b>
- Italic: <i>text</i>
- Code block: \`\`\`language
code
\`\`\`
(CRITICAL: Always use the \`\`\` format for code blocks with the exact language name!)

QUALITY & PRECISION:
- Give thorough, highly accurate, and incredibly clear answers. No robotic filler words.
- Use step-by-step reasoning and practical advice.
- NEVER invent facts, APIs, or numbers. If unsure, state so honestly.
${modelStyle ? `\nMODEL STYLE (follow this closely):\n${modelStyle}\n` : ''}`;
};

// ---- helper: progress bar for token usage ----
function progressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, empty));
}

function fmtTokens(n) {
  if (n === Infinity) return '∞';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

const TEXTS = {
  ru: {
    welcome: (name) => `🤖 <b>MortisAI</b> — <i>твой персональный AI-ассистент</i>

Привет, <b>${name || 'друг'}</b>! 👋
Я умею:

🧠 Отвечать на любые вопросы
💻 Анализировать и писать код
🖼 Разбирать изображения
🎙 Понимать голосовые сообщения
📜 Помню историю наших диалогов
🌍 Говорить на разных языках

Просто напиши, отправь фото или голосовое — начнём! 🚀

Используй кнопки внизу 👇 или /premium, чтобы посмотреть тарифы.`,
    cleared: '🗑️ История очищена!',
    help: `<b>MortisAI — Помощь</b>

Все функции доступны через кнопки меню внизу 👇:
📜 История — последние сообщения
🗑️ Очистить — стереть историю диалога
💎 Тарифы — планы и оплата
🤖 Модель — выбрать версию ИИ
🌐 Язык — сменить язык интерфейса
💡 Отзыв / ❗ Жалоба — написать команде

<b>Как использовать:</b>
- Напиши вопрос или сообщение
- Отправь код — найду ошибки
- Отправь фото — проанализирую
- Отправь голосовое — расшифрую и отвечу
- Отправь файл — проверю

В группах: добавь меня админом, активируй за ⭐ и отвечай мне в реплае или через @упоминание.`,
    fileTooLarge: '⚠️ Файл слишком большой. Максимум 2MB.',
    error: '⚠️ Ошибка. Попробуйте снова.',
    limit: '⏱️ Лимит. Подождите минуту и попробуйте снова.',
    langChanged: '🌐 Язык переключен на Русский',
    chooseLang: 'Выберите язык:',
    menu: {
      clear: '🗑️ Очистить',
      help: 'ℹ️ Помощь',
      lang: '🌐 Язык',
      history: '📜 История',
      premium: '💎 Тарифы',
      model: '🤖 Модель',
      feedback: '💡 Отзыв',
      report: '❗ Жалоба',
    },
    voiceProcessing: '🎙 Обрабатываю голосовое...',
    historyEmpty: '📭 История пуста.',
    historyTitle: '📜 <b>Последние сообщения:</b>\n\n',
    you: '👤 Вы',
    bot: '🤖 MortisAI',
    backButton: '⬅️ Назад',
    cancelled: '❌ Отменено.',
    modelTaglines: {
      'llama-3.1-8b-instant': 'быстрый',
      'llama-3.3-70b-versatile': 'улучшенный',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'мощный',
      'openai/gpt-oss-120b': 'самый мощный',
      'qwen/qwen3-32b': 'топовое рассуждение',
    },

    // ---- plans / premium ----
    packages: {
      pro_week: '💎 Pro — 1 неделя (50 ⭐)',
      pro_month: '💎 Pro — 1 месяц (150 ⭐)',
      max_month: '👑 Max — 1 месяц (300 ⭐)',
    },
    dailyLimitReached: (planName, resetTime) =>
      `⚠️ <b>Дневной лимит исчерпан</b>\n\n` +
      `📦 Текущий план: <b>${planName}</b>\n` +
      `🕒 Лимит обновится: <b>${resetTime}</b>\n\n` +
      `<i>💡 Чтобы снять ограничения и получить доступ к мощным моделям, перейдите в <b>💎 Тарифы</b>.</i>`,
    tokenLimitReached: (planName, resetTime) =>
      `🔋 <b>Лимит токенов исчерпан</b>\n\n` +
      `📦 Текущий план: <b>${planName}</b>\n` +
      `🕒 Баланс обновится: <b>${resetTime}</b>\n\n` +
      `<i>💡 Чтобы снять ограничения, перейдите в <b>💎 Тарифы</b>.</i>`,
    premiumIntro: (usage) => {
      const t = usage.tokens;
      const bar = t.limit === Infinity ? '▓▓▓▓▓▓▓▓▓▓' : progressBar(t.percentUsed);

      return (
        `💎 <b>ТАРИФЫ MortisAI</b>\n\n` +
        `👤 <b>Ваш профиль:</b>\n` +
        `├ 📦 План: <b>${usage.planName}</b>\n` +
        `├ 💬 Сообщения: <b>${usage.used}</b> / ${usage.limit === Infinity ? '∞' : usage.limit}\n` +
        `└ 🪙 Токены: <b>${t.limit === Infinity ? '∞' : fmtTokens(t.remaining)}</b> (осталось)\n\n` +
        (t.limit === Infinity 
          ? `⚡ <i>У вас безлимитный доступ!</i>\n\n` 
          : `📊 <b>Расход токенов:</b> ${bar} ${t.percentUsed}%\n\n`) +
        `⭐️ <b>Улучшить план:</b>\n` +
        `Выберите подписку ниже, чтобы снять лимиты и получить доступ к мощным версиям модели:`
      );
    },
    planGranted: (planName, until) =>
      `💳 <b>Ваш тариф обновлен!</b>\n\n` +
      `Текущий план: <b>${planName}</b> 💎\n` +
      `Активен до: <b>${until}</b>\n\n` +
      `<i>Приятного использования!</i>`,
    giftReceived: (planName, until) =>
      `🎉 <b>Вам отправлен подарок!</b>\n\n` +
      `Ваш аккаунт обновлен до тарифа <b>${planName}</b> 💎\n` +
      `Активен до: <b>${until}</b>\n\n` +
      `<i>Все лимиты сняты. Наслаждайтесь мощью MortisAI!</i>`,

    // ---- /model ----
    modelChooseTitle: (current, planName) =>
      `🤖 <b>Выбор версии модели</b>\n\n` +
      `Текущая версия: <b>${current}</b>\nВаш план: <b>${planName}</b>\n\n` +
      `Чем выше версия — тем умнее, точнее и тщательнее ответы (меняется и стиль, и глубина рассуждений).\n👇 Выберите версию:`,
    modelLocked: '🔒 Эта версия доступна только на более высоком плане. Кнопка 💎 Тарифы для покупки.',
    modelSet: (name) => `✅ Версия модели переключена: <b>${name}</b>`,

    // ---- feedback / report ----
    feedbackPrompt: '💡 Напишите текст вашего отзыва или идеи одним сообщением:',
    feedbackUsage: 'Использование: /feedback <текст отзыва>',
    feedbackSent: '✅ Спасибо! Ваш отзыв отправлен команде MortisAI.',
    reportPrompt: '❗ Опишите проблему одним сообщением:',
    reportUsage: 'Использование: /report <текст проблемы>',
    reportSent: '✅ Спасибо! Ваша жалоба отправлена команде MortisAI.',

    // ---- groups ----
    groupNotActivated:
      `🔒 <b>MortisAI не активирован в этой группе.</b>\n\n` +
      `Чтобы пользоваться ботом в группе, активируйте доступ за <b>15 ⭐</b>.`,
    groupActivateButton: '⚡ Активировать за 15 ⭐',
    groupInvoiceTitle: '🔓 Активация MortisAI в группе',
    groupInvoiceDesc: 'Разовая активация бота для использования всеми участниками этой группы.',
    groupActivated: '✅ <b>MortisAI активирован в этой группе!</b>\nТеперь все участники могут общаться со мной, упомянув @ или ответив на сообщение.',

    // ---- admin gift flow ----
    adminMenuTitle: '🛠 <b>Админ-панель MortisAI</b>\n\nВыберите действие:',
    adminGiftAskUser: '🎁 Введите ID или @username пользователя, которому хотите подарить подписку:',
    adminGiftAskPlan: (target) => `🎁 Получатель: <code>${target}</code>\n\nВыберите план для подарка:`,
    adminGiftAskDays: (target, plan) =>
      `🎁 Получатель: <code>${target}</code>\nПлан: <b>${plan}</b>\n\nВыберите срок действия:`,
    adminGiftNotFound: '❌ Пользователь не найден. Он должен хотя бы раз запустить бота (/start). Попробуйте снова, отправьте ID или @username:',
    adminGiftDone: (userId, planName, until) =>
      `✅ Пользователю <code>${userId}</code> подарен план <b>${planName}</b> до: <b>${until}</b>`,
    adminUserInfoAsk: '🔎 Введите ID или @username пользователя для просмотра информации:',
    adminRevokeAsk: '♻️ Введите ID или @username пользователя, план которого нужно сбросить на Free:',
    adminRevokeDone: (userId) => `✅ Пользователь <code>${userId}</code> сброшен на Free.`,
  },
  uz: {
    welcome: (name) => `🤖 <b>MortisAI</b> — <i>shaxsiy AI-yordamchingiz</i>

Salom, <b>${name || "do'st"}</b>! 👋
Men quyidagilarni qila olaman:

🧠 Har qanday savolga javob beraman
💻 Kodni tahlil qilaman va yozaman
🖼 Rasmlarni tahlil qilaman
🎙 Ovozli xabarlarni tushunaman
📜 Suhbat tarixini eslab qolaman
🌍 Turli tillarda gaplashaman

Yozing, rasm yoki ovozli xabar yuboring — boshlaymiz! 🚀

Pastdagi tugmalardan 👇 yoki /premium orqali tariflarni ko'ring.`,
    cleared: "🗑️ Tarix tozalandi!",
    help: `<b>MortisAI — Yordam</b>

Barcha funksiyalar pastdagi menyu tugmalarida 👇:
📜 Tarix — oxirgi xabarlar
🗑️ Tozalash — suhbat tarixini o'chirish
💎 Tariflar — rejalar va to'lov
🤖 Model — AI versiyasini tanlash
🌐 Til — interfeys tilini almashtirish
💡 Fikr / ❗ Shikoyat — jamoaga yozish

<b>Qanday ishlatish:</b>
- Savol yoki xabar yozing
- Kod yuboring — xatolarni topaman
- Rasm yuboring — tahlil qilaman
- Ovozli xabar yuboring — tushunib javob beraman
- Fayl yuboring — tekshiraman

Guruhlarda: meni admin qilib qo'shing, ⭐ orqali faollashtiring va reply yoki @mention orqali yozing.`,
    fileTooLarge: "⚠️ Fayl juda katta. Maksimum 2MB.",
    error: '⚠️ Xatolik. Qaytadan urinib ko\'ring.',
    limit: "⏱️ Limit. Bir daqiqa kutib qaytadan urinib ko'ring.",
    langChanged: "🌐 Til O'zbekchaga o'zgartirildi",
    chooseLang: 'Tilni tanlang:',
    menu: {
      clear: "🗑️ Tozalash",
      help: 'ℹ️ Yordam',
      lang: '🌐 Til',
      history: '📜 Tarix',
      premium: '💎 Tariflar',
      model: '🤖 Model',
      feedback: '💡 Fikr',
      report: '❗ Shikoyat',
    },
    voiceProcessing: "🎙 Ovozli xabar qayta ishlanmoqda...",
    historyEmpty: "📭 Tarix bo'sh.",
    historyTitle: "📜 <b>Oxirgi xabarlar:</b>\n\n",
    you: '👤 Siz',
    bot: '🤖 MortisAI',
    backButton: '⬅️ Orqaga',
    cancelled: '❌ Bekor qilindi.',
    modelTaglines: {
      'llama-3.1-8b-instant': 'tezkor',
      'llama-3.3-70b-versatile': 'yaxshilangan',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'kuchli',
      'openai/gpt-oss-120b': 'eng kuchli',
      'qwen/qwen3-32b': 'top reasoning',
    },

    packages: {
      pro_week: '💎 Pro — 1 hafta (50 ⭐)',
      pro_month: '💎 Pro — 1 oy (150 ⭐)',
      max_month: '👑 Max — 1 oy (300 ⭐)',
    },
    dailyLimitReached: (planName, resetTime) =>
      `⚠️ <b>Kunlik xabar limiti tugadi</b>\n\n` +
      `📦 Joriy rejangiz: <b>${planName}</b>\n` +
      `🕒 Limit yangilanadi: <b>${resetTime}</b>\n\n` +
      `<i>💡 Cheklovlarni olib tashlash va kuchli modellarga o'tish uchun <b>💎 Tariflar</b> bo'limiga o'ting.</i>`,
    tokenLimitReached: (planName, resetTime) =>
      `🔋 <b>Tokenlar limiti tugadi</b>\n\n` +
      `📦 Joriy rejangiz: <b>${planName}</b>\n` +
      `🕒 Balans yangilanadi: <b>${resetTime}</b>\n\n` +
      `<i>💡 Cheklovlarni olib tashlash uchun <b>💎 Tariflar</b> bo'limiga o'ting.</i>`,
    premiumIntro: (usage) => {
      const t = usage.tokens;
      const bar = t.limit === Infinity ? '▓▓▓▓▓▓▓▓▓▓' : progressBar(t.percentUsed);

      return (
        `💎 <b>MortisAI TARIFLARI</b>\n\n` +
        `👤 <b>Sizning profilingiz:</b>\n` +
        `├ 📦 Tarif: <b>${usage.planName}</b>\n` +
        `├ 💬 Xabarlar: <b>${usage.used}</b> / ${usage.limit === Infinity ? '∞' : usage.limit}\n` +
        `└ 🪙 Tokenlar: <b>${t.limit === Infinity ? '∞' : fmtTokens(t.remaining)}</b> (qoldi)\n\n` +
        (t.limit === Infinity 
          ? `⚡ <i>Sizda cheksiz (bezlimit) ruxsat bor!</i>\n\n` 
          : `📊 <b>Tokenlar sarfi:</b> ${bar} ${t.percentUsed}%\n\n`) +
        `⭐️ <b>Tarifni oshirish:</b>\n` +
        `Limitlarni olib tashlash va kuchli modellarga o'tish uchun quyidan obunani tanlang:`
      );
    },
    planGranted: (planName, until) =>
      `💳 <b>Tarifingiz yangilandi!</b>\n\n` +
      `Joriy reja: <b>${planName}</b> 💎\n` +
      `Amal qiladi: <b>${until}</b> gacha\n\n` +
      `<i>Maroqli foydalaning!</i>`,
    giftReceived: (planName, until) =>
      `🎉 <b>Sizga sovg'a yuborildi!</b>\n\n` +
      `Akkauntingiz <b>${planName}</b> tarifiga ko'tarildi 💎\n` +
      `Amal qiladi: <b>${until}</b> gacha\n\n` +
      `<i>Barcha limitlar olib tashlandi. MortisAI imkoniyatlaridan to'liq foydalaning!</i>`,

    modelChooseTitle: (current, planName) =>
      `🤖 <b>Model versiyasini tanlash</b>\n\n` +
      `Joriy versiya: <b>${current}</b>\nRejangiz: <b>${planName}</b>\n\n` +
      `Versiya qancha yuqori bo'lsa — javoblar shunchalik aqlli, aniq va chuqur (uslub va fikrlash darajasi ham farq qiladi).\n👇 Versiyani tanlang:`,
    modelLocked: "🔒 Bu versiya faqat yuqori rejada mavjud. Sotib olish uchun 💎 Tariflar.",
    modelSet: (name) => `✅ Model versiyasi tanlandi: <b>${name}</b>`,

    feedbackPrompt: "💡 Fikr yoki g'oyangizni bitta xabar qilib yozing:",
    feedbackUsage: 'Foydalanish: /feedback <fikr matni>',
    feedbackSent: "✅ Rahmat! Fikringiz MortisAI jamoasiga yuborildi.",
    reportPrompt: '❗ Muammoni bitta xabar qilib tasvirlab bering:',
    reportUsage: 'Foydalanish: /report <muammo matni>',
    reportSent: "✅ Rahmat! Xabaringiz MortisAI jamoasiga yuborildi.",

    groupNotActivated:
      `🔒 <b>MortisAI bu guruhda faollashtirilmagan.</b>\n\n` +
      `Guruhda botdan foydalanish uchun <b>15 ⭐</b> evaziga faollashtiring.`,
    groupActivateButton: '⚡ 15 ⭐ orqali faollashtirish',
    groupInvoiceTitle: '🔓 MortisAI guruh faollashtirish',
    groupInvoiceDesc: "Botni shu guruhdagi barcha a'zolar uchun bir martalik faollashtirish.",
    groupActivated: "✅ <b>MortisAI bu guruhda faollashtirildi!</b>\nEndi barcha a'zolar @mention yoki reply orqali men bilan gaplashishi mumkin.",

    adminMenuTitle: '🛠 <b>MortisAI Admin-panel</b>\n\nAmalni tanlang:',
    adminGiftAskUser: "🎁 Sovg'a qilmoqchi bo'lgan foydalanuvchining ID yoki @username'ini kiriting:",
    adminGiftAskPlan: (target) => `🎁 Qabul qiluvchi: <code>${target}</code>\n\nSovg'a uchun rejani tanlang:`,
    adminGiftAskDays: (target, plan) =>
      `🎁 Qabul qiluvchi: <code>${target}</code>\nReja: <b>${plan}</b>\n\nMuddatni tanlang:`,
    adminGiftNotFound: "❌ Foydalanuvchi topilmadi. U botni kamida bir marta ishga tushirgan bo'lishi kerak (/start). Qaytadan ID yoki @username yuboring:",
    adminGiftDone: (userId, planName, until) =>
      `✅ <code>${userId}</code> foydalanuvchiga <b>${planName}</b> rejasi sovga qilindi. Muddati: <b>${until}</b>`,
    adminUserInfoAsk: "🔎 Ma'lumotni ko'rish uchun foydalanuvchi ID yoki @username'ini kiriting:",
    adminRevokeAsk: "♻️ Free rejasiga qaytariladigan foydalanuvchi ID yoki @username'ini kiriting:",
    adminRevokeDone: (userId) => `✅ <code>${userId}</code> foydalanuvchisi Free rejasiga qaytarildi.`,
  },
  en: {
    welcome: (name) => `🤖 <b>MortisAI</b> — <i>your personal AI assistant</i>

Hello, <b>${name || 'friend'}</b>! 👋
I can:

🧠 Answer any question
💻 Analyze and write code
🖼 Analyze images
🎙 Understand voice messages
📜 Remember our chat history
🌍 Speak multiple languages

Just type, send a photo, or a voice message — let's go! 🚀

Use the buttons below 👇 or /premium to see plans.`,
    cleared: '🗑️ History cleared!',
    help: `<b>MortisAI — Help</b>

All features are available via the menu buttons below 👇:
📜 History — recent messages
🗑️ Clear — wipe conversation history
💎 Plans — subscriptions & payment
🤖 Model — choose AI version
🌐 Language — switch interface language
💡 Feedback / ❗ Report — write to the team

<b>How to use:</b>
- Type a question or message
- Send code — I'll find bugs
- Send a photo — I'll analyze it
- Send a voice message — I'll transcribe and reply
- Send a file — I'll check it

In groups: add me as admin, activate with ⭐, then reply or @mention me.`,
    fileTooLarge: '⚠️ File too large. Max 2MB.',
    error: '⚠️ Error. Please try again.',
    limit: '⏱️ Limit reached. Wait a minute and try again.',
    langChanged: '🌐 Language switched to English',
    chooseLang: 'Choose a language:',
    menu: {
      clear: '🗑️ Clear',
      help: 'ℹ️ Help',
      lang: '🌐 Language',
      history: '📜 History',
      premium: '💎 Plans',
      model: '🤖 Model',
      feedback: '💡 Feedback',
      report: '❗ Report',
    },
    voiceProcessing: '🎙 Processing voice message...',
    historyEmpty: '📭 History is empty.',
    historyTitle: '📜 <b>Recent messages:</b>\n\n',
    you: '👤 You',
    bot: '🤖 MortisAI',
    backButton: '⬅️ Back',
    cancelled: '❌ Cancelled.',
    modelTaglines: {
      'llama-3.1-8b-instant': 'fast',
      'llama-3.3-70b-versatile': 'improved',
      'meta-llama/llama-4-scout-17b-16e-instruct': 'powerful',
      'openai/gpt-oss-120b': 'most powerful',
      'qwen/qwen3-32b': 'top reasoning',
    },

    packages: {
      pro_week: '💎 Pro — 1 week (50 ⭐)',
      pro_month: '💎 Pro — 1 month (150 ⭐)',
      max_month: '👑 Max — 1 month (300 ⭐)',
    },
    dailyLimitReached: (planName, resetTime) =>
      `⚠️ <b>Daily message limit reached</b>\n\n` +
      `📦 Current plan: <b>${planName}</b>\n` +
      `🕒 Limit resets at: <b>${resetTime}</b>\n\n` +
      `<i>💡 To remove limits and access powerful models, go to <b>💎 Plans</b>.</i>`,
    tokenLimitReached: (planName, resetTime) =>
      `🔋 <b>Token limit reached</b>\n\n` +
      `📦 Current plan: <b>${planName}</b>\n` +
      `🕒 Balance resets at: <b>${resetTime}</b>\n\n` +
      `<i>💡 To remove limits, go to <b>💎 Plans</b>.</i>`,
    premiumIntro: (usage) => {
      const t = usage.tokens;
      const bar = t.limit === Infinity ? '▓▓▓▓▓▓▓▓▓▓' : progressBar(t.percentUsed);

      return (
        `💎 <b>MortisAI PLANS</b>\n\n` +
        `👤 <b>Your profile:</b>\n` +
        `├ 📦 Plan: <b>${usage.planName}</b>\n` +
        `├ 💬 Messages: <b>${usage.used}</b> / ${usage.limit === Infinity ? '∞' : usage.limit}\n` +
        `└ 🪙 Tokens: <b>${t.limit === Infinity ? '∞' : fmtTokens(t.remaining)}</b> (left)\n\n` +
        (t.limit === Infinity 
          ? `⚡ <i>You have unlimited access!</i>\n\n` 
          : `📊 <b>Token usage:</b> ${bar} ${t.percentUsed}%\n\n`) +
        `⭐️ <b>Upgrade plan:</b>\n` +
        `Choose a subscription below to remove limits and unlock powerful models:`
      );
    },
    planGranted: (planName, until) =>
      `💳 <b>Your plan was updated!</b>\n\n` +
      `Current plan: <b>${planName}</b> 💎\n` +
      `Valid until: <b>${until}</b>\n\n` +
      `<i>Enjoy your premium features!</i>`,
    giftReceived: (planName, until) =>
      `🎉 <b>You received a gift!</b>\n\n` +
      `Your account has been upgraded to <b>${planName}</b> 💎\n` +
      `Valid until: <b>${until}</b>\n\n` +
      `<i>All limits are removed. Enjoy the full power of MortisAI!</i>`,

    modelChooseTitle: (current, planName) =>
      `🤖 <b>Choose model version</b>\n\n` +
      `Current version: <b>${current}</b>\nYour plan: <b>${planName}</b>\n\n` +
      `Higher version = smarter, more accurate, and more thorough answers (style and reasoning depth differ too).\n👇 Pick a version:`,
    modelLocked: '🔒 This version is available on a higher plan only. Use 💎 Plans to upgrade.',
    modelSet: (name) => `✅ Model version switched to: <b>${name}</b>`,

    feedbackPrompt: '💡 Type your feedback or idea in one message:',
    feedbackUsage: 'Usage: /feedback <your feedback text>',
    feedbackSent: '✅ Thanks! Your feedback was sent to the MortisAI team.',
    reportPrompt: '❗ Describe the problem in one message:',
    reportUsage: 'Usage: /report <problem description>',
    reportSent: '✅ Thanks! Your report was sent to the MortisAI team.',

    groupNotActivated:
      `🔒 <b>MortisAI is not activated in this group.</b>\n\n` +
      `To use the bot in this group, activate access for <b>15 ⭐</b>.`,
    groupActivateButton: '⚡ Activate for 15 ⭐',
    groupInvoiceTitle: '🔓 MortisAI group activation',
    groupInvoiceDesc: 'One-time activation of the bot for everyone in this group.',
    groupActivated: '✅ <b>MortisAI activated in this group!</b>\nAll members can now chat with me via @mention or reply.',

    adminMenuTitle: '🛠 <b>MortisAI Admin Panel</b>\n\nChoose an action:',
    adminGiftAskUser: '🎁 Enter the ID or @username of the user to gift a subscription to:',
    adminGiftAskPlan: (target) => `🎁 Recipient: <code>${target}</code>\n\nChoose a plan to gift:`,
    adminGiftAskDays: (target, plan) =>
      `🎁 Recipient: <code>${target}</code>\nPlan: <b>${plan}</b>\n\nChoose a duration:`,
    adminGiftNotFound: '❌ User not found. They must have started the bot at least once (/start). Try again — send ID or @username:',
    adminGiftDone: (userId, planName, until) =>
      `✅ User <code>${userId}</code> was gifted plan <b>${planName}</b> until: <b>${until}</b>`,
    adminUserInfoAsk: '🔎 Enter the ID or @username of the user to view info for:',
    adminRevokeAsk: '♻️ Enter the ID or @username of the user to reset to Free:',
    adminRevokeDone: (userId) => `✅ User <code>${userId}</code> was reset to Free.`,
  },
};

module.exports = { SYSTEM_PROMPT, TEXTS, progressBar, fmtTokens };