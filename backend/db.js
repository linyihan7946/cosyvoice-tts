const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

let DB_PATH = path.join(__dirname, 'data.db');

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

// 测试用：重置数据库连接，支持传入内存数据库路径
function resetDb(testPath) {
  if (db) {
    try { db.close(); } catch (e) {}
    db = null;
  }
  if (testPath !== undefined) {
    DB_PATH = testPath;
  }
  return getDb();
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

    CREATE TABLE IF NOT EXISTS quota_config (
      tier TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tier, key)
    );

    CREATE TABLE IF NOT EXISTS user_tiers (
      user_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL DEFAULT 'free',
      expires_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS usage_tracking (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      tts_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    INSERT OR IGNORE INTO quota_config (tier, key, value) VALUES ('free', 'max_voice_clones', '1');
    INSERT OR IGNORE INTO quota_config (tier, key, value) VALUES ('free', 'daily_tts_limit', '10');
    INSERT OR IGNORE INTO quota_config (tier, key, value) VALUES ('monthly', 'max_voice_clones', '5');
    INSERT OR IGNORE INTO quota_config (tier, key, value) VALUES ('monthly', 'daily_tts_limit', '100');
    INSERT OR IGNORE INTO quota_config (tier, key, value) VALUES ('admin', 'max_voice_clones', '100');
    INSERT OR IGNORE INTO quota_config (tier, key, value) VALUES ('admin', 'daily_tts_limit', '-1');
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

function deleteUser(userId) {
  const db = getDb();
  const deleteUserTx = db.transaction(() => {
    db.prepare('DELETE FROM custom_voices WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_tiers WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM usage_tracking WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  deleteUserTx();
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

// ===== 配额配置 =====

function getQuotaConfig(tier) {
  const rows = getDb().prepare('SELECT key, value FROM quota_config WHERE tier = ?').all(tier);
  const config = {};
  for (const row of rows) {
    config[row.key] = Number(row.value);
  }
  return config;
}

function setQuotaConfig(tier, key, value) {
  getDb().prepare(
    "INSERT OR REPLACE INTO quota_config (tier, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(tier, key, String(value));
}

function getAllQuotaConfig() {
  const rows = getDb().prepare('SELECT * FROM quota_config').all();
  const result = {};
  for (const row of rows) {
    if (!result[row.tier]) result[row.tier] = {};
    result[row.tier][row.key] = Number(row.value);
  }
  return result;
}

// ===== 用户层级 =====

function getUserTier(userId) {
  const row = getDb().prepare('SELECT tier, expires_at FROM user_tiers WHERE user_id = ?').get(userId);
  return row ? { tier: row.tier, expiresAt: row.expires_at } : { tier: 'free', expiresAt: null };
}

function setUserTier(userId, tier, expiresAt) {
  getDb().prepare(
    "INSERT OR REPLACE INTO user_tiers (user_id, tier, expires_at, updated_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(userId, tier, expiresAt || null);
}

function getAllUserTiers() {
  return getDb().prepare(`
    SELECT u.id as user_id, u.phone, u.nickname, u.is_admin,
           COALESCE(ut.tier, 'free') as tier, ut.expires_at,
           (SELECT COUNT(*) FROM custom_voices WHERE user_id = u.id) as voice_clone_count
    FROM users u
    LEFT JOIN user_tiers ut ON u.id = ut.user_id
    ORDER BY u.created_at DESC
  `).all();
}

// ===== 用量追踪 =====

function getTodayUsage(userId) {
  const row = getDb().prepare(
    "SELECT tts_count FROM usage_tracking WHERE user_id = ? AND date = date('now')"
  ).get(userId);
  return row ? row.tts_count : 0;
}

function incrementTtsUsage(userId) {
  getDb().prepare(`
    INSERT INTO usage_tracking (user_id, date, tts_count)
    VALUES (?, date('now'), 1)
    ON CONFLICT(user_id, date) DO UPDATE SET tts_count = tts_count + 1
  `).run(userId);
}

function getUsageByDate(userId, date) {
  const row = getDb().prepare(
    'SELECT tts_count FROM usage_tracking WHERE user_id = ? AND date = ?'
  ).get(userId, date);
  return row ? row.tts_count : 0;
}

function getAllUsageByDate(date) {
  return getDb().prepare(`
    SELECT u.id as user_id, u.phone, u.nickname,
           COALESCE(ut.tts_count, 0) as tts_count
    FROM users u
    LEFT JOIN usage_tracking ut ON u.id = ut.user_id AND ut.date = ?
    WHERE COALESCE(ut.tts_count, 0) > 0
    ORDER BY tts_count DESC
  `).all(date);
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
  resetDb,
  getUserByPhone,
  getUserById,
  createUser,
  setUserAdmin,
  deleteUser,
  getCustomVoicesByUserId,
  getCustomVoiceById,
  addCustomVoice,
  deleteCustomVoice,
  getAllCustomVoices,
  getStats,
  migrateFromJson,
  // 配额配置
  getQuotaConfig,
  setQuotaConfig,
  getAllQuotaConfig,
  // 用户层级
  getUserTier,
  setUserTier,
  getAllUserTiers,
  // 用量追踪
  getTodayUsage,
  incrementTtsUsage,
  getUsageByDate,
  getAllUsageByDate,
};
