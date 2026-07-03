# agents.md — Qwen3-TTS 语音合成项目

> 本文档记录项目架构和开发规范。**每次新功能开发或功能修改后，必须更新此文档。**

---

## 项目概述

基于阿里百炼 **qwen3-tts-flash** 模型的语音合成 Web 应用。
将文本转换为高质量语音（WAV 格式，24000Hz），支持 17 种音色。

---

## 技术栈

| 组件 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 前端 | 原生 HTML/CSS/JS（无框架） |
| TTS 模型 | 阿里百炼 qwen3-tts-flash |
| 依赖 | express, node-fetch |

---

## 项目结构

```
cosyvoice-tts/
├── .env                # API Key 配置
├── server.js           # Express 后端服务
├── package.json        # 项目配置和依赖
├── agents.md           # 本文档（项目架构记录）
├── public/
│   └── index.html      # 前端单页应用
└── node_modules/
```

---

## API 配置

### 端点

- **主端点（DashScope 原生）**:
  `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **备用端点（MaaS）**:
  `https://llm-epwm5xmzoslfuxyh.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`

### 请求格式

```json
{
  "model": "qwen3-tts-flash",
  "input": {
    "text": "要转换的文本",
    "voice": "Cherry"
  }
}
```

### 响应格式

```json
{
  "output": {
    "audio": {
      "id": "audio_xxx",
      "url": "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/...",
      "expires_at": 1783074642
    },
    "finish_reason": "stop"
  },
  "usage": { "characters": 22 }
}
```

响应中的 `url` 是 OSS 临时链接，需要再次请求下载 WAV 音频文件。

### 认证

- Header: `Authorization: Bearer <DASHSCOPE_API_KEY>`
- Key 从 `.env` 文件读取：`DASHSCOPE_API_KEY=sk-xxx`
- 可通过设置 `USE_MAAS=true` 切换到 MaaS 端点

---

## 可用音色（17 种）

| ID | 名称 | 描述 | 方言 |
|---|---|---|---|
| Cherry | 芊悦 | 阳光积极女声 | 普通话 |
| Ethan | 晨煦 | 标准普通话男声 | 普通话 |
| Nofish | 不吃鱼 | 不翘舌音女声 | 普通话 |
| Jennifer | 詹妮弗 | 电影感美式女声 | 英语 |
| Ryan | 甜茶 | 戏剧张力男声 | 普通话 |
| Katerina | 卡捷琳娜 | 成熟韵律女声 | 普通话 |
| Elias | 墨讲师 | 学术风格男声 | 普通话 |
| Jada | 阿珍 | 上海话女声 | 上海话 |
| Dylan | 晓东 | 北京话男声 | 北京话 |
| Sunny | 晴儿 | 四川话女声 | 四川话 |
| li | 老李 | 南京话男声 | 南京话 |
| Marcus | 秦川 | 陕西话男声 | 陕西话 |
| Roy | 阿杰 | 闽南话男声 | 闽南话 |
| Peter | 李彼得 | 天津话男声 | 天津话 |
| Rocky | 阿强 | 粤语男声 | 粤语 |
| Kiki | 阿清 | 粤语女声 | 粤语 |
| Eric | 程川 | 四川话男声 | 四川话 |

---

## 服务端接口

### GET /api/voices

返回所有可用音色列表。

### POST /api/tts

请求体：
```json
{ "text": "文本内容", "voice": "Cherry" }
```

响应：直接返回 WAV 音频二进制数据（`audio/wav`）。

---

## 前端功能

- 文本输入（最大 2000 字符，实时字数统计）
- 音色选择卡片网格
- 生成语音按钮（带 loading 状态）
- 音频播放器（HTML5 audio）
- 下载按钮（保存为 `qwen3_tts_<timestamp>.wav`）

---

## 运行方式

```bash
npm install
npm start          # 或 npm run dev
# 打开 http://localhost:3000
```

---

## 历史变更

| 日期 | 变更内容 |
|---|---|
| 2026-07-02 | 项目初始化，使用 CosyVoice + DashScope 原生 API |
| 2026-07-02 | 切换为 qwen3-tts-flash 模型，使用 multimodal-generation 端点；新增 17 种音色支持；新增 MaaS 端点支持 |

---

## 开发注意事项

1. **更新 agents.md**：每次新增功能或修改架构后，必须同步更新本文档
2. **API Key 安全**：Key 存储在 `.env` 中，不要提交到版本控制
3. **音频格式**：qwen3-tts-flash 返回 WAV 格式（24000Hz, 16-bit, mono）
4. **MaaS 切换**：设置 `USE_MAAS=true` 可切换到 MaaS 端点
5. **依赖**：仅 express 和 node-fetch 两个依赖，无需额外安装
