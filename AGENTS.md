# agents.md — Qwen3-TTS 语音合成项目

> 本文档记录项目架构和开发规范。**每次新功能开发或功能修改后，必须更新此文档。**

---

## 项目概述

基于阿里百炼 **qwen3-tts-flash** 模型的语音合成 Web 应用。
将文本转换为高质量语音（WAV 格式，24000Hz），支持 17 种内置音色 + 自定义音色克隆。

### 核心功能

- 文本转语音（TTS）
- 音色克隆（Voice Clone）：上传 15~20 秒音频即可克隆专属音色
- 克隆音色管理：创建、查询、删除

---

## 技术栈

| 组件 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 前端 | 原生 HTML/CSS/JS（无框架） |
| TTS 模型 | 阿里百炼 qwen3-tts-flash（内置音色）/ qwen3-tts-vc-2026-01-22（克隆音色） |
| 音色克隆 | qwen-voice-enrollment |
| 依赖 | express, node-fetch |

---

## 项目结构

```
cosyvoice-tts/
── .env                # API Key 配置（禁止提交）
├── .gitignore          # Git 忽略规则
├── server.js           # Express 后端服务
├── package.json        # 项目配置和依赖
├── agents.md           # 本文档（项目架构记录）
├── README.md           # GitHub 项目说明
├── custom_voices.json  # 自定义音色持久化存储
├── public/
│   └── index.html      # 前端单页应用（含 Tab 切换）
└── node_modules/
```

---

## API 配置

### 端点

| 用途 | 端点 |
|---|---|
| **TTS 合成** | `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` |
| **音色克隆/管理** | `https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization` |

### TTS 请求格式

```json
{
  "model": "qwen3-tts-flash",
  "input": { "text": "要转换的文本", "voice": "Cherry" }
}
```

### TTS 响应格式

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

### 音色克隆请求格式

```json
{
  "model": "qwen-voice-enrollment",
  "input": {
    "action": "create",
    "target_model": "qwen3-tts-vc-2026-01-22",
    "preferred_name": "myvoice",
    "audio": { "data": "data:audio/wav;base64,..." },
    "language": "zh"
  }
}
```

### 音色克隆响应格式

```json
{
  "output": {
    "voice": "qwen-tts-vc-myvoice-voice-20260703...",
    "target_model": "qwen3-tts-vc-2026-01-22"
  }
}
```

### 认证

- Header: `Authorization: Bearer <DASHSCOPE_API_KEY>`
- Key 从 `.env` 文件读取：`DASHSCOPE_API_KEY=sk-xxx`
- 可通过设置 `USE_MAAS=true` 切换到 MaaS 端点

---

## 内置音色（17 种）

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

返回所有可用音色列表（内置 + 自定义），每个音色包含 `type: "builtin" | "custom"`。

### POST /api/tts

请求体：
```json
{ "text": "文本内容", "voice": "Cherry" }
```

自动检测音色类型：
- 内置音色 → 使用 `qwen3-tts-flash` 模型
- 克隆音色（voice 以 `qwen-tts-vc-` 开头）→ 使用 `qwen3-tts-vc-2026-01-22` 模型

响应：直接返回 WAV 音频二进制数据（`audio/wav`）。

### POST /api/voice-clone

创建克隆音色。

请求体：
```json
{
  "audioBase64": "data:audio/wav;base64,...",
  "voiceName": "myvoice",
  "language": "zh"
}
```

- `audioBase64`：base64 编码的音频数据（支持 wav/mp3/m4a，15~20 秒，前端会校验时长）
- `voiceName`：音色名称（英文字母、数字、下划线，最长 16 字符）
- `language`：音频语种（zh/en/ja/ko/fr/de）

### DELETE /api/voice-clone/:voiceId

删除克隆音色（同时从百炼平台和本地存储中删除）。

---

## 前端功能

### 语音合成 Tab
- 文本输入（最大 2000 字符，实时字数统计）
- 音色选择卡片网格（内置 + 自定义，带类型标签）
- 生成语音按钮（带 loading 状态）
- 音频播放器（HTML5 audio）
- 下载按钮（保存为 `qwen3_tts_<timestamp>.wav`）

### 音色克隆 Tab
- 音频文件上传（点击或拖拽，支持 wav/mp3/m4a，最大 20MB）
- 音色名称输入
- 语种选择
- 克隆按钮（带 loading 状态）
- 已克隆音色列表（支持删除）
- 成功/错误提示

---

## 音色克隆存储

自定义音色持久化存储在 `custom_voices.json` 文件中：

```json
[
  {
    "id": "qwen-tts-vc-myvoice-voice-...",
    "name": "myvoice",
    "desc": "自定义克隆音色",
    "createdAt": "2026-07-03T02:13:41.542Z"
  }
]
```

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
| 2026-07-02 | 切换为 qwen3-tts-flash 模型，使用 multimodal-generation 端点；新增 17 种音色支持 |
| 2026-07-03 | **新增音色克隆功能**：支持上传音频克隆专属音色；新增 /api/voice-clone 创建/删除接口；前端新增「音色克隆」Tab；自定义音色持久化存储到 custom_voices.json |
| 2026-07-07 | **新增手机短信验证登录与账号管理**：引入 SQLite 数据库（better-sqlite3）；新增用户系统（users 表）；新增 JWT 认证（jsonwebtoken）；新增 /api/auth/send-code、/api/auth/login、/api/auth/me、/api/auth/admin/stats 接口；音色克隆数据从 JSON 迁移到 SQLite 并关联 user_id；音色按用户隔离（当前用户只看到自己的克隆音色）；前端新增登录页面 + 用户状态栏 + 管理员统计面板；支持 UniSMS 短信发送 |

---

## 开发注意事项

1. **更新 agents.md**：每次新增功能或修改架构后，必须同步更新本文档
2. **API Key 安全**：Key 存储在 `.env` 中，不要提交到版本控制
3. **音频格式**：qwen3-tts-flash 返回 WAV 格式（24000Hz, 16-bit, mono）
4. **模型匹配**：克隆音色必须使用 `qwen3-tts-vc-2026-01-22` 模型合成，TTS 接口会自动检测音色类型并选择正确模型
5. **音色命名**：克隆音色名称只允许英文字母、数字、下划线，最长 16 字符
6. **克隆音频要求**：15~20 秒，最大 20MB，前端通过 HTML5 Audio API 校验时长
7. **依赖**：express、node-fetch、better-sqlite3、jsonwebtoken
8. **认证**：所有 TTS/克隆接口需要 JWT 认证（Authorization: Bearer <token>），未登录返回 401
9. **音色隔离**：每个用户只能看到/使用/删除自己的克隆音色，内置音色所有人可用
10. **管理员**：通过 ADMIN_PHONES 环境变量配置，管理员可查看平台统计
11. **数据存储**：用户和音色数据存储在 SQLite（data.db），旧 custom_voices.json 在首次启动时自动迁移
