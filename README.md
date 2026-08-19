# larkbot

> 把开发机上的 AI 编程 CLI 封装成一个飞书里的“开发者替身”。

larkbot 的目标不是再做一个聊天机器人，而是把开发机上的 traex 会话和共享知识库封装成一个
可远程接入、可观察、可中断、可恢复的工作代理。群里的 QA、客户端、前端或研发同学在飞书里
@ 机器人提问，实际执行仍发生在开发机：代码仓库、CLI 凭证、运行环境、历史上下文和脱敏同步
后的 public 知识库都留在开发机侧，飞书只承担入口和协作界面。

这个设计解决的是一个很具体的问题：很多排查问题需要同时理解业务口径、知识库、线上日志和
代码实现，但 QA 或客户端同学不一定知道该查哪个服务、哪个字段、哪个仓库。larkbot 把这些能力
收敛到一个飞书入口：用户直接问问题，开发机替身先用共享知识库对齐业务对象和规则，再结合日志
和代码给出可转述的结论。

```
飞书 @机器人 ──▶ 长连接(WSClient) ──▶ 开发机 daemon ──▶ node-pty 拉起 traex
     ▲                                                          │
     └────────────── 实时流式卡片 / 表情操作 ◀───────────────────┘
```

## 当前能力（MVP）

- **@ 即开会话**：@ 机器人自动用 `reply_in_thread` 建一个飞书话题，话题 = 会话身份
- **群内直接提问**：控制台展示 bot 已加入 / 已感知的群聊，Owner 点“启用”后群内成员即可直接提问或操作卡片
- **队列不打断**：会话忙时新消息进 FIFO 队列，不打断进行中的 turn，空闲后按序执行
- **实时分析卡片**：每轮一张可刷新的交互卡片，展示“正在全力分析中…”、完成 / 停止状态、token 和总耗时
- **只读分析过程**：卡片和控制台可打开只读终端，查看当前 traex 会话输出
- **停止本轮分析**：卡片按钮 / 控制台只中断当前 turn，不关闭会话；会话后续可继续复用
- **关闭会话**：控制台关闭并冻结会话路由
- **表情进度指示**：关闭流式卡片后，用表情在触发消息上标注进度（收到 `Get` → 完成 `DONE`）
- **本地控制台**：Web 页面配置 bot、群聊授权、系统提示词 profiles、Trae 模型、落款、流式卡片开关，并按发起人和群聊管理活跃 / 历史会话
- **模型选择**：控制台通过 `/api/models` 执行 `traex models` 动态获取模型列表；保存后只影响新会话
- **会话恢复**：daemon 重启后恢复会话路由，下一条消息 lazy resume 到 traex 原生会话；恢复失败时降级为新上下文
- **生命周期清理**：每天凌晨 3 点关闭 2 天未活跃会话、删除 7 天未活跃路由，并私聊 Owner 汇总清理明细
- **知识库增强排查**：搭配开发机 public 知识库使用，先按脱敏知识库建立业务判定口径，再查日志和代码

## 设计取舍

- **开发机主动连出**：使用飞书长连接，避免公网 IP、内网穿透和 webhook 暴露。
- **执行环境不搬家**：traex 仍在本机仓库和本机配置中运行，减少凭证复制和环境漂移。
- **知识库不进飞书**：共享知识库由本地资料脱敏同步到开发机，Agent 在开发机侧读取，飞书只看到最终答复。
- **话题即会话**：飞书 Thread 天然承载上下文边界，便于多人查看，也便于恢复路由。
- **过程可观察但不刷屏**：飞书卡片只展示状态和入口，完整终端输出放在只读控制台。
- **停止不等于关闭**：停止当前 turn 后保留会话，下一条消息仍可继续。

## 为什么用飞书长连接（WSClient）

开发机主动连出去订阅事件，**无需公网 IP、无需内网穿透、无需配置 webhook 回调地址**。
这是「飞书上只是个 bot、真正执行在开发机」这一形态能成立的关键。

## 快速开始

```bash
npm install               # 安装依赖（postinstall 会自动修复 node-pty 的 spawn-helper 权限）
cp .env.example .env       # 填入飞书 appId / appSecret / 你的 open_id
npm run build              # 编译到 dist/
npm run dev                # 或直接以 tsx 运行 daemon
```

然后打开控制台配置 bot，再在飞书里 @ 你的机器人开始对话。默认控制台地址：

```bash
http://127.0.0.1:8787/
```

常用运行方式：

```bash
npm test                   # 单测
npm run typecheck          # TypeScript 类型检查
npm start                  # 运行已编译的 dist/daemon.js
```

状态文件默认保存在 `~/.larkbot/`，可通过 `LARKBOT_STATE_DIR` 覆盖。

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
- [docs/roadmap.md](docs/roadmap.md) — 当前状态与后续路线图
- [docs/scope.md](docs/scope.md) — 明确做什么 / 不做什么
- [docs/qa-log-troubleshooting-prompt.md](docs/qa-log-troubleshooting-prompt.md) — QA 日志排查 Bot prompt

## 技术栈

TypeScript · Node >=20 · @larksuiteoapi/node-sdk（长连接 + API）· node-pty（PTY）·
@xterm/headless（终端渲染）· 原生 HTTP 控制台 · JSON 文件持久化

## License

MIT
