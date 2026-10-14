# R1 修复审核结论：会话任务串行化与准确写回

- 审查时间：2026-10-13
- 审查时区：Asia/Shanghai
- 审查对象：当前工作区中 R1 修复后的 `SessionTurnCoordinator`、`BridgeService`、`AccountManager` 及相关测试
- 审查方式：只读源码审查、调用链追踪、静态逻辑与类型边界检查
- 限制：未修改业务实现；未安装或升级依赖；未提交 Git；未运行测试、构建或服务

## 结论摘要

R1 已完成了核心的“按 session 串行化” wiring：`AccountManager` 持有一个
`SessionTurnCoordinator`，默认构造 `BridgeService` 时把同一实例传入；Web
`continueSession` 和微信 `runCodexTurn` 都以 session id 入队。队列实现使用每个
session 的尾 Promise，正常任务成功或失败后都会释放尾节点，后续任务不会因为前一个
任务的业务异常而永久停滞。

但该修复尚未形成完整的会话状态变更合同。`activate/reset/delete` 以及账号移除不经过
同一协调器。特别是：

1. `resetSession` 可以在 Codex turn 运行期间清空 `threadId`，随后运行中的任务仍会按
   启动时捕获的 session 写回新 thread，导致 reset 被覆盖。
2. `deleteSession` 可以在运行期间删除目标 session，运行完成后的 `setSessionThread`
   会抛出“Managed session not found”；Codex 实际已执行但调用方收到失败，且新 thread
   不会被持久化。
3. `removeAccount` 只等待微信 monitor，不等待 Web turn 或协调器队列；删除运行时目录后，
   仍在运行的 Web turn 可能重新写出已删除账号的状态文件。

因此，本次审核**不建议继续 R2**。应先明确并实现运行中 session/account 的
`reset/delete/remove` 策略（拒绝、等待或取消），并增加交错场景测试。若项目明确规定
这些管理操作允许与任务并发，至少需要 generation/version 校验，禁止旧任务覆盖新状态。

## 1. 已确认的正确点

### 1.1 同一 session 的 Web/微信入口使用同一协调器

- `src/server/account-manager.ts:104`：`AccountManager` 创建唯一的
  `private readonly turnCoordinator = new SessionTurnCoordinator()`。
- `src/server/account-manager.ts:157-172`：默认创建 `BridgeService` 时传入
  `turnCoordinator: this.turnCoordinator`。
- `src/server/account-manager.ts:395`：Web `continueSession` 调用
  `this.turnCoordinator.run(session.id, ...)`。
- `src/bridge/service.ts:421-425`：微信 `runCodexTurn` 在存在协调器时调用
  `this.options.turnCoordinator.run(session.id, run)`。

据此，生产路径下同一 `AccountManager` 内、同一 session id 的 Web 与微信任务会排队，
不同 session id 可并行。`BridgeService` 的 `turnCoordinator` 是可选参数，因此绕过
`AccountManager` 直接构造服务的调用方仍可能没有串行化；当前源码中默认生产 wiring
是正确的，但该约束没有在类型层强制。

### 1.2 队列释放逻辑不会被任务业务异常卡住

- `src/bridge/session-turn.ts:7-12`：先保存旧尾节点，再登记当前尾节点。
- `src/bridge/session-turn.ts:14-22`：等待旧尾后执行任务，并在 `finally` 中
  `release()`；只有当前尾仍是自身时才删除 map 项。

任务抛出或拒绝时，`finally` 仍会释放当前节点，后继任务可以继续。当前实现内部创建
的尾 Promise 只由 `release` resolve，不会因业务任务异常而 reject，因此“前一任务失败
导致整条队列拒绝”的问题在该实现中未复现。

### 1.3 Web turn 在真正执行前重新读取目标 session

- `src/server/account-manager.ts:390-396`：入口先校验并保存 `session.id`，入队后
  在任务体内重新 `requireSession(store, session.id)`。
- `src/bridge/service.ts:369-377`：微信入口保存 session id，任务体内重新
  `getSession(session.id)`。

这避免了“入队等待期间切换活动 session 后，把结果写入新的活动 session”的旧式
`setThread(senderId)` 错误。Web 入口本身使用明确的 `accountId + sessionId`，不会因
活动 session 切换而改目标。

## 2. 已确认的问题

### R1-A（P1）：reset 与运行中任务没有协调，reset 可能被旧任务覆盖

证据链：

1. `src/server/account-manager.ts:395-416` 的 Web turn 在任务开始时读取
   `currentSession.threadId`，Codex 完成后无条件调用
   `store.setSessionThread(currentSession.id, threadId)`。
2. `src/server/account-manager.ts:320-322` 的 `resetSession` 直接调用
   `RuntimeStateStore.resetSession`。
3. `src/state/runtime-state.ts:258-264` 的 `resetSession` 只删除 session 的
   `threadId` 并保存，没有检查 responding 状态，也没有进入 turn coordinator。

可确定的时序：

```text
T1 任务读取 threadId = old-thread，并开始 Codex turn
T2 Web 调用 resetSession，threadId 被删除并持久化
T3 T1 完成，setSessionThread(sessionId, new-thread)
T4 reset 的“下一次从无 thread 开始”语义被 T1 的回写覆盖
```

微信路径也有同样结构：`src/bridge/service.ts:375-380` 捕获
`currentSession`，`src/bridge/service.ts:403-405` 完成后按该 session 写回。

这不是队列内部死锁，而是状态变更操作没有与任务串行化。若 reset 的产品语义是
“丢弃当前会话 thread，下一次从新 thread 开始”，当前实现不满足该语义。

建议：

- 最小方案：为 session 增加 turn generation/version；任务入队时记录版本，回写前仅当
  session 仍存在且版本未变才保存 thread。
- 或者：`resetSession` 在目标 session responding/排队时明确拒绝，等待调用方先停止任务。
- 无论采用哪一种，都应保留用户可理解的 HTTP/微信错误，不要把 Codex 已完成的任务
  伪装成普通执行失败。

### R1-B（P1）：delete 与运行中任务没有协调，造成“执行成功但请求失败”

证据链：

- `src/server/account-manager.ts:325-328` 的 `deleteSession` 立即删除 runtime
  session，并清理 responding 计数；不检查协调器是否有排队或执行任务。
- `src/server/account-manager.ts:412-416` 的 Web turn 在 Codex 返回后调用
  `store.setSessionThread(currentSession.id, threadId)`。
- `src/state/runtime-state.ts:315-320` 的 `mutableSession` 在 session 不存在时抛出
  `Managed session not found`。

如果删除发生在 Codex 调用期间，Codex 子任务可能已经产生副作用，但回写阶段必然找
不到 session。Web 请求会以异常结束；微信任务会进入 monitor 的错误处理路径
（`src/weixin/monitor.ts:74-84`），但用户看到的却是“处理失败”，而不是“Codex 已执行，
但会话已删除”。这会造成状态与外部 Codex thread 不一致，也可能诱发重复提交。

建议：

- 删除运行中 session 时采用“拒绝并提示正在响应”或“等待当前 turn 完成后再删除”。
- 若必须允许立即删除，应把任务标记为已取消，回写阶段只允许丢弃结果，并提供明确的
  幂等/可追踪提示；不能让普通 not-found 异常代表取消语义。

### R1-C（P1）：账号移除不等待 Web turn，可能在删除后重新创建状态文件

证据链：

- `src/server/account-manager.ts:214-229` 的 `removeAccount` 调用
  `stopAccount`，随后在非保留模式下 `fs.rmSync(...)` 删除账号状态目录，并从
  `entries` 移除。
- `src/server/account-manager.ts:381-433` 的 Web `continueSession` 不依赖
  `entries` 的生命周期；它已经取得的 `store` 和 runner 仍可继续执行。
- `RuntimeStateStore.setSessionThread` 最终调用 `save()`；`save()` 会通过
  `writeJsonFile` 写回原状态路径。

如果 Web turn 在 `removeAccount` 删除目录后完成，旧 `store` 仍可能执行
`setSessionThread`、`setSessionPromptPreview` 等保存操作，从而重新创建账号状态文件。
这会使“删除账号”不是终态，并留下已删除账号的运行时数据。该问题也影响共享 runner
的生命周期语义，不能仅靠 monitor abort 解决。

建议：

- 账号移除前等待该账号所有 session turn 结束，或给 coordinator 增加按账号取消/封存
  能力。
- 删除后让旧任务的回写显式失效（account generation/token），并在 `RuntimeStateStore`
  层拒绝失效账号写入。
- 增加“Web turn 运行中执行 removeAccount，删除目录后检查目录不会被重建”的回归测试。

## 3. 潜在风险与边界

### R1-D（P2）：协调器 key 只有 sessionId，没有 accountId

`src/bridge/session-turn.ts:4-12` 以 `sessionId` 作为 map key。当前 session id 由
`crypto.randomUUID()` 生成（`src/state/runtime-state.ts:190-196`），跨账号碰撞概率
极低，因此不能把这认定为现实中的跨账号数据串扰。但从隔离契约看，账号维度没有表达在
协调器 API 中；测试、迁移数据或外部注入固定 id 时，两个账号可能被无意义地串行化。

建议将 key 设计为 `accountId + sessionId`，或在 AccountManager 层保证传入命名空间。
这是隔离与可测试性改进，不是当前生产数据下已确认的安全漏洞。

### R1-E（P2）：协调器没有取消、超时或队列上限

`src/bridge/session-turn.ts:6-23` 会无限等待前一任务完成。若 runner、进度回调或
网络发送永久挂起，同一 session 的后续 Web 请求全部保持 pending；队列也没有长度、
deadline 或 caller cancellation。当前项目其他层可能提供 runner timeout，但从本次
审查范围内不能证明该 timeout 覆盖所有 `onProgress`、回复发送和状态写回阶段。

建议先沿用现有 timeout 语义，再为队列补充可观测的 pending count、取消策略和 HTTP
超时响应；避免在 R1 中引入复杂调度框架。

### R1-F（P2）：状态管理 API 不强制经过协调器

`BridgeServiceOptions.turnCoordinator` 在 `src/bridge/service.ts:31` 为可选；当调用方
未传入时，`runCodexTurn` 在 `src/bridge/service.ts:421-425` 直接执行 `run()`。
当前 `AccountManager` 默认 wiring 传入了协调器，但自定义 `bridgeFactory` 或未来新的
入口可能不小心绕过串行化。建议在生产构造边界强制依赖，或至少增加 wiring 测试。

### R1-G（P2）：当前测试只覆盖抽象队列，没有覆盖真实交错场景

现有 `test/session-turn.test.ts:6-31` 只验证：

- 同一 key 的第二个任务等待第一个任务；
- 不同 key 可以并行；
- 第一个任务释放后第二个任务继续。

未见覆盖：

- Web `continueSession` 与微信 `runCodexTurn` 交错；
- 等待期间 `activateSession`；
- 运行期间 `resetSession`、`deleteSession`；
- `removeAccount` 与 Web turn 并发；
- 任务失败后后继任务仍可执行；
- 默认 `AccountManager -> BridgeService` wiring 传入同一协调器。

这些缺口使 R1 的“准确写回”尚未被行为测试证明。

## 4. 安全风险评估

- 未发现由 `SessionTurnCoordinator` 直接引入的任意代码执行、路径穿越或认证绕过。
- R1-A/B/C 的主要影响是状态完整性、任务结果可追踪性和删除语义；在共享本机 Web
  管理接口场景下，攻击者若能触发并发管理操作，可能放大状态混乱，但本审查未证明
  可由远程未授权用户直接利用。
- 跨账号 key 碰撞属于理论隔离风险，随机 UUID 使现实概率极低，不应按已确认跨账号
  数据泄露报告。
- 协调器无限等待属于可用性风险；是否可被外部请求稳定触发，取决于 runner/网络
  deadline，当前未做运行时验证。

## 5. 建议的最小修复顺序

1. 先定义运行中 `reset/delete/removeAccount` 的产品合同：拒绝、等待或取消只能选定一种
   可观察语义。
2. 对 session 和 account 增加 generation/active 标记，在任务完成回写前校验；旧任务
   不得覆盖 reset，也不得在账号删除后重新写文件。
3. 为 Web/微信交错、reset/delete/remove 并发补充测试；保留现有抽象 coordinator 测试。
4. 再考虑把 coordinator key 命名空间化为 `accountId + sessionId`，并补充取消/超时
   可观测性。

## 最终审核结论

**结论：R1 核心串行化 wiring 基本正确，但修复不完整；不建议继续下一项（R2）。**

在 R1-A、R1-B、R1-C 的状态合同明确并有回归测试之前，继续处理文件回传权限会把两个
高风险状态问题留在主干，后续验证成本更高。建议先修复或明确拒绝这些并发管理操作，再
重新提交 R1 审核。

## 6. 复审记录（2026-10-13）

本节针对 R1 修复后的再次提交进行静态复审。此前文档中的结论不删除，以下内容为当前
代码状态的更新判断。

### 6.1 已闭合：session reset/delete 的运行中拒绝

- `src/bridge/session-turn.ts:6-8` 新增 `isActive(sessionId)`，队列中存在当前执行或
  排队任务时返回 `true`。
- `src/server/account-manager.ts:322-335` 的 `resetSession` 和 `deleteSession` 在
  修改 runtime state 前检查该值，并返回明确的“Session is responding”错误。
- `test/account-manager.test.ts:320-337` 覆盖任务执行期间 reset/delete 被拒绝，以及
  任务完成后 reset 正常清除 thread。

这使此前 R1-A、R1-B 的主要时序不再成立：管理操作不能在任务持有队列尾节点时清空或
删除目标 session。当前证据足以将这两项标记为**已修复（静态通过）**。仍建议在 HTTP
层补充错误状态码/前端提示的行为测试，但这不是本次状态回写缺陷。

### 6.2 部分闭合但仍存在：账号移除的等待窗口

当前 `removeAccount` 已改为：

1. `stopAccount`，等待微信 monitor 结束；
2. 取得账号 store 的 session 列表；
3. 调用 `turnCoordinator.waitForSessions(...)`；
4. 删除账号文件和状态目录。

对应位置：`src/server/account-manager.ts:217-234`；测试
`test/account-manager.test.ts:339-353` 覆盖已有 Web turn 完成后再删除目录。

但 `waitForSessions` 只对调用瞬间的尾节点做快照：

- `src/bridge/session-turn.ts:29-34` 读取 `tails.get(sessionId)`，等待这些 Promise；
- `src/server/account-manager.ts:217-221` 在等待期间没有把账号标记为 removing，也没有
  阻止新的 `continueSession`；
- `src/server/account-manager.ts:389-405` 的 Web 入口仍可通过 `storeFor(accountId)`
  获取旧 store，并在 `removeAccount` 完成前再次调用 `turnCoordinator.run(...)`。

因此存在以下可确认的竞态：

```text
T1 removeAccount 完成 stopAccount，读取当前 session 列表
T2 waitForSessions 看到当前没有 tail（或只看到旧 tail）
T3 并发 Web 请求进入 continueSession，加入新 tail
T4 T1 的 waitForSessions 返回，删除账号状态目录并移除 entries
T5 T3 继续执行并调用 store.save()，可能重新创建已删除账号的状态文件
```

即使 T2 已看到旧 tail，新 Web 请求也可以在 T2 快照之后排队，仍不受等待保护。
新增测试只验证“已有任务先入队”，尚未验证“removeAccount 等待期间新请求被拒绝或等待”。

这保留了原 R1-C 的核心风险，因此标记为**未闭合（P1）**。

建议：

- 在 `removeAccount` 开始时设置 account-level removing/closing 状态，令
  `continueSession`、创建/修改 session 等入口立即拒绝；待已有 coordinator tails 完成后
  再删除目录。
- 或把账号生命周期状态纳入 coordinator，提供原子性的“关闭新任务 + 等待已入队任务”
  操作；仅重复调用 `waitForSessions` 不能消除 admission race。
- 增加测试：挂起一个移除操作，在 `waitForSessions` 期间发起新的
  `continueSession`，断言请求被拒绝且删除完成后状态文件不会被重建。

### 6.3 复审后的剩余潜在风险

- `SessionTurnCoordinator` 仍以 `sessionId` 而非 `accountId + sessionId` 为 key
  （`src/bridge/session-turn.ts:4-16`）。随机 UUID 使现实碰撞概率极低，仍属于隔离
  设计改进而非已确认漏洞。
- `BridgeServiceOptions.turnCoordinator` 仍为可选（`src/bridge/service.ts:31`），
  未来绕过 `AccountManager` 的构造路径可能失去串行化；当前默认生产 wiring 已确认
  传入同一实例。
- `waitForSessions` 没有超时/取消；若某 turn 永不结束，账号移除会一直等待。现有审查
  未运行时验证 runner 的所有 deadline 覆盖范围，因此保留为可用性风险。

## 7. 复审结论

**结论：部分通过，但 R1 仍不建议进入 R2。**

session 级 reset/delete 拒绝已静态闭合，已有测试覆盖对应基本路径；账号移除仍缺少
关闭新任务入口的原子步骤，R1-C 的目录重建风险尚未排除。请先补充 account-level
removing 状态或等价的“拒绝新任务并等待旧任务”机制及竞态测试，再重新审核。
