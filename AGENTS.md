# agents.md — 文字转语音助手项目

> 本文档记录项目架构和开发规范。**每次新功能开发或功能修改后，必须更新此文档。**

---

## 项目概述

基于阿里百炼 **qwen3-tts-flash** 模型的语音合成 Web 应用。
将文本转换为高质量语音（WAV 格式，24000Hz），支持 17 种内置音色 + 自定义音色克隆。

用户可见产品名：**文字转语音助手**。

### 核心功能

- 文本转语音（TTS）
- 音色克隆（Voice Clone）：上传 15~20 秒音频即可克隆专属音色
- 克隆音色管理：创建、查询、删除
- **动态配额系统**：按用户层级限制克隆数和每日 TTS 次数，配额参数可在运行时动态调整

---

## 技术栈

| 组件 | 技术 |
|---|---|
| 后端 | Node.js + Express |
| 前端 | 原生 HTML/CSS/JS（无框架） |
| TTS 模型 | 阿里百炼 qwen3-tts-flash（内置音色）/ qwen3-tts-vc-2026-01-22（克隆音色） |
| 音色克隆 | qwen-voice-enrollment |
| 依赖 | express, node-fetch, better-sqlite3, jsonwebtoken |
| 测试 | Jest, supertest |
| 数据库 | SQLite（better-sqlite3） |
| 认证 | JWT（jsonwebtoken，30 天有效期） |
| 短信 | UniSMS REST API |

---

## 项目结构

```
cosyvoice-tts/
├── backend/               # 后端
│   ├── server.js          # Express 后端服务
│   ├── db.js              # SQLite 数据库层
│   ├── auth.js            # JWT 认证模块
│   ├── send_sms_unisdk.py # UniSMS Python SDK 桥接脚本
│   ├── .env               # API Key 配置（禁止提交）
│   ├── package.json       # 后端依赖
│   ├── data.db            # SQLite 数据库（运行时）
│   ├── custom_voices.json
│   └── __tests__/         # 单元测试
│       ├── db.test.js     # 数据库层测试
│       ├── auth.test.js   # 认证模块测试
│       └── api.test.js    # API 接口测试
├── frontend/              # 前端
│   └── index.html         # 前端单页应用
├── .gitignore             # Git 忽略规则
├── README.md              # GitHub 项目说明
└── agents.md              # 本文档（项目架构记录）
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

### GET /api/quota

查询当前用户的配额和用量。需要登录。

响应：
```json
{
  "tier": "free",
  "voiceClones": { "current": 1, "limit": 1 },
  "dailyTts": { "used": 3, "limit": 10 },
  "expiresAt": null
}
```

- `dailyTts.limit` 为 `-1` 表示无限

### GET /api/auth/admin/quota-config

管理员：获取所有层级的配额配置。

### PUT /api/auth/admin/quota-config

管理员：动态修改配额。Body: `{ "tier": "free", "key": "daily_tts_limit", "value": "20" }`

### GET /api/auth/admin/user-tiers

管理员：获取所有用户的层级、到期时间、克隆数、今日 TTS 用量。

### PUT /api/auth/admin/user-tiers

管理员：修改用户层级。Body: `{ "userId": "xxx", "tier": "monthly", "expiresAt": "2026-08-08" }`

### GET /api/auth/admin/usage

管理员：查询用量记录。Query: `?date=2026-07-08&userId=xxx`（均可选）

---

## 配额系统

### 用户层级

| 层级 | 标识 | 默认克隆上限 | 默认每日 TTS |
|---|---|---|---|
| 普通用户 | `free` | 1 | 10 |
| 月会员 | `monthly` | 5 | 100 |
| 管理员 | `admin` | 100 | 无限 (-1) |

### 层级解析优先级

1. `ADMIN_PHONES` 环境变量中的手机号 → `admin`（兼容旧逻辑）
2. `user_tiers` 表中的记录 → 对应层级（月会员会检查 `expires_at` 是否过期）
3. 默认 → `free`

### 数据库表

| 表 | 用途 |
|---|---|
| `quota_config` | 各层级配额参数（key-value），运行时可改 |
| `user_tiers` | 用户层级 + 会员到期时间 |
| `usage_tracking` | 每日 TTS 用量（user_id + date 联合主键） |

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
cd backend
npm install
npm start          # 或 npm run dev
# 打开 http://localhost:3000
```

---

## 测试

### 运行测试

```bash
cd backend
npm test              # 运行所有测试
npm run test:watch    # 监听模式
npm run test:coverage # 查看覆盖率
```

### 测试覆盖范围

| 文件 | 测试类型 | 测试数量 |
|---|---|---|
| `__tests__/db.test.js` | 数据库层单元测试 | 30+ |
| `__tests__/auth.test.js` | 认证模块单元测试 | 15+ |
| `__tests__/api.test.js` | API 接口集成测试 | 20+ |

### 测试策略

- **db.js 测试**：使用 `:memory:` 内存数据库，每个测试前重置，确保数据隔离
- **auth.js 测试**：直接测试函数输入输出，中间件使用 mock 对象
- **API 测试**：使用 supertest 发送 HTTP 请求，mock 外部 API（DashScope、UniSMS）

### 注意事项

- 测试时会创建临时内存数据库，不影响生产数据
- `db.resetDb()` 函数支持切换到测试数据库
- server.js 使用 `require.main === module` 判断是否直接运行，避免测试时启动服务器

---

## 历史变更

| 日期 | 变更内容 |
|---|---|
| 2026-07-02 | 项目初始化，使用 CosyVoice + DashScope 原生 API |
| 2026-07-02 | 切换为 qwen3-tts-flash 模型，使用 multimodal-generation 端点；新增 17 种音色支持 |
| 2026-07-03 | **新增音色克隆功能**：支持上传音频克隆专属音色；新增 /api/voice-clone 创建/删除接口；前端新增「音色克隆」Tab；自定义音色持久化存储到 custom_voices.json |
| 2026-07-07 | **新增手机短信验证登录与账号管理**：引入 SQLite 数据库（better-sqlite3）；新增用户系统（users 表）；新增 JWT 认证（jsonwebtoken）；新增 /api/auth/send-code、/api/auth/login、/api/auth/me、/api/auth/admin/stats 接口；音色克隆数据从 JSON 迁移到 SQLite 并关联 user_id；音色按用户隔离（当前用户只看到自己的克隆音色）；前端新增登录页面 + 用户状态栏 + 管理员统计面板；支持 UniSMS 短信发送 |
| 2026-07-07 | **优化短信验证码登录与产品命名**：UniSMS 发送按 ai-personal-trainer 项目中的 Python SDK 逻辑对齐（POST JSON、秒级 timestamp、8 字节 nonce、HMAC hex 签名），并兼容 UniSMS 实际返回的 message=Success/messages.status=sent 成功响应；服务端/前端统一清理手机号格式；调试环境返回验证码用于短信不可达兜底；页面和 README 用户可见标题改为「文字转语音助手」 |
| 2026-07-08 | **新增动态配额系统**：新增 `quota_config`（各层级配额参数）、`user_tiers`（用户层级+到期时间）、`usage_tracking`（每日 TTS 用量）三张表；新增 `checkQuota()` 中间件在 TTS 和音色克隆接口前拦截超额请求（返回 429）；TTS 成功后自动递增用量计数；管理员可通过 API 动态调整各层级配额值、用户层级、查看用量记录；前端展示配额进度条、层级标签、管理员配额管理面板 |
| 2026-07-08 | **前后端目录分离**：后端代码（server.js, db.js, auth.js, .env, package.json, data.db）迁移到 `backend/` 目录；前端代码（index.html）迁移到 `frontend/` 目录；服务启动方式改为 `cd backend && npm start` |
| 2026-07-08 | **新增完整单元测试**：引入 Jest + supertest 测试框架；新增 `__tests__/db.test.js`（数据库层测试，覆盖用户/音色/配额/用量等 18 个函数）、`__tests__/auth.test.js`（认证模块测试，覆盖 token 创建/验证/中间件）、`__tests__/api.test.js`（API 接口集成测试，覆盖 14 个接口）；修改 db.js 添加 `resetDb()` 支持测试隔离；server.js 添加 `module.exports` 支持 supertest；共 66 个测试用例，全部通过 |
| 2026-07-08 | **优化短信不可达兜底体验**：当 UniSMS 返回发送成功但用户未收到短信时，前端成功提示会在调试环境显示 `debug_code` 作为本地验证码兜底，避免运营商延迟或拦截导致无法登录 |
| 2026-07-08 | **短信发送改为优先使用 UniSMS Python SDK**：新增 `backend/send_sms_unisdk.py`，后端 `sendSms()` 优先调用与 ai-personal-trainer 相同的 Python SDK 发送短信；仅当 SDK 不可用时才回退 REST API |
| 2026-07-09 | **固定生成语音按钮位置**：将语音合成 Tab 的生成按钮改为视口底部固定操作栏，切换音色分类或列表高度变化时按钮不再上下跳动；内容区增加底部留白避免遮挡结果和音色列表 |
| 2026-07-09 | **扩大音色列表区域**：语音合成 Tab 的音色网格改为响应式固定高度滚动区，音色较少的分类也会占据接近底部生成按钮的位置，减少中间空白 |

---

## 开发注意事项

1. **更新 agents.md**：每次新增功能或修改架构后，必须同步更新本文档
2. **API Key 安全**：Key 存储在 `backend/.env` 中，不要提交到版本控制
3. **音频格式**：qwen3-tts-flash 返回 WAV 格式（24000Hz, 16-bit, mono）
4. **模型匹配**：克隆音色必须使用 `qwen3-tts-vc-2026-01-22` 模型合成，TTS 接口会自动检测音色类型并选择正确模型
5. **音色命名**：克隆音色名称只允许英文字母、数字、下划线，最长 16 字符
6. **克隆音频要求**：15~20 秒，最大 20MB，前端通过 HTML5 Audio API 校验时长
7. **依赖**：express、node-fetch、better-sqlite3、jsonwebtoken
8. **认证**：所有 TTS/克隆接口需要 JWT 认证（Authorization: Bearer <token>），未登录返回 401
9. **音色隔离**：每个用户只能看到/使用/删除自己的克隆音色，内置音色所有人可用
10. **管理员**：通过 ADMIN_PHONES 环境变量配置，管理员可查看平台统计
11. **数据存储**：用户、音色、配额配置、层级关系和用量数据存储在 SQLite（`backend/data.db`，含 5 张表：users, custom_voices, quota_config, user_tiers, usage_tracking），旧 custom_voices.json 在首次启动时自动迁移
12. **短信发送**：UniSMS 逻辑需与 ai-personal-trainer 的 Python SDK 保持一致；鉴权参数放 URL Query，短信内容参数（to/signature/templateId/templateData）放 JSON Body；签名使用排序后的 Query + HMAC-SHA256 hex；发送成功需满足顶层 `code === "0"`，并兼容 `message === "Success"`、`data.code === "OK"` 或 `messages[].status === "sent"`；调试环境可返回 debug_code 作为验证码兜底
13. **配额系统**：配额参数存储在 `quota_config` 表中（非 .env），支持运行时通过管理 API 动态修改无需重启；`-1` 表示无限；每日用量以 `date('now')` 为键，无需 cron 清理；管理员层级兼容 `ADMIN_PHONES` 环境变量（优先级最高）
14. **短信兜底体验**：前端在 `sms_sent: true` 且响应包含 `debug_code` 时，可在成功提示中显示本地验证码；生产环境应设置 `NODE_ENV=production` 或关闭 `SHOW_DEBUG_CODE`，避免暴露验证码
15. **重启服务**：每次修改后端代码（server.js, db.js, auth.js 等）后，必须先停掉旧服务（`taskkill /F /IM node.exe` 或关闭终端），再重启新服务（`cd backend && npm start`），否则修改不会生效
16. **Python SDK 依赖**：短信发送优先调用 `backend/send_sms_unisdk.py`，运行环境需要可用的 `python` 命令和 `unisms`/`uni-sdk` Python 包；若 SDK 不可用，后端会自动回退 REST API；`NODE_ENV=test` 时会跳过真实短信发送
