const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getPlanConfig } = require('./plans');

const db = new DatabaseSync(path.join(__dirname, 'mortisai.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    lang TEXT NOT NULL DEFAULT 'ru',
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    plan TEXT NOT NULL DEFAULT 'free',
    plan_until INTEGER,           -- NULL = forever, otherwise timestamp ms
    daily_used INTEGER NOT NULL DEFAULT 0,
    daily_tokens_used INTEGER NOT NULL DEFAULT 0,
    daily_reset_at INTEGER NOT NULL DEFAULT 0,
    selected_model TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    chat_id INTEGER PRIMARY KEY,
    title TEXT,
    activated_by INTEGER,
    activated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
`);

// ---- migrations for existing DBs ----
{
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes('daily_tokens_used')) {
    db.exec('ALTER TABLE users ADD COLUMN daily_tokens_used INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('last_active_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0');
    // Backfill: set last_active_at = created_at for existing users
    db.exec('UPDATE users SET last_active_at = created_at WHERE last_active_at = 0');
  }
}

const MAX_STORED = 200; // messages kept per user in DB

// ---- ADMIN ids from env ----
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

// ---- user CRUD ----
const getUserStmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
const insertUserStmt = db.prepare(`
  INSERT INTO users (user_id, lang, username, first_name, last_name, created_at, daily_reset_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateLangStmt = db.prepare('UPDATE users SET lang = ? WHERE user_id = ?');
const updateProfileStmt = db.prepare(
  'UPDATE users SET username = ?, first_name = ?, last_name = ? WHERE user_id = ?'
);
const updatePlanStmt = db.prepare('UPDATE users SET plan = ?, plan_until = ? WHERE user_id = ?');
const updateUsageStmt = db.prepare(
  'UPDATE users SET daily_used = ?, daily_tokens_used = ?, daily_reset_at = ? WHERE user_id = ?'
);
const updateModelStmt = db.prepare('UPDATE users SET selected_model = ? WHERE user_id = ?');
const findByUsernameStmt = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
const recentUsersStmt = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ?');
const updateLastActiveStmt = db.prepare('UPDATE users SET last_active_at = ? WHERE user_id = ?');

// ---- group CRUD ----
const getGroupStmt = db.prepare('SELECT * FROM groups WHERE chat_id = ?');
const upsertGroupStmt = db.prepare(`
  INSERT INTO groups (chat_id, title, activated_by, activated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title
`);

function isGroupActivated(chatId) {
  return !!getGroupStmt.get(chatId);
}

function activateGroup(chatId, title, activatedBy) {
  upsertGroupStmt.run(chatId, title || null, activatedBy, Date.now());
}

function dayMs() {
  return 24 * 60 * 60 * 1000;
}

function resetMs() {
  return 4 * 60 * 60 * 1000;
}

// Returns true if a brand-new row was created
function ensureUser(ctxFrom) {
  const userId = ctxFrom.id;
  let row;
  try {
    row = getUserStmt.get(userId);
  } catch (e) {
    console.error('[ensureUser] getUserStmt error:', e.message);
    return false;
  }
  if (!row) {
    try {
      insertUserStmt.run(
        userId,
        'ru',
        ctxFrom.username || null,
        ctxFrom.first_name || null,
        ctxFrom.last_name || null,
        Date.now(),
        Date.now() + resetMs()
      );
      console.log(`[ensureUser] New user saved: ${userId} (@${ctxFrom.username || 'no_username'})`);
    } catch (e) {
      console.error(`[ensureUser] INSERT failed for user ${userId}:`, e.message);
      return false;
    }
    return true;
  }
  // Keep profile info fresh
  try {
    if (
      row.username !== (ctxFrom.username || null) ||
      row.first_name !== (ctxFrom.first_name || null) ||
      row.last_name !== (ctxFrom.last_name || null)
    ) {
      updateProfileStmt.run(
        ctxFrom.username || null,
        ctxFrom.first_name || null,
        ctxFrom.last_name || null,
        userId
      );
    }
  } catch (e) {
    console.error(`[ensureUser] updateProfile error for ${userId}:`, e.message);
  }
  return false;
}

function getUser(userId) {
  let row = getUserStmt.get(userId);
  if (!row) {
    // Fallback minimal insert (shouldn't normally happen, ensureUser runs first)
    insertUserStmt.run(userId, 'ru', null, null, null, Date.now(), Date.now() + resetMs());
    row = getUserStmt.get(userId);
  }
  return row;
}

// ---- language ----
function getLang(userId) {
  return getUser(userId).lang;
}

function setLang(userId, lang) {
  getUser(userId); // ensure exists
  updateLangStmt.run(lang, userId);
}

// ---- plan logic ----
// Returns effective plan info: { plan, isAdmin, until }
function getEffectivePlan(userId) {
  if (isAdmin(userId)) {
    return { plan: 'max', until: null, isAdminUser: true };
  }
  const row = getUser(userId);
  // Auto-downgrade if expired
  if (row.plan !== 'free' && row.plan_until !== null && row.plan_until < Date.now()) {
    updatePlanStmt.run('free', null, userId);
    updateModelStmt.run(null, userId);
    return { plan: 'free', until: null, isAdminUser: false };
  }
  return { plan: row.plan, until: row.plan_until, isAdminUser: false };
}

// Set a plan (admin grant or successful payment). days=0 or null => forever
function setPlan(userId, plan, days) {
  let until = null;
  if (days && days > 0) {
    const row = getUser(userId);
    const base =
      row.plan === plan && row.plan_until && row.plan_until > Date.now()
        ? row.plan_until
        : Date.now();
    until = base + days * dayMs();
  }
  updatePlanStmt.run(plan, until, userId);
  return until;
}

function revokePlan(userId) {
  updatePlanStmt.run('free', null, userId);
  updateModelStmt.run(null, userId);
}

function resetUsageIfNeeded(row, userId) {
  const now = Date.now();
  if (now >= row.daily_reset_at) {
    const newResetAt = now + resetMs();
    updateUsageStmt.run(0, 0, newResetAt, userId);
    return { ...row, daily_used: 0, daily_tokens_used: 0, daily_reset_at: newResetAt };
  }
  return row;
}

// ---- daily usage / rate limiting (message-count based gate) ----
// Returns { allowed: bool, used, limit, remaining }
function checkAndIncrementUsage(userId) {
  const { plan, isAdminUser } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);

  if (isAdminUser || cfg.dailyLimit === Infinity) {
    return { allowed: true, used: 0, limit: Infinity, remaining: Infinity, plan };
  }

  let row = getUser(userId);
  row = resetUsageIfNeeded(row, userId);
  let { daily_used, daily_tokens_used, daily_reset_at } = row;

  if (daily_used >= cfg.dailyLimit) {
    return { allowed: false, used: daily_used, limit: cfg.dailyLimit, remaining: 0, plan, resetAt: daily_reset_at };
  }

  daily_used += 1;
  if (daily_used === cfg.dailyLimit) {
    daily_reset_at = Date.now() + resetMs();
  }
  updateUsageStmt.run(daily_used, daily_tokens_used, daily_reset_at, userId);

  return {
    allowed: true,
    used: daily_used,
    limit: cfg.dailyLimit,
    remaining: cfg.dailyLimit - daily_used,
    plan,
  };
}

// Add token usage (called after AI response with real token counts)
function addTokenUsage(userId, tokens) {
  if (!tokens || tokens <= 0) return;
  const { plan, isAdminUser } = getEffectivePlan(userId);
  if (isAdminUser) return;

  const cfg = getPlanConfig(plan);
  let row = getUser(userId);
  row = resetUsageIfNeeded(row, userId);
  const newTokens = row.daily_tokens_used + tokens;
  let new_reset_at = row.daily_reset_at;

  // Hitting the token limit right now sets the reset timer to 6 hours from now
  if (row.daily_tokens_used < cfg.dailyTokens && newTokens >= cfg.dailyTokens) {
    new_reset_at = Date.now() + resetMs();
  }

  updateUsageStmt.run(row.daily_used, newTokens, new_reset_at, userId);
}

// Returns token usage info: used, limit, remaining, percentUsed
function getTokenUsageInfo(userId) {
  const { plan, isAdminUser } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  let row = getUser(userId);
  row = resetUsageIfNeeded(row, userId);

  if (isAdminUser || cfg.dailyTokens === Infinity) {
    return { used: 0, limit: Infinity, remaining: Infinity, percentUsed: 0 };
  }

  const used = row.daily_tokens_used;
  const limit = cfg.dailyTokens;
  const remaining = Math.max(0, limit - used);
  const percentUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return { used, limit, remaining, percentUsed, resetAt: row.daily_reset_at };
}

function getUsageInfo(userId) {
  const { plan, isAdminUser, until } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  let row = getUser(userId);
  row = resetUsageIfNeeded(row, userId);
  const used = row.daily_used;
  const tokenInfo = getTokenUsageInfo(userId);
  return {
    plan,
    planName: cfg.name,
    isAdminUser,
    until,
    used,
    limit: cfg.dailyLimit,
    remaining: cfg.dailyLimit === Infinity ? Infinity : Math.max(0, cfg.dailyLimit - used),
    tokens: tokenInfo,
  };
}

// ---- model selection ----
function getSelectedModel(userId) {
  const { plan } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  const row = getUser(userId);
  if (row.selected_model && cfg.models.includes(row.selected_model)) {
    return row.selected_model;
  }
  return cfg.models[0];
}

function setSelectedModel(userId, model) {
  const { plan } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  if (!cfg.models.includes(model)) return false;
  updateModelStmt.run(model, userId);
  return true;
}

// ---- messages / history ----
const insertMsgStmt = db.prepare(
  'INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)'
);
const getRecentForModelStmt = db.prepare(
  'SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
);
const getRecentForDisplayStmt = db.prepare(
  'SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?'
);
const countMsgStmt = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?');
const deleteOldestStmt = db.prepare(`
  DELETE FROM messages WHERE id IN (
    SELECT id FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT ?
  )
`);
const deleteAllStmt = db.prepare('DELETE FROM messages WHERE user_id = ?');

function addMessage(userId, role, content) {
  insertMsgStmt.run(userId, role, content, Date.now());

  const { c } = countMsgStmt.get(userId);
  if (c > MAX_STORED) {
    deleteOldestStmt.run(userId, c - MAX_STORED);
  }
}

// Returns history in chronological order, formatted for the AI model,
// truncated to the user's plan history limit
function getHistory(userId) {
  const { plan } = getEffectivePlan(userId);
  const cfg = getPlanConfig(plan);
  const rows = getRecentForModelStmt.all(userId, cfg.historyLimit);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

function getRecentMessages(userId, limit = 10) {
  const rows = getRecentForDisplayStmt.all(userId, limit);
  return rows.reverse();
}

function clearSession(userId) {
  deleteAllStmt.run(userId);
}

// ---- admin lookups ----
function findUserByUsername(username) {
  const clean = username.replace(/^@/, '');
  return findByUsernameStmt.get(clean);
}

function getRecentUsers(limit = 10) {
  return recentUsersStmt.all(limit);
}

// ---- last_active update ----
function updateLastActive(userId) {
  try {
    updateLastActiveStmt.run(Date.now(), userId);
  } catch (e) {
    // non-critical, ignore
  }
}

// ---- global stats ----
function getStats() {
  const now = Date.now();
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const dayAgo   = now - 24 * 60 * 60 * 1000;

  const total   = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const monthly = db.prepare('SELECT COUNT(*) AS c FROM users WHERE last_active_at >= ?').get(monthAgo).c;
  const daily   = db.prepare('SELECT COUNT(*) AS c FROM users WHERE last_active_at >= ?').get(dayAgo).c;
  const paid    = db.prepare("SELECT COUNT(*) AS c FROM users WHERE plan != 'free'").get().c;

  return { total, monthly, daily, paid };
}

// ──────────────────────────────────────────────────────────────────────────
// ---- pending "awaiting text input" state for button-driven flows ----
// Used for things like: "admin pressed Gift -> bot asks for username ->
// admin's NEXT text message should be treated as that username, not as a
// chat message to the AI". Kept in-memory (per-process) since it's
// short-lived UX state, not data that needs to survive restarts.
// ──────────────────────────────────────────────────────────────────────────
const pendingActions = new Map(); // userId -> { type, data }

function setPendingAction(userId, type, data = {}) {
  pendingActions.set(userId, { type, data });
}

function getPendingAction(userId) {
  return pendingActions.get(userId) || null;
}

function clearPendingAction(userId) {
  pendingActions.delete(userId);
}

module.exports = {
  ADMIN_IDS,
  isAdmin,
  ensureUser,
  getUser,
  getLang,
  setLang,
  getEffectivePlan,
  setPlan,
  revokePlan,
  checkAndIncrementUsage,
  addTokenUsage,
  getTokenUsageInfo,
  getUsageInfo,
  getSelectedModel,
  setSelectedModel,
  addMessage,
  getHistory,
  getRecentMessages,
  clearSession,
  findUserByUsername,
  getRecentUsers,
  isGroupActivated,
  activateGroup,
  setPendingAction,
  getPendingAction,
  clearPendingAction,
  updateLastActive,
  getStats,
};