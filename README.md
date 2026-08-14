# larkbot

> 在飞书里遥控本地开发机上的 traex 会话。

在飞书里 @ 一个机器人，它就在你的**开发机**上拉起一个 traex 会话：
每个话题（Thread）就是一个独立会话，实时把 CLI 输出流式回传成飞书卡片。

我平时用 traex 在开发机上写代码，但人不总在电脑前。想要一个「用飞书就能随时接着聊、
任务在开发机上真实执行」的入口——于是有了 larkbot：单机器人、单 CLI、单进程、零公网依赖。

```
飞书 @机器人 ──▶ 长连接(WSClient) ──▶ 开发机 daemon ──▶ node-pty 拉起 traex
     ▲                                                          │
     └────────────── 实时流式卡片 / 表情操作 ◀───────────────────┘
```

## 核心特性（v1 目标）

- **@ 即开会话**：@ 机器人自动用 `reply_in_thread` 建一个飞书话题，话题 = 会话身份
- **队列不打断**：会话忙时新消息进 FIFO 队列，不打断进行中的 turn，空闲后按序执行
- **实时流式卡片**：每轮一张可刷新的交互卡片，增量 PATCH 展示 traex 输出
- **关闭会话**：通过卡片按钮 / 控制台关闭并冻结会话
- **表情进度指示**：关闭流式卡片后，用表情在触发消息上标注进度（收到 `Get` → 完成 `DONE`）
- **主动命令注入**：通过本地控制台 / HTTP 主动向某会话注入指令
- **建 bot 控制台**：本地 Web 页面创建 / 编辑机器人、查看活跃会话

> 当前进度：@ 建会话、队列调度、idle 检测已实现（阶段一、二）；流式卡片、表情、控制台
> 开发中（见 [docs/roadmap.md](docs/roadmap.md)）。

## 为什么用飞书长连接（WSClient）

开发机主动连出去订阅事件，**无需公网 IP、无需内网穿透、无需配置 webhook 回调地址**。
这是「飞书上只是个 bot、真正执行在我自己的开发机」这一形态能成立的关键。

## 快速开始

```bash
npm install               # 安装依赖（postinstall 会自动修复 node-pty 的 spawn-helper 权限）
cp .env.example .env       # 填入飞书 appId / appSecret / 你的 open_id
npm run build              # 编译到 dist/
npm run dev                # 或直接以 tsx 运行 daemon
```

然后在飞书里 @ 你的机器人，开始对话。

### 环境说明：node-pty 原生依赖

node-pty 通过 prebuild 分发（`prebuilds/<platform-arch>/`），无需本地 `node-gyp` 编译。
但在开启了 npm `allow-scripts` 安全策略的环境里，node-pty 的 postinstall 会被拦，导致 macOS 上的
`spawn-helper` 缺少执行位、运行期报 `posix_spawnp failed`。本项目用 `scripts/fix-pty-helper.mjs`
在自身 postinstall 里幂等修复该权限；若仍遇到，可手动：

```bash
chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
```

## 文档

- [docs/architecture.md](docs/architecture.md) — 架构设计与模块拆分
- [docs/data-model.md](docs/data-model.md) — 核心数据模型与状态机
- [docs/roadmap.md](docs/roadmap.md) — 分阶段实现路线图
- [docs/scope.md](docs/scope.md) — 明确做什么 / 不做什么

## 技术栈

TypeScript · Node >=20 · @larksuiteoapi/node-sdk（长连接 + API）· node-pty（PTY）·
@xterm/headless（终端渲染）· 原生 HTTP 控制台 · JSON 文件持久化

## License

MIT
