# 分阶段实现路线图

按里程碑推进，而非按固定工期。优先把精力投在有技术含量的部分
（idle 检测、队列调度、流式渲染），把体力活（控制台 UI、配置项）压到最小。

## 阶段一 · 打通命脉 ✅

- 脚手架：TS + node-pty + lark sdk，`bots.json` 读取，daemon 启动 / 退出
- 飞书 WSClient 长连接，订阅 `im.message.receive_v1`，识别 @ 到 bot 的消息
- `spawn(traex)` PTY，把消息写进 stdin，`pty.onData` 原样回贴飞书（纯文本）

**里程碑 M1**：飞书 @ 一句 → 开发机 traex 跑 → 结果回飞书，端到端跑通。

## 阶段二 · 会话模型（核心）✅

- `reply_in_thread` 建话题，`SessionManager` 建立 threadId ↔ Session 映射
- **状态机 + 队列**：idle/busy，busy 入队不打断，idle drain 出队
- **idle 检测**（最难）：quiescence（静默 2s）+ spinner guard（3s）+ readyPattern gate
  + 每轮 reset + ANSI 剥离。traex 无完成标记，屏幕层纯靠这套启发式；保留 `fireIdle`
  外部权威通道供后续接 rollout task_complete。

**里程碑 M2**：话题 = 会话、连发不乱、一轮一轮有序执行。
产出：IdleDetector + 状态机队列，13 个单测覆盖核心边沿（静默判定 / spinner 抑制 /
readyPattern gate / reset 重新武装 / 中途停顿不误判 / 外部信号幂等）。

## 阶段三 · 流式卡片 + 交互

- interactive card 构建 + 节流 PATCH（每轮一张实时刷新卡片）
- headless xterm 截图渲染（先文本兜底，截图作增强）
- 关闭流式卡片时用表情指示进度（收到 `Get` → 完成 `DONE`）
- 会话关闭：卡片按钮 / 控制台触发（非表情）
- 主动命令注入（本地 HTTP `POST /inject`）

**里程碑 M3**：实时卡片 + 表情进度。

## 阶段四 · 控制台 + 韧性 + 收尾

- Web 控制台（建 / 编辑 bot、列活跃会话、注入命令、关闭会话）——原生 HTML + fetch
- 韧性：PTY 崩溃重启、断线重连、daemon 重启会话丢弃重开（v1 不做 resume）
- 测试（idle 检测、队列调度）+ 日志
- 文档收尾：架构图、README

**里程碑 M4**：完整可用 + 完整文档。

## 风险提示（最可能翻车处）

1. **idle 检测** — 唯一可能拖期的点。已用 quiescence + spinner guard + readyPattern gate
   三重启发式解决；traex 屏幕层无完成标记，后续接 rollout task_complete
   （`fireIdle` external 通道）作权威信号进一步降误判。
2. **截图渲染** — `@napi-rs/canvas` 装原生依赖偶尔踩坑。缓解：文本卡片兜底，
   截图是加分项，做不完不影响主线。
3. **飞书应用权限** — 建 bot、发卡、收 reaction 需对应 scope。缓解：动手前先把
   应用建好、权限开齐。

## commit 节奏

按里程碑切成有逻辑的一串 commit，让历史读起来是清晰、有规划的开发过程：

- `chore: 初始化项目脚手架与 TypeScript 配置`
- `feat(lark): 接入飞书长连接并订阅消息事件`
- `feat(cli): 用 node-pty 拉起 traex 并桥接输入输出`
- `feat(session): 实现话题 ↔ 会话映射`
- `feat(session): 实现 idle/busy 状态机与 FIFO 队列`
- `feat(idle): 实现 IdleDetector 驱动队列流转`
- `feat(card): 实现流式卡片增量 PATCH`
- `feat(card): 关闭卡片时用 Get/DONE 表情指示进度`
- `feat(console): 实现建 / 管 bot 的本地控制台`

规范：Conventional Commits（英文 type/scope + 中文描述）；杜绝 `wip`/`update` 等空洞提交。
