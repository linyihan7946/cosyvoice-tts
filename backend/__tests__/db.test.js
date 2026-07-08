const db = require('../db');

describe('Database - 用户操作', () => {
  beforeEach(() => {
    db.resetDb(':memory:');
  });

  test('createUser 创建用户', () => {
    const user = db.createUser('13800138000', '测试用户');
    expect(user).toHaveProperty('id');
    expect(user.phone).toBe('13800138000');
    expect(user.nickname).toBe('测试用户');
    expect(user.is_admin).toBe(0);
  });

  test('createUser 不传 nickname 自动生成', () => {
    const user = db.createUser('13800138000');
    expect(user.nickname).toBe('用户8000');
  });

  test('getUserByPhone 查询用户', () => {
    db.createUser('13800138000', '测试');
    const user = db.getUserByPhone('13800138000');
    expect(user).not.toBeNull();
    expect(user.phone).toBe('13800138000');
  });

  test('getUserByPhone 查询不存在的用户返回 undefined', () => {
    const user = db.getUserByPhone('19900000000');
    expect(user).toBeUndefined();
  });

  test('getUserById 查询用户', () => {
    const created = db.createUser('13800138000', '测试');
    const user = db.getUserById(created.id);
    expect(user).not.toBeNull();
    expect(user.id).toBe(created.id);
  });

  test('setUserAdmin 设置管理员', () => {
    const user = db.createUser('13800138000', '测试');
    db.setUserAdmin(user.id, true);
    const updated = db.getUserById(user.id);
    expect(updated.is_admin).toBe(1);
  });

  test('setUserAdmin 取消管理员', () => {
    const user = db.createUser('13800138000', '测试');
    db.setUserAdmin(user.id, true);
    db.setUserAdmin(user.id, false);
    const updated = db.getUserById(user.id);
    expect(updated.is_admin).toBe(0);
  });
});

describe('Database - 音色操作', () => {
  let userId;

  beforeEach(() => {
    db.resetDb(':memory:');
    const user = db.createUser('13800138000', '测试');
    userId = user.id;
  });

  test('addCustomVoice 添加克隆音色', () => {
    const voice = db.addCustomVoice('voice-001', userId, 'myvoice', '测试音色');
    expect(voice).toHaveProperty('id', 'voice-001');
    expect(voice.user_id).toBe(userId);
    expect(voice.name).toBe('myvoice');
  });

  test('addCustomVoice 默认描述', () => {
    const voice = db.addCustomVoice('voice-001', userId, 'myvoice');
    expect(voice.desc).toBe('自定义克隆音色');
  });

  test('getCustomVoicesByUserId 获取用户的音色列表', () => {
    db.addCustomVoice('voice-001', userId, 'voice1');
    db.addCustomVoice('voice-002', userId, 'voice2');
    const voices = db.getCustomVoicesByUserId(userId);
    expect(voices).toHaveLength(2);
  });

  test('getCustomVoiceById 获取单个音色', () => {
    db.addCustomVoice('voice-001', userId, 'myvoice');
    const voice = db.getCustomVoiceById('voice-001');
    expect(voice).not.toBeNull();
    expect(voice.name).toBe('myvoice');
  });

  test('deleteCustomVoice 删除音色', () => {
    db.addCustomVoice('voice-001', userId, 'myvoice');
    db.deleteCustomVoice('voice-001');
    const voice = db.getCustomVoiceById('voice-001');
    expect(voice).toBeUndefined();
  });

  test('getAllCustomVoices 获取所有音色', () => {
    const user2 = db.createUser('13900139000', '用户2');
    db.addCustomVoice('voice-001', userId, 'voice1');
    db.addCustomVoice('voice-002', user2.id, 'voice2');
    const all = db.getAllCustomVoices();
    expect(all).toHaveLength(2);
  });
});

describe('Database - 统计', () => {
  beforeEach(() => {
    db.resetDb(':memory:');
  });

  test('getStats 返回统计数据', () => {
    db.createUser('13800138000', '用户1');
    db.createUser('13900139000', '用户2');
    const stats = db.getStats();
    expect(stats.totalUsers).toBe(2);
    expect(stats).toHaveProperty('todayActiveUsers');
    expect(stats).toHaveProperty('totalCustomVoices');
  });
});

describe('Database - 配额配置', () => {
  beforeEach(() => {
    db.resetDb(':memory:');
  });

  test('getQuotaConfig 获取默认配额', () => {
    const config = db.getQuotaConfig('free');
    expect(config.max_voice_clones).toBe(1);
    expect(config.daily_tts_limit).toBe(10);
  });

  test('getQuotaConfig 不同层级不同配额', () => {
    const free = db.getQuotaConfig('free');
    const monthly = db.getQuotaConfig('monthly');
    const admin = db.getQuotaConfig('admin');
    expect(free.max_voice_clones).toBe(1);
    expect(monthly.max_voice_clones).toBe(5);
    expect(admin.max_voice_clones).toBe(100);
  });

  test('setQuotaConfig 修改配额', () => {
    db.setQuotaConfig('free', 'daily_tts_limit', 20);
    const config = db.getQuotaConfig('free');
    expect(config.daily_tts_limit).toBe(20);
  });

  test('getAllQuotaConfig 获取所有层级配额', () => {
    const all = db.getAllQuotaConfig();
    expect(all).toHaveProperty('free');
    expect(all).toHaveProperty('monthly');
    expect(all).toHaveProperty('admin');
    expect(all.free.max_voice_clones).toBe(1);
    expect(all.admin.daily_tts_limit).toBe(-1);
  });
});

describe('Database - 用户层级', () => {
  let userId;

  beforeEach(() => {
    db.resetDb(':memory:');
    const user = db.createUser('13800138000', '测试');
    userId = user.id;
  });

  test('getUserTier 默认返回 free', () => {
    const tier = db.getUserTier(userId);
    expect(tier.tier).toBe('free');
    expect(tier.expiresAt).toBeNull();
  });

  test('setUserTier 设置用户层级', () => {
    db.setUserTier(userId, 'monthly', '2026-12-31');
    const tier = db.getUserTier(userId);
    expect(tier.tier).toBe('monthly');
    expect(tier.expiresAt).toBe('2026-12-31');
  });

  test('setUserTier 不设置过期时间', () => {
    db.setUserTier(userId, 'admin');
    const tier = db.getUserTier(userId);
    expect(tier.tier).toBe('admin');
    expect(tier.expiresAt).toBeNull();
  });

  test('getAllUserTiers 获取所有用户层级', () => {
    const user2 = db.createUser('13900139000', '用户2');
    db.setUserTier(userId, 'monthly', '2026-12-31');
    const tiers = db.getAllUserTiers();
    expect(tiers).toHaveLength(2);
    const tierMap = {};
    tiers.forEach(t => { tierMap[t.user_id] = t; });
    expect(tierMap[userId].tier).toBe('monthly');
    expect(tierMap[user2.id].tier).toBe('free');
  });
});

describe('Database - 用量追踪', () => {
  let userId;

  beforeEach(() => {
    db.resetDb(':memory:');
    const user = db.createUser('13800138000', '测试');
    userId = user.id;
  });

  test('getTodayUsage 初始为 0', () => {
    const usage = db.getTodayUsage(userId);
    expect(usage).toBe(0);
  });

  test('incrementTtsUsage 递增用量', () => {
    db.incrementTtsUsage(userId);
    db.incrementTtsUsage(userId);
    db.incrementTtsUsage(userId);
    const usage = db.getTodayUsage(userId);
    expect(usage).toBe(3);
  });

  test('getUsageByDate 查询指定日期用量', () => {
    db.incrementTtsUsage(userId);
    const today = new Date().toISOString().slice(0, 10);
    const usage = db.getUsageByDate(userId, today);
    expect(usage).toBe(1);
  });

  test('getUsageByDate 查询无记录日期返回 0', () => {
    const usage = db.getUsageByDate(userId, '2020-01-01');
    expect(usage).toBe(0);
  });

  test('getAllUsageByDate 获取某日所有用户用量', () => {
    const user2 = db.createUser('13900139000', '用户2');
    db.incrementTtsUsage(userId);
    db.incrementTtsUsage(userId);
    db.incrementTtsUsage(user2.id);
    const today = new Date().toISOString().slice(0, 10);
    const usageList = db.getAllUsageByDate(today);
    expect(usageList).toHaveLength(2);
    expect(usageList[0].tts_count).toBe(2);
  });
});
