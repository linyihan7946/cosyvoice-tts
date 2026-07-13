const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// 读取 .env 文件（简单的实现，不需要额外依赖）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  });
}

// 认证模块
const { createToken, authMiddleware, optionalAuth } = require('./auth');

// 数据库模块
const {
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
  getUserFavorites,
  addFavorite,
  removeFavorite,
  getStats,
  migrateFromJson,
  // 配额相关
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
} = require('./db');

const app = express();
const PORT = 3000;
const PUBLIC_BASE_PATH = normalizeBasePath(process.env.PUBLIC_BASE_PATH);

function normalizeBasePath(value) {
  const trimmed = (value || '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function routePath(pathname) {
  return `${PUBLIC_BASE_PATH}${pathname}`;
}

// ============================================================
//  配置
//  使用阿里百炼 qwen3-tts-flash 模型
//  支持音色克隆（Voice Clone）
// ============================================================
const API_CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY || '在此填入你的 DashScope API Key',
  // TTS 合成端点
  ttsUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  // 音色克隆/管理端点
  voiceCloneUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',
  // TTS 模型（内置音色使用）
  ttsModel: 'qwen3-tts-flash',
  // 音色克隆目标模型（VC 模型，克隆音色必须用此模型合成）
  voiceCloneTargetModel: 'qwen3-tts-vc-2026-01-22',
  // 音色克隆模型
  voiceCloneModel: 'qwen-voice-enrollment',
};

// 管理员手机号列表
const ADMIN_PHONES = new Set(
  (process.env.ADMIN_PHONES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

// 短信配置
const SMS_CONFIG = {
  accessKeyId: process.env.SMS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.SMS_ACCESS_KEY_SECRET || '',
  signature: process.env.SMS_SIGNATURE || '',
  templateId: process.env.SMS_TEMPLATE_ID || '',
};
const SHOULD_RETURN_DEBUG_CODE = process.env.SHOW_DEBUG_CODE === 'true' || process.env.NODE_ENV !== 'production';
const SMS_SDK_SCRIPT = path.join(__dirname, 'send_sms_unisdk.py');

// ============================================================
//  配额检查中间件
// ============================================================

// 解析用户层级：ADMIN_PHONES 优先 → user_tiers 表 → 默认 free
async function resolveUserTier(user) {
  if (user.is_admin) return 'admin';
  const dbTier = await getUserTier(user.id);
  // 检查会员是否过期
  if (dbTier.tier === 'monthly' && dbTier.expiresAt) {
    const expiresAt = new Date(dbTier.expiresAt + 'T23:59:59');
    if (expiresAt < new Date()) return 'free';
  }
  return dbTier.tier;
}

// 获取配额值
async function getQuotaValue(tier, key) {
  const config = await getQuotaConfig(tier);
  return config[key] !== undefined ? config[key] : 0;
}

// 配额检查中间件
function checkQuota(resource) {
  return async (req, res, next) => {
    const user = await getUserById(req.userId);
    if (!user) return res.status(401).json({ error: '用户不存在' });

    const tier = await resolveUserTier(user);

    if (resource === 'voice_clone') {
      // 检查当前克隆数上限
      const maxClones = await getQuotaValue(tier, 'max_voice_clones');
      if (maxClones > 0) {
        const currentClones = (await getCustomVoicesByUserId(req.userId)).length;
        if (currentClones >= maxClones) {
          return res.status(429).json({
            error: '已达音色克隆上限',
            current: currentClones,
            limit: maxClones,
            tier,
          });
        }
      }

      // 检查每日克隆次数限制
      const dailyCloneLimit = await getQuotaValue(tier, 'daily_clone_limit');
      if (dailyCloneLimit > 0) {
        const todayClones = await getTodayCloneCount(req.userId);
        if (todayClones >= dailyCloneLimit) {
          return res.status(429).json({
            error: '今日克隆次数已用完',
            used: todayClones,
            limit: dailyCloneLimit,
            resetTime: '明天 00:00',
          });
        }
      }

      // 检查删除后冷却期（24 小时内不能重新克隆，管理员豁免）
      if (!user.is_admin) {
        const lastDeleteTime = await getLastDeleteTime(req.userId);
        if (lastDeleteTime) {
          const lastDelete = new Date(lastDeleteTime);
          const now = new Date();
          const hoursSinceDelete = (now - lastDelete) / (1000 * 60 * 60);
          if (hoursSinceDelete < 24) {
            const remainingHours = Math.ceil(24 - hoursSinceDelete);
            return res.status(429).json({
              error: '冷却期内无法克隆',
              remainingHours: remainingHours,
            });
          }
        }
      }
    }

    if (resource === 'tts') {
      const dailyLimit = await getQuotaValue(tier, 'daily_tts_limit');
      if (dailyLimit === -1) return next(); // -1 表示无限
      if (dailyLimit > 0) {
        const todayUsage = await getTodayUsage(req.userId);
        if (todayUsage >= dailyLimit) {
          return res.status(429).json({
            error: '今日语音生成次数已用完',
            used: todayUsage,
            limit: dailyLimit,
            tier,
          });
        }
      }
    }

    next();
  };
}

// ============================================================
//  内置音色列表（qwen3-tts-flash 支持的音色）
// ============================================================
const BUILTIN_VOICES = [
  { id: 'Cherry', name: '芊悦', desc: '阳光积极女声', type: 'builtin' },
  { id: 'Ethan', name: '晨煦', desc: '标准普通话男声', type: 'builtin' },
  { id: 'Nofish', name: '不吃鱼', desc: '不翘舌音女声', type: 'builtin' },
  { id: 'Jennifer', name: '詹妮弗', desc: '电影感美式女声', type: 'builtin' },
  { id: 'Ryan', name: '甜茶', desc: '戏剧张力男声', type: 'builtin' },
  { id: 'Katerina', name: '卡捷琳娜', desc: '成熟韵律女声', type: 'builtin' },
  { id: 'Elias', name: '墨讲师', desc: '学术风格男声', type: 'builtin' },
  { id: 'Jada', name: '阿珍', desc: '上海话女声', type: 'builtin' },
  { id: 'Dylan', name: '晓东', desc: '北京话男声', type: 'builtin' },
  { id: 'Sunny', name: '晴儿', desc: '四川话女声', type: 'builtin' },
  { id: 'li', name: '老李', desc: '南京话男声', type: 'builtin' },
  { id: 'Marcus', name: '秦川', desc: '陕西话男声', type: 'builtin' },
  { id: 'Roy', name: '阿杰', desc: '闽南话男声', type: 'builtin' },
  { id: 'Peter', name: '李彼得', desc: '天津话男声', type: 'builtin' },
  { id: 'Rocky', name: '阿强', desc: '粤语男声', type: 'builtin' },
  { id: 'Kiki', name: '阿清', desc: '粤语女声', type: 'builtin' },
  { id: 'Eric', name: '程川', desc: '四川话男声', type: 'builtin' },
];

// ============================================================
//  验证码存储（内存）
// ============================================================
const codeStore = new Map(); // phone -> { code, expiresAt }

const CODE_EXPIRE_MS = 5 * 60 * 1000; // 5 分钟过期

function generateCode() {
  // 6 位数字验证码，首位非零
  const first = crypto.randomInt(1, 10).toString();
  const rest = Array.from({ length: 5 }, () => crypto.randomInt(0, 10).toString()).join('');
  return first + rest;
}

function storeCode(phone, code) {
  codeStore.set(phone, { code, expiresAt: Date.now() + CODE_EXPIRE_MS });
}

function verifyAndConsumeCode(phone, code) {
  const entry = codeStore.get(phone);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    codeStore.delete(phone);
    return false;
  }
  if (entry.code !== code) return false;
  codeStore.delete(phone);
  return true;
}

// 定期清理过期验证码
const codeCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of codeStore) {
    if (now > entry.expiresAt) codeStore.delete(phone);
  }
}, 60 * 1000);
if (typeof codeCleanupTimer.unref === 'function') codeCleanupTimer.unref();

// ============================================================
//  短信发送（UniSMS）
//  REST API: https://uni.apistd.com
//  文档: https://unisms.apistd.com/docs
// ============================================================
async function sendSmsWithPythonSdk(phone, code) {
  try {
    const { stdout } = await execFileAsync(
      process.env.PYTHON_BIN || 'python',
      [SMS_SDK_SCRIPT, phone, code],
      {
        env: process.env,
        timeout: 20000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }
    );
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const payload = JSON.parse(lines[lines.length - 1] || '{}');

    if (payload.sent) {
      console.log('[SMS] Python SDK 响应:', JSON.stringify(payload));
      return { sent: true, sdkAvailable: true };
    }

    if (payload.sdk_available === false) {
      console.warn('[SMS] Python SDK 不可用，回退 REST:', payload.error);
      return { sent: false, sdkAvailable: false, error: payload.error };
    }

    console.warn('[SMS] Python SDK 发送失败:', JSON.stringify(payload));
    return {
      sent: false,
      sdkAvailable: true,
      error: payload.error || payload.message || payload.code || 'Python SDK 发送失败',
    };
  } catch (e) {
    console.warn('[SMS] Python SDK 调用异常，回退 REST:', e.message);
    return { sent: false, sdkAvailable: false, error: e.message };
  }
}

async function sendSms(phone, code) {
  if (process.env.NODE_ENV === 'test') {
    return { sent: false, error: '测试环境跳过短信发送' };
  }

  if (!SMS_CONFIG.accessKeyId) {
    console.log('[SMS] 未配置 SMS_ACCESS_KEY_ID，跳过短信发送');
    return { sent: false, error: '未配置短信 AccessKey' };
  }

  if (!SMS_CONFIG.signature || !SMS_CONFIG.templateId) {
    console.log('[SMS] 未配置短信签名或模板 ID，跳过短信发送');
    return { sent: false, error: '未配置短信签名或模板 ID' };
  }

  const sdkResult = await sendSmsWithPythonSdk(phone, code);
  if (sdkResult.sent) return sdkResult;
  if (sdkResult.sdkAvailable) return sdkResult;

  try {
    // 与 ai-personal-trainer 中 UniSMS Python SDK 保持一致：
    // 鉴权参数走 Query，短信内容参数走 JSON Body。
    const params = new URLSearchParams();
    params.append('action', 'sms.message.send');
    params.append('accessKeyId', SMS_CONFIG.accessKeyId);

    // 如果配置了 accessKeySecret，使用 HMAC-SHA256 签名模式
    if (SMS_CONFIG.accessKeySecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = crypto.randomBytes(8).toString('hex');

      params.append('algorithm', 'hmac-sha256');
      params.append('timestamp', timestamp);
      params.append('nonce', nonce);

      const signStr = [...params.entries()]
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
      const signature = crypto
        .createHmac('sha256', SMS_CONFIG.accessKeySecret)
        .update(signStr)
        .digest('hex');
      params.append('signature', signature);
    }

    const url = `https://uni.apistd.com/?${params.toString()}`;
    const body = {
      to: phone,
      signature: SMS_CONFIG.signature,
      templateId: SMS_CONFIG.templateId,
      templateData: { code },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'uni-python-sdk/0.2.0',
        'Content-Type': 'application/json;charset=utf-8',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      result = { code: String(response.status), message: responseText || response.statusText };
    }
    console.log('[SMS] API 响应:', JSON.stringify(result));

    const messageStatuses = Array.isArray(result.data && result.data.messages)
      ? result.data.messages.map(message => message.status)
      : [];
    const smsAccepted =
      result.code === '0' &&
      (
        result.message === 'Success' ||
        (result.data && result.data.code === 'OK') ||
        messageStatuses.some(status => ['sent', 'delivered', 'accepted'].includes(status))
      );

    if (response.ok && smsAccepted) {
      console.log(`[SMS] 验证码已发送到 ${phone}`);
      return { sent: true };
    }
    console.warn('[SMS] 发送失败:', JSON.stringify(result));
    return {
      sent: false,
      error: (result.data && (result.data.message || result.data.code)) ||
        result.message ||
        `短信服务返回异常 (${result.code || response.status})`,
    };
  } catch (e) {
    console.warn('[SMS] 发送异常:', e.message);
    return { sent: false, error: e.message };
  }
}

// ============================================================
//  数据迁移：从 custom_voices.json 迁移到 MySQL
// ============================================================
const CUSTOM_VOICES_JSON = path.join(__dirname, 'custom_voices.json');
if (process.env.NODE_ENV !== 'test') {
  migrateFromJson(CUSTOM_VOICES_JSON).catch(err => {
    console.error('[DB] custom_voices.json 迁移失败:', err.message);
  });
}

app.use(express.json({ limit: '10mb' }));

const publicDir = path.join(__dirname, '..', 'frontend');
// 禁止浏览器缓存 HTML/JS，确保部署后用户立即看到最新版本
const noCacheHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
};
function setNoCacheHeaders(res) {
  res.set(noCacheHeaders);
}
if (PUBLIC_BASE_PATH) {
  app.get(PUBLIC_BASE_PATH, (req, res, next) => {
    if (req.path === PUBLIC_BASE_PATH) {
      return res.redirect(301, `${PUBLIC_BASE_PATH}/`);
    }
    return next();
  });
  app.get(`${PUBLIC_BASE_PATH}/`, (req, res) => {
    res.set(noCacheHeaders);
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use(PUBLIC_BASE_PATH, express.static(publicDir, { redirect: false, setHeaders: setNoCacheHeaders }));
} else {
  app.get('/', (req, res, next) => {
    if (req.path === '/') {
      res.set(noCacheHeaders);
      return res.sendFile(path.join(publicDir, 'index.html'));
    }
    return next();
  });
  app.use(express.static(publicDir, { setHeaders: setNoCacheHeaders }));
}

// ============================================================
//  Auth API 接口
// ============================================================

// 发送验证码
app.post(routePath('/api/auth/send-code'), async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(0, 11);

  if (!phone || !/^1\d{10}$/.test(phone)) {
    return res.status(400).json({ error: '请输入正确的手机号' });
  }

  const code = generateCode();
  storeCode(phone, code);

  // 尝试发送短信（失败不阻塞）
  const smsResult = await sendSms(phone, code);

  console.log(`[Auth] 验证码 for ${phone}: ${code}${smsResult.sent ? ' (SMS已发送)' : ' (SMS未发送)'}`);

  const payload = {
    message: smsResult.sent ? '验证码已发送，请查收短信' : '验证码已生成',
    sms_sent: smsResult.sent,
  };

  if (smsResult.error) payload.sms_error = smsResult.error;
  if (SHOULD_RETURN_DEBUG_CODE || !smsResult.sent) payload.debug_code = code;

  res.json(payload);
});

// 登录
app.post(routePath('/api/auth/login'), async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(0, 11);
  const { code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: '请提供手机号和验证码' });
  }

  if (!verifyAndConsumeCode(phone, code)) {
    return res.status(400).json({ error: '验证码错误或已过期' });
  }

  // 查找或创建用户
  let user = await getUserByPhone(phone);
  if (!user) {
    const nickname = `用户${phone.slice(-4)}`;
    user = await createUser(phone, nickname);
    console.log(`[Auth] 新用户注册: ${phone} (${user.id})`);
  }

  // 检查是否为管理员
  if (ADMIN_PHONES.has(phone) && !user.is_admin) {
    await setUserAdmin(user.id, true);
    user.is_admin = 1;
  }
  // 同步 admin 层级到 user_tiers
  if (user.is_admin) {
    await setUserTier(user.id, 'admin', null);
  }

  const token = createToken(user.id);
  const tier = await resolveUserTier(user);
  const tierInfo = await getUserTier(user.id);

  res.json({
    token,
    user: {
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      is_admin: !!user.is_admin,
      tier,
      expiresAt: tierInfo.expiresAt,
    },
  });
});

// 获取当前用户信息
app.get(routePath('/api/auth/me'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  const tier = await resolveUserTier(user);
  const tierInfo = await getUserTier(req.userId);
  res.json({
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    is_admin: !!user.is_admin,
    tier,
    expiresAt: tierInfo.expiresAt,
  });
});

// 管理员统计
app.get(routePath('/api/auth/admin/stats'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: '无权访问' });
  }
  res.json(await getStats());
});

// 用户配额查询
app.get(routePath('/api/quota'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const tier = await resolveUserTier(user);
  const voiceCloneLimit = await getQuotaValue(tier, 'max_voice_clones');
  const dailyTtsLimit = await getQuotaValue(tier, 'daily_tts_limit');
  const currentClones = (await getCustomVoicesByUserId(req.userId)).length;
  const todayTts = await getTodayUsage(req.userId);
  const userTierInfo = await getUserTier(req.userId);

  res.json({
    tier,
    voiceClones: {
      current: currentClones,
      limit: voiceCloneLimit,
    },
    dailyTts: {
      used: todayTts,
      limit: dailyTtsLimit,
    },
    expiresAt: userTierInfo.expiresAt,
  });
});

// ============================================================
//  管理员配额管理接口
// ============================================================

// 获取所有配额配置
app.get(routePath('/api/auth/admin/quota-config'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });
  res.json(await getAllQuotaConfig());
});

// 修改配额配置
app.put(routePath('/api/auth/admin/quota-config'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const { tier, key, value } = req.body;
  if (!tier || !key || value === undefined) {
    return res.status(400).json({ error: '请提供 tier, key, value' });
  }

  const validTiers = ['free', 'monthly', 'admin'];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: `无效的层级，可选: ${validTiers.join(', ')}` });
  }

  await setQuotaConfig(tier, key, value);
  console.log(`[Admin] 配额已更新: ${tier}.${key} = ${value}`);
  res.json({ success: true });
});

// 获取所有用户层级
app.get(routePath('/api/auth/admin/user-tiers'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const tiers = await getAllUserTiers();
  // 附加今日 TTS 用量
  const today = new Date().toISOString().slice(0, 10);
  const result = await Promise.all(tiers.map(async t => ({
    ...t,
    todayTtsUsed: await getUsageByDate(t.user_id, today),
  })));
  res.json(result);
});

// 修改用户层级
app.put(routePath('/api/auth/admin/user-tiers'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const { userId, tier, expiresAt } = req.body;
  if (!userId || !tier) {
    return res.status(400).json({ error: '请提供 userId 和 tier' });
  }

  const validTiers = ['free', 'monthly', 'admin'];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: `无效的层级，可选: ${validTiers.join(', ')}` });
  }

  const targetUser = await getUserById(userId);
  if (!targetUser) return res.status(404).json({ error: '目标用户不存在' });

  await setUserTier(userId, tier, expiresAt || null);
  // 如果设为 admin，同步 is_admin 标志
  if (tier === 'admin') await setUserAdmin(userId, true);

  console.log(`[Admin] 用户层级已更新: ${targetUser.phone} → ${tier}${expiresAt ? ` (到期: ${expiresAt})` : ''}`);
  res.json({ success: true });
});

// 删除用户
app.delete(routePath('/api/auth/admin/users/:userId'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const { userId } = req.params;

  // 不能删除自己
  if (userId === req.userId) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }

  const targetUser = await getUserById(userId);
  if (!targetUser) return res.status(404).json({ error: '目标用户不存在' });

  await deleteUser(userId);
  console.log(`[Admin] 用户已删除: ${targetUser.phone} (${userId})`);
  res.json({ success: true });
});

// 查询用量记录
app.get(routePath('/api/auth/admin/usage'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const { date, userId } = req.query;
  const queryDate = date || new Date().toISOString().slice(0, 10);

  if (userId) {
    // 查指定用户
    const count = await getUsageByDate(userId, queryDate);
    const targetUser = await getUserById(userId);
    return res.json([{
      userId,
      phone: targetUser?.phone || '',
      nickname: targetUser?.nickname || '',
      ttsCount: count,
    }]);
  }

  // 查所有用户
  const usageList = await getAllUsageByDate(queryDate);
  res.json(usageList.map(u => ({
    userId: u.user_id,
    phone: u.phone,
    nickname: u.nickname,
    ttsCount: u.tts_count,
  })));
});

// ============================================================
//  API 接口（受保护）
// ============================================================

// 获取音色列表（内置 + 当前用户的自定义音色）
app.get(routePath('/api/voices'), optionalAuth, async (req, res) => {
  let customVoices = [];
  let favoriteIds = new Set();
  if (req.userId) {
    customVoices = await getCustomVoicesByUserId(req.userId);
    favoriteIds = new Set(await getUserFavorites(req.userId));
  }

  // 系统音色：所有用户都可见
  const systemVoices = await getSystemVoices();

  const markFavorite = v => ({ ...v, favorited: favoriteIds.has(v.id) });

  const allVoices = [
    ...BUILTIN_VOICES.map(markFavorite),
    ...systemVoices.map(v => markFavorite({ ...v, type: 'system' })),
    ...customVoices.map(v => ({ ...v, type: 'custom', favorited: false })),
  ];
  res.json({ voices: allVoices });
});

// 收藏/取消收藏音色（仅内置和系统音色可收藏）
app.post(routePath('/api/voices/favorite'), authMiddleware, async (req, res) => {
  const { voiceId } = req.body;
  if (!voiceId) return res.status(400).json({ error: '请提供音色 ID' });

  // 检查是否为内置或系统音色（不能收藏用户自己的克隆音色）
  const isBuiltin = BUILTIN_VOICES.some(v => v.id === voiceId);
  const customVoice = await getCustomVoiceById(voiceId);
  const isSystem = customVoice && customVoice.is_system;

  if (!isBuiltin && !isSystem) {
    return res.status(400).json({ error: '该音色不支持收藏' });
  }

  await addFavorite(req.userId, voiceId);
  res.json({ success: true, favorited: true });
});

app.delete(routePath('/api/voices/favorite/:voiceId'), authMiddleware, async (req, res) => {
  const { voiceId } = req.params;
  await removeFavorite(req.userId, voiceId);
  res.json({ success: true, favorited: false });
});

// 语音合成接口
app.post(routePath('/api/tts'), authMiddleware, checkQuota('tts'), async (req, res) => {
  let { text, voice } = req.body;

  if (!text || !voice) {
    return res.status(400).json({ error: '请提供文本和音色' });
  }

  // 预处理文本：将换行符替换为空格，确保 TTS 能继续读取后续文本
  text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

  // 检查克隆音色所有权
  if (voice.startsWith('qwen-tts-vc-')) {
    const customVoice = await getCustomVoiceById(voice);
    if (!customVoice) {
      return res.status(404).json({ error: '音色不存在' });
    }
    // 系统音色所有用户都可用；普通克隆音色仅限本人
    if (!customVoice.is_system && customVoice.user_id !== req.userId) {
      return res.status(403).json({ error: '无权使用此音色' });
    }
  }

  // 克隆音色必须以 "qwen-tts-vc-" 开头，需用 VC 模型合成
  const isClonedVoice = voice.startsWith('qwen-tts-vc-');
  const ttsModel = isClonedVoice ? API_CONFIG.voiceCloneTargetModel : API_CONFIG.ttsModel;

  try {
    const response = await fetch(API_CONFIG.ttsUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ttsModel,
        input: { text, voice },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('TTS API Error:', response.status, errorText);
      let errorMsg = `API 请求失败 (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.message || errorJson.error?.message || errorMsg;
      } catch (_) {}
      return res.status(response.status).json({ error: errorMsg, detail: errorText });
    }

    const data = await response.json();
    const audioUrl = data.output?.audio?.url;
    if (!audioUrl) {
      return res.status(500).json({ error: 'API 返回中未找到音频 URL' });
    }

    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      return res.status(500).json({ error: '音频下载失败' });
    }

    const audioBuffer = await audioRes.buffer();
    const urlExt = audioUrl.split('?')[0].split('.').pop().toLowerCase();
    const contentType = urlExt === 'wav' ? 'audio/wav' : 'audio/mpeg';

    res.set({ 'Content-Type': contentType, 'Content-Length': audioBuffer.length });
    res.send(audioBuffer);

    // TTS 成功后递增用量
    await incrementTtsUsage(req.userId);
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// ============================================================
//  音色克隆接口
// ============================================================

// 创建克隆音色
app.post(routePath('/api/voice-clone'), authMiddleware, checkQuota('voice_clone'), async (req, res) => {
  let { audioBase64, voiceName, audioText, language } = req.body;

  if (!audioBase64 || !voiceName) {
    return res.status(400).json({ error: '请提供音频数据和音色名称' });
  }

  // 验证音色名称
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(voiceName)) {
    return res.status(400).json({ error: '音色名称只能包含英文字母、数字、下划线，最长16字符' });
  }

  // 检查重名（在当前用户的自定义音色中）
  const userVoices = await getCustomVoicesByUserId(req.userId);
  if (userVoices.find(v => v.name === voiceName)) {
    return res.status(400).json({ error: `音色 "${voiceName}" 已存在，请换个名称` });
  }

  // 确保音频数据为 Data URI 或 URL 格式（DashScope API 要求）
  if (!audioBase64.startsWith('data:') && !audioBase64.startsWith('http')) {
    audioBase64 = `data:audio/wav;base64,${audioBase64}`;
  }

  try {
    const response = await fetch(API_CONFIG.voiceCloneUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: API_CONFIG.voiceCloneModel,
        input: {
          action: 'create',
          target_model: API_CONFIG.voiceCloneTargetModel,
          preferred_name: voiceName,
          audio: { data: audioBase64 },
          ...(audioText ? { text: audioText } : {}),
          ...(language ? { language } : {}),
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Voice Clone API Error:', response.status, JSON.stringify(data));
      const errorMsg = data.message || data.error?.message || `克隆失败 (${response.status})`;
      return res.status(response.status).json({ error: errorMsg, detail: data });
    }

    const clonedVoice = data.output?.voice;
    if (!clonedVoice) {
      return res.status(500).json({ error: '克隆成功但未返回音色 ID', detail: data });
    }

    // 保存到数据库（关联当前用户）
    const newVoice = await addCustomVoice(clonedVoice, req.userId, voiceName, '自定义克隆音色');

    console.log(`✅ 音色克隆成功: "${voiceName}" → voice ID: "${clonedVoice}" (user: ${req.userId})`);
    res.json({ success: true, voice: newVoice });
  } catch (error) {
    console.error('Voice Clone Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// 删除克隆音色
app.delete(routePath('/api/voice-clone/:voiceId'), authMiddleware, async (req, res) => {
  const { voiceId } = req.params;
  const voice = await getCustomVoiceById(voiceId);

  if (!voice) {
    return res.status(404).json({ error: '音色不存在' });
  }

  // 检查所有权
  if (voice.user_id !== req.userId) {
    return res.status(403).json({ error: '无权删除此音色' });
  }

  try {
    // 从百炼平台删除
    const response = await fetch(API_CONFIG.voiceCloneUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: API_CONFIG.voiceCloneModel,
        input: {
          action: 'delete',
          voice: voiceId,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Delete Voice API Error:', response.status, errorText);
      // 即使 API 删除失败，也从本地列表移除
    }

    // 从数据库移除
    await deleteCustomVoice(voiceId);

    // 记录删除时间，用于冷却期检查
    await logVoiceDelete(req.userId);

    console.log(`✅ 音色已删除: "${voice.name}" (${voiceId})`);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete Voice Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// ============================================================
//  系统音色克隆（管理员专用）
// ============================================================

// 管理员：通过音频文件路径克隆系统音色
app.post(routePath('/api/auth/admin/clone-system-voice'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const { audioFilePath, voiceName, audioBase64, audioText, language } = req.body;

  if (!voiceName) {
    return res.status(400).json({ error: '请提供音色名称' });
  }

  // 验证音色名称（允许中文）
  if (voiceName.length > 20) {
    return res.status(400).json({ error: '音色名称最长 20 字符' });
  }

  // 检查重名
  const existingSystem = (await getSystemVoices()).find(v => v.name === voiceName);
  if (existingSystem) {
    return res.status(400).json({ error: `系统音色 "${voiceName}" 已存在` });
  }

  let audioDataBase64 = audioBase64;

  // 如果提供了文件路径，读取文件
  if (audioFilePath) {
    try {
      const absPath = path.resolve(audioFilePath);
      if (!fs.existsSync(absPath)) {
        return res.status(400).json({ error: `音频文件不存在: ${absPath}` });
      }
      const fileBuffer = fs.readFileSync(absPath);
      const ext = path.extname(absPath).toLowerCase();
      const mimeMap = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };
      const mime = mimeMap[ext] || 'audio/wav';
      // 构造 Data URI（DashScope 要求 URL 或 Data URI 格式）
      audioDataBase64 = `data:${mime};base64,${fileBuffer.toString('base64')}`;
    } catch (e) {
      return res.status(400).json({ error: '读取音频文件失败: ' + e.message });
    }
  } else if (audioDataBase64 && !audioDataBase64.startsWith('data:') && !audioDataBase64.startsWith('http')) {
    // 如果是纯 base64（无 data: 前缀），自动补全为 Data URI
    audioDataBase64 = `data:audio/wav;base64,${audioDataBase64}`;
  }

  if (!audioDataBase64) {
    return res.status(400).json({ error: '请提供音频数据（audioBase64 或 audioFilePath）' });
  }

  try {
    const response = await fetch(API_CONFIG.voiceCloneUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: API_CONFIG.voiceCloneModel,
        input: {
          action: 'create',
          target_model: API_CONFIG.voiceCloneTargetModel,
          preferred_name: voiceName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16),
          audio: { data: audioDataBase64 },
          ...(audioText ? { text: audioText } : {}),
          ...(language ? { language } : {}),
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[System Voice Clone] API Error:', response.status, JSON.stringify(data));
      const errorMsg = data.message || data.error?.message || `克隆失败 (${response.status})`;
      return res.status(response.status).json({ error: errorMsg, detail: data });
    }

    const clonedVoiceId = data.output?.voice;
    if (!clonedVoiceId) {
      return res.status(500).json({ error: '克隆成功但未返回音色 ID', detail: data });
    }

    // 保存为系统音色（user_id = 'system', is_system = 1）
    const newVoice = await addSystemVoice(clonedVoiceId, voiceName, '');

    console.log(`✅ 系统音色克隆成功: "${voiceName}" → ${clonedVoiceId}`);
    res.json({ success: true, voice: newVoice });
  } catch (error) {
    console.error('[System Voice Clone] Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// 管理员：列出所有系统音色
app.get(routePath('/api/auth/admin/system-voices'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });
  res.json(await getSystemVoices());
});

// 管理员：删除系统音色
app.delete(routePath('/api/auth/admin/system-voices/:voiceId'), authMiddleware, async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user || !user.is_admin) return res.status(403).json({ error: '无权访问' });

  const { voiceId } = req.params;
  const voice = await getCustomVoiceById(voiceId);

  if (!voice) return res.status(404).json({ error: '音色不存在' });
  if (!voice.is_system) return res.status(400).json({ error: '不是系统音色' });

  await deleteCustomVoice(voiceId);
  console.log(`[Admin] 系统音色已删除: "${voice.name}" (${voiceId})`);
  res.json({ success: true });
});

// ============================================================
//  启动服务
// ============================================================
if (require.main === module) {
  app.listen(PORT, async () => {
    const totalCustomVoices = (await getAllCustomVoices()).length;
    console.log(`\n🎙️  文字转语音助手服务已启动`);
    console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);
    console.log(`  TTS 端点: DashScope multimodal-generation`);
    console.log(`  内置音色: ${BUILTIN_VOICES.length} 种`);
    console.log(`  自定义音色: ${totalCustomVoices} 种`);
    if (ADMIN_PHONES.size > 0) {
      console.log(`  管理员手机号: ${[...ADMIN_PHONES].join(', ')}`);
    }
    console.log();
  });
}

module.exports = app;
