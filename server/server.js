const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 读取 .env 文件（简单的实现，不需要额外依赖）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
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
  getCustomVoicesByUserId,
  getCustomVoiceById,
  addCustomVoice,
  deleteCustomVoice,
  getAllCustomVoices,
  getStats,
  migrateFromJson,
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
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of codeStore) {
    if (now > entry.expiresAt) codeStore.delete(phone);
  }
}, 60 * 1000);

// ============================================================
//  短信发送（UniSMS）
//  REST API: https://uni.apistd.com
//  文档: https://unisms.apistd.com/docs
// ============================================================
async function sendSms(phone, code) {
  if (!SMS_CONFIG.accessKeyId) {
    console.log('[SMS] 未配置 SMS_ACCESS_KEY_ID，跳过短信发送');
    return { sent: false, error: '未配置短信 AccessKey' };
  }

  if (!SMS_CONFIG.signature || !SMS_CONFIG.templateId) {
    console.log('[SMS] 未配置短信签名或模板 ID，跳过短信发送');
    return { sent: false, error: '未配置短信签名或模板 ID' };
  }

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
//  数据迁移：从 custom_voices.json 迁移到 SQLite
// ============================================================
const CUSTOM_VOICES_JSON = path.join(__dirname, 'custom_voices.json');
migrateFromJson(CUSTOM_VOICES_JSON);

app.use(express.json({ limit: '10mb' }));

const publicDir = path.join(__dirname, 'public');
if (PUBLIC_BASE_PATH) {
  app.get(PUBLIC_BASE_PATH, (req, res, next) => {
    if (req.path === PUBLIC_BASE_PATH) {
      return res.redirect(301, `${PUBLIC_BASE_PATH}/`);
    }
    return next();
  });
  app.get(`${PUBLIC_BASE_PATH}/`, (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.use(PUBLIC_BASE_PATH, express.static(publicDir, { redirect: false }));
} else {
  app.use(express.static(publicDir));
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
  let user = getUserByPhone(phone);
  if (!user) {
    const nickname = `用户${phone.slice(-4)}`;
    user = createUser(phone, nickname);
    console.log(`[Auth] 新用户注册: ${phone} (${user.id})`);
  }

  // 检查是否为管理员
  if (ADMIN_PHONES.has(phone) && !user.is_admin) {
    setUserAdmin(user.id, true);
    user.is_admin = 1;
  }

  const token = createToken(user.id);

  res.json({
    token,
    user: {
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      is_admin: !!user.is_admin,
    },
  });
});

// 获取当前用户信息
app.get(routePath('/api/auth/me'), authMiddleware, (req, res) => {
  const user = getUserById(req.userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    is_admin: !!user.is_admin,
  });
});

// 管理员统计
app.get(routePath('/api/auth/admin/stats'), authMiddleware, (req, res) => {
  const user = getUserById(req.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: '无权访问' });
  }
  res.json(getStats());
});

// ============================================================
//  API 接口（受保护）
// ============================================================

// 获取音色列表（内置 + 当前用户的自定义音色）
app.get(routePath('/api/voices'), optionalAuth, (req, res) => {
  let customVoices = [];
  if (req.userId) {
    customVoices = getCustomVoicesByUserId(req.userId);
  }

  const allVoices = [
    ...BUILTIN_VOICES,
    ...customVoices.map(v => ({ ...v, type: 'custom' })),
  ];
  res.json({ voices: allVoices });
});

// 语音合成接口
app.post(routePath('/api/tts'), authMiddleware, async (req, res) => {
  const { text, voice } = req.body;

  if (!text || !voice) {
    return res.status(400).json({ error: '请提供文本和音色' });
  }

  // 检查克隆音色所有权
  if (voice.startsWith('qwen-tts-vc-')) {
    const customVoice = getCustomVoiceById(voice);
    if (!customVoice || customVoice.user_id !== req.userId) {
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
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// ============================================================
//  音色克隆接口
// ============================================================

// 创建克隆音色
app.post(routePath('/api/voice-clone'), authMiddleware, async (req, res) => {
  const { audioBase64, voiceName, audioText, language } = req.body;

  if (!audioBase64 || !voiceName) {
    return res.status(400).json({ error: '请提供音频数据和音色名称' });
  }

  // 验证音色名称
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(voiceName)) {
    return res.status(400).json({ error: '音色名称只能包含英文字母、数字、下划线，最长16字符' });
  }

  // 检查重名（在当前用户的自定义音色中）
  const userVoices = getCustomVoicesByUserId(req.userId);
  if (userVoices.find(v => v.name === voiceName)) {
    return res.status(400).json({ error: `音色 "${voiceName}" 已存在，请换个名称` });
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
    const newVoice = addCustomVoice(clonedVoice, req.userId, voiceName, '自定义克隆音色');

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
  const voice = getCustomVoiceById(voiceId);

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
    deleteCustomVoice(voiceId);

    console.log(`✅ 音色已删除: "${voice.name}" (${voiceId})`);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete Voice Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// ============================================================
//  启动服务
// ============================================================
app.listen(PORT, () => {
  const totalCustomVoices = getAllCustomVoices().length;
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
