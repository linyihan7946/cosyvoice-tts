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
| 依赖 | express, node-fetch, mysql2, jsonwebtoken |
| 测试 | Jest, supertest |
| 数据库 | MySQL（mysql2；测试环境使用内存库） |
| 认证 | JWT（jsonwebtoken，30 天有效期） |
| 短信 | UniSMS REST API |

---

## 项目结构

```
cosyvoice-tts/
├── backend/               # 后端
│   ├── server.js          # Express 后端服务
│   ├── db.js              # MySQL 数据库层
│   ├── auth.js            # JWT 认证模块
│   ├── send_sms_unisdk.py # UniSMS Python SDK 桥接脚本
│   ├── .env               # API Key 配置（禁止提交）
│   ├── package.json       # 后端依赖
│   ├── custom_voices.json
│   └── __tests__/         # 单元测试
│       ├── db.test.js     # 数据库层测试
│       ├── auth.test.js   # 认证模块测试
│       └── api.test.js    # API 接口测试
├── frontend/              # 前端
│   └── index.html         # 前端单页应用
├── Dockerfile             # 生产镜像构建，安装 Node + UniSMS Python SDK
├── docker-compose.yml     # 生产部署配置，MySQL 使用 Docker 命名卷持久化
├── .dockerignore          # Docker 构建排除规则（禁止打包本地数据库）
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
{ "text": "文本内容", "voice": "Cherry", "returnUrl": true }
```

自动检测音色类型：
- 内置音色 → 使用 `qwen3-tts-flash` 模型
- 克隆音色（voice 以 `qwen-tts-vc-` 开头）→ 使用 `qwen3-tts-vc-2026-01-22` 模型

默认响应：直接返回 WAV 音频二进制数据（`audio/wav`）。

当 `returnUrl: true` 时返回 JSON，供微信浏览器等不支持 `Blob download` 的环境使用：
```json
{
  "success": true,
  "audioUrl": "/api/tts-audio/xxx",
  "downloadUrl": "/api/tts-audio/xxx/download",
  "filename": "tts_1783074642000.wav",
  "contentType": "audio/wav",
  "expiresIn": 1800
}
```

### GET /api/tts-audio/:id

打开临时生成的音频，`Content-Disposition: inline`，适合微信内置浏览器直接播放。

### GET /api/tts-audio/:id/download

下载临时生成的音频，`Content-Disposition: attachment`，适合普通浏览器下载。

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

### POST /api/feedback

用户提交问题反馈。需要登录。

请求体：
```json
{ "content": "反馈内容（最长 2000 字）", "contact": "联系方式（选填）" }
```

### GET /api/auth/admin/feedback

管理员：获取反馈列表。Query: `?status=pending`（可选，筛选状态）

### PUT /api/auth/admin/feedback/:id

管理员：更新反馈状态。Body: `{ "status": "resolved" }`。可选值：`pending`/`processing`/`resolved`/`closed`

### DELETE /api/auth/admin/feedback/:id

管理员：删除反馈记录

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
| `feedback` | 用户问题反馈（user_id, content, contact, status, created_at） |

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
| `__tests__/db.test.js` | 数据库层单元测试 | 37+ |
| `__tests__/auth.test.js` | 认证模块单元测试 | 15+ |
| `__tests__/api.test.js` | API 接口集成测试 | 32+ |

### 测试策略

- **db.js 测试**：使用 `:memory:` 内存数据库，每个测试前重置，确保数据隔离
- **auth.js 测试**：直接测试函数输入输出，中间件使用 mock 对象
- **API 测试**：使用 supertest 发送 HTTP 请求，mock 外部 API（DashScope、UniSMS）
- **强制要求：开发完新的功能或者功能修改后，必须新增或更新对应的单元测试**

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
| 2026-07-09 | **生产数据库持久化部署**：新增 Dockerfile、docker-compose.yml 和 .dockerignore；生产部署使用 MySQL 服务和 `cosyvoice_mysql_data` Docker 命名卷持久化，避免重新构建/部署镜像覆盖用户数据 |
| 2026-07-09 | **数据库切换到 MySQL**：后端数据库层从 SQLite/better-sqlite3 改为 MySQL/mysql2；新增 `DATABASE_URL`/`MYSQL_*` 环境变量配置；测试环境通过 `db.resetDb(':memory:')` 使用内存库，不依赖真实 MySQL；旧 SQLite 数据不迁移 |
| 2026-07-09 | **新增本地内存库兜底**：开发环境可设置 `USE_MEMORY_DB=true` 临时使用内存数据库启动页面；该开关在 `NODE_ENV=production` 下无效，线上仍强制使用 MySQL，避免部署数据丢失 |
| 2026-07-09 | **修复 Windows .env 解析**：后端读取 `.env` 时先 `trim()` 再匹配，并支持数字/下划线变量名，避免 CRLF 行尾导致 `MYSQL_*`、短信和 API Key 等配置无法加载 |
| 2026-07-13 | **优化微信浏览器音频下载**：`POST /api/tts` 支持 `returnUrl: true` 返回临时真实音频链接；新增 `/api/tts-audio/:id` inline 播放和 `/download` 附件下载；前端在微信内置浏览器中改为打开音频页面，避免 `Blob URL + download` 被微信拦截 |
| 2026-07-14 | **新增问题反馈模块**：新增 `feedback` 表（id, user_id, content, contact, status, created_at）；新增 `POST /api/feedback` 用户提交反馈接口、`GET /api/auth/admin/feedback` 管理员查看反馈列表、`PUT /api/auth/admin/feedback/:id` 更新状态、`DELETE /api/auth/admin/feedback/:id` 删除反馈；反馈状态支持 pending/processing/resolved/closed；前端用户栏新增「问题反馈」按钮和弹窗；管理员面板新增「问题反馈」子标签，支持按状态筛选、标记处理、删除 |
| 2026-07-14 | **音色克隆新增录音功能**：克隆页面顶部新增录音区域（放在文件上传前面），使用 MediaRecorder API 录制麦克风音频，最长 20 秒，带倒计时显示；录音完成后可试听、重新录制或使用；15~20 秒时长校验与文件上传一致 |
| 2026-07-14 | **管理员删除音色免冷却**：管理员删除克隆音色后不再受 24 小时冷却期限制，可立即重新克隆 |

---

## 开发注意事项

1. **更新 agents.md**：每次新增功能或修改架构后，必须同步更新本文档
2. **API Key 安全**：Key 存储在 `backend/.env` 中，不要提交到版本控制
3. **音频格式**：qwen3-tts-flash 返回 WAV 格式（24000Hz, 16-bit, mono）
4. **模型匹配**：克隆音色必须使用 `qwen3-tts-vc-2026-01-22` 模型合成，TTS 接口会自动检测音色类型并选择正确模型
5. **音色命名**：克隆音色名称只允许英文字母、数字、下划线，最长 16 字符
6. **克隆音频要求**：15~20 秒，最大 20MB，前端通过 HTML5 Audio API 校验时长
7. **依赖**：express、node-fetch、mysql2、jsonwebtoken
8. **认证**：所有 TTS/克隆接口需要 JWT 认证（Authorization: Bearer <token>），未登录返回 401
9. **音色隔离**：每个用户只能看到/使用/删除自己的克隆音色，内置音色所有人可用
10. **管理员**：通过 ADMIN_PHONES 环境变量配置，管理员可查看平台统计
11. **数据存储**：用户、音色、配额配置、层级关系和用量数据存储在 MySQL；支持 `DATABASE_URL`/`MYSQL_URL` 或 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 配置；测试环境使用内存库；开发环境可用 `USE_MEMORY_DB=true` 临时内存启动（生产环境无效）；旧 SQLite 数据不迁移，旧 custom_voices.json 在首次启动时仍可自动迁移到 MySQL
12. **短信发送**：UniSMS 逻辑需与 ai-personal-trainer 的 Python SDK 保持一致；鉴权参数放 URL Query，短信内容参数（to/signature/templateId/templateData）放 JSON Body；签名使用排序后的 Query + HMAC-SHA256 hex；发送成功需满足顶层 `code === "0"`，并兼容 `message === "Success"`、`data.code === "OK"` 或 `messages[].status === "sent"`；调试环境可返回 debug_code 作为验证码兜底
13. **配额系统**：配额参数存储在 `quota_config` 表中（非 .env），支持运行时通过管理 API 动态修改无需重启；`-1` 表示无限；每日用量以 MySQL `CURDATE()` 为键，无需 cron 清理；管理员层级兼容 `ADMIN_PHONES` 环境变量（优先级最高）
14. **短信兜底体验**：前端在 `sms_sent: true` 且响应包含 `debug_code` 时，可在成功提示中显示本地验证码；生产环境应设置 `NODE_ENV=production` 或关闭 `SHOW_DEBUG_CODE`，避免暴露验证码
15. **重启服务**：每次修改后端代码（server.js, db.js, auth.js 等）后，必须先停掉旧服务（`taskkill /F /IM node.exe` 或关闭终端），再重启新服务（`cd backend && npm start`），否则修改不会生效
16. **Python SDK 依赖**：短信发送优先调用 `backend/send_sms_unisdk.py`，运行环境需要可用的 `python` 命令和 `unisms`/`uni-sdk` Python 包；若 SDK 不可用，后端会自动回退 REST API；`NODE_ENV=test` 时会跳过真实短信发送
17. **部署数据保护**：生产部署必须保留 `docker-compose.yml` 中的 `cosyvoice_mysql_data` 命名卷或等效 MySQL 持久化存储；常规 `docker compose up -d --build` 会保留数据，禁止在没有备份时执行 `docker compose down -v`、删除 Docker volume、重建 MySQL 数据目录或用空库覆盖线上库
18. **环境变量解析**：`.env` 支持 Windows CRLF 行尾；新增配置项时保持 `KEY=value` 格式即可，后端会先去除行首尾空白再解析
19. **微信下载兼容**：微信内置浏览器会拦截 `Blob URL` 或 `a.download` 文件下载；语音生成前端应使用 `returnUrl: true` 获取真实音频链接，微信中打开 `/api/tts-audio/:id` 播放/保存，普通浏览器使用 `/download` 下载
