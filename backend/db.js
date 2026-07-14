const mysql = require('mysql2/promise');
const crypto = require('crypto');

let pool = null;
let initPromise = null;
let memory = null;

function newUuid() {
  return crypto.randomUUID();
}

function shouldUseLocalMemoryDb() {
  return process.env.NODE_ENV !== 'production' && process.env.USE_MEMORY_DB === 'true';
}

function mysqlConfig(withDatabase = true) {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, '') || process.env.MYSQL_DATABASE || 'cosyvoice_tts';
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username || 'root'),
      password: decodeURIComponent(url.password || ''),
      database: withDatabase ? database : undefined,
      waitForConnections: true,
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
      charset: 'utf8mb4',
    };
  }

  return {
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: withDatabase ? (process.env.MYSQL_DATABASE || 'cosyvoice_tts') : undefined,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    charset: 'utf8mb4',
  };
}

function databaseName() {
  return mysqlConfig(true).database || 'cosyvoice_tts';
}

async function ensureDatabase() {
  const cfg = mysqlConfig(false);
  let conn;
  try {
    conn = await mysql.createConnection(cfg);
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${databaseName().replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } catch (e) {
    // 线上常用最小权限账号可能不能 CREATE DATABASE，但目标库已由运维或 MySQL 镜像初始化。
    // 这里继续让后续连接校验库是否可用；若库不存在，会在 initTables 阶段报出明确错误。
    if (!['ER_DBACCESS_DENIED_ERROR', 'ER_ACCESS_DENIED_ERROR'].includes(e.code)) {
      throw e;
    }
    console.warn(`[DB] 无法自动创建数据库 ${databaseName()}，将尝试直接连接: ${e.message}`);
  } finally {
    if (conn) await conn.end();
  }
}

async function getPool() {
  if (!memory && shouldUseLocalMemoryDb()) {
    memory = makeMemoryStore();
  }
  if (memory) return null;
  if (!pool) {
    await ensureDatabase();
    pool = mysql.createPool(mysqlConfig(true));
  }
  if (!initPromise) initPromise = initTables();
  await initPromise;
  return pool;
}

async function query(sql, params = []) {
  const db = await getPool();
  const [rows] = await db.execute(sql, params);
  return rows;
}

async function initTables() {
  const db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      nickname VARCHAR(255) NOT NULL DEFAULT '',
      is_admin TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS custom_voices (
      id VARCHAR(255) PRIMARY KEY,
      user_id VARCHAR(64),
      name VARCHAR(255) NOT NULL,
      \`desc\` TEXT,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_custom_voices_user_id (user_id),
      INDEX idx_custom_voices_is_system (is_system),
      CONSTRAINT fk_custom_voices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS quota_config (
      tier VARCHAR(32) NOT NULL,
      \`key\` VARCHAR(64) NOT NULL,
      value VARCHAR(64) NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tier, \`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_tiers (
      user_id VARCHAR(64) PRIMARY KEY,
      tier VARCHAR(32) NOT NULL DEFAULT 'free',
      expires_at DATE NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_user_tiers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS usage_tracking (
      user_id VARCHAR(64) NOT NULL,
      date DATE NOT NULL,
      tts_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date),
      CONSTRAINT fk_usage_tracking_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id VARCHAR(64) NOT NULL,
      voice_id VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, voice_id),
      CONSTRAINT fk_user_favorites_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_delete_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      deleted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_voice_delete_log_user (user_id),
      CONSTRAINT fk_voice_delete_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      content TEXT NOT NULL,
      contact VARCHAR(100) DEFAULT '',
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_feedback_status (status),
      INDEX idx_feedback_user (user_id),
      CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const defaults = [
    ['free', 'max_voice_clones', '1'],
    ['free', 'daily_tts_limit', '10'],
    ['free', 'daily_clone_limit', '1'],
    ['monthly', 'max_voice_clones', '5'],
    ['monthly', 'daily_tts_limit', '100'],
    ['monthly', 'daily_clone_limit', '10'],
    ['admin', 'max_voice_clones', '100'],
    ['admin', 'daily_tts_limit', '-1'],
    ['admin', 'daily_clone_limit', '-1'],
  ];
  for (const row of defaults) {
    await db.execute(
      'INSERT IGNORE INTO quota_config (tier, `key`, value) VALUES (?, ?, ?)',
      row
    );
  }
}

function makeMemoryStore() {
  return {
    users: [],
    customVoices: [],
    quotaConfig: new Map([
      ['free:max_voice_clones', '1'],
      ['free:daily_tts_limit', '10'],
      ['monthly:max_voice_clones', '5'],
      ['monthly:daily_tts_limit', '100'],
      ['admin:max_voice_clones', '100'],
      ['admin:daily_tts_limit', '-1'],
    ]),
    userTiers: [],
    usageTracking: [],
    userFavorites: [],
    feedback: [],
  };
}

async function resetDb(testPath) {
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
  memory = testPath === ':memory:' ? makeMemoryStore() : null;
  if (!memory) await getPool();
}

async function closeDb() {
  if (pool) await pool.end();
  pool = null;
  initPromise = null;
  memory = null;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeRow(row) {
  if (!row) return row;
  const normalized = { ...row };
  for (const [key, value] of Object.entries(normalized)) {
    if (value instanceof Date) {
      normalized[key] = key.endsWith('_at')
        ? value.toISOString().slice(0, 19).replace('T', ' ')
        : value.toISOString().slice(0, 10);
    }
  }
  return normalized;
}

// ===== 用户操作 =====

async function getUserByPhone(phone) {
  if (memory) return memory.users.find(u => u.phone === phone);
  const rows = await query('SELECT * FROM users WHERE phone = ?', [phone]);
  return normalizeRow(rows[0]);
}

async function getUserById(id) {
  if (memory) return memory.users.find(u => u.id === id);
  const rows = await query('SELECT * FROM users WHERE id = ?', [id]);
  return normalizeRow(rows[0]);
}

async function createUser(phone, nickname) {
  const id = newUuid();
  const user = { id, phone, nickname: nickname || `用户${phone.slice(-4)}`, is_admin: 0, created_at: new Date().toISOString() };
  if (memory) {
    memory.users.push(user);
    return user;
  }
  await query('INSERT INTO users (id, phone, nickname) VALUES (?, ?, ?)', [id, phone, user.nickname]);
  return getUserById(id);
}

async function setUserAdmin(userId, isAdmin) {
  if (memory) {
    const user = await getUserById(userId);
    if (user) user.is_admin = isAdmin ? 1 : 0;
    return;
  }
  await query('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin ? 1 : 0, userId]);
}

async function deleteUser(userId) {
  if (memory) {
    memory.customVoices = memory.customVoices.filter(v => v.user_id !== userId);
    memory.userTiers = memory.userTiers.filter(t => t.user_id !== userId);
    memory.usageTracking = memory.usageTracking.filter(u => u.user_id !== userId);
    memory.userFavorites = memory.userFavorites.filter(f => f.user_id !== userId);
    memory.users = memory.users.filter(u => u.id !== userId);
    return;
  }
  const db = await getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM custom_voices WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM user_tiers WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM usage_tracking WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM user_favorites WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ===== 音色操作 =====

async function getCustomVoicesByUserId(userId) {
  if (memory) return memory.customVoices.filter(v => v.user_id === userId && !v.is_system).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await query('SELECT * FROM custom_voices WHERE user_id = ? AND is_system = 0 ORDER BY created_at DESC', [userId]);
  return rows.map(normalizeRow);
}

// 获取用户今日克隆次数
async function getTodayCloneCount(userId) {
  if (memory) {
    const today = new Date().toISOString().slice(0, 10);
    return memory.customVoices.filter(v => v.user_id === userId && v.created_at && v.created_at.startsWith(today)).length;
  }
  const today = new Date().toISOString().slice(0, 10);
  const rows = await query(
    'SELECT COUNT(*) as count FROM custom_voices WHERE user_id = ? AND is_system = 0 AND DATE(created_at) = ?',
    [userId, today]
  );
  return rows[0].count || 0;
}

// 获取用户最后删除音色的时间
async function getLastDeleteTime(userId) {
  if (memory) return memory.lastDeleteTimes ? (memory.lastDeleteTimes[userId] || null) : null;
  const rows = await query(
    'SELECT deleted_at FROM voice_delete_log WHERE user_id = ? ORDER BY deleted_at DESC LIMIT 1',
    [userId]
  );
  return rows[0] ? rows[0].deleted_at : null;
}

// 记录音色删除时间
async function logVoiceDelete(userId) {
  if (memory) {
    if (!memory.lastDeleteTimes) memory.lastDeleteTimes = {};
    memory.lastDeleteTimes[userId] = new Date().toISOString();
    return;
  }
  await query(
    'INSERT INTO voice_delete_log (user_id, deleted_at) VALUES (?, NOW())',
    [userId]
  );
}

async function getCustomVoiceById(voiceId) {
  if (memory) return memory.customVoices.find(v => v.id === voiceId);
  const rows = await query('SELECT * FROM custom_voices WHERE id = ?', [voiceId]);
  return normalizeRow(rows[0]);
}

async function getSystemVoices() {
  if (memory) return memory.customVoices.filter(v => v.is_system).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const rows = await query('SELECT * FROM custom_voices WHERE is_system = 1 ORDER BY created_at ASC');
  return rows.map(normalizeRow);
}

async function addSystemVoice(voiceId, name, desc) {
  if (memory) {
    if (!memory.users.find(u => u.id === 'system')) {
      memory.users.push({ id: 'system', phone: '00000000000', nickname: '系统', is_admin: 0, created_at: new Date().toISOString() });
    }
    memory.customVoices.push({ id: voiceId, user_id: 'system', name, desc: desc || '', is_system: 1, created_at: new Date().toISOString() });
    return getCustomVoiceById(voiceId);
  }
  await query(
    'INSERT IGNORE INTO users (id, phone, nickname, is_admin) VALUES (?, ?, ?, 0)',
    ['system', '00000000000', '系统']
  );
  await query(
    'INSERT INTO custom_voices (id, user_id, name, `desc`, is_system) VALUES (?, ?, ?, ?, 1)',
    [voiceId, 'system', name, desc || '']
  );
  return getCustomVoiceById(voiceId);
}

async function upsertSystemVoice(voiceId, name, desc) {
  if (memory) {
    if (!memory.users.find(u => u.id === 'system')) {
      memory.users.push({ id: 'system', phone: '00000000000', nickname: '系统', is_admin: 0, created_at: new Date().toISOString() });
    }
    const existing = memory.customVoices.find(v => v.id === voiceId);
    if (existing) {
      Object.assign(existing, { user_id: 'system', name, desc: desc || '', is_system: 1 });
    } else {
      memory.customVoices.push({ id: voiceId, user_id: 'system', name, desc: desc || '', is_system: 1, created_at: new Date().toISOString() });
    }
    return getCustomVoiceById(voiceId);
  }
  await query(
    'INSERT IGNORE INTO users (id, phone, nickname, is_admin) VALUES (?, ?, ?, 0)',
    ['system', '00000000000', '系统']
  );
  await query(
    `INSERT INTO custom_voices (id, user_id, name, \`desc\`, is_system)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       name = VALUES(name),
       \`desc\` = VALUES(\`desc\`),
       is_system = 1`,
    [voiceId, 'system', name, desc || '']
  );
  return getCustomVoiceById(voiceId);
}

async function addCustomVoice(voiceId, userId, name, desc) {
  if (memory) {
    memory.customVoices.push({ id: voiceId, user_id: userId, name, desc: desc || '自定义克隆音色', is_system: 0, created_at: new Date().toISOString() });
    return getCustomVoiceById(voiceId);
  }
  await query(
    'INSERT INTO custom_voices (id, user_id, name, `desc`) VALUES (?, ?, ?, ?)',
    [voiceId, userId, name, desc || '自定义克隆音色']
  );
  return getCustomVoiceById(voiceId);
}

async function deleteCustomVoice(voiceId) {
  if (memory) {
    const before = memory.customVoices.length;
    memory.customVoices = memory.customVoices.filter(v => v.id !== voiceId);
    return { changes: before - memory.customVoices.length, affectedRows: before - memory.customVoices.length };
  }
  const result = await query('DELETE FROM custom_voices WHERE id = ?', [voiceId]);
  return result;
}

async function getAllCustomVoices() {
  if (memory) return [...memory.customVoices].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const rows = await query('SELECT * FROM custom_voices ORDER BY created_at DESC');
  return rows.map(normalizeRow);
}

// ===== 收藏操作 =====

async function getUserFavorites(userId) {
  if (memory) return memory.userFavorites.filter(f => f.user_id === userId).map(f => f.voice_id);
  const rows = await query('SELECT voice_id FROM user_favorites WHERE user_id = ?', [userId]);
  return rows.map(r => r.voice_id);
}

async function addFavorite(userId, voiceId) {
  if (memory) {
    if (!memory.userFavorites.find(f => f.user_id === userId && f.voice_id === voiceId)) {
      memory.userFavorites.push({ user_id: userId, voice_id: voiceId, created_at: new Date().toISOString() });
    }
    return;
  }
  await query('INSERT IGNORE INTO user_favorites (user_id, voice_id) VALUES (?, ?)', [userId, voiceId]);
}

async function removeFavorite(userId, voiceId) {
  if (memory) {
    memory.userFavorites = memory.userFavorites.filter(f => !(f.user_id === userId && f.voice_id === voiceId));
    return;
  }
  await query('DELETE FROM user_favorites WHERE user_id = ? AND voice_id = ?', [userId, voiceId]);
}

// ===== 统计 =====

async function getStats() {
  if (memory) {
    const todayPrefix = today();
    return {
      totalUsers: memory.users.length,
      todayActiveUsers: new Set(memory.customVoices.filter(v => v.created_at.slice(0, 10) === todayPrefix).map(v => v.user_id)).size,
      totalCustomVoices: memory.customVoices.length,
    };
  }
  const totalUsers = (await query('SELECT COUNT(*) as count FROM users'))[0].count;
  const todayActive = (await query('SELECT COUNT(DISTINCT user_id) as count FROM custom_voices WHERE DATE(created_at) = CURDATE()'))[0].count;
  const totalVoices = (await query('SELECT COUNT(*) as count FROM custom_voices'))[0].count;
  return { totalUsers, todayActiveUsers: todayActive, totalCustomVoices: totalVoices };
}

// ===== 配额配置 =====

async function getQuotaConfig(tier) {
  if (memory) {
    const config = {};
    for (const [compoundKey, value] of memory.quotaConfig.entries()) {
      const [rowTier, key] = compoundKey.split(':');
      if (rowTier === tier) config[key] = Number(value);
    }
    return config;
  }
  const rows = await query('SELECT `key`, value FROM quota_config WHERE tier = ?', [tier]);
  const config = {};
  for (const row of rows) config[row.key] = Number(row.value);
  return config;
}

async function setQuotaConfig(tier, key, value) {
  if (memory) {
    memory.quotaConfig.set(`${tier}:${key}`, String(value));
    return;
  }
  await query(
    'INSERT INTO quota_config (tier, `key`, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = CURRENT_TIMESTAMP',
    [tier, key, String(value)]
  );
}

async function getAllQuotaConfig() {
  if (memory) {
    const result = {};
    for (const [compoundKey, value] of memory.quotaConfig.entries()) {
      const [tier, key] = compoundKey.split(':');
      if (!result[tier]) result[tier] = {};
      result[tier][key] = Number(value);
    }
    return result;
  }
  const rows = await query('SELECT * FROM quota_config');
  const result = {};
  for (const row of rows) {
    if (!result[row.tier]) result[row.tier] = {};
    result[row.tier][row.key] = Number(row.value);
  }
  return result;
}

// ===== 用户层级 =====

async function getUserTier(userId) {
  if (memory) {
    const row = memory.userTiers.find(t => t.user_id === userId);
    return row ? { tier: row.tier, expiresAt: row.expires_at } : { tier: 'free', expiresAt: null };
  }
  const rows = await query('SELECT tier, expires_at FROM user_tiers WHERE user_id = ?', [userId]);
  const row = normalizeRow(rows[0]);
  return row ? { tier: row.tier, expiresAt: row.expires_at } : { tier: 'free', expiresAt: null };
}

async function setUserTier(userId, tier, expiresAt) {
  if (memory) {
    const existing = memory.userTiers.find(t => t.user_id === userId);
    if (existing) {
      existing.tier = tier;
      existing.expires_at = expiresAt || null;
    } else {
      memory.userTiers.push({ user_id: userId, tier, expires_at: expiresAt || null, updated_at: new Date().toISOString() });
    }
    return;
  }
  await query(
    'INSERT INTO user_tiers (user_id, tier, expires_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE tier = VALUES(tier), expires_at = VALUES(expires_at), updated_at = CURRENT_TIMESTAMP',
    [userId, tier, expiresAt || null]
  );
}

async function getAllUserTiers() {
  if (memory) {
    return [...memory.users]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(u => {
        const tier = memory.userTiers.find(t => t.user_id === u.id);
        return {
          user_id: u.id,
          phone: u.phone,
          nickname: u.nickname,
          is_admin: u.is_admin,
          tier: tier ? tier.tier : 'free',
          expires_at: tier ? tier.expires_at : null,
          voice_clone_count: memory.customVoices.filter(v => v.user_id === u.id).length,
        };
      });
  }
  const rows = await query(`
    SELECT u.id as user_id, u.phone, u.nickname, u.is_admin,
           COALESCE(ut.tier, 'free') as tier, ut.expires_at,
           (SELECT COUNT(*) FROM custom_voices WHERE user_id = u.id) as voice_clone_count
    FROM users u
    LEFT JOIN user_tiers ut ON u.id = ut.user_id
    ORDER BY u.created_at DESC
  `);
  return rows.map(normalizeRow);
}

// ===== 用量追踪 =====

async function getTodayUsage(userId) {
  if (memory) {
    const row = memory.usageTracking.find(u => u.user_id === userId && u.date === today());
    return row ? row.tts_count : 0;
  }
  const rows = await query('SELECT tts_count FROM usage_tracking WHERE user_id = ? AND date = CURDATE()', [userId]);
  return rows[0] ? rows[0].tts_count : 0;
}

async function incrementTtsUsage(userId) {
  if (memory) {
    const date = today();
    const row = memory.usageTracking.find(u => u.user_id === userId && u.date === date);
    if (row) row.tts_count += 1;
    else memory.usageTracking.push({ user_id: userId, date, tts_count: 1 });
    return;
  }
  await query(`
    INSERT INTO usage_tracking (user_id, date, tts_count)
    VALUES (?, CURDATE(), 1)
    ON DUPLICATE KEY UPDATE tts_count = tts_count + 1
  `, [userId]);
}

async function getUsageByDate(userId, date) {
  if (memory) {
    const row = memory.usageTracking.find(u => u.user_id === userId && u.date === date);
    return row ? row.tts_count : 0;
  }
  const rows = await query('SELECT tts_count FROM usage_tracking WHERE user_id = ? AND date = ?', [userId, date]);
  return rows[0] ? rows[0].tts_count : 0;
}

async function getAllUsageByDate(date) {
  if (memory) {
    return memory.usageTracking
      .filter(u => u.date === date && u.tts_count > 0)
      .map(u => {
        const user = memory.users.find(row => row.id === u.user_id) || {};
        return { user_id: u.user_id, phone: user.phone, nickname: user.nickname, tts_count: u.tts_count };
      })
      .sort((a, b) => b.tts_count - a.tts_count);
  }
  const rows = await query(`
    SELECT u.id as user_id, u.phone, u.nickname,
           COALESCE(ut.tts_count, 0) as tts_count
    FROM users u
    LEFT JOIN usage_tracking ut ON u.id = ut.user_id AND ut.date = ?
    WHERE COALESCE(ut.tts_count, 0) > 0
    ORDER BY tts_count DESC
  `, [date]);
  return rows;
}

// ===== 数据迁移 =====

async function migrateFromJson(jsonPath) {
  const fs = require('fs');
  if (!fs.existsSync(jsonPath)) return;

  const existingVoices = await getAllCustomVoices();
  if (existingVoices.length > 0) return;

  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (!Array.isArray(data) || data.length === 0) return;

    let legacyUser = await getUserByPhone('00000000000');
    if (!legacyUser) legacyUser = await createUser('00000000000', 'Legacy用户');

    for (const v of data) {
      if (!(await getCustomVoiceById(v.id))) {
        await addCustomVoice(v.id, legacyUser.id, v.name, v.desc || '自定义克隆音色');
      }
    }
    console.log(`✅ 已从 ${jsonPath} 迁移 ${data.length} 条音色数据到 MySQL`);
  } catch (e) {
    console.error('数据迁移失败:', e.message);
  }
}

// ===== 问题反馈 =====

async function addFeedback(userId, content, contact) {
  const id = crypto.randomInt(1, 2147483647);
  if (memory) {
    const fb = { id, user_id: userId, content, contact: contact || '', status: 'pending', created_at: new Date().toISOString() };
    memory.feedback = memory.feedback || [];
    memory.feedback.push(fb);
    return fb;
  }
  await query(
    'INSERT INTO feedback (user_id, content, contact, status) VALUES (?, ?, ?, ?)',
    [userId, content, contact || '', 'pending']
  );
  const rows = await query('SELECT * FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  return normalizeRow(rows[0]);
}

async function getAllFeedback(status) {
  if (memory) {
    let list = memory.feedback || [];
    if (status) list = list.filter(f => f.status === status);
    return list.map(normalizeRow).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  let sql = `
    SELECT f.*, u.phone, u.nickname
    FROM feedback f
    LEFT JOIN users u ON f.user_id = u.id
  `;
  const params = [];
  if (status) {
    sql += ' WHERE f.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY f.created_at DESC';
  const rows = await query(sql, params);
  return rows.map(normalizeRow);
}

async function updateFeedbackStatus(id, status) {
  const numId = Number(id);
  if (memory) {
    const fb = (memory.feedback || []).find(f => f.id === numId);
    if (fb) fb.status = status;
    return;
  }
  await query('UPDATE feedback SET status = ? WHERE id = ?', [status, numId]);
}

async function deleteFeedback(id) {
  const numId = Number(id);
  if (memory) {
    memory.feedback = (memory.feedback || []).filter(f => f.id !== numId);
    return;
  }
  await query('DELETE FROM feedback WHERE id = ?', [numId]);
}

module.exports = {
  getPool,
  resetDb,
  closeDb,
  getUserByPhone,
  getUserById,
  createUser,
  setUserAdmin,
  deleteUser,
  getCustomVoicesByUserId,
  getTodayCloneCount,
  getLastDeleteTime,
  logVoiceDelete,
  getCustomVoiceById,
  addCustomVoice,
  deleteCustomVoice,
  getAllCustomVoices,
  getSystemVoices,
  addSystemVoice,
  upsertSystemVoice,
  getUserFavorites,
  addFavorite,
  removeFavorite,
  getStats,
  migrateFromJson,
  getQuotaConfig,
  setQuotaConfig,
  getAllQuotaConfig,
  getUserTier,
  setUserTier,
  getAllUserTiers,
  getTodayUsage,
  incrementTtsUsage,
  getUsageByDate,
  getAllUsageByDate,
  addFeedback,
  getAllFeedback,
  updateFeedbackStatus,
  deleteFeedback,
};
