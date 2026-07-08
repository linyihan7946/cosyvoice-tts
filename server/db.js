const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS custom_voices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      desc TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_custom_voices_user_id ON custom_voices(user_id);
  `);
}

function newUuid() {
  return crypto.randomUUID();
}

// ===== 用户操作 =====

function getUserByPhone(phone) {
  return getDb().prepare('SELECT * FROM users WHERE phone = ?').get(phone);
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function createUser(phone, nickname) {
  const id = newUuid();
  getDb().prepare(
    'INSERT INTO users (id, phone, nickname) VALUES (?, ?, ?)'
  ).run(id, phone, nickname || `用户${phone.slice(-4)}`);
  return getUserById(id);
}

function setUserAdmin(userId, isAdmin) {
  getDb().prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
}

// ===== 音色操作 =====

function getCustomVoicesByUserId(userId) {
  return getDb().prepare(
    'SELECT * FROM custom_voices WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
}

function getCustomVoiceById(voiceId) {
  return getDb().prepare('SELECT * FROM custom_voices WHERE id = ?').get(voiceId);
}

function addCustomVoice(voiceId, userId, name, desc) {
  getDb().prepare(
    'INSERT INTO custom_voices (id, user_id, name, desc) VALUES (?, ?, ?, ?)'
  ).run(voiceId, userId, name, desc || '自定义克隆音色');
  return getCustomVoiceById(voiceId);
}

function deleteCustomVoice(voiceId) {
  return getDb().prepare('DELETE FROM custom_voices WHERE id = ?').run(voiceId);
}

function getAllCustomVoices() {
  return getDb().prepare('SELECT * FROM custom_voices ORDER BY created_at DESC').all();
}

// ===== 统计 =====

function getStats() {
  const totalUsers = getDb().prepare('SELECT COUNT(*) as count FROM users').get().count;
  const todayActive = getDb().prepare(
    "SELECT COUNT(DISTINCT user_id) as count FROM custom_voices WHERE date(created_at) = date('now')"
  ).get().count;
  const totalVoices = getDb().prepare('SELECT COUNT(*) as count FROM custom_voices').get().count;
  return { totalUsers, todayActiveUsers: todayActive, totalCustomVoices: totalVoices };
}

// ===== 数据迁移 =====

function migrateFromJson(jsonPath) {
  const fs = require('fs');
  if (!fs.existsSync(jsonPath)) return;

  const existingVoices = getAllCustomVoices();
  if (existingVoices.length > 0) return; // 已有数据，跳过迁移

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) return;

    // 为旧数据创建一个 legacy 用户
    let legacyUser = getUserByPhone('00000000000');
    if (!legacyUser) {
      legacyUser = createUser('00000000000', 'Legacy用户');
    }

    const insert = getDb().prepare(
      'INSERT OR IGNORE INTO custom_voices (id, user_id, name, desc, created_at) VALUES (?, ?, ?, ?, ?)'
    );

    const migrateMany = getDb().transaction((voices) => {
      for (const v of voices) {
        insert.run(v.id, legacyUser.id, v.name, v.desc || '自定义克隆音色', v.createdAt || new Date().toISOString());
      }
    });

    migrateMany(data);
    console.log(`✅ 已从 ${jsonPath} 迁移 ${data.length} 条音色数据到 SQLite`);
  } catch (e) {
    console.error('数据迁移失败:', e.message);
  }
}

module.exports = {
  getDb,
  getUserByPhone,
  getUserById,
  createUser,
  setUserAdmin,
  getCustomVoicesByUserId,
  getCustomVoiceById,
  addCustomVoice,
  deleteCustomVoice,
  getAllCustomVoices,
  getStats,
  migrateFromJson,
};
