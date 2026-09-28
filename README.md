# dsh-auto-handoff

> DeepSeek Harness 插件：把长会话的任务与进度**结构化交接**给同一工作区里的新会话，并继续未完成的任务。
> 迁移在 **Step 边界**发生——它只会拒绝「启动下一个 Step」，绝不硬中断正在跑的 Step、Tool Call、文件操作或终端命令。

| 项 | 值 |
| --- | --- |
| npm 包名 | `dsh-auto-handoff` |
| cordis 行 id / 插件 `name` | `dsh-auto-handoff` |
| 斜杠命令 | `/handoff`（含 `status` / `cancel` / `retry`） |
| 设置命名空间 | `dsh-auto-handoff` |
| 设置卡 Slot | `settings.plugin.item`，`key: "dsh-auto-handoff"` |
| HTTP 路由前缀 | `/dsh-auto-handoff` |
| 事实基线 | `@deepseek-ai/dsh@0.1.5-rc.3` |
| 许可 | MIT |

---

## 1. 插件用途

一次很长的会话会不断把历史重新发给模型，Token 成本随长度线性增长，而模型对早期内容的注意力却在下降。`dsh-auto-handoff` 的做法是：

1. 在**安全的 Step 边界**让当前会话停下来（不是中断，见 §8）；
2. 把「总体目标 / 约束 / 已完成 / 当前进度 / 已改文件 / 关键决策 / 已知问题 / 未完成 / 下一步」九个小节，
   连同**由程序直接读取**的原会话配置，渲染成一份固定结构的交接简报；
3. 在**同一工作区**创建一个全新会话；
4. 尽可能继承原会话的 preset / 模型 / 权限 / Plan 模式；
5. 把简报作为新会话的第一个提示词投递过去；
6. 旧会话标记为 `retired`，不再参与后续工作。

触发方式有两种：手动 `/handoff`，或按**会话累计 Token** 阈值自动执行。两者共用同一套实现。

---

## 2. 安装

```sh
dsh plugin --profile <profile> add "file:/path/to/dsh-auto-handoff"
```

`package.json` 声明了 `dsh.bundle.patch`（`cordis.patch.yml`）与 `dsh.client`（`platform: "web"`），
因此 Host 半与浏览器半都会自动挂载；浏览器半无需额外的 profile 行。

从源码安装需要在 profile 里批准构建（`allowBuilds`），或先在本仓库执行一次 `npm run build`，
让 `lib/` 随包一起发布。

---

## 3. `/handoff` 用法

| 命令 | 行为 |
| --- | --- |
| `/handoff` | 立即把当前会话迁移到同工作区的新会话 |
| `/handoff status` | 显示当前阶段、累计 Token 与来源、阈值、自动动作次数、最近一次动作与失败记录 |
| `/handoff cancel` | 请求取消正在进行的迁移或压缩（在下一个安全检查点生效） |
| `/handoff retry` | 重试最近一次失败的迁移 |

命令本身**不进入模型可见历史**。`command/run` 与 `command/done` 是仓库既有的 log-only 事件，
不会出现在 `session.deriveMessages()` 里（见 UT-SU-03）。

空白会话（投影里既没有人类提示，也没有任何 turn）会被拒绝并提示「当前没有可迁移的活动会话。」，
**不会**创建一个无法继续执行任何任务的空会话。

---

## 4. 设置项

命名空间 `dsh-auto-handoff`。有 `settings` 服务时写入设置文档并重启后仍生效；没有时仅本次进程内有效。

### 4.1 主设置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `autoHandoffEnabled` | boolean | `false` | 启用 Token 阈值自动迁移 |
| `autoHandoffThreshold` | 整数 ≥ 0 | `2000000` | 自动迁移阈值（会话累计 Token） |
| `autoCompactEnabled` | boolean | `false` | 启用 Token 阈值自动压缩 |
| `autoCompactThreshold` | 整数 ≥ 0 | `1500000` | 自动压缩阈值 |

### 4.2 高级设置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `rearmDeltaTokens` | 整数 ≥ 0 | `200000` | 动作成功后，需要再增长多少累计 Token 才重新武装 |
| `maxAutoActionsPerSession` | 整数 1–10 | `3` | 单会话自动动作上限 |
| `summaryMaxTokens` | 整数 ≥ 256 | `4096` | 摘要模型调用的输出上限 |
| `stepWaitTimeoutMs` | 整数 ≥ 1000 | `900000` | 「等待 Step 完成」多久算偏久（**只提示，不中断**） |
| `actionDeadlineMs` | 整数 ≥ 1000 | `1800000` | 动作总时限；到期**只释放闩锁**并标记失败 |
| `openNewSessionOnHandoff` | boolean | `true` | 迁移成功后由浏览器半切到新会话 |

### 4.3 非法与警告规则

| 规则 | 行为 |
| --- | --- |
| 数值必须是安全整数且 ≥ 0（`maxAutoActionsPerSession` 1–10，`summaryMaxTokens` ≥ 256，时间 ≥ 1000） | schema 层拒绝；旧文档缺字段自动补默认值 |
| 两个开关**都开启**且 `autoCompactThreshold >= autoHandoffThreshold` | **硬拒绝写入**，并返回原因 |
| 只有一个开关开启时的阈值顺序颠倒 | 允许保存，但设置卡与 `status` 给出警告 |
| 阈值 < 50000 | 允许保存，给出「阈值偏小」警告 |

设置卡内的保存按钮在两个开关同时开启且顺序非法时会被禁用，并就地显示原因。

### 4.4 如何关闭自动功能

把 `autoHandoffEnabled` 与 `autoCompactEnabled` 都置为 `false`。此时不产生任何自动动作，
手动 `/handoff`、`status`、`cancel`、`retry` 全部照常可用。默认值本身就是「两个都关闭」。

---

## 5. Token 使用量与判定规则

### 5.1 来源

优先级从高到低（`src/token-threshold.ts` 的 `readCumulativeUsage`）：

1. **`tokenUsage` 投影**（`ctx.sessionProjections.stateOf(session, 'tokenUsage')`）。
   数据来自 durable 的 `assistant/message.usage`，由日志**纯折叠**得出，重启后按日志重放。
2. **`ctx.tokenMeter.measure(session).totalTokens`**——适配器未上报用量时的固定启发式估算。
3. 两者都不可用。

### 5.2 精确 / 估算 / 不可用

| 标注 | 判定条件 | 自动化影响 |
| --- | --- | --- |
| `exact`（精确） | 四个 bucket 之和 > 0 | 正常参与阈值判定 |
| `estimated`（估算） | 和为零，但 `measure()` 返回 > 0 | 正常参与判定，但 UI 明确标注「估算」 |
| `unavailable`（不可用） | 两者都为 0 | **自动功能停用**，手动 `/handoff` 仍可用 |

### 5.3 累计口径

```
cumulative = totals.uncachedInputTokens
           + totals.outputTokens
           + totals.cacheReadTokens
           + totals.cacheWriteTokens
```

这是**会话累计用量**，不是单次请求的上下文压力；compaction 只影子化 surface，**不会**把它归零。

---

## 6. 配置继承矩阵

### 6.1 会继承

| 配置 | 读取 | 写入 |
| --- | --- | --- |
| 工作区 / cwd | `session.header.cwd` | `sessionController.create({ cwd })` |
| 工作区归属 | `workspaceRegistry.resolveByPath(cwd)` | `workspace.attachSession(newSessionId)`（见 §6.5） |
| Agent preset | `session.header.agentPreset`，回退 `agentPresets.composedPreset(ctx)` | `create({ agentPreset })` |
| 模型 | 日志最新 `model/selection` → `requestHeader().config` → `agent.options` → `agentDefaultModel.currentSelection()` | `sessionController.selectModel(...)` |
| 权限预设 | `permissionPresets.current(session)` | `permissionPresets.set(newSession, name)` |
| 权限为 `custom` | `approval.overrideOf(session)` | `approval.setPolicy(newAgent, policy)` |
| Plan 模式 | 按 agent 解析出的 `planMode.get(agent).active`（见 §6.4） | 在**新会话 agent 自己**的实例上 `planMode.set(newAgent, active)` |

每一步都**逐项报告**：`已继承` / `回退` / `未继承（原因）`。任何一步失败都不会被静默吞掉。

### 6.2 不继承

- 浏览器私有的交互状态（滚动位置、折叠状态、选中项、未提交草稿）；
- UI 里的临时选择（临时切换的模型、临时权限，未落到会话配置上的）；
- `custom` 权限预设下的 sandbox 档位——仓库没有「自定义组合」这个名字可以重放，
  因此只能继承审批策略，并在结果里明确写明「sandbox 档位未继承」；
- 已在原会话里写入的日志与附件（新会话从零开始，只带简报）。

### 6.3 服务缺失时的降级

| 缺失的服务 | 后果 |
| --- | --- |
| `sessionController` | 迁移失败并明确报错；自动功能停用；不静默失败 |
| `llm` | 摘要无法生成 → 放弃迁移，保留原会话 |
| `agentPresets` | preset 行标记「未继承」，使用部署默认 |
| `workspaceRegistry` | 工作区归属行标记「未继承」；新会话仍会创建，只是不进入任何项目分组（见 §6.5） |
| `permissionPresets` / `approval` | 权限行标记「未继承」 |
| `planMode`（两边都没有） | Plan 模式行标记「未继承」 |
| `tokenMeter` / `sessionProjections` | Token 标注为「不可用」，自动功能停用 |
| `settings` | 设置只在本进程内有效（见 §12） |
| `webServer` | 设置卡降级为「状态通道不可用」，设置表单仍可读写 |
| `compaction`（该 agent 两边都没有） | 自动压缩停用并明确提示；手动 `/handoff` 不受影响 |

### 6.4 服务解析时机与 agent realm

插件对可选服务**一律惰性读取**：`src/index.ts` 的 `serviceReader()` 在每次使用时重新 `ctx.get`，绝不在 `apply()` 里快照。这不是风格问题——Loader **并发**装配同层条目（`cordis-plugin-loader/src/config/group.ts` 用 `Promise.allSettled` 创建同层的所有条目），而任何 `inject` 了服务的行都会停在 `PENDING`，直到它的依赖全部就绪才真正 apply。`sessionController` 自己 inject 了 10 个服务，落在本插件之后是常态；装配时一次性取值会把健康的部署误报成「本部署未安装 sessionController」。

`planMode` 与 `compaction` 还多一层：Web 面（`dsh-web-app/cordis.patch.yml`）把宿主 `plan-mode` / `compaction-basic` 两行 `disabled`，改由每个 **agent preset** 挂载，并且包在 `isolate` realm 内。realm 对组外的行不可见——包括宿主平面的插件行——所以 `ctx.get` 永远拿不到。这两个服务因此按 **agent** 解析：

```
agentPresets.serviceFor(agent, 'planMode')   // preset realm 里的实例
  ?? ctx.get('planMode')                     // 宿主平面（TUI 等保留宿主行的场合）
```

迁移时源 agent 与新会话 agent 各自解析一次，两个实例可以不同——这正是 per-agent 语义。于是 `/handoff status` 与继承矩阵里的「Plan 模式」「自动压缩」反映的都是**该会话真正能用的**服务，而不是某个进程全局的猜测。

### 6.5 迁移后的可见性与自动跳转

一次真实 `/handoff` 暴露了三个各自独立的缺陷：会话确实建好了、简报也确实投递了，但用户「在工作区里看不到新会话，页面也没有跳过去」。三者都不是配置问题，修法也不在同一层：

**缺陷 A（Host）：按 cwd 建会话不会附加任何工作区。** 浏览器严格按 `Workspace.sessionIds` 分项目组，而该字段只是**过滤**、从不按 cwd 补全：

```js
get sessionIds() { return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path) }
```

`sessionController.create()` 只在请求带 `workspaceId` 时调用 `attachSession()`；只带 `cwd` 时谁都不记账。而 `workspaceId` 与 `cwd` **互斥**（同时给会得到 `gateway/bad-request`），`cwd` 才是这里真正要继承的事实。因此迁移改为「按 cwd 创建 → 再 `resolveByPath(cwd).attachSession(newId)`」，与 `dsh-api-session-controller` 自己 fork 会话时的做法一致（它同样是先建、后 attach）。

这里有三条**有意**的设计决定：

- 不把 `workspaceId` 传给 `create()`：一旦 attach 失败，Host 会在会话**已经创建成功**之后抛错，我们就会把「已存在的新会话」误报成创建失败，并丢掉它的 sessionId；
- 不在目录未注册时自动 `registry.create()`：那会静默改动用户的侧边栏顺序；
- attach 是 best-effort：失败了也只是继承行标记「未继承（原因）」，**绝不**把迁移报成失败——新会话的真实存在比报告好看更重要。

**缺陷 B（Client）：新会话被当成「空白行」隐藏。** 会话在 `session/created` 时就以 `api-session/added` 广播，此刻 Host 侧 `blank === true`（`ApiSessionList.init = { blank: true }`，只有 `turn/start` 才清掉）。客户端 `mergeSummary` 只写入这份 summary，之后**再没有任何事件会清 blank**：`handleSessionStatus` 只改 running，`handleSessionActivity` 只改 updatedAt，而 activity 只对 `source.kind === 'user'` 的消息发——迁移简报是 `kind: 'plugin'`。工作区分组里 `sessionVisible = !blank || id === current`，于是这张行除当前会话外一律隐藏。所以自动跳转前必须先 `sessions.refresh()` 重新拉一次列表（这是让 Host 重算 `blank` 的唯一手段），**再** `open()`；只 open 会跳到一个侧边栏仍拒绝显示的行上。

**缺陷 C（Client）：切换器不能寄生在设置卡里。** 原先的切换逻辑写在设置卡的 effect 里，而卡片只在「设置 → 插件」标签挂载时才存在；`/handoff` 是在聊天里敲的，观察者根本没运行。现在由 `apply()` 启动常驻的 `startHandoffFollower()`（`src/client/follow.ts`），对整页有效，与卡片是否挂载无关。

follower 的两条规则值得单独写下来：

- **基线规则**：某个会话**首次**被观察到时，只记录它当时的 `newSessionId`、不动作。否则每次打开页面都会被劫持到历史上某次迁移的会话；只有 `undefined → 有值` 的跃迁才切换。
- **重试规则**：新行还没出现在列表里、或仍是 `blank` 时，本 tick 放弃、下个 tick 重试，最多 12 次（约 24 秒）后静默放弃——简报没能启动 turn 时行会一直是 blank，无限重试只会每 2 秒重拉一次整份列表。

---

## 7. 软终止的具体行为

状态流转：

```
IDLE
 → PREPARING                    已受理
 → WAITING_FOR_STEP_BOUNDARY    已设停止闩锁，等待当前 Step（含 Tool Call）自然结束
 → SUMMARIZING                  生成并脱敏摘要
 → CREATING_SESSION             创建新会话 + 逐项继承
 → TRANSFERRING                 投递简报
 → COMPLETED | FAILED | CANCELLED
```

自动压缩使用同一套前置流程，执行阶段显示为 `WAITING_FOR_COMPACT`。

### 7.1 为什么当前 Step 与 Tool Call 不会被立即中断

因为插件**从不调用任何取消 API**。整段等待只做两件事：

1. 设置一个闩锁（`stopRequested`）；
2. `await agent.whenIdle()`——等 Harness 自己把当前 Step 正常收尾。

`agent.cancel()` 在整个代码库中一次都没有被调用；集成测试对每个替身 Agent 的 `cancel` spy
断言调用次数为 **0**（IT-07、IT-15）。

### 7.2 `agent/pre-step` reject 的语义

`agent/pre-step` 是一个 waterfall。插件的监听器在「闩锁已设」且「本批消息里没有新的人类提示」时
返回 `{ kind: 'reject' }`。仓库的 turn 循环收到 reject 后：

```js
if (decision.kind === "reject") { turnEnds = { kind: "blocked" }; return false }
```

也就是：**这一步不启动，turn 以 `reason: 'blocked'` 关闭**，并且不会再有下一个 Step。
当前 Step 的结果已经按仓库既有机制写入会话日志与 checkpoint——插件只读日志，不写日志。

### 7.3 人类提示守卫

被 reject 的 step 里已经 claim 的消息**既不入库也不重发**（`dsh-agent` 的明确契约）。
因此监听器在 reject 之前先检查：只要本批消息里存在 `source.kind === 'user'`（人类提示，
包括浏览器的 `user-rpc`），就**绝不 reject**，直接放行。插件自己的注入（`kind: 'plugin'`）
与 goal 轮次（`kind: 'goal'`）不在此列。

### 7.4 时限策略

| 时限 | 行为 |
| --- | --- |
| `stepWaitTimeoutMs`（默认 15 分钟） | 只把 `slowWarning` 置位并显示「正在等待当前 Step 完成…（已等待 N 分钟）」，**继续等待** |
| `actionDeadlineMs`（默认 30 分钟） | 释放闩锁、恢复会话正常运行、标记 `FAILED` 并给出明确文案；**不做任何破坏性动作** |

---

## 8. 自动压缩与「继续任务」的边界

### 8.1 流程

1. 单会话只保留一个待执行动作（重复请求被抑制）；
2. 设置闩锁，不中断在跑的工作；
3. `agent/pre-step` 拒绝下一个 Step（人类提示守卫优先）；
4. `await agent.whenIdle()` 回到安全状态；
5. `ctx.compaction.compactNow(agent, signal)`——其内部走官方的 `runMaintenance` 空闲相位；
6. 等待结果（`CompactionResult | null`）；
7. **有条件地**发送「继续任务」（见下）；
8. 清除闩锁，恢复原会话；
9. 清理动作状态并更新重臂基线。

### 8.2 忙碌时（`ManualCompactionError.code === 'busy'`）

- **不报错、不硬中止**，按 250 ms × 次数退避重试，最多 **3 次**（`COMPACT_MAX_RETRIES`）；
- 每次重试前重新 `await agent.whenIdle()`，重新争取安全点；
- 到达上限 → 放弃并给出明确文案，清除待执行动作，但**不更新重臂基线**
  （允许在下一轮阈值窗口重试，仍受 `maxAutoActionsPerSession` 约束）；
- 其它 code（`cancelled` / `changed` / `summary` / `commit` / `persistence`）→ 一次性失败并报错，保留原会话；
- 深化：`compactNow` 返回 `null` 表示「没有可安全压缩的有用范围」，这是**结果不是失败**。

### 8.3 「继续任务」的策略偏离（有意的）

`PLAN.md` §9.7 要求 compaction 成功后发送「继续任务」。本插件**只在本次压缩是对「正在跑的 turn
先软终止、再压缩」时**才发送。若会话本来就空闲，压缩后不自动发消息。

理由：往一个本来空闲的会话注入「继续任务」会凭空开启一个新的 turn，从而形成
`compact → 继续任务 → handoff → compact` 的循环风险，违反「不无限循环」的硬要求。
`PLAN.md` §10 允许在「行为明确 + 不重复触发 + 不无限循环 + 在设置界面与文档中说明优先级」的前提下调整策略，
本节的说明同时出现在 README 与设置卡的状态区。

---

## 9. 阈值、优先级与防循环

1. 两个阈值同时满足 → **handoff 优先**；
2. 只启用一个 → 只产出该动作；
3. 两个都关闭 → 自动功能停用，手动 `/handoff` 仍可用；
4. `session/event` 按**水位去重**：同一个日志位置只判定一次；
5. 每次**成功**动作后记录 `lastActionAtTokens`；需要
   `cumulative >= lastActionAtTokens + rearmDeltaTokens` 才重新武装；
6. 每会话自动动作次数上限 `maxAutoActionsPerSession`（默认 3），达到后不再自动触发并给出文案；
7. handoff 成功后旧会话 `retired`，不再产生任何自动动作；
8. 同一会话同一时刻只有一个待执行动作。

---

## 10. 失败与恢复

| 失败点 | 行为 |
| --- | --- |
| 无法读取会话历史 | 中止迁移，保留原会话，报出原因 |
| 摘要生成失败 / 摘要为空 | **放弃迁移，保留原会话**，不做任何写操作 |
| 新会话创建失败 | 保留原会话，允许稍后 `/handoff` 或 `retry`；**不创建空会话** |
| 逐项继承失败 | 逐项降级并在结果中列出「未继承（原因）」 |
| 简报投递失败 | **不假装成功**：把已创建的新会话 id 一并返回给用户，可手动继续 |
| compact 失败 | 保留原会话并显示错误码与信息 |
| 动作超时 | 释放闩锁、恢复运行、标记失败，不做破坏性动作 |
| 插件卸载 | 回收监听器、定时器与全部闩锁，`Promise.allSettled` 在途任务 |

恢复路径：失败后闩锁一定被释放，原会话立即可继续工作；`/handoff retry`
会重新武装最近一次失败的动作（`lastActionAtTokens` 未更新，因此不受重臂基线阻挡）。

---

## 11. 迁移过程中用户发来新消息

| 阶段 | 处理 |
| --- | --- |
| `PREPARING` / `WAITING_FOR_STEP_BOUNDARY` / `SUMMARIZING`（新会话尚未创建） | **放弃本次迁移**（`CANCELLED`），消息放行，在**原会话**继续执行；不丢弃任何输入 |
| `CREATING_SESSION` / `TRANSFERRING`（新会话已建、简报未投递完） | 拒绝该 Step，并把消息文本**转投到新会话**（追加在简报之后），UI 明确提示「已转投到新会话」 |
| `COMPLETED` 之后 | 旧会话 `retired`，浏览器半切到新会话；旧会话不再处理任务，避免两个会话并行处理同一任务 |

转投失败时不会吞掉消息：插件放弃拒绝、放行该 Step，让消息在原会话执行，并记录一条提示。
原会话日志**只追加不删除**，插件从不删日志。

---

## 12. 持久化与降级

| 情形 | 行为 |
| --- | --- |
| 有 `settings` 服务 | 通过 `installSection` 把插件 `config` 作为 base 层；用户写入落到设置文档，重启后仍生效；`settings/updated` 实时生效 |
| 无 `settings` 服务 | 使用 `config` 默认值，`persistence = 'memory'`，设置卡与 `status` 明示「本次会话内有效，重启后恢复默认」 |

协调器状态（阶段、闩锁、最近结果、自动动作计数）**只存在于内存**：

- 不新建独立数据库——仓库已有 `tokenUsage` / `contextPressure` 投影，另建一份统计会与它们冲突；
- 重启后闩锁与最近结果丢失，会话恢复正常运行；
- **设置**与**已创建的新会话**不受影响；
- 应用退出时不写入半成品状态，也不破坏任何会话。

---

## 13. 浏览器半（设置卡）

- 注册在 `settings.plugin.item` Slot（`key: "dsh-auto-handoff"`），即 Settings → Plugins → configurable 里的一张卡。
- 内容：主设置、高级设置、状态区、操作区、提示区。
  - 状态区：会话累计 Token、阈值进度条、**精确 / 估算 / 不可用**标注、当前阶段、是否在等待 Step、最近一次动作结果与失败记录。
  - 操作区：立即迁移 / 取消 / 重试，走 `POST /dsh-auto-handoff/{handoff,cancel,retry}`。
- 会话切换：由 `apply()` 启动的常驻 follower（`src/client/follow.ts`）负责，**不在卡片里**——卡片只在「设置 → 插件」标签挂载时才存在，而 `/handoff` 是在聊天里敲的。每 2 秒读一次 `ctx.sessions.list.getSnapshot().current` 并轮询 `GET /dsh-auto-handoff/state`；只有 `newSessionId` 出现 `undefined → 有值` 的跃迁、且 `openNewSessionOnHandoff` 为真时才动作，顺序是
  `ctx.sessions.refresh()`（让 Host 重算 `blank`）→ 读 `byId[newId]` → `ctx.sessions.open(id)`。
  基线规则、重试与放弃条件见 §6.5。
- 依赖声明：浏览器半的 `inject` 是 `['slots', 'settingsScope', 'sessions']`，三者缺一即整个 bundle 不挂载。
  原因是 Cordis 的服务代理会对**未在 `inject` 里声明**的服务抛
  `cannot get property "<name>" without inject`——即使提供方已经在同一张图里、服务确实可用
  （三个服务分别由 ui-slots / ui-settings / session controller 这三个兄弟 bundle 提供，
  挂载顺序不由本插件决定）。声明为依赖同时让 Cordis 在三者都激活后才启动 fiber，
  这也正是 `settingsScope.bind()` 需要的：它把 disposer 挂到调用方 fiber 上。
- 降级：宿主没有为本命名空间提供设置项时，卡片显示「设置服务未暴露本命名空间」，表单仍可显示；
  Host 半缺 `webServer` 时卡片显示「状态通道不可用」，表单仍可用。

### 13.1 主题与皮肤

- 所有颜色只走 `--dsw-alias-*` 设计令牌，字面量仅作为老宿主的回退值；**不写** `[data-theme]` 之类的主题分支选择器。
- 根节点带 `data-dsh-plugin="dsh-auto-handoff"` 与 `data-dsh-surface="settings-modal"`；
  字段行带 `data-dsh-part="field"`，控件带 `data-dsh-field="<字段名>"`。

### 13.2 Host 路由契约

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/dsh-auto-handoff/state?sessionId=<id>` | `{ sessionId, phase, phaseLabel, waitingForStep, summarizing, creatingSession, transferring, waitingForCompact, stopRequested, atBoundary, retired, slowWarning, tokens, tokenSource, thresholds, autoHandoffEnabled, autoCompactEnabled, maxAutoActionsPerSession, rearmDeltaTokens, openNewSessionOnHandoff, autoActions, persistence, newSessionId?, lastResult?, progress, failures, warnings }` |
| POST | `/dsh-auto-handoff/handoff` | `{ ok: true, phase, text }` / `{ ok: false, error }` |
| POST | `/dsh-auto-handoff/cancel` | 同上 |
| POST | `/dsh-auto-handoff/retry` | 同上 |

`kind: 'prefix'`，`path: '/dsh-auto-handoff'`；`POST` 只接受 loopback 来源；响应只含标量 JSON，
不含任何 Harness 活体对象。

---

## 14. 构建与测试

```sh
npm install
npm run typecheck   # tsc -p tsconfig.json --noEmit（src + test 全量严格检查）
npm test            # vitest run
npm run build       # 产出 lib/index.js（Host）与 lib/client.js（浏览器半）
npm run build:host  # tsc -p tsconfig.build.json
npm run build:client# tsc -p tsconfig.client.json && node scripts/build-client.mjs
```

### 14.1 浏览器半是怎么构建的

`lib/client.js` 由 `scripts/build-client.mjs` 生成，**不引入任何打包器**：
`tsc -p tsconfig.client.json` 先把 `src/client/*.ts` 编译成 CommonJS，
脚本再把这些模块内联进 `window.__ModuleLoader__.load({ id, factory })` 信封和一个小型惰性注册表
（相对 `require` 走注册表，`react` 之类交给加载器自己的 `require`）。
这正是 `create-dsh-plugin@0.2.3` 的 `panel` 模板采用的形态，好处是浏览器半仍然是**真正的 TypeScript**，
享受严格的类型检查，而产物体积与依赖面都最小。

### 14.2 测试矩阵

| 文件 | 覆盖 |
| --- | --- |
| `test/unit/redaction.test.ts` | UT-RD-01 … 04 |
| `test/unit/token-threshold.test.ts` | UT-TT-01 … 09 |
| `test/unit/settings.test.ts` | UT-SE-01 … 04 |
| `test/unit/session-summary.test.ts` | UT-SU-01 … 05 |
| `test/unit/graceful-stop.test.ts` | UT-SM-01 … 05 |
| `test/unit/coordinator.test.ts` | UT-ST-01 … 03 |
| `test/unit/command.test.ts` | UT-CM-01 … 04（`/handoff status` 渲染） |
| `test/unit/compact-handler.test.ts` | compact 全部边界 |
| `test/unit/follow.test.ts` | 浏览器切换器：基线、跃迁、blank 重试、放弃、错误隔离（§6.5） |
| `test/integration/handoff.test.ts` | IT-01 … IT-14（含 IT-08b/c/d：工作区归属） |
| `test/integration/client-mount.test.ts` | 浏览器半挂载：注入声明、卡片注册、`apply()` 启动 follower |
| `test/integration/plugin-mount.test.ts` | IT-15、IT-16、装载与卸载、`session/disposed` 记录回收 |

当前矩阵共 **12 个测试文件 / 111 个用例**，`npm test` 全绿。

集成测试使用**真实 `@deepseek-ai/cordis`** 构造 Context，并挂上一组可控替身服务；
`plugin-mount.test.ts` 会把真实的插件模块 `apply()` 装进真实 Context，用真实事件总线派发
`agent/pre-step`，并通过真实的 HTTP 路由处理器观察协调器状态。
所有替身 Agent 的 `cancel` 都是 spy，全部测试结束时断言调用次数为 0。

---

## 15. 版本兼容性

- 事实基线：`@deepseek-ai/dsh@0.1.5-rc.3`（全部 `@deepseek-ai/dsh-*` 子包同为 `0.1.5-rc.3`），
  `@deepseek-ai/cordis@4.0.2`，`@deepseek-ai/schemastery@3.18.2`。
- `devDependencies` 精确锁定 `0.1.5-rc.3`，避免用新声明类型检查旧运行时。
- `peerDependencies` 使用**显式预发布分支**写法，例如：

  ```
  >=0.1.5-rc.1 <0.1.6-0 || >=0.1.6-rc.1 <0.1.7-0 || >=0.1.7-rc.1 <0.2.0-0
  ```

  不带预发布分支的范围（如 `>=0.0.1-rc.1 <0.2.0`）会**静默排除** harness 的所有预发布构建，
  让用户在 `npm install` 时撞上 `ERESOLVE`。
- 所有对官方包的 import 都在 `src/**/*.ts` 里，Host 半只对
  `@deepseek-ai/dsh-llm`（`createUserMessage` / `BlockAssembler`）与 `@deepseek-ai/schemastery` 有运行时依赖，
  其余全部是 `import type`——`verbatimModuleSyntax` 保证它们在产物中被完全擦除。

### 15.1 明确不存在、因而没有被伪造的能力

| 设想 | 实际情况 | 本插件的做法 |
| --- | --- | --- |
| 「软停止请求」服务或 `stopRequested` 字段 | 仓库不存在 | 自建闩锁 + `agent/pre-step` reject |
| 静态插件包的通用 Host↔Client 私有 RPC | 只有动态 Cordis 插件有 `harness.handle` | 走 `ctx.webServer` 前缀路由 + `fetch` |
| 会话级累计 Token 独立统计服务 | 没有独立服务，但有 `tokenUsage` 投影 | 复用投影，不新建统计 |
| 可自定义 source 的官方 prompt 端点 | `sessionController.prompt` 固定记 `user-rpc` | 直接用 `agent.followup` + `source: {kind:'plugin'}` |
| `GenerateOptions.purpose` 自定义值 | `0.1.5-rc.3` 是封闭联合 `'compaction' \| 'session-title'` | 摘要调用**不传** `purpose` |
| 从 Host 侧删除已写入旧会话的用户消息 | 日志只追加，删除会破坏事实来源 | 阶段 2 转投新会话并明示；旧日志保留 |

---

## 16. 当前实现的限制与 TODO

| # | 限制 | 原因 | 应对 / 现状 |
| --- | --- | --- | --- |
| L1 | 没有独立的软停止服务 | 仓库不存在该能力 | 用 `agent/pre-step` reject 实现「不启动下一个 Step」 |
| L2 | 被 reject 的 step 中已 claim 的消息不会写入历史 | `dsh-agent` 的明确契约 | 人类提示守卫：含人类输入时绝不 reject |
| L3 | 无法从 Host 侧删除旧会话中的用户消息 | 日志只追加 | 转投新会话 + UI 明示；旧日志保留 |
| L4 | 协调状态不落盘 | 不新建独立数据库 | 内存态 + 本节说明；重启后闩锁与最近结果丢失 |
| L5 | 静态插件包没有通用 Host↔Client RPC | 见 §15.1 | `webServer` 路由 + `fetch`；无 `webServer` 时卡片降级 |
| L6 | `custom` 权限预设无法整体继承 | 没有对应的 preset 名 | 逐项继承审批策略并报告未继承项 |
| L7 | 服务可能在 `apply()` **之后**才发布 | Loader 并发装配同层条目；`sessionController` 自身 inject 了 10 个服务，fiber 长期 `PENDING` | 全部可选服务改为惰性读取（`serviceReader`，见 §6.4）；真正的极简部署仍按需降级 |
| L8 | `GenerateOptions.purpose` 是封闭联合 | `0.1.5-rc.3` 声明 | 不传 `purpose` |
| L9 | 适配器未上报 usage 时 Token 只能估算 | 数据源限制 | UI 与文档明确标注「估算」及判定规则 |
| L10 | 自动 compact 的「继续任务」策略偏离 `PLAN.md` §9.7 | 防止空闲会话被凭空开启 turn 造成循环 | 见 §8.3；README 与设置卡均已说明 |
| L11 | Web 面上 `planMode` / `compaction` 在 agent preset 的 `isolate` realm 内，宿主行不可见 | `dsh-web-app` 禁用了宿主 `plan-mode` / `compaction-basic`，改由各 preset 挂载 | 按 agent 经 `agentPresets.serviceFor(agent, name)` 解析，宿主平面读法作回退（§6.4） |
| L12 | cwd 未注册为工作区时，新会话进入「未分组」 | 不自动 `workspaceRegistry.create()`：那会静默改动用户的侧边栏顺序 | 继承行标记「回退」并写明原因；原会话本身也在同一位置，等价迁移（§6.5） |
| L13 | 简报若未能启动 turn，新会话在侧边栏仍是 `blank`，follower 不会切过去 | 客户端没有任何事件会清 `blank`，只有重新拉列表才会（§6.5 缺陷 B） | follower 每次跳转前 `refresh()`，并在 `blank` 期间最多重试 12 次后静默放弃 |
| L14 | 自动跳转只在浏览器半生效 | 跳转是纯 UI 行为，Host 无权操作已连接的页面 | 未开页面时迁移照常完成，新会话在列表里（前提是 L12 不适用） |

**尚未做（TODO）**

- 协调状态的跨重启恢复（当前有意不做，见 L4）；
- 设置卡的多语言（目前为中文硬编码文案）；
- compact 成功后的「压缩前后 Token 对比」展示；
- 把摘要模型路由做成可配置项（目前固定使用会话当前模型）。

---

## 17. 代码结构

```
src/
├── index.ts               Host 半入口：惰性读取可选服务、装配、订阅、卸载
├── types.ts               阶段、记录、文案表、依赖注入接口
├── redaction.ts           纯函数脱敏
├── settings.ts            命名空间 + schema + 跨字段校验 + 持久化桥
├── token-threshold.ts     累计读取、阈值判定、水位去重、重臂
├── graceful-stop.ts       闩锁、pre-step 判定、边界等待
├── session-summary.ts     输入构造、事实读取、渲染、摘要模型调用
├── session-migration.ts   建会话 + 逐项继承 + 投递 + 结果核验
├── compact-handler.ts     自动压缩：有界重试与「继续任务」边界
├── coordinator.ts         单会话单动作、阶段机、取消/重试/幂等
├── state.ts               进程内状态表
├── command.ts             /handoff 注册与渲染
├── routes.ts              HTTP 状态与操作通道
└── client/
    ├── index.ts           浏览器半入口：常驻 follower + 注册设置卡
    ├── protocol.ts        React-free 的共享契约（命名空间、路由前缀、服务形状）
    ├── follow.ts          常驻切换器：基线/跃迁判定 + refresh→open（§6.5）
    └── card.ts            卡片组件（createElement，无 JSX）
```

---

## 18. 许可

MIT，见 [LICENSE](./LICENSE)。
