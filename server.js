const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

// 读取 .env 文件（简单的实现，不需要额外依赖）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  });
}

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

// 内置音色列表（qwen3-tts-flash 支持的音色）
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

// 自定义音色存储文件
const CUSTOM_VOICES_FILE = path.join(__dirname, 'custom_voices.json');

// 加载自定义音色
function loadCustomVoices() {
  try {
    if (fs.existsSync(CUSTOM_VOICES_FILE)) {
      const data = JSON.parse(fs.readFileSync(CUSTOM_VOICES_FILE, 'utf-8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    console.error('加载自定义音色失败:', e.message);
  }
  return [];
}

// 保存自定义音色
function saveCustomVoices(voices) {
  fs.writeFileSync(CUSTOM_VOICES_FILE, JSON.stringify(voices, null, 2), 'utf-8');
}

let customVoices = loadCustomVoices();

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
//  API 接口
// ============================================================

// 获取音色列表（内置 + 自定义）
app.get(routePath('/api/voices'), (req, res) => {
  const allVoices = [
    ...BUILTIN_VOICES,
    ...customVoices.map(v => ({ ...v, type: 'custom' })),
  ];
  res.json({ voices: allVoices });
});

// 语音合成接口
app.post(routePath('/api/tts'), async (req, res) => {
  const { text, voice } = req.body;

  if (!text || !voice) {
    return res.status(400).json({ error: '请提供文本和音色' });
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
app.post(routePath('/api/voice-clone'), async (req, res) => {
  const { audioBase64, voiceName, audioText, language } = req.body;

  if (!audioBase64 || !voiceName) {
    return res.status(400).json({ error: '请提供音频数据和音色名称' });
  }

  // 验证音色名称
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(voiceName)) {
    return res.status(400).json({ error: '音色名称只能包含英文字母、数字、下划线，最长16字符' });
  }

  // 检查重名
  if (customVoices.find(v => v.id === voiceName)) {
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

    // 保存到自定义音色列表
    const newVoice = {
      id: clonedVoice,
      name: voiceName,
      desc: `自定义克隆音色`,
      createdAt: new Date().toISOString(),
    };
    customVoices.push(newVoice);
    saveCustomVoices(customVoices);

    console.log(`✅ 音色克隆成功: "${voiceName}" → voice ID: "${clonedVoice}"`);
    res.json({ success: true, voice: newVoice });
  } catch (error) {
    console.error('Voice Clone Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

// 删除克隆音色
app.delete(routePath('/api/voice-clone/:voiceId'), async (req, res) => {
  const { voiceId } = req.params;
  const voice = customVoices.find(v => v.id === voiceId);

  if (!voice) {
    return res.status(404).json({ error: '音色不存在' });
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

    // 从本地列表移除
    customVoices = customVoices.filter(v => v.id !== voiceId);
    saveCustomVoices(customVoices);

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
  console.log(`\n🎙️  Qwen3-TTS 语音合成服务已启动`);
  console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);
  console.log(`  TTS 端点: DashScope multimodal-generation`);
  console.log(`  内置音色: ${BUILTIN_VOICES.length} 种`);
  console.log(`  自定义音色: ${customVoices.length} 种\n`);
});
