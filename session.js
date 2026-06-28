const sessions = new Map();
const MAX_HISTORY = 12;

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { history: [], lang: 'ru' });
  }
  return sessions.get(userId);
}

function addMessage(userId, role, content) {
  const session = getSession(userId);
  session.history.push({ role, content });
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
}

function getHistory(userId) {
  return getSession(userId).history;
}

function clearSession(userId) {
  const session = getSession(userId);
  session.history = [];
}

function getLang(userId) {
  return getSession(userId).lang;
}

function setLang(userId, lang) {
  getSession(userId).lang = lang;
}

module.exports = { getHistory, addMessage, clearSession, getLang, setLang };