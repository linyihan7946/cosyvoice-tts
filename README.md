# 文字转语音助手

基于阿里百炼 **qwen3-tts-flash** 模型的语音合成 Web 应用，支持 17 种音色（含多种方言）。

## 功能

-  文本输入（最长 2000 字符）
- 🎤 17 种音色可选（普通话、上海话、北京话、四川话、粤语、闽南话、天津话、南京话、陕西话）
- 🎧 在线试听 + 下载 WAV 音频
- ⚡ 无需额外依赖，开箱即用

## 快速开始

### 1. 获取 API Key

前往 [阿里百炼控制台](https://bailian.console.aliyun.com/) 创建 API Key。

### 2. 配置

```bash
# 复制并编辑 backend/.env 文件
echo "DASHSCOPE_API_KEY=sk-你的APIKey" > backend/.env
```

数据库使用 MySQL。可通过 `DATABASE_URL`/`MYSQL_URL`，或 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 配置连接。

### 3. 运行

```bash
cd backend
npm install
npm start
```

打开浏览器访问 `http://localhost:3000`

### Docker 部署

```bash
docker compose up -d --build
```

`docker-compose.yml` 会启动 MySQL，并把数据保存到 `cosyvoice_mysql_data` Docker 命名卷。重新构建和重新部署会保留数据；不要在没有备份时执行 `docker compose down -v` 或删除该 volume。

## 可用音色

| 音色 | 描述 | 方言 |
|---|---|---|
| Cherry (芊悦) | 阳光积极女声 | 普通话 |
| Ethan (晨煦) | 标准普通话男声 | 普通话 |
| Nofish (不吃鱼) | 不翘舌音女声 | 普通话 |
| Jennifer (詹妮弗) | 电影感美式女声 | 英语 |
| Ryan (甜茶) | 戏剧张力男声 | 普通话 |
| Katerina (卡捷琳娜) | 成熟韵律女声 | 普通话 |
| Elias (墨讲师) | 学术风格男声 | 普通话 |
| Jada (阿珍) | 上海话女声 | 上海话 |
| Dylan (晓东) | 北京话男声 | 北京话 |
| Sunny (晴儿) | 四川话女声 | 四川话 |
| li (老李) | 南京话男声 | 南京话 |
| Marcus (秦川) | 陕西话男声 | 陕西话 |
| Roy (阿杰) | 闽南话男声 | 闽南话 |
| Peter (李彼得) | 天津话男声 | 天津话 |
| Rocky (阿强) | 粤语男声 | 粤语 |
| Kiki (阿清) | 粤语女声 | 粤语 |
| Eric (程川) | 四川话男声 | 四川话 |

## 技术栈

- Node.js + Express
- 原生 HTML/CSS/JS 前端
- MySQL + mysql2
- qwen3-tts-flash 模型

## License

MIT
