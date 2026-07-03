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

// ============================================================
//  配置
//  使用阿里百炼 MaaS 端点的 qwen3-tts-flash 模型
//  端点: /api/v1/services/aigc/multimodal-generation/generation
//  支持音色: Cherry, Ethan, Nofish, Jennifer, Ryan, Katerina,
//            Elias, Jada(上海话), Dylan(北京话), Sunny(四川话),
//            li(南京话), Marcus(陕西话), Roy(闽南话), Peter(天津话),
//            Rocky(粤语), Kiki(粤语), Eric(四川话)
// ============================================================
const API_CONFIG = {
  apiKey: process.env.DASHSCOPE_API_KEY || '在此填入你的 DashScope API Key',
  // DashScope 原生 multimodal-generation 端点
  ttsUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  // MaaS 端点（备用）
  ttsUrlMaaS: 'https://llm-epwm5xmzoslfuxyh.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  useMaaS: process.env.USE_MAAS === 'true',
};

// 音色列表（qwen3-tts-flash 支持的音色）
const VOICES = [
  { id: 'Cherry', name: '芊悦', desc: '阳光积极女声' },
  { id: 'Ethan', name: '晨煦', desc: '标准普通话男声' },
  { id: 'Nofish', name: '不吃鱼', desc: '不翘舌音女声' },
  { id: 'Jennifer', name: '詹妮弗', desc: '电影感美式女声' },
  { id: 'Ryan', name: '甜茶', desc: '戏剧张力男声' },
  { id: 'Katerina', name: '卡捷琳娜', desc: '成熟韵律女声' },
  { id: 'Elias', name: '墨讲师', desc: '学术风格男声' },
  { id: 'Jada', name: '阿珍', desc: '上海话女声' },
  { id: 'Dylan', name: '晓东', desc: '北京话男声' },
  { id: 'Sunny', name: '晴儿', desc: '四川话女声' },
  { id: 'li', name: '老李', desc: '南京话男声' },
  { id: 'Marcus', name: '秦川', desc: '陕西话男声' },
  { id: 'Roy', name: '阿杰', desc: '闽南话男声' },
  { id: 'Peter', name: '李彼得', desc: '天津话男声' },
  { id: 'Rocky', name: '阿强', desc: '粤语男声' },
  { id: 'Kiki', name: '阿清', desc: '粤语女声' },
  { id: 'Eric', name: '程川', desc: '四川话男声' },
];

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 获取音色列表
app.get('/api/voices', (req, res) => {
  res.json({ voices: VOICES });
});

// 语音合成接口（qwen3-tts-flash 模型）
app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body;

  if (!text || !voice) {
    return res.status(400).json({ error: '请提供文本和音色' });
  }

  const ttsUrl = API_CONFIG.useMaaS ? API_CONFIG.ttsUrlMaaS : API_CONFIG.ttsUrl;

  try {
    // 第一步：提交 TTS 请求，获取音频 URL
    const response = await fetch(ttsUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen3-tts-flash',
        input: {
          text: text,
          voice: voice,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error:', response.status, errorText);

      let errorMsg = `API 请求失败 (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.message || errorJson.error?.message || errorMsg;
      } catch (_) {}

      return res.status(response.status).json({ error: errorMsg, detail: errorText });
    }

    const data = await response.json();

    // 第二步：下载音频文件
    const audioUrl = data.output?.audio?.url;
    if (!audioUrl) {
      return res.status(500).json({ error: 'API 返回中未找到音频 URL' });
    }

    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      return res.status(500).json({ error: '音频下载失败' });
    }

    const audioBuffer = await audioRes.buffer();

    // 根据文件扩展名判断格式
    const urlExt = audioUrl.split('?')[0].split('.').pop().toLowerCase();
    const contentType = urlExt === 'wav' ? 'audio/wav' : 'audio/mpeg';

    res.set({
      'Content-Type': contentType,
      'Content-Length': audioBuffer.length,
    });
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS Error:', error);
    res.status(500).json({ error: '服务器错误: ' + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🎙️  Qwen3-TTS 语音合成服务已启动`);
  console.log(`🌐  打开浏览器访问: http://localhost:${PORT}\n`);
  console.log(`📡  端点: ${API_CONFIG.useMaaS ? 'MaaS' : 'DashScope'} multimodal-generation`);
  console.log(`🎤  可用音色: ${VOICES.length} 种\n`);
});
