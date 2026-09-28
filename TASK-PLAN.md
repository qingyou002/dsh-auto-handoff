# DSH Session Handoff —— 计划任务书

| 项 | 内容 |
| --- | --- |
| 任务书版本 | v1.0 |
| 需求来源 | 同目录 `PLAN.md`（729 行，v 未标注） |
| 目标仓库目录 | 插件仓库根目录（本文档所在目录） |
| 事实基线 | 本机 harness `@deepseek-ai/dsh@0.1.5-rc.3`（全部 `@deepseek-ai/dsh-*` 子包均为 `0.1.5-rc.3`） |
| 交付形态 | 可安装 DSH 插件包（`dsh.bundle` + `cordis.patch.yml`），非进程内动态 Cordis 插件 |
| 文档状态 | 待评审 → 批准后进入 M0 |

> 本任务书的所有接口结论均来自实际安装的 harness 源码与 `.d.ts` 声明，**没有**任何按名称猜测的接口。
> 路径简写：`HS\` = `D:\APPs\Nodejs\nodejs_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`。
> 完整证据索引见 §17。

---

## 1. 任务概述与目标

`PLAN.md` 要求实现一个用于**减少超长会话 Token 浪费**、并能在同一工作区**安全迁移并继续执行任务**的插件。

插件必须达成的 7 条目标：

| # | 目标 | 本任务书的落地方案 |
| --- | --- | --- |
| G1 | 总结当前会话全部任务与最新进度 | §7.4 摘要模块：`session.deriveMessages()` → 过滤 → 脱敏 → LLM 结构化摘要 |
| G2 | 在相同工作区创建新会话 | §7.5 `sessionController.create({ cwd })` |
| G3 | 把摘要作为新会话的初始提示词 | §7.5 `agent.followup(createUserMessage(...))` |
| G4 | 尽可能继承模式 / 权限 / 模型 | §7.5：`agentPreset` + `selectModel` + `permissionPresets.set` + `planMode.set`，逐项报告继承结果 |
| G5 | 让新会话继续未完成任务 | 摘要内嵌「下一步行动」+「给新会话的指令」小节；不清空旧会话 |
| G6 | 手动执行 + Token 阈值自动执行 | 手动 `/handoff`；自动 handoff / 自动 compact 两套独立开关与阈值 |
| G7 | 自动操作前对当前对话软终止 | §7.3 `agent/pre-step` 瀑布返回 `{kind:'reject'}`；**绝不**调用硬中断 API |

**铁的约束（贯穿全部实现）**

1. 不硬中止在跑的 Step / Tool Call / 文件操作 / 终端命令 / 模型请求。
2. 不伪造成功：任何不存在的能力都要降级 + 明确提示 + 文档说明。
3. 不建立与仓库既有统计冲突的独立数据库。
4. 不修改无关目录与无关功能。
5. 关键代码用 TypeScript + 严格类型，不用不必要的 `any`。

---

## 2. 交付物与验收标准

### 2.1 交付物清单

```
dsh-auto-handoff/
├── PLAN.md                 # 需求原件（本次不改动）
├── TASK-PLAN.md            # 本任务书
├── README.md               # 使用/设置/限制文档，覆盖 PLAN.md §18 的 20 项
├── LICENSE                 # MIT
├── package.json            # dsh.bundle + dsh.client 清单
├── cordis.patch.yml        # 插件行挂载补丁
├── tsconfig.json
├── vitest.config.ts
├── src/                    # 见 §5.2
├── test/                   # 见 §11
└── lib/                    # 构建产物：Host ESM + Client bundle
```

### 2.2 `PLAN.md` §19 验收标准的落位表

| # | 验收标准 | 负责模块 | 验证方式 |
| --- | --- | --- | --- |
| 1 | `/handoff` 手动迁移当前任务 | `command.ts` + `coordinator.ts` | IT-01 |
| 2 | 当前 Step 不被硬中断 | `graceful-stop.ts`（无 cancel 调用） | IT-07 + 静态断言 |
| 3 | 当前 Tool Call 可以完成 | `graceful-stop.ts`（只设闩锁） | IT-07 |
| 4 | Step 完成后不自动启动下一个 Step | `graceful-stop.ts` pre-step reject | UT-SM-02 / IT-05 |
| 5 | 最新任务状态被保存 | 依赖 harness 既有 checkpoint，本插件只等待 `whenIdle()` | IT-05 |
| 6 | 新会话位于相同工作区 | `session-migration.ts` | IT-09 |
| 7 | 新会话收到结构化任务摘要 | `session-summary.ts` + `session-migration.ts` | IT-08 |
| 8 | 支持时继承模式 | `planMode.get/set` | IT-10a |
| 9 | 支持时继承模型 | `sessionController.selectModel` | IT-10b |
| 10 | 支持时继承权限 | `permissionPresets.current/set` | IT-10c |
| 11 | 自动 handoff 可配置 | `settings.ts` | UT-SE-01 |
| 12 | 自动 compact 可配置 | `settings.ts` | UT-SE-01 |
| 13 | 两个阈值可分别配置 | `settings.ts` | UT-SE-01 |
| 14 | compact 阈值必须小于 handoff 阈值 | `settings.ts` `validate` | UT-SE-02 |
| 15 | 不会重复触发 | `state.ts` 水位 + `token-threshold.ts` 闩锁 | UT-TT-05 / IT-13 |
| 16 | 不会产生无限循环 | `maxAutoActionsPerSession` + `rearmDeltaTokens` | UT-TT-04 / IT-13 |
| 17 | 不会丢失用户消息 | `graceful-stop.ts` 人类提示守卫 + `coordinator.ts` 阶段 2 转投 | UT-SM-03 / IT-14 |
| 18 | 不把敏感信息写入摘要 | `redaction.ts` | UT-RD-01..04 |
| 19 | 内部命令不进入模型可见历史 | 复用 `session.deriveMessages()`（surface 只含 message-producing 事件） | UT-SU-03 |
| 20 | 原有功能不受影响 | 监听器全部 scope 到本插件 fiber；无全局副作用 | IT-15 |
| 21 | TypeScript 类型检查通过 | — | `npm run typecheck` |
| 22 | 项目原有测试通过 | — | 本插件为独立包，`npm test` 全绿即满足；不触碰其它包 |
| 23 | 新增测试通过 | — | `npm test` |
| 24 | 文档已更新 | `README.md` | 人工核对 §13 清单 |

---

## 3. 命名定稿

| 项 | 定稿值 | 依据 |
| --- | --- | --- |
| npm 包名 | `dsh-auto-handoff` | 工作区既有插件命名 `dsh-git-commit`；目录名一致 |
| cordis 行 id | `dsh-auto-handoff` | `cordis.patch.yml` 的 `insert[].id` |
| 插件 `name` 导出 | `dsh-auto-handoff` | 与行 id 一致，便于 loader 诊断 |
| 斜杠命令 | `/handoff`（`name: "handoff"`） | 已核对本机已注册命令仅有 `commit`、`compact`、`feedback`、`goal`、`permission`、`plan`、`export`，**无冲突** |
| 设置命名空间 | `dsh-auto-handoff` | schemastery 要求「小写字母开头 + 仅小写字母/数字/连字符」 |
| 客户端设置卡 Slot | `settings.plugin.item`，`key: "dsh-auto-handoff"` | 该 Slot 契约明确：外部插件在 Host 注册命名空间、在浏览器用同一 key 注册卡片 |
| HTTP 路由前缀 | `/dsh-auto-handoff` | 避免与既有 `/sidebar` 等路由冲突 |

`cordis.patch.yml` 内容：

```yaml
- insert:
    - id: dsh-auto-handoff
      name: dsh-auto-handoff
```

---

## 4. 仓库事实基线（核心章节）

### 4.1 命令注册

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 注册 | `ctx.commands.register(definition: CommandDefinition): () => void`（返回 disposer，自动随 fiber 回收） | `HS\dsh-commands\lib\types\index.d.ts:91` |
| 定义 | `{ name: string; description: string; input?: { hint: string; attachments?: boolean }; recordInput?: boolean; handler: (invocation) => CommandResult \| Promise<CommandResult> }` | 同上 `:37-52` |
| 调用参数 | `CommandInvocation = { commandId, agent, rawInput, attachments, signal }` | 同上 `:18-35` |
| 返回 | `CommandResult = { kind:'success'; text?: string; sourceEventSeq?: SessionSeq } \| { kind:'error'; text: string }` | `HS\dsh-commands\lib\types\types.d.ts:33-41` |
| 日志行为 | `command/run` 与 `command/done` 是 **log-only**（"Log-only (never model surface)"），不会进入模型可见历史 | 同上 `:88-117` |
| 参数解析 | `parseCommand(line)` 返回 `{ name, rawInput }`；`rawInput` 含分隔空白 | 同上 `:71` |

### 4.2 会话与 Agent

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 会话查找 | `ctx.sessions.get(id)`, `ctx.sessions.list()`, `ctx.sessions.flush(session)` | `HS\dsh-session\lib\types\index.d.ts:317+` |
| 会话头 | `session.header: SessionHeader`（**不在事件日志里**）：`{ version, id, createdAt, cwd?, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset? }` | `HS\dsh-session\lib\types\types.d.ts:58-95` |
| 事件读取 | `session.snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[]` | `HS\dsh-session\lib\types\index.d.ts:187` |
| 模型可见历史 | `session.deriveMessages(): Message[]` | 同上 `:285` |
| 请求头 | `session.requestHeader(): EpochHeader \| undefined` | 同上 `:251` |
| 表面 | `session.surface: SessionSurface`，`{ nodes: readonly SessionSeq[]; replaceGeneration: number }` | `HS\dsh-session\lib\types\surface.d.ts:92-97` |
| 单事件投影 | `deriveEventMessage(event): Message \| null`；`isSurfaceEligibleType` 只认四类 message-producing 事件 | 同上 `:18,64` |
| Agent 查找 | `ctx.agents.get(id): Agent \| undefined`，`ctx.agents.list()`, `ctx.agents.roots()` | `HS\dsh-agent\lib\types\index.d.ts:341-362` |
| Agent 活体面 | `agent.options`, `agent.session`, `agent.inbox`, `agent.status: 'idle' \| 'running'`, `agent.ctx` | `HS\dsh-agent\lib\types\runtime-types.d.ts:139-148` |
| 等待静止 | `agent.whenIdle(): Promise<void>` | 同上 `:164` |
| 维护任务 | `agent.runMaintenance<T>(task: (signal) => Promise<T>): Promise<T>`（真 idle 相位执行，期间公开 `status` 仍为 `idle`） | 同上 `:174` |
| 投递消息 | `agent.followup(msg)`（排队一个独立 turn 并唤醒）、`agent.steer(msg)`、`agent.inject(msg)`、`agent.send(msg, target, wakeup)` | 同上 `:186-209` |
| **硬中断（禁用）** | `agent.cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean })`：`"Clear queued and steering work … and abort the active turn"` | 同上 `:149-157` |

### 4.3 会话创建与配置继承（Host 侧）

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 服务键 | `ctx.sessionController`（`@deepseek-ai/dsh-api-session-controller`） | `HS\dsh-api-session-controller\lib\types\index.d.ts:14-19` |
| 建会话 | `create(request: SessionCreateRequest): Promise<SessionCreateValue>`；请求 `{ workspaceId?, cwd?, sessionId?, agentPreset? }`（`workspaceId` 与 `cwd` 互斥）；返回 `{ sessionId, agentPreset? }` | 同上 `:86`；`types.d.ts:252-263` |
| id 生成 | 未指定 id 时 Host 用 `session-${randomUUID()}` 生成 | `lib\index.js:573` |
| 选模型 | `selectModel({ sessionId, provider, model, reasoningEffort? })`：校验路由 → 追加 `model/selection` → 设为该会话下一请求选择 → 同时保存为默认 | 同上 `:605-634`；`lib\index.js:315-318` |
| 投递提示词 | `prompt({ requestId, sessionId, mode:'queue'\|'steer', content, clientTimeZone? })`，内部即 `agent.followup(message)` / `agent.steer(message)` | `lib\index.js:736-790` |
| 权限预设 | `ctx.permissionPresets.current(session): string`；`set(session, name)` 写 `permission/preset` + 各 knob；`CUSTOM_PRESET = "custom"` | `HS\dsh-permission-presets\lib\types\index.d.ts:58,127,158` |
| 审批策略 | `ctx.approval.setPolicy(agent, policy)`；`approval.overrideOf(session): ApprovalPolicy \| undefined`；`ApprovalPolicy = 'ask' \| 'never'`；持久事件 `approval/policy` | `HS\dsh-user-approval\lib\types\index.d.ts:26-31,108,141,46` |
| Plan 模式 | `ctx.planMode.get(agent): { active: boolean; pending?: boolean }`；`set(agent, active)` 返回 `'committed'\|'queued'\|'cancelled'\|'noop'`；持久事件 `plan/mode` | `HS\dsh-plan-mode\lib\types\index.d.ts:112,132,36-38` |
| Agent preset | `create({ agentPreset })`；读取 `ctx.agentPresets.composedPreset(agentCtx)`；会话投影键 `agentPreset` | `HS\dsh-api-session-controller\lib\index.js:594,335-337` |
| 事件 | `api-session/added(summary)`、`api-session/removed(id)`、`api-session/status(id, running)`、`api-session/activity`、`api-session/error` | `HS\dsh-api-session-controller\lib\types\types.d.ts:537-572` |

### 4.4 软终止（本插件的技术核心）

`HS\dsh-agent-loop\lib\index.js` 的 turn 循环（简化）：

```js
while (true) {
  const step = phase.step + 1
  const decision = await this.preStep(target, { turn, step })   // → waterfall agent/pre-step
  if (decision.kind === "reject") { turnEnds = { kind: "blocked" }; return false }
  ...
  this.session.append("step/start", { turn, step })
  try { const stepEnd = await this.step(decision); ... }
  finally { this.session.append("step/end", { turn, step }) }
  if (turnEnds && this.inbox.nextStep.length === 0) { await this.dispatch.serial("agent/turn-stopping", ...) }
  if (turnEnds && this.inbox.nextStep.length === 0) break
  target = "next-step"
}
```

证据：`HS\dsh-agent-loop\lib\index.js:885-908`（`preStep`）、`:919-975`（`turn`）。

| 事实 | 结论 | 证据 |
| --- | --- | --- |
| `agent/pre-step` 是 **waterfall**，payload `{ agent, messages: UserMessage[], turn, step, signal }`，`next: () => Promise<PreStepDecision>` | 插件可以否决下一步 | `HS\dsh-agent\lib\types\runtime-types.d.ts:302-319` |
| `PreStepDecision = { kind:'reject' } \| { kind:'enter'; messages; startsRequestSeries? }` | `reject` 即「不启动这一步」 | 同上 `:91-99` |
| `reject` 的后果：`turnEnds = { kind:'blocked' }`，turn 关闭，**不再启动新 step** | 正是「软终止」所需 | `HS\dsh-agent-loop\lib\index.js:941-944` |
| 被 reject 时已 claim 的 `messages` **不会**被写成 `user/message`（既不入库也不重发） | 若 `messages` 中含用户新输入，reject 会吞掉它 → **必须守卫** | `HS\dsh-agent\lib\types\runtime-types.d.ts:262-276` |
| 全局监听写法已在多个官方插件使用 | 注册方式是安全的 | `HS\dsh-compaction-basic\lib\index.js:798`、`HS\dsh-plan-mode\lib\index.js:151`、`HS\dsh-session-checkpoint-policy\lib\index.js:72` |
| `agent/status` 提供 `idle ⇄ running` 翻转 | 用于判断是否正在跑 Step | `HS\dsh-agent\lib\types\runtime-types.d.ts:238-250` |
| `agent/turn-stopping`（serial）在 turn 将关闭前触发 | 可观测 turn 收尾 | 同上 `:379-400` |
| **不存在**「软停止请求」服务，也不存在 `stopRequested` 字段 | 必须由本插件自建协调器 | 全量 Service/Event 目录查询结果中无对应项 |

### 4.5 Token 统计

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 累计用量（**精确**） | `ctx.sessionProjections.stateOf(session, 'tokenUsage')` → `{ totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last: { turn, step, buckets } \| null }` | `HS\dsh-token-meter\lib\types\usage-projection.d.ts:12-148` |
| 数据来源 | durable `assistant/message.usage?: TokenUsage`；「Each v2 Assistant settlement contributes the last usage sample embedded in its stream」 | `HS\dsh-session\lib\types\types.d.ts:309-317`；同上 `:50-56` |
| 重放安全性 | projection 由 durable 日志**纯折叠**得出，重启后按日志重放；`stateOf` 为同步读，缺失单元自动惰性 fold | `HS\dsh-session-projection\lib\types\index.d.ts:167-175` |
| 推理成本 | `stateOf` 是 watermark 缓存读（缺 cell 才惰性 fold） | 同上 `:175` |
| 估算回退 | `ctx.tokenMeter.measure(session): TokenMeasurement`，字段 `{ logRevision, baseline:{kind:'none'\|'estimated'\|'usage', tokens, usage?}, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes }`（同步、启发式） | `HS\dsh-token-meter\lib\types\index.d.ts:46`；`types.d.ts:24-37` |
| 上下文占用 | 投影键 `contextPressure` → `{ contextWindow?, pressureTokens?, projectedTokens? }` | `HS\dsh-token-meter\lib\types\usage-projection.d.ts:170-221` |
| 既有自动压缩实现（参考，不复制） | `dsh-compaction-basic` 在 `agent/pre-step` 内调 `compactIfNeeded(agent,'pressure',signal)`，用 `tokenMeter.measure` 定价 | `HS\dsh-compaction-basic\lib\index.js:793-819, 873-889` |

**「当前会话累计 Token 使用量」定义（本插件采用）**：

```
cumulative = totals.uncachedInputTokens + totals.outputTokens
           + totals.cacheReadTokens   + totals.cacheWriteTokens
```

- 当 `assistant/message.usage` 由适配器上报时，该值为**精确累计**（`source = 'exact'`）。
- 当没有任何 usage 上报（四个 bucket 全 0）时，回退 `tokenMeter.measure(session).totalTokens`，标注 `source = 'estimated'`（**估算值**，按固定启发式定价）。
- 两者都不可用 → `source = 'unavailable'`，自动功能停用，手动 `/handoff` 仍可用。
- 语义明确：这是**会话累计**，不是单次请求压力；不随 compaction 归零（compaction 只影子化 surface）。

### 4.6 Compaction

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 服务键 | `ctx.compaction`（`CompactionEngine` 抽象类，一个 context 只挂一个实现） | `HS\dsh-compaction\lib\types\index.d.ts:61-75` |
| 手动压缩 | `compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult \| null>`；内部自行 `agent.runMaintenance` | 同上 `:110`；`HS\dsh-compaction-basic\lib\index.js:944-968` |
| 空闲要求 | `runMaintenance` 同步抛错时包装为 `ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work')` | 同上 `:968` |
| 失败分类（封闭联合） | `ManualCompactionErrorCode = 'busy' \| 'cancelled' \| 'changed' \| 'summary' \| 'commit' \| 'persistence'` | `HS\dsh-compaction\lib\types\index.d.ts:21,27-37` |
| 结果 | `CompactionResult = { compactionId, sourceCommandId?, startSeq, summarySeq, endSeq, summary: ContentBlock[], shadowedRange:{start,end}, shadowedSeqs, shadowedTokenCount }` | `HS\dsh-compaction\lib\types\types.d.ts:101-131` |
| `null` 语义 | 没有可安全压缩的有用范围（不是失败） | `HS\dsh-compaction\lib\types\index.d.ts:104` |
| 既有 `/compact` 命令参考 | `ctx.commands.register({ name:'compact', handler })` + `expectedFailure(error)` 的 code→文案 映射 | `HS\dsh-command-compact\lib\index.js:12-97` |
| 持久事件 | `compaction/start`、`compaction/summary`、`compaction/end`、`compaction/prune` 均 **log-only**，不在 surface | `HS\dsh-compaction\lib\types\types.d.ts:14-99` |

### 4.7 设置与持久化

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 可选挂载惯用法 | `ctx.inject(['settings'], (settingsCtx) => { settingsCtx.settings.installSection(ctx, NS, Schema, entry, { setSource, onChange, validate? }) })` | 实例 `HS\dsh-web-search-deepseek\lib\index.js:293-304`；`HS\dsh-agent-loop\lib\index.js:1520` |
| `installSection` 语义 | 消费者把自己在组合层（`config`）的值注册为 base；settings provider 卸载时回落该 entry | `HS\dsh-settings\lib\types\index.d.ts:60-75` |
| `register`（另一路径） | `settings.register(ns, schema, { base?, applies?, validate? }): SettingsScope<T>` | 同上 `:66-88` |
| owner scope | `SettingsScope<T> = { get(): T; watch(cb): () => void; update(patch): Promise<void>; replace(section): Promise<void> }` | 同上 `:84-110` |
| 描述面 | `describe({ redactSecrets? }): SettingsDescriptor[]`，含 `ns/schema/value/revision/base/user/applies` | 同上 `:49-81`；`SettingsDescriptor` 见查询结果 |
| 事件 | `settings/updated(ns, next, prev, source)`、`settings/document-updated(ns, revision)` | Event 目录 |
| 命名空间约束 | 必须匹配 `^[a-z][a-z0-9-]*$`（`SettingsNamespaceInput`），否则 `throws TypeError` | `HS\dsh-settings\lib\types\index.d.ts:15-19,66` |
| schemastery 数值写法 | `z.object({ maxParallelToolCalls: z.number().step(1).min(1).default(10) })` | `HS\dsh-agent-loop\lib\index.js:1465` |
| 无 settings 服务时 | `inject` 不满足 → `installSection` 不执行，插件使用自身 `config` 默认值（**必须保证插件仍可加载**） | §4.7 惯用法 + Cordis inject 语义 |

### 4.8 Client 半、UI 与 Host↔Client 通道

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| 清单 | `package.json.dsh.client = { platform: string; inject?: string[]; immediately?: boolean; external?: string[] }` | `HS\dsh-package-manifest\lib\types\types.d.ts:39-52` |
| 客户端 bundle 形态 | `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => { var module = { exports: {} }; …; return module.exports } })` | `HS\dsh-better-sidebar\lib\client.js`（首 5 行，实机安装包） |
| 模块 id | 等于包名；`<id>/client` 与裸包名归一化到同一行 | `HS\dsh-client-modules\lib\types\client\manifest.d.ts:129-138` |
| 设置卡 Slot | `settings.plugin.item`：`kind:'keyed'`, `scope:'root'`, 注册选项 `key: string`（命名空间）；owner props 为空 | `HS\dsh-client-ui-settings-plugins\lib\types\client\slot-contract.d.ts:16-31` |
| Slot 活着 | 实机 Slot 查询确认 `available: true`，已有占用者 `dsh-market`(key `dsh-market`)、`shell`、`agent-loop`、`web-search-deepseek`、`modlens`(key `modlens`, `order:30`) | 本机 Client Inspect `Slots.listSubTree(root='settings.plugin.item')` |
| 卡片如何被渲染 | Plugins 设置区的 `configurable` tab 声明该 Slot 并渲染所有注册卡；**没有卡片就没有 UI** | 同上契约文件；`HS\dsh-client-ui-settings-plugins\lib\types\client\index.d.ts:1-10` |
| 客户端读写设置 | `ctx.settingsScope.bind<T>({ namespace, decode? }): SettingsScope<T>`，客户端 scope 提供 `getSnapshot()/subscribe()/set(field,value)/unset(field)/mutate(ops)` | `HS\dsh-client-ui-settings\lib\types\client\settings-scope.d.ts:100-140`；`settings-contract.d.ts:34-85` |
| 客户端切换会话 | `ctx.sessions.refresh(): Promise<void>`；`ctx.sessions.open(id): void`（"Select a session as current"，未知 id 会报错）；`ctx.sessions.list: ObservableSnapshot<SessionListState>` | `HS\dsh-api-session-controller\lib\types\client\contract\sessions.d.ts:20-21,33-42,72-77` |
| Host 路由 | `ctx.webServer.register({ kind: 'exact'|'prefix', path, handler(req,res) }): () => void`；handler 拥有完整响应生命周期；重复 `(kind,path)` 抛错 | `HS\dsh-host-webserver\lib\types\index.d.ts:30-39,90` |
| 第三方先例 | `dsh-better-sidebar` 客户端 `fetch('/sidebar/api/<method>')` | `C:\Users\wjj\.dsh\profiles\web\node_modules\dsh-better-sidebar\src\client\api.ts:1-23` |

### 4.9 打包与工具链

| 能力 | 真实契约 | 证据 |
| --- | --- | --- |
| bundle 清单 | `dsh.bundle.patch: string`（相对包根） | `HS\dsh-package-manifest\lib\types\types.d.ts:25-28` |
| 挂载补丁 | `- insert: [ { id, name } ]` | 工作区 `dsh-git-commit\cordis.patch.yml` |
| 模块回退 | launcher 会生成 `moduleFallback` 代理，使插件对 `@deepseek-ai/*` 的 import 解析到 launcher 自身副本 | `HS\dsh-package-manifest\lib\types\types.d.ts:85-91` |
| 官方包用 peer | `dsh-git-commit` 把 `@deepseek-ai/dsh-*` 声明为 `peerDependencies` 并正常工作 | 工作区 `dsh-git-commit\package.json:41-45` |
| peer 预发布写法 | 必须带显式预发布分支，否则静默排除 harness 预发布版本 | 工作区 `contributing.md:130-140` |
| 脚手架 | `npx create-dsh-plugin@0.2.3 <dir> -t panel -n <pkg> --plugin-id <id>`：`panel` 模板 = 「Host `ctx.webServer` 路由 + Web 设置面板」双半插件 | npm registry `create-dsh-plugin` README（0.2.3） |
| 既有测试/构建惯例（`PLAN.md` §2.16） | harness 各包**不随包发布测试**（只发布 `lib/` 与 `lib/types/*.d.ts`）；生态内既有两种惯例：`dsh-better-sidebar` 用 `vitest run` 测试 + `tsdown` 构建，`create-dsh-plugin` 生成的模板用 `node --test` | `HS\dsh-*\` 文件树；`C:\Users\wjj\.dsh\profiles\web\node_modules\dsh-better-sidebar\package.json` 的 scripts/devDependencies；`create-dsh-plugin` README「Development」节 |
| 本机依赖版本 | 全部 `@deepseek-ai/dsh-*` = `0.1.5-rc.3`；npm `next` = `0.1.7-rc.2`，npm `latest` = 陈旧线（不可用） | 本机 `HS\*\package.json`；registry dist-tags |
| 可用工具 | node v24.18.0 / npm 11.16.0 / pnpm 11.22.0；`registry.npmjs.org` 可达 | 本机实测 |

### 4.10 明确**不存在**的能力（不伪造）

| 曾经设想 | 实际情况 | 应对 |
| --- | --- | --- |
| 「软停止请求」服务 / `stopRequested` 字段 | 不存在 | 自建协调器 + `agent/pre-step` reject（§7.3） |
| 插件级 Host↔Client 私有 RPC（静态插件） | 无通用机制；动态 Cordis 插件的 `harness.handle` 不适用于静态包 | 走 `webServer` 路由 + `fetch`（§10.5） |
| 会话级累计 Token 独立统计服务 | 无独立服务，但有 `tokenUsage` 投影 | 复用投影（§4.5） |
| 向会话注入自定义 source 的官方 prompt 端点 | `sessionController.prompt` 固定记 `user-rpc` | 直接用 `agent.followup` + `source:{kind:'plugin'}` |
| `GenerateOptions.purpose` 自定义值 | 该字段在 0.1.5-rc.3 是**封闭联合** `'compaction' \| 'session-title'` | 本插件**不传** `purpose` |

---

## 5. 架构与目录结构

### 5.1 Host / Client 职责

| Host 半 | Client 半 |
| --- | --- |
| Token 累计读取与阈值判定 | 设置界面（四项主设置 + 高级项） |
| Agent 生命周期监听、Step 边界等待 | 插件状态展示（阶段、等待项、结果） |
| 软终止协调器 | Token 使用量与阈值进度 |
| 命令调度（`/handoff`） | 精确/估算标注 |
| 会话摘要生成 | 错误与成功提示 |
| 新会话创建与配置继承 | 取消 / 重试操作 |
| compact 触发与重试队列 | 成功后切到新会话 |
| 错误处理与状态（内存降级） | — |

### 5.2 `src/` 模块清单与契约

| 文件 | 职责（单一职责，可独立测试） | 关键导出 |
| --- | --- | --- |
| `src/index.ts` | Host 半入口：导出 `name` / `inject` / `apply`；装配命令、协调器、设置、路由；`ctx.effect` 统一回收 | `name`, `inject`, `apply` |
| `src/types.ts` | 阶段枚举、会话记录、动作类型、依赖注入接口（供测试替身）、文案常量 | `HandoffPhase`, `HandoffAction`, `SessionRecord`, `CoordinatorDeps`, `MESSAGES` |
| `src/redaction.ts` | 纯函数：脱敏 | `redactSecrets`, `redactText` |
| `src/settings.ts` | 命名空间 + schema + 跨字段校验 + 观察 + 内存降级 | `HANDOFF_NAMESPACE`, `HandoffSettingsSchema`, `installSettings`, `readSettings` |
| `src/token-threshold.ts` | 纯核心：累计读取、阈值判定、闩锁与重臂 | `readCumulativeUsage`, `decideAutoAction`, `TokenTracker` |
| `src/graceful-stop.ts` | 软终止：pre-step 守卫与拒绝、等待静止、超时策略 | `GracefulStop`（`requestStop`, `waitForBoundary`, `release`, `cancel`） |
| `src/session-summary.ts` | 可见历史 → 过滤去重 → 脱敏 → LLM 结构化摘要（含本地兜底） | `buildSummaryInput`, `renderSummary`, `generateSummary` |
| `src/session-migration.ts` | 建会话 + 逐项继承 + 投递摘要 + 结果核验 | `migrateSession` |
| `src/compact-handler.ts` | 自动 compact：空闲等待、有界重试、成功后处理 | `CompactHandler.run` |
| `src/coordinator.ts` | 单会话单动作、阶段机、取消/重试/幂等、事件订阅 | `Coordinator` |
| `src/state.ts` | 进程内状态表 + 可选持久化钩子（无则内存） | `StateStore` |
| `src/command.ts` | `/handoff` 注册与子命令解析 | `registerHandoffCommand` |
| `src/routes.ts` | 可选 HTTP 路由（state/handoff/cancel/retry） | `registerRoutes` |
| `src/client/index.ts` | Client 半入口：注册设置卡 | `name`, `inject`, `apply` |
| `src/client/card.ts` | 卡片组件（`React.createElement`，无 JSX） | `HandoffCard` |

### 5.3 依赖注入（按需，不滥用 `inject`）

- 插件对象 `inject`：仅硬依赖 `['commands']`。
- 其它服务一律 `ctx.get(name)` + `undefined` 检查并降级：
  `settings`（用 `ctx.inject(['settings'], cb)` 惯用法）、`agents`、`sessionController`、`sessionProjections`、`tokenMeter`、`llm`、`compaction`、`permissionPresets`、`planMode`、`approval`、`agentPresets`、`webServer`。
- 理由：`PLAN.md` §12 明确「不得因为可选持久化服务缺失而导致插件无法加载」。

---

## 6. 分阶段实施计划（里程碑）

每个里程碑完成后单独汇报「产出物 + 验证命令 + 结果」，未通过不进入下一阶段。

| 里程碑 | 内容 | 产出物 | 验证 |
| --- | --- | --- | --- |
| **M0** 骨架 | 脚手架并入：`package.json` / `tsconfig.json` / `cordis.patch.yml` / client 构建配置 / LICENSE / 空 README | 可 `npm install` 的包骨架 | `npm install` + `npm run typecheck`（空实现）通过 |
| **M1** 纯核心 | `types.ts`、`redaction.ts`、`token-threshold.ts`、`settings.ts`（schema 与校验）、`session-summary.ts` 的过滤与渲染部分 | 无 harness 依赖的纯逻辑 | UT-RD-*、UT-TT-*、UT-SE-*、UT-SU-* 全绿 |
| **M2** 软终止 | `graceful-stop.ts` + `state.ts` + `coordinator.ts` 状态机骨架 | 可单测的软终止协调器 | UT-SM-*、UT-ST-* 全绿 |
| **M3** 迁移 | `session-summary.ts` 的 LLM 部分 + `session-migration.ts` | 手动迁移链路 | IT-08、IT-09、IT-10a/b/c |
| **M4** compact 与冲突 | `compact-handler.ts` + 冲突与重臂规则 | 自动压缩链路 | IT-03、IT-04、IT-11 |
| **M5** 命令 | `command.ts`（`/handoff`、`/handoff cancel`、`/handoff status`）+ 全部文案 | 手动入口可用 | IT-01、IT-02 |
| **M6** 设置持久化 | `settings.ts` 写入 settings 服务、`settings/updated` 实时生效、内存降级 | 设置可持久化 | UT-SE-01..04、IT-16 |
| **M7** Client | `src/client/*` + `routes.ts` | 设置卡 + 状态 + 操作 + 切会话 | `npm run build` 产出 `lib/client.js`；临时 profile 安装 + `dump-config` |
| **M8** 收口 | 集成测试补齐、README、全量验证、证据复核 | 完整交付物 | §15 全部步骤 |

---

## 7. 机制定稿

### 7.1 软终止状态机

```
running
  → stop_requested              # 只设闩锁，不碰任何在跑工作
  → waiting_for_step_completion # 等当前 step（含 Todo tool call）自然结束
  → stopped_at_step_boundary    # pre-step 返回 reject，turn 以 reason:'blocked' 关闭
  → handoff_in_progress | compact_in_progress
  → completed | failed | cancelled
```

与 `PLAN.md` §4 推荐流转一致，并额外暴露 `waitingForCompact` 子状态。

### 7.2 软终止规则（逐条对应 `PLAN.md` §4.1–§4.10）

| # | 规则 | 实现 |
| --- | --- | --- |
| 1 | 当前无在跑 Step → 可立即执行 | `agent.status === 'idle'` 或 `agent.whenIdle()` 立即兑现 |
| 2 | 正在跑 Step → 只设待终止状态 | `record.stopRequested = true`，其余不动 |
| 3 | 当前 Step 必须完整结束 | 不调用任何取消 API；只等 `step/end` |
| 4 | 当前 Tool Call 必须正常返回或明确失败 | 同上（`agent.cancel` 从不被调用，测试断言） |
| 5 | 当前 Step 结果必须写入会话历史 | 依赖 harness 既有 append/checkpoint；插件只读不写日志 |
| 6 | 当前 Step 完成后不得启动下一个 Step | `agent/pre-step` 返回 `{kind:'reject'}` |
| 7 | 到达 Step 边界后才执行 handoff/compact | `await agent.whenIdle()` 后再进入实际动作 |
| 8 | 不得因硬中止导致半完成状态 | 无硬中止路径 |
| 9 | 当前 Step 失败也要记录失败结果 | 监听 `agent/error` 记录进动作结果，继续软终止流程 |
| 10 | Step 长时间未完成 → 显示等待状态 | `stepWaitTimeoutMs`（默认 15 min）只置 `slowWarning`，继续等 |

**附加安全规则（对 `PLAN.md` §11 的落实）**：

- **人类提示守卫**：pre-step payload 的 `messages` 中若含「新的人类提示」（`message.source.kind === 'user'` 且存在 `rpcId`/`user-rpc` 来源），**绝不 reject**，改为 `return next()`，让用户消息正常进入模型；在下一次边界再判断。
- **全局兜底时限**：动作总时长超过 `actionDeadlineMs`（默认 30 min）→ **只释放 stop 闩锁**（会话恢复正常运行）+ 标记 `failed` + 明确文案；**不做任何破坏性动作**。
- **卸载**：`ctx.effect` 回收 pre-step 监听器、`agent/status` 监听器、`session/event` 监听器、定时器；对所有在途 Promise 执行 `Promise.allSettled`；释放全部闩锁。

### 7.3 事件订阅清单

| 事件 | 模式 | 用途 | 过滤 |
| --- | --- | --- | --- |
| `agent/pre-step` | waterfall | 软终止（不启动下一个 Step） | `payload.agent.id` 有在途动作才介入，否则立刻 `next()` |
| `agent/status` | emit | 观测 `idle`/`running` 变化 | 同上 |
| `agent/error` | emit | 记录 Step 失败 | 同上 |
| `session/event` | emit | 累计 Token 变化 → 阈值判定 | 仅处理有 `agent` 且未被 `retired` 的会话；带水位去重 |
| `agent/disposed` / `session/disposed` | emit | 清理该会话状态 | 同上 |
| `settings/updated` | emit | 设置实时生效 | 命名空间匹配 |

### 7.4 摘要规格（对应 `PLAN.md` §5）

**输入构造（按优先级）**

1. `session.deriveMessages()` —— 唯一的模型可见投影。它只投影四类 message-producing 事件，因此 `command/run`、`command/done`、`model/selection`、`plan/mode`、`approval/policy`、`permission/preset`、`request/header`、`turn/start`、`turn/end`、`step/start`、`step/end`、`session/end-seed`、`compaction/*` 等 log-only 事件**天然不会**进入摘要输入。
2. 显式二次过滤与去重（`buildSummaryInput`）：
   - 丢弃 `source.kind === 'plugin'` 的纯内部注入消息；
   - 对同一内容做内容 hash 去重；
   - 只保留最近 `N` 条（默认 200）、单条截断至 8000 字符，保证摘要输入自身不爆 Token；
   - 不重复拼接已被压缩替代的旧内容（由第 1 步保证；若投影行为变化，以 `session.surface.nodes` + `deriveEventMessage` 自行 fold 作为后备）。
3. 脱敏：`redactSecrets` 在**送入模型之前**执行（`PLAN.md` §5「摘要必须避免包含」）。

**必须覆盖的 18 项内容与来源**

| # | 内容 | 来源 |
| --- | --- | --- |
| 1 | 用户的总体目标 | 模型从投影归纳 |
| 2 | 用户提出的所有约束与偏好 | 模型从投影归纳 |
| 3 | 所有子任务 | 模型从投影归纳 |
| 4 | 已完成的工作 | 模型从投影归纳 |
| 5 | 当前正在进行的工作 | 模型从投影归纳 |
| 6 | 尚未完成的任务 | 模型从投影归纳 |
| 7 | 下一步行动计划 | 模型从投影归纳（无法确定时写「需在新会话中重新确认」） |
| 8 | 已创建/修改/删除的文件 | 从 `tool/call`（`write`/`edit`/`str_replace` 等 fs 工具）的 `arguments.path` 与 `tool/result` 归纳，不依赖模型记忆 |
| 9 | 关键技术决策 | 模型从投影归纳 |
| 10 | 当前遇到的问题和错误 | `agent/error` 事件 + `tool/result.error` + 模型归纳 |
| 11 | 已尝试但失败的方法 | 模型从投影归纳 |
| 12 | 需要继续验证的事项 | 模型从投影归纳 |
| 13 | 工作区和项目状态 | 插件直接读 `session.header.cwd` |
| 14 | 当前模型 | 插件直接读 route 解析结果（§7.5） |
| 15 | 当前模式 | 插件直接读 `ctx.planMode.get(agent)` |
| 16 | 当前权限控制 | 插件直接读 `ctx.permissionPresets.current(session)` + `ctx.approval.overrideOf(session)` |
| 17 | 当前会话是否经历过压缩 | 插件直接读日志中是否存在 `compaction/end` |
| 18 | 最近一个完整 Step 的结果 | 插件直接读最后一条 `step/end` 及其之前最近的 `assistant/message` / `tool/result` |

其中 13–18 **由插件直接读取真实状态注入**，不交给模型猜测（避免模型编造当前模型/模式/权限）。

**固定输出结构（缺项写「（无）」，不省略小节）**

```
# 任务迁移摘要
## 总体目标
## 用户要求与限制
## 已完成工作
## 当前进度
## 已修改文件
## 关键技术决策
## 已知问题与错误
## 未完成任务
## 下一步行动
## 原会话配置
- 工作区：
- 模式：
- 模型：
- 权限控制：
- 是否经历过压缩：
## 给新会话的指令
请基于以上信息继续完成未完成的任务。
不要重复已经完成的工作。
如果上下文不完整，请先检查当前工作区、已有文件和项目状态，再继续执行。
```

**LLM 调用**

`ctx.llm.stream({ provider, model, messages: [createUserMessage({ content:[{type:'text',text:提示}], source:{kind:'plugin',plugin:'dsh-auto-handoff'} })], system: SUMMARY_SYSTEM, maxTokens: summaryMaxTokens, signal, sessionId })` + `BlockAssembler`。
- **不传 `purpose`**（0.1.5-rc.3 为封闭联合，见 §4.10）。
- 路由解析顺序：日志中最新 `model/selection` → `session.requestHeader()?.config` → `agent.options`；全部失败则摘要失败（不伪造）。

**失败策略**：摘要为空或生成失败 → 放弃迁移、保留原会话、在原会话显示错误文案（见 §14）。

### 7.5 迁移与配置继承（对应 `PLAN.md` §6）

**创建**：`ctx.sessionController.create({ cwd, agentPreset })`。会话 id **不自行拼接**，交给 Host 按仓库规范生成（`session-${randomUUID()}`）。

**继承矩阵（逐项读取 → 写入 → 失败降级）**

| 配置 | 读取路径 | 写入路径 | 不支持/失败时的处理 |
| --- | --- | --- | --- |
| 工作区 / cwd | `session.header.cwd` | `create({ cwd })` | cwd 缺失 → 用 `process.cwd()` 并在结果中提示 |
| Agent 模式（preset） | 会话投影 `agentPreset` / `ctx.agentPresets.composedPreset(agentCtx)` | `create({ agentPreset })` | 缺失 → 用部署默认 preset 并提示 |
| 模型 | 最新 `model/selection` → `session.requestHeader()?.config` → `agent.options` | `selectModel({ sessionId, provider, model, reasoningEffort? })` | 解析失败 → 用 `ctx.agentDefaultModel.currentSelection()` 并提示 |
| 权限控制 | `ctx.permissionPresets.current(session)`；为 `custom` 时读 `ctx.approval.overrideOf(session)` | `permissionPresets.set(newSession, name)`；`custom` 时 `approval.setPolicy(newAgent, policy)`（sandbox mode 可读时一并写入） | 服务缺失 → 跳过并在结果中明确报告未继承项 |
| Plan 模式 | `ctx.planMode.get(agent).active` | `ctx.planMode.set(newAgent, active)` | 服务缺失 → 跳过并报告 |
| 其它会话级配置 | — | **不继承** | 浏览器私有交互状态、UI 选中项、未提交草稿等明确不继承，写入文档 |

**投递摘要**

`ctx.agents.get(newSessionId).followup(createUserMessage({ content:[{type:'text',text: summary}], source:{kind:'plugin',plugin:'dsh-auto-handoff'} }))`

- 不使用 `sessionController.prompt`：其 source 固定为 `user-rpc`，会把插件摘要伪装成浏览器提交；`followup` 正是 `prompt` 内部使用的同一原语，且保留精确来源。

**结果与失败语义**

| 情形 | 行为 |
| --- | --- |
| 创建失败 | **不创建空会话**、保留原会话、原会话明确报错、允许稍后重新 `/handoff` |
| 逐项继承失败 | **不静默失败**：结果中列出「已继承 / 未继承（原因）/ 回退值」 |
| 投递失败 | **不假装迁移成功**；把已创建的新会话 id 一并返回给用户，可手动继续 |
| 全部成功 | 旧会话标记 `retired`；结果含新会话 id 与继承清单 |

### 7.6 `/handoff` 完整流程（对应 `PLAN.md` §3 的 11 步）

| # | `PLAN.md` 步骤 | 实现位置 |
| --- | --- | --- |
| 1 | 获取当前活动会话 | `command.ts` 从 `invocation.agent` 取 |
| 2 | 获取当前会话的完整任务上下文 | `session-summary.ts` 的 `buildSummaryInput`（§7.4） |
| 3 | 请求当前 Agent 在安全的 Step 边界停止 | `graceful-stop.ts` 设 `stopRequested`（只设闩锁） |
| 4 | 等待当前 Step 和正在执行的 Tool Call 完整结束 | `await agent.whenIdle()` |
| 5 | 确保最后一个 Step 的结果已写入会话状态/事件日志 | 复用 harness 既有 append/checkpoint；等待静止即已完成 |
| 6 | 生成任务迁移摘要 | `session-summary.ts` 的 `generateSummary` |
| 7 | 在相同工作区创建新会话 | `sessionController.create({ cwd })` |
| 8 | 尽可能继承原会话配置 | §7.5 继承矩阵 |
| 9 | 将摘要发送给新会话 | `agent.followup(...)` |
| 10 | 让新会话继续执行未完成任务 | 摘要内嵌「未完成任务」+「下一步行动」+「给新会话的指令」小节 |
| 11 | 向用户显示迁移结果 | `CommandResult` 文案 + §10.5 状态接口 + 卡片状态区 |

**无活动会话 / 空白会话**：`invocation.agent` 缺失，或投影中既无 `user/message` 也无任何 turn → 返回 `{ kind:'error', text:'当前没有可迁移的活动会话。' }`，**绝不创建会话**。

### 7.7 迁移阶段状态（对应 `PLAN.md` §11）

```
IDLE
  → PREPARING                    # 已受理，正在准备
  → WAITING_FOR_STEP_BOUNDARY    # 已设 stop 闩锁，等待当前 Step/Tool Call 结束
  → SUMMARIZING                  # 生成并脱敏摘要
  → CREATING_SESSION             # 创建新会话 + 继承配置
  → TRANSFERRING                 # 投递摘要
  → COMPLETED | FAILED | CANCELLED
```

`IDLE` 为无在途动作的初态；其余 8 个与 `PLAN.md` §11 列举的 `PREPARING / WAITING_FOR_STEP_BOUNDARY / SUMMARIZING / CREATING_SESSION / TRANSFERRING / COMPLETED / FAILED / CANCELLED` 一一对应。每个值都映射到 `/handoff status` 文案与 §10.5 的状态接口字段。

**阶段与用户输入的交互（`PLAN.md` §11 的三段式）**

| 阶段 | 用户发来新消息 | 处理 |
| --- | --- | --- |
| `PREPARING` / `WAITING_FOR_STEP_BOUNDARY` / `SUMMARIZING`（新会话尚未创建） | 消息进入原会话 | 放弃本次迁移（`CANCELLED`），**不丢弃消息**，消息继续留在原会话正常执行 |
| `CREATING_SESSION` / `TRANSFERRING`（新会话已建、摘要未投递完） | 消息进入原会话 | 不静默丢弃：把该消息文本**转投到新会话**（追加在摘要之后），并在 UI 明示「已转投到新会话」；原会话日志保留原文不删 |
| `COMPLETED` 之后 | 消息进入当前有效会话 | 客户端已切到新会话；旧会话 `retired`，不再处理任务，避免两个会话并行处理同一任务与消息重复投递 |

### 7.8 命令与内部事件的可见性（对应 `PLAN.md` §14）

| `PLAN.md` 的问题 | 仓库实际处理 | 本插件动作 |
| --- | --- | --- |
| 斜杠命令是否进入 session log | **是**：`commands.execute` 直接 append `command/run` 与 `command/done` | 复用，不额外写日志 |
| 斜杠命令是否进入模型历史 | **否**：两者均为「log-only (never model surface)」 | 无需处理 |
| 内部插件事件如何标记 | 事件是否进入 surface 由 `surfaceOp` 标记决定；无标记即 log-only，且 `KNOWN_SESSION_EVENT_TYPES` 之外的仓库外事件需要 `ignorable` 标记才能被持久化读取 | 本插件**不追加任何自定义 session 事件**，从而完全规避该兼容性问题 |
| compaction 是否已过滤内部命令 | **是**：surface 本身不含 log-only 事件，compaction 只替换 surface 节点 | 复用 |
| 消息投影是否会包含插件状态事件 | **否**：`deriveMessages()` 只投影四类 message-producing 事件 | 复用；由 UT-SU-03 断言 |

**结论**：不为了隐藏事件而删除事实来源日志；本插件既不删日志也不新增事件，命令与内部状态的可见性完全交由仓库既有的 surface 投影控制。

---

## 8. 阈值与冲突策略

### 8.1 累计口径

见 §4.5。判定使用「会话累计」，不是单次请求压力，**不因 compaction 归零**。

### 8.2 决策优先级

1. 两个阈值同时满足 → **handoff 优先**（`PLAN.md` §10.3）。
2. 只启用其一 → 只产出该动作（§10.7）。
3. 两个都关闭 → 自动功能停用；手动 `/handoff` 仍然可用（§10.8）。

### 8.3 重臂与防循环

- 每次成功动作后记录 `lastAction.atTokens = 当前累计`。
- 需要 `cumulative >= lastAction.atTokens + rearmDeltaTokens` 才重新武装（默认 20 万 token）。
- 每会话自动动作次数上限 `maxAutoActionsPerSession`（默认 3），达到后不再自动触发并给出明确文案（§10.6）。
- handoff 成功后旧会话 `retired`，不再产生任何自动动作（§10.4）。
- 同一会话同一时刻只有一个待执行动作（`PLAN.md` §10、§16.14–15）。

### 8.4 自动 compact 的「继续任务」策略（**有意偏离 §9.7**）

- `PLAN.md` §9.7 要求 compact 成功后发送「继续任务」。
- 本插件：**仅当本次自动 compact 是对「正在跑的 turn 先软终止、再压缩」时**，成功后才 `agent.followup("继续任务")`。
- 若会话本来就 idle，压缩后**不自动发消息** —— 否则 idle 会话会被凭空开启新 turn，形成 `compact → 继续任务 → handoff → compact` 循环风险，违反 §10.6。
- 该偏离必须同时出现在 README 与设置卡说明中（`PLAN.md` §10 允许调整策略，但要求「行为明确 + 不重复触发 + 不无限循环 + 在设置界面和文档中说明优先级」）。

### 8.5 自动 compact 完整流程（对应 `PLAN.md` §9 的 9 步）

| # | `PLAN.md` 步骤 | 实现位置 |
| --- | --- | --- |
| 1 | 只为当前会话创建一个待处理 compact 请求 | `coordinator.ts`：写 `SessionRecord.armedAction = {kind:'compact'}`（单会话单动作，重复请求被抑制） |
| 2 | 请求当前 Step 安全完成 | `graceful-stop.ts`：设 `stopRequested`，不中断在跑工作 |
| 3 | 阻止下一个 Step 启动 | `agent/pre-step` 返回 `{kind:'reject'}`（人类提示守卫优先） |
| 4 | 等待 Agent 回到可执行的安全状态 | `await agent.whenIdle()` |
| 5 | 执行仓库实际支持的 compact 机制 | `ctx.compaction.compactNow(agent, signal)`（其内部走 `runMaintenance`，即官方安全点） |
| 6 | 等待压缩完成 | `await` 上述 Promise；结果 `CompactionResult \| null` |
| 7 | 发送「继续任务」 | 见 §8.4 的边界决策：仅在「软终止了在跑 turn」时发送 |
| 8 | 恢复原会话执行 | 清除 `stopRequested` 闩锁；若已发送「继续任务」，由该 turn 自然恢复 |
| 9 | 清理 compact 请求状态 | `state.ts` 清除 `armedAction`、更新 `lastAction.atTokens`（重臂基线） |

**忙碌 / 重试规则（`PLAN.md` §9「如果当前 Agent 忙碌或已有压缩操作正在执行」）**

- `ManualCompactionError.code === 'busy'` → **不报错、不硬中止**，放入重试队列，按退避重试，最多 `3` 次（常量 `COMPACT_MAX_RETRIES`）；每次都重新 `whenIdle()` 后再试。
- 达到上限 → 放弃并给出明确文案（§14），清除 `armedAction`，但 `lastAction.atTokens` **不更新**（允许下一轮阈值窗口重试，仍受 `maxAutoActionsPerSession` 约束）。
- 其它 code（`cancelled` / `changed` / `summary` / `commit` / `persistence`）→ 一次性失败，按 §14 文案报错，**保留原会话**。
- `ctx.get('compaction')` 缺失 → 明确提示「本部署未安装 compaction，自动压缩不可用」，**不伪造成功**；手动 `/handoff` 不受影响。

---

## 9. 设置项规格

命名空间：`dsh-auto-handoff`。

| 字段 | 类型 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `autoHandoffEnabled` | boolean | `false` | — | 启用 Token 阈值自动迁移 |
| `autoHandoffThreshold` | number | `2000000` | 整数 ≥ 0 | 自动迁移阈值（会话累计 Token） |
| `autoCompactEnabled` | boolean | `false` | — | 启用 Token 阈值自动压缩 |
| `autoCompactThreshold` | number | `1500000` | 整数 ≥ 0 | 自动压缩阈值 |
| `rearmDeltaTokens` | number | `200000` | 整数 ≥ 0 | 动作成功后重臂所需增量 |
| `maxAutoActionsPerSession` | number | `3` | 整数 1–10 | 单会话自动动作上限 |
| `summaryMaxTokens` | number | `4096` | 整数 ≥ 256 | 摘要 LLM 输出上限 |
| `stepWaitTimeoutMs` | number | `900000` | 整数 ≥ 1000 | 等待 Step 完成的「偏久」提示阈值（**不触发中断**） |
| `actionDeadlineMs` | number | `1800000` | 整数 ≥ 1000 | 动作总时限；到期仅释放闩锁 |
| `openNewSessionOnHandoff` | boolean | `true` | — | 迁移成功后由客户端切到新会话 |

**校验规则（`SettingsRegisterOptions.validate`）**

| 规则 | 行为 | 对应要求 |
| --- | --- | --- |
| 所有数值必须是安全整数且 ≥ 0 | 拒绝写入 | §13「数值不允许为负数」「阈值必须是有效数字」 |
| 两者都启用时 `autoCompactThreshold < autoHandoffThreshold` | **硬拒绝**，返回原因 | §10.2 / §19.14 |
| 阈值 < 50000 | 允许保存，但 UI 显示**警告** | §13「阈值过小或不合理时给出警告」 |
| 旧配置缺字段 | schema `default` 补全，不破坏已有设置 | §13「对旧配置提供默认值和兼容处理」 |

**持久化与降级**

- 有 `settings` 服务：`installSection` 把插件 `config` 作为 base，用户写入落到 `settings.yaml`，重启后仍生效，`settings/updated` 实时生效。
- 无 `settings` 服务：使用 `config` 默认值，`persistence = 'memory'`，UI 明示「本次会话内有效，重启后恢复默认」。

---

## 10. 客户端 UI 规格

### 10.1 注册方式

- 在客户端插件 `apply(ctx)` 中：
  ```ts
  const slots = ctx.get('slots')
  slots?.inject('settings.plugin.item', () => slots.register(
    { name: 'settings.plugin.item', key: 'dsh-auto-handoff' },
    () => React.createElement(HandoffCard),
  ))
  ```
- 不使用 `settings.section`（整页）——`settings.plugin.item` 才是外部插件被明确设计使用的座位，正好落在 Settings → Plugins 下。

### 10.2 卡片内容

| 区块 | 内容 |
| --- | --- |
| 标题 | DeepSeek Harness Session Handoff |
| 主设置 | 启用自动迁移 / 自动迁移阈值 / 启用自动压缩 / 自动压缩阈值 |
| 高级设置 | 重臂增量、单会话自动动作上限、摘要输出上限、等待提示阈值、动作总时限、迁移后自动切换会话 |
| 状态 | 当前会话累计 Token、阈值进度条、**精确 / 估算 / 不可用**标注、当前阶段（等待 Step / 生成摘要 / 创建会话 / 等待 compact）、是否在等待 Step 完成、最近一次动作结果 |
| 操作 | 立即迁移、取消、重试 |
| 提示 | 若 `autoCompactThreshold >= autoHandoffThreshold` 就地提示并禁用保存按钮 |

### 10.3 读写路径

- 设置：`ctx.settingsScope.bind<HandoffSettings>({ namespace: 'dsh-auto-handoff' })` → `getSnapshot()` / `subscribe()` / `set(field, value)`。
- 状态与操作：`fetch('/dsh-auto-handoff/state?sessionId=…')`、`POST /dsh-auto-handoff/handoff|cancel|retry`。

### 10.4 会话切换

- 轮询到 `lastResult.newSessionId` 且 `openNewSessionOnHandoff` 为真时：
  `await ctx.sessions.refresh(); ctx.sessions.open(newSessionId)`。
- 一次性闩锁（记录已打开过的 sessionId），避免每次轮询重复切换。

### 10.5 Host 路由契约

| 方法 | 路径 | 请求 | 响应（纯 JSON） |
| --- | --- | --- | --- |
| GET | `/dsh-auto-handoff/state` | `?sessionId=<id>` | `{ tokens, tokenSource:'exact'\|'estimated'\|'unavailable', thresholds:{handoff,compact}, phase, waitingForStep, summarizing, creatingSession, waitingForCompact, lastResult, newSessionId, persistence:'host'\|'memory' }` |
| POST | `/dsh-auto-handoff/handoff` | `{sessionId}` | `{ ok: true, phase }` / `{ ok:false, error }` |
| POST | `/dsh-auto-handoff/cancel` | `{sessionId}` | 同上 |
| POST | `/dsh-auto-handoff/retry` | `{sessionId}` | 同上 |

约束：`kind: 'prefix'`，`path: '/dsh-auto-handoff'`；只接受 loopback 来源的 `POST`；响应不含任何 Harness 活体对象（只输出标量 JSON）。

### 10.6 降级与样式

- 无 `webServer`：卡片降级为只读设置表单 + 「状态通道不可用」提示。
- 无 `settingsScope`：卡片显示「设置服务不可用」。
- 颜色只用 `--dsw-alias-*` 主题令牌；根节点带 `data-dsh-plugin="dsh-auto-handoff"`；全部用 `React.createElement`（无 JSX）。

---

## 11. 测试计划

### 11.1 框架与替身策略

- 运行器：`vitest`（`npm test` = `vitest run`）。
- 集成测试使用**真实 `@deepseek-ai/cordis`**（devDependency）构造 Context，并挂载一组**可控替身服务**：`commands`、`agents`、`sessionController`、`compaction`、`tokenMeter`、`sessionProjections`、`settings`、`llm`。
- 替身服务于 `test/harness.ts`，提供 `advanceStep()`、`emitEvent()`、`abortCompaction()` 等控制点，使 §11.3 的集成场景可确定性重放。
- **关键断言**：替身 Agent 的 `cancel` 为 `vi.fn()`，全部集成测试结束时断言 `cancel` 从未被调用（对应 §19.2、§19.3）。

### 11.2 单元测试矩阵（对应 `PLAN.md` §17 的 20 条）

| 编号 | 用例 | 对应需求 |
| --- | --- | --- |
| UT-RD-01 | 识别 `sk-*`、`ghp_*`、Bearer、Authorization 头 | 4 脱敏 |
| UT-RD-02 | 识别 `PASSWORD=…`、`TOKEN=…`、`COOKIE=…` 形态 | 4 |
| UT-RD-03 | 长十六进制/base64 串替换为 `[已脱敏]` | 4 |
| UT-RD-04 | 普通技术文本不被误伤（无假阳性） | 4 |
| UT-SU-01 | 摘要渲染包含 `PLAN.md` §5 的全部小节 | 1 摘要结构 |
| UT-SU-02 | 缺项小节写「（无）」而非省略 | 1 |
| UT-SU-03 | `command/run`、`command/done` 等 log-only 事件不进入摘要输入 | 3、`PLAN.md` §14 |
| UT-SU-04 | 被 compaction 影子覆盖的旧内容不重复拼接 | 3 |
| UT-SU-05 | 内部插件消息按 source 过滤；重复内容去重 | 2 过滤 |
| UT-TT-01 | 四 bucket 求和即累计值 | 5 |
| UT-TT-02 | `tokenUsage` 缺失/全 0 → 回退估算并标注 `estimated` | 5 |
| UT-TT-03 | 全部不可用 → `unavailable` 且不触发自动动作 | 5 |
| UT-TT-04 | 达到 `maxAutoActionsPerSession` 后不再产出动作 | 10、16 |
| UT-TT-05 | 同一水位重复事件只判定一次 | 6、15 |
| UT-TT-06 | 数值回退时告警且不重复累计 | 6 |
| UT-TT-07 | 重臂：需 `>= last + rearmDeltaTokens` | 6、16 |
| UT-TT-08 | 两阈值同时满足 → 返回 `handoff` | 9 优先级 |
| UT-TT-09 | 只启用 compact → 只返回 compact | 9 |
| UT-SE-01 | 默认值完整、旧配置缺字段被补全 | 7 非法设置值 |
| UT-SE-02 | `autoCompactThreshold >= autoHandoffThreshold` 被拒 | 8 |
| UT-SE-03 | 负数/非整数/NaN 被拒 | 7 |
| UT-SE-04 | 过小阈值产生警告但不阻止保存 | 7 |
| UT-SM-01 | 空闲会话立即进入下一步 | 11 状态流转 |
| UT-SM-02 | 运行中只设闩锁，不调用 cancel | 12、14 |
| UT-SM-03 | pre-step 含新人类提示 → 不 reject | 19（用户消息不丢） |
| UT-SM-04 | 无人类提示 → reject，turn 以 `blocked` 关闭 | 12 |
| UT-SM-05 | `actionDeadlineMs` 到期只释放闩锁并标失败 | 12、13 |
| UT-ST-01 | 会话记录状态流转与幂等 | 11 |
| UT-ST-02 | 单会话并发两个请求 → 第二个被抑制 | 10 |
| UT-ST-03 | 卸载时释放闩锁并清空状态 | 20 清理 |

### 11.3 集成测试矩阵（对应 `PLAN.md` §17 的 14 条）

| 编号 | 场景 | 对应需求 |
| --- | --- | --- |
| IT-01 | 手动 `/handoff` 全链路成功 | 1 |
| IT-02 | 自动达到阈值执行 handoff | 2 |
| IT-03 | 自动达到阈值执行 compact | 3 |
| IT-04 | compact 后按 §8.4 决策发送 / 不发送「继续任务」 | 4 |
| IT-05 | 当前 Step 未完成 → handoff 不执行 | 5 |
| IT-06 | 当前 Step 未完成 → compact 不执行 | 6 |
| IT-07 | 当前 Tool Call 不被强制中断（断言 `cancel` 零调用） | 7 |
| IT-08 | 新会话创建成功并收到摘要 | 8 |
| IT-09 | cwd 与 agentPreset 正确继承 | 9 |
| IT-10a/b/c | 模式 / 模型 / 权限在支持时正确继承；不支持时逐项降级并报告 | 10 |
| IT-11 | handoff 与 compact 同时满足 → 只执行 handoff | 11 |
| IT-12 | 迁移失败后原会话仍可继续（闩锁释放、无残留监听） | 12 |
| IT-13 | 自动流程不重复触发、不无限循环（连续阈值事件 + 多次动作上限） | 13 |
| IT-14 | 迁移期间用户新消息不丢失（阶段 1 放弃 / 阶段 2 转投） | 14 |
| IT-15 | 卸载后监听器全部回收（`ctx.on` 注册数归零、在途 Promise 已 settle） | 20 |

---

## 12. 构建与依赖策略

### 12.1 脚本

```jsonc
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",          // 产出 lib/；含 client bundle 步骤
    "test": "vitest run",
    "watch": "tsc -p tsconfig.json --watch"
  }
}
```

### 12.2 tsconfig 要点

`strict: true`、`noUncheckedIndexedAccess: true`、`noImplicitOverride: true`、`verbatimModuleSyntax: true`、`module: "nodenext"`、`moduleResolution: "nodenext"`、`target: "es2023"`、`rootDir: "src"`、`outDir: "lib"`、`declaration: false`、`skipLibCheck: true`。

### 12.3 依赖

- `peerDependencies`（可被 harness 满足）：仅列运行时真正 import 的官方包 ——
  `@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-token-meter`、`@deepseek-ai/dsh-session-projection`、`@deepseek-ai/dsh-compaction`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-util-values`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/cordis`。
  版本范围按 `contributing.md` 的显式预发布分支写法，例如：
  `">=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-rc.1 <0.1.7-0 || >=0.1.7-rc.1 <0.2.0-0"`。
- `devDependencies` 精确锁 `0.1.5-rc.3`（与本机 harness 完全一致，避免用新声明类型检查旧运行时），另加 `typescript@^5.6`、`vitest@^4`、`@types/node@^24`。
- 客户端类型依赖：`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-api-session-controller`、`react`/`@types/react`（仅类型）。
- **不引入**任何非必要运行时依赖（无 axios、无 zod 直接依赖 —— schema 走 `@deepseek-ai/schemastery`）。

### 12.4 Client bundle 生成

1. 首选：并入 `create-dsh-plugin -t panel` 生成的客户端构建管道（`tsdown`），产出 `lib/client.js`。
2. 兜底：按 §4.8 已确认的信封形态手写 `lib/client.js`（`window.__ModuleLoader__.load({id, factory})` + `React.createElement`），此时 client 侧只做类型检查不参与 tsc 产物；Host 侧不受影响。
3. 无论走哪条，`package.json.exports["./client"]` 必须指向 `lib/client.js`，且 `dsh.client.platform = "web"`。

---

## 13. 文档要求（`README.md`）

必须覆盖 `PLAN.md` §18 的全部 20 项，并额外包含：

1. 插件用途与命名定稿（§3 表格）。
2. `/handoff`、`/handoff status`、`/handoff cancel` 用法。
3. 自动迁移与自动压缩的设置项、默认值、非法组合规则。
4. Token 使用量来源、精确/估算判定规则、**累计口径公式**。
5. 哪些会话配置可继承（cwd / agentPreset / 模型 / 权限预设 / Plan 模式）、哪些不可继承（浏览器私有交互状态、UI 选中项等）。
6. 软终止的具体行为：为什么当前 Step 与 Tool Call 不会被立即中断；`agent/pre-step` reject 的语义与 `blocked` turn 结束原因。
7. compact 忙碌时的处理（有界重试 + 放弃策略）。
8. 迁移失败时如何恢复（保留原会话、闩锁释放、可重试）。
9. 用户在迁移过程中发消息的三种阶段处理。
10. 如何关闭自动功能（两个开关置 false，手动 `/handoff` 仍可用）。
11. 持久化不可用时的降级行为与重启后的行为差异。
12. 如何运行测试（`npm test`）、如何构建（`npm run build`）。
13. harness 版本兼容性（`0.1.5-rc.3` 基线；peer 范围写法说明）。
14. 当前实现的限制与 TODO（§16 全文）。
15. §8.4「继续任务」偏离的说明与理由。
16. 主题/皮肤声明节（`--dsw-alias-*` 令牌 + `data-dsh-plugin` 属性）。

---

## 14. 错误处理与用户可见文案（对应 `PLAN.md` §15）

错误文案集中在 `src/types.ts` 的 `MESSAGES` 常量表中，便于单测与复查；全部通过 `CommandResult.text`、`/handoff status`、HTTP 状态接口与卡片三处一致呈现。

| # | 错误场景 | 检测方式 | 处理 | 用户可见文案（要点） |
| --- | --- | --- | --- | --- |
| 1 | 当前没有活动会话 | `invocation.agent` 缺失，或投影为空且无 turn | 中止，**不建会话** | 当前没有可迁移的活动会话。 |
| 2 | 无法读取会话历史 | `deriveMessages()` / `snapshotEvents()` 抛错 | 中止迁移，保留原会话 | 无法读取当前会话历史：<原因>；已保留原会话。 |
| 3 | 无法获取 Token 使用量 | 投影与 `tokenMeter` 均不可用 | 停用自动功能，手动仍可用 | 无法获取 Token 统计，自动迁移/压缩已停用。 |
| 4 | Token 统计结果不完整 | `source === 'estimated'` | 允许但标注估算 | Token 为估算值（适配器未上报用量）。 |
| 5 | 当前 Step 无法结束 | `whenIdle()` 长时间未兑现 | 只显示等待，**不破坏性终止** | 正在等待当前 Step 完成…（已等待 N 分钟） |
| 6 | 当前 Tool Call 失败 | `agent/error` / `tool/result.error` | 记录失败结果，继续软终止流程 | 当前 Tool Call 失败：<原因>；已记录，继续迁移流程。 |
| 7 | 摘要生成失败 | `llm.stream` 抛错 / finish 非 `stop` | 放弃迁移，保留原会话 | 生成任务摘要失败：<原因>；已放弃迁移，原会话保持不变。 |
| 8 | 摘要为空 | 解析后文本为空 | 放弃迁移 | 摘要为空，已放弃迁移。 |
| 9 | 新会话创建失败 | `sessionController.create` 抛错 | 保留原会话，允许重试 | 创建新会话失败：<原因>；原会话可用，可稍后重试 /handoff。 |
| 10 | 配置继承失败 | 逐项 try/catch | 逐项降级并如实报告 | 已继承：<列表>；未继承：<列表及原因>。 |
| 11 | 摘要发送失败 | `followup` 抛错 | 不假装成功；返回新会话 id | 摘要未能发送到新会话，新会话已创建：<id>，可手动继续。 |
| 12 | compact 不支持 | `ctx.get('compaction') === undefined` | 停用自动压缩 | 本部署未安装 compaction，自动压缩不可用。 |
| 13 | compact 执行失败 | `ManualCompactionError` | 保留原会话并报错 | 自动压缩失败（<code>）：<message> |
| 14 | Agent 状态变化 | `agent/status` 与记录不一致 | 重新判定；不一致则重置闩锁 | 会话状态已变化，正在重新判定… |
| 15 | 插件被卸载 | `ctx.effect` 回收钩子 | 释放闩锁、`allSettled` 在途任务 | （无 UI，仅日志） |
| 16 | 应用退出 | 不写入半成品状态 | 不破坏会话；内存态自然丢弃 | （无 UI，文档说明重启后行为） |
| 17 | 用户在迁移期间发消息 | 人类提示守卫 + 阶段判定 | 见 §7.7 三段式 | 检测到新消息：已取消迁移 / 已转投到新会话。 |
| 18 | 重复触发或状态不一致 | 水位 + 单会话单动作 + 幂等 | 抑制重复；如不一致则重置 | 该会话已有迁移/压缩在进行中。 |

**默认失败策略（`PLAN.md` §15 原文逐条落实）**

- 摘要生成失败 → 放弃迁移，保留原会话。
- 新会话创建失败 → 保留原会话。
- 摘要发送失败 → 不假装迁移成功。
- compact 失败 → 保留原会话并显示错误。
- 不丢弃用户输入。
- 不创建无法继续执行任务的空会话。
- 不无限重试（compact 上限 3 次；自动动作上限 `maxAutoActionsPerSession`）。
- 在原会话中显示明确的错误或系统状态提示。

**状态提示文案清单（`PLAN.md` §15 末）**

`正在等待当前 Step 完成…` / `当前 Step 已完成，正在保存状态…` / `正在生成任务摘要…` / `正在创建新会话…` / `正在发送迁移摘要…` / `正在等待 compact…` / `已完成会话迁移` / `会话迁移失败` / `已取消会话迁移`。

---

## 15. 验证步骤

| # | 步骤 | 命令 / 方式 | 通过标准 |
| --- | --- | --- | --- |
| V1 | 安装依赖 | `npm install`（工作目录 `dsh-auto-handoff/`） | 无 `ERESOLVE` |
| V2 | 类型检查 | `npm run typecheck` | 退出码 0，无 `any` 泄漏告警 |
| V3 | 单元 + 集成测试 | `npm test` | 全绿；`cancel` 零调用断言通过 |
| V4 | 构建 | `npm run build` | 产出 `lib/index.js` 与 `lib/client.js` |
| V5 | 非侵入装载验证 | 新建临时 profile：`dsh plugin --profile handoff-verify add "file:<插件仓库根目录>"` → `dsh dump-config` | 配置中可见 `dsh-auto-handoff` 行；Host 半加载无报错；随后删除该临时 profile |
| V6 | 验收对表 | 人工逐条核对 §2.2 的 24 行 | 全部有对应实现与测试/说明 |
| V7 | **可选，需用户明确同意** | 装入正在使用的 `web` profile 并重启 harness，实测 GUI 中的 `/handoff` 全流程 | 会用 `/handoff` 完成一次真实迁移；**重启会中断当前会话，未获同意不执行** |

---

## 16. 风险、限制与降级（必须在 README 复述）

| # | 限制 | 原因 | 降级 / 应对 |
| --- | --- | --- | --- |
| L1 | 没有独立的软停止服务 | 仓库不存在该能力（§4.10） | 用 `agent/pre-step` reject 实现「不启动下一个 Step」；turn 以 `reason:'blocked'` 关闭 |
| L2 | 被 reject 的 step 中已 claim 的消息不会写入模型历史 | `dsh-agent` 的明确契约 | 人类提示守卫（§7.2）；含用户新输入时绝不 reject |
| L3 | 无法从 Host 侧删除已写入旧会话的用户消息 | 日志只追加，删日志会破坏事实来源（`PLAN.md` §14） | 阶段 2 把用户文本转投新会话并在 UI 明示；旧日志保留 |
| L4 | 协调状态不落盘 | 不新建独立数据库（`PLAN.md` §7.4） | 内存态 + 明确文档；重启后闩锁与最近结果丢失，设置与已建会话不受影响 |
| L5 | 无静态插件的通用 Host↔Client RPC | 仅动态 Cordis 插件有 `harness.handle` | 走 `webServer` 路由 + `fetch`；无 `webServer` 时卡片降级只读 |
| L6 | 权限预设为 `custom` 时无法整体继承 | 无对应 preset 名 | 逐项继承 `approval/policy` 与 sandbox mode（可读时），并在结果中报告未继承项 |
| L7 | `sessionController` 缺失的极简部署 | 该服务由 `dsh-api-session-controller` 提供 | 自动功能停用，`/handoff` 返回明确错误，不静默失败 |
| L8 | `GenerateOptions.purpose` 是封闭联合 | 0.1.5-rc.3 声明 | 本插件不传 `purpose` |
| L9 | Token 为估算值时的精确性 | 适配器未上报 usage 时只能启发式 | UI 与 README 明确标注「估算」，并说明与精确值的判定规则 |
| L10 | 自动 compact 的「继续任务」策略偏离 §9.7 | 防止 idle 会话被凭空开启 turn 造成循环 | §8.4 明文规定 + 设置卡与 README 说明 |

---

## 17. 附录：证据索引

`HS\` = `D:\APPs\Nodejs\nodejs_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

| 主题 | 文件 | 位置 |
| --- | --- | --- |
| 命令注册与调用契约 | `HS\dsh-commands\lib\types\index.d.ts` | 18-52、91 |
| 命令结果与 log-only 事件 | `HS\dsh-commands\lib\types\types.d.ts` | 33-62、88-117 |
| 会话头字段 | `HS\dsh-session\lib\types\types.d.ts` | 58-95 |
| turn/step/assistant/tool 事件 | `HS\dsh-session\lib\types\types.d.ts` | 242-378 |
| Session API（快照/派生/请求头） | `HS\dsh-session\lib\types\index.d.ts` | 100-200、238-290 |
| Surface 与可见历史 | `HS\dsh-session\lib\types\surface.d.ts` | 14-24、52-64、91-112 |
| Agent 活体面与生命周期事件 | `HS\dsh-agent\lib\types\runtime-types.d.ts` | 84-209、212-417 |
| Agent 注册表（get/list/create/resume） | `HS\dsh-agent\lib\types\index.d.ts` | 279-362 |
| turn 循环与 pre-step 决策 | `HS\dsh-agent-loop\lib\index.js` | 885-908、919-975 |
| 会话创建 | `HS\dsh-api-session-controller\lib\index.js` | 571-599 |
| 模型选择与 route 解析 | 同上 | 277-318、605-634 |
| 提示词投递 | 同上 | 736-790 |
| 会话、模型、权限、来源事件 | `HS\dsh-api-session-controller\lib\types\types.d.ts` | 30-35、252-332、537-572 |
| 客户端会话契约 | `HS\dsh-api-session-controller\lib\types\client\contract\sessions.d.ts` | 19-42、72-77 |
| Token 累计投影 | `HS\dsh-token-meter\lib\types\usage-projection.d.ts` | 12-148、170-221 |
| TokenMeasurement | `HS\dsh-token-meter\lib\types\types.d.ts` | 12-46 |
| tokenMeter 服务 | `HS\dsh-token-meter\lib\types\index.d.ts` | 20-70 |
| 投影注册表状态读 | `HS\dsh-session-projection\lib\types\index.d.ts` | 134-185 |
| Compaction 契约与错误码 | `HS\dsh-compaction\lib\types\index.d.ts` | 19-37、61-131 |
| CompactionResult 与事件 | `HS\dsh-compaction\lib\types\types.d.ts` | 14-131 |
| 自动压缩参考实现 | `HS\dsh-compaction-basic\lib\index.js` | 793-819、873-889、944-968 |
| `/compact` 命令参考 | `HS\dsh-command-compact\lib\index.js` | 12-97 |
| 设置注册/继承与校验 | `HS\dsh-settings\lib\types\index.d.ts` | 20-110 |
| 设置可选挂载惯用法 | `HS\dsh-web-search-deepseek\lib\index.js` | 293-304 |
| schemastery 数值写法 | `HS\dsh-agent-loop\lib\index.js` | 1465、1520 |
| 权限预设 | `HS\dsh-permission-presets\lib\types\index.d.ts` | 58、112-158 |
| 审批策略 | `HS\dsh-user-approval\lib\types\index.d.ts` | 26-31、46、108、141 |
| Plan 模式 | `HS\dsh-plan-mode\lib\types\index.d.ts` | 36-38、112-132 |
| LLM 流与 GenerateOptions | `HS\dsh-llm\lib\types\types.d.ts` | 404-444 |
| BlockAssembler | `HS\dsh-llm\lib\types\assembler.d.ts` | 22-73 |
| 消息与 source 联合 | `HS\dsh-llm\lib\types\message.d.ts` | 92-118、180 |
| 辅助 LLM 调用实例 | `dsh-git-commit\lib\index.js`（工作区） | 194-233 |
| WebServer 路由 | `HS\dsh-host-webserver\lib\types\index.d.ts` | 30-39、90 |
| Client 模块清单 | `HS\dsh-package-manifest\lib\types\types.d.ts` | 7-52、85-91 |
| Client 设置卡 Slot | `HS\dsh-client-ui-settings-plugins\lib\types\client\slot-contract.d.ts` | 16-31 |
| 客户端设置 scope | `HS\dsh-client-ui-settings\lib\types\client\settings-scope.d.ts` | 100-140 |
| 客户端设置 scope 契约 | `HS\dsh-client-ui-settings\lib\types\client\settings-contract.d.ts` | 34-85 |
| Client bundle 形态 | `C:\Users\wjj\.dsh\profiles\web\node_modules\dsh-better-sidebar\lib\client.js` | 首 5 行 |
| 第三方 Host↔Client 先例 | 同上 `\src\client\api.ts` | 1-23 |
| 打包与 peer 写法 | 工作区 `dsh-git-commit\package.json`、`contributing.md` | 41-45 / 130-140 |
| 脚手架双半模板 | npm `create-dsh-plugin@0.2.3` README | Templates 表 `panel` 行 |
