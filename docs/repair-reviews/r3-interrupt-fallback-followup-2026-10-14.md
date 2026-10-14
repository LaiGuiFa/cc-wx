# R3/R9 后续改动复审结论：账号协调、停止生命周期与首轮 thread 持久化

- 审查时间：2026-10-14 00:20（Asia/Shanghai）
- 审查对象：R3/R9 后续改动
- 审查方式：只读源码审查、调用链追踪、静态并发与安全风险评估
- 审查范围：`src/server/account-manager.ts`、`src/bridge/service.ts`、`src/bridge/session-turn.ts`、`src/codex/runner.ts`、`src/codex/app-server-runner.ts`、`src/codex/exec-runner.ts`，以及相关测试
- 限制：未修改业务源码；未安装或升级依赖；未提交 Git；本次未运行测试、构建、服务或真实微信/Codex 调用。结论仅代表静态审查结果。

## 结论

当前生产调用链已经把微信和 Web turn 接入同一个账号级
`SessionTurnCoordinator`，并且两条入口的锁顺序一致：先获取 session 锁，再获取
account 锁。按当前代码未发现上一轮所担心的 session/account 锁顺序反转死锁。

`stopAccount()` 即使没有 `RuntimeEntry` 也会关闭缓存中的账号 runner；对已运行的
monitor，它先关闭 runner，再 abort monitor，并等待 account/session coordinator 的尾节点。
这种顺序可以让正在等待 Codex 的 turn 先得到拒绝并释放协调器。

但 R3/R9 仍不能清空。当前仍存在一个已确认的停服/fallback 交互问题，以及一个
生命周期 admission race：

1. 在 `auto` backend 的 app-server turn 运行中调用 `stopAccount()` 时，
   `runner.close()` 产生的普通 `"Codex app-server runner closed"` 错误仍可能被
   `HybridCodexRunner` 当作可 fallback 的错误，继而启动新的 `codex exec`。
   `CodexExecRunner.close()` 没有 closed 状态，因而关闭之后仍允许新的 `run()`。
2. `stopAccount()` 不会把账号标记为 stopping；并发 Web `continueSession()` 仍可在
   首次关闭 runner 后获准进入，重新创建 runner，随后被 stopAccount 最后的关闭操作
   打断或与重启交错。

这些问题属于已确认的代码行为；实际是否造成重复 Codex 副作用或用户可见停服延迟，
还需运行场景验证。

## 1. 已确认的正确点

### 1.1 微信与 Web 都经过账号级协调器

`AccountManager.startAccount()` 将 `accountId` 与同一个
`accountTurnCoordinator` 注入 `BridgeService`（`src/server/account-manager.ts:172-182`）。

微信入口的 `BridgeService.runCodexTurn()` 在当前实现中构造：

```text
turnCoordinator.run(sessionId,
  () => accountTurnCoordinator.run(accountId, run))
```

见 `src/bridge/service.ts:431-446`。

Web 入口 `AccountManager.continueSession()` 使用相同顺序：

```text
turnCoordinator.run(sessionId,
  () => accountTurnCoordinator.run(accountId, run))
```

见 `src/server/account-manager.ts:485-488`。

因此，在生产路径中：

- 同一 session 的微信/Web turn 共享 session 串行化；
- 同一账号的不同 session 共享 account 串行化；
- 不同账号使用不同的 account key，可以并行。

这也意味着当前没有 session-first/account-second 与 account-first/session-second
的锁顺序反转。此前审核中关于该反转死锁的结论不适用于当前工作区版本。

需要保留一个维护性边界：`SessionTurnCoordinator` 本身只以传入字符串作 key，
`turnCoordinator` 是全局实例，而 session key 没有显式拼接 `accountId`。如果不同
账号的 session ID 发生碰撞，会造成不必要的跨账号串行；当前 session ID 的生成方式
和碰撞前提未在本轮运行验证。

### 1.2 stopAccount 无 entry 时仍会关闭账号 runner

`src/server/account-manager.ts:215-227` 在读取可选 `entry` 后立即调用
`closeAccountRunner(account.accountId)`，而不是只在 `entry` 存在时关闭。因此：

- 只有 Web 请求创建的 runner（没有 monitor entry）也会被关闭；
- 有 entry 的 runner 在等待 monitor/session 后还会再次关闭，形成幂等式清理；
- `stopAll()`/`restartRunning()` 之后的 `closeRunners()` 仍会清理 utility runner。

这覆盖了“无 entry 不清理 runner”的遗漏路径。

### 1.3 当前 stop() boolean 语义一致

`HybridCodexRunner.stop()`（`src/codex/runner.ts:65-71`）并行调用 app-server 和
exec，并以逻辑或返回结果。

- app-server 在未连接、无 threadId 或没有活动 turn 时返回 `false`；
- exec 在无 threadId 或找不到匹配活动进程时返回 `false`；
- 找到目标并发出 `turn/interrupt` 或执行 `child.kill()` 时返回 `true`。

`BridgeService` 根据该 boolean 返回“Stop signal sent.” 或“No active Codex task was
found.”（`src/bridge/service.ts:122-125`）。当前 no-thread 不会再让 exec 随意选择
全局最近进程。

这表示 boolean 表示“至少一个 backend 接受了停止动作”，不表示 Codex turn 已经完成
并确认进入 interrupted 状态。当前没有把这个区别展示给调用方，属于语义边界而非
直接错误。

### 1.4 app-server 首轮 thread 在 turn/start 前持久化

`AppServerCodexRunner.run()` 在 `thread/start` 或 `thread/resume` 返回后取得
`threadId`，先调用 `input.onThreadId(threadId)`，再发送 `turn/start`
（`src/codex/app-server-runner.ts:140-169`）。

生产的 Web 与微信调用都传入回调：

- Web：`src/server/account-manager.ts:450-456`；
- 微信：`src/bridge/service.ts:394-400`。

回调调用 `setSessionThread()`，因此首轮 app-server turn 在等待最终结果时已经有
持久化 threadId。后续 `/stop`、历史查询或进程中断至少可以知道该 thread。

## 2. 已确认问题

### R3-A（P1）：stopAccount 关闭 runner 可能触发 auto fallback

调用链如下：

1. `stopAccount()` 先执行 `closeAccountRunner()`（`account-manager.ts:215-221`）。
2. `HybridCodexRunner.close()` 同步调用 `appServer.close()` 与 `exec.close()`
   （`runner.ts:85-88`）。
3. `AppServerCodexRunner.close()` 通过 `failTransport(new Error("Codex app-server runner closed"), true)`
   拒绝活动 turn waiter（`app-server-runner.ts:267-270、603-627`）。
4. `HybridCodexRunner.run()` 捕获该普通 `Error`，`isSafeToFallback()` 只排除
   interrupted、turn-started、timeout/status 等错误；`"runner closed"` 不匹配
   （`runner.ts:47-62、91-99`）。
5. 在 `auto` backend 下，代码因此调用 `this.exec.run(...)`。
6. `CodexExecRunner.close()` 只杀掉当前活动进程、没有设置 closed 标志
   （`exec-runner.ts:149-153`），所以该后续 `run()` 仍可启动新的 exec 子进程。

这条行为链不依赖真实 Codex 响应即可从代码确定。后果是，停止账号时可能发生：

- app-server turn 已被关闭，随后同一 prompt 被新的 exec 再次提交；
- `stopAccount()` 等待 monitor/task 的时间被新 exec 延长；
- 文件修改、命令执行或附件动作可能重复。

实际是否触发取决于账号使用 `auto` backend 且关闭时恰有 app-server turn 在途；
重复副作用需要运行场景确认，但 fallback 启动本身是已确认的控制流风险。

**建议**：关闭/停服错误应使用专用不可 fallback 类型或稳定错误码；同时让
`HybridCodexRunner` 在 close 后拒绝新 run，或在关闭阶段显式禁止 fallback。

### R3-B（P2）：stopAccount 期间仍可接纳新的 Web turn

`continueSession()` 仅检查 `closingAccounts`（`account-manager.ts:431-433`），
而该集合只由 `removeAccount()` 设置；`stopAccount()` 和 `restartRunning()` 不会设置
stopping 门禁。

因此存在如下静态可达时序：

1. `stopAccount()` 关闭现有 runner 并开始等待；
2. 并发 Web 请求通过 `continueSession()` 的入口检查；
3. 请求进入 account coordinator；若原尾节点已释放或尚未被等待捕获，
   `runnerForAccount()` 会创建新的 `HybridCodexRunner`；
4. `stopAccount()` 后续的 `closeAccountRunner()` 或 `restartRunning()` 的
   `startAccount()` 与该新 turn 交错。

这不是“无 entry runner 没有清理”；恰恰相反，首次关闭已执行，但缺少停止期间的
admission gate 使新工作能够重新创建 runner。影响是新 Web turn 可能被意外关闭、
报错，或在重启边界使用不一致的配置。需要并发测试确认具体时序表现。

**建议**：为 stop/restart 设置账号级 stopping 状态，拒绝新的 Web/微信 turn；
待 runner 和 coordinator drain 完成后再清除状态并允许 start。

## 3. 潜在风险和兼容性边界

### 3.1 exec backend/fallback 不调用 onThreadId

`CodexRunnerInput` 声明了 `onThreadId`（`app-server-runner.ts:33-42`），但
`CodexExecRunner` 的输入类型和实现没有该回调。`HybridCodexRunner` 在纯 exec 路径
（`runner.ts:42-46`）和 fallback 路径（`runner.ts:53-57`）都直接调用 exec，
不会在读取到 `thread.started` 时通知调用方。

因此：

- app-server 首轮 thread 可以在 turn/start 前持久化；
- 纯 exec 首轮只能等整个进程结束后，从 `CodexRunResult.threadId` 在上层写回；
- exec 首轮执行中 `/stop` 没有 threadId，stop 会返回 `false`；
- fallback 若在 app-server 已创建 thread 后才发生，exec 输入仍可能没有原 threadId，
  会创建新的 exec thread。

这些是代码确定的接口差异；是否满足产品对 exec 首轮中断的预期，以及 fallback
导致的重复副作用，需通过真实/fixture 场景验证。

### 3.2 onThreadId 回调异常的 fallback 边界

`AppServerCodexRunner.run()` 对 `onThreadId` 的 await 位于 `turn/start` 的 try/catch
之外（`app-server-runner.ts:154-168`）。若持久化回调抛错，异常不会被包装成
`CodexTurnStartedError`，`HybridCodexRunner` 可能把它当作普通可 fallback 错误。

在 `thread/start` 已经成功而本地写回失败时，这可能留下远端 thread，并再执行一个
新的 exec turn。该路径依赖本地持久化失败，当前未运行验证，标记为潜在风险。

### 3.3 stop boolean 的失败语义仍未完全结构化

`Hybrid.stop()` 使用 `Promise.all`。如果一个 backend 的 interrupt request 失败，
整个 `stop()` 会 reject，即使另一个 backend 已经返回 `true`。调用方收到的是异常，
而不是 `{ stopped: true, error: ... }` 一类结构化结果。当前代码没有测试该组合场景。

这属于可运维性/用户反馈风险，不足以单独认定为安全漏洞。

### 3.4 进程关闭仍未等待进程树收敛

app-server 与 exec 仍以 `child.kill()` 为主，没有等待 `close` 或 Windows 子进程树
终止。该风险在前一轮已记录，本轮未发现新的收敛机制。

## 4. 测试与未验证项

当前静态测试文件包含：

- `test/session-turn.test.ts`：单 coordinator 的同 session 串行、不同 session 并行；
- `test/codex-app-server.test.ts`：app-server lifecycle、interrupt、auto fallback；
- `test/codex-exec.test.ts`：exec stop fixture；
- `test/account-manager.test.ts`：Web session 生命周期与账号移除。

本轮未发现针对以下关键契约的测试：

- 微信 BridgeService 与 Web AccountManager 同账号并发时的统一锁顺序；
- `stopAccount()` 关闭 runner 后 auto fallback 不启动新 exec；
- stopAccount 无 entry 且有 Web turn 的并发 admission；
- `Hybrid.stop()` 一个 backend reject、另一个 backend true/false 的返回语义；
- app-server `onThreadId` 回调在 turn/start 前写回的断言；
- 纯 exec/fallback 首轮 thread 在执行中是否可持久化并可停止。

本轮未运行测试、类型检查、构建或真实 Codex/微信调用。

## 5. 安全风险评估

本轮未发现新的直接权限绕过或远程代码执行漏洞。需要优先处理的安全/可靠性影响：

- 停服期间自动 fallback 可能重复执行 Codex prompt，带来重复文件修改、命令或附件
  副作用；
- stop/restart 期间新 Web turn 被接纳并重新创建 runner，可能造成任务边界和配置边界
  混淆；
- exec 首轮没有及时 threadId，停止命令无法定位当前进程。

上述影响均需要相应并发/fixture 测试补强；未把未验证的运行结果写成确定事实。

## 6. 是否可清空 R3

**不可清空。**

已通过的子项：

- 微信/Web 生产入口都使用账号级 coordinator；
- 两条入口锁顺序一致，当前未见锁反转死锁；
- `stopAccount()` 对无 entry 的缓存 runner 也执行关闭；
- stop() 的 no-thread boolean 语义一致；
- app-server 首轮 thread 在 turn/start 前通过回调写回。

仍需先处理或明确验收：

1. 关闭 runner 时禁止 auto fallback，并让 close 后的 exec runner 不再接受新 run；
2. stop/restart 期间增加账号级 stopping/admission gate；
3. 明确 exec/fallback 的 `onThreadId` 契约和首轮 stop 语义；
4. 补充 stop boolean 失败组合、关闭顺序和并发场景测试。

## 7. 00:33 补丁复审

- 复审时间：2026-10-14 00:33（Asia/Shanghai）
- 复审对象：`HybridCodexRunner.closed`、`run()` 关闭门禁及 fallback 错误分类补丁

### 7.1 已确认通过

`src/codex/runner.ts:29-45` 新增 `closed` 状态，并在 `run()` 入口先拒绝
`"Codex runner is closed"`。`close()`（约 `89-94`）具有幂等保护，先设置状态再
关闭 app-server 和 exec backend。

`isSafeToFallback()`（约 `97-105`）新增 `runner closed` 匹配。因而在
`stopAccount()` 先关闭 runner、再等待 monitor/turn 的时序中：

1. 已在 app-server 等待中的 turn 会收到 runner closed 错误；
2. 该错误不会再进入 `codex exec` fallback；
3. close 后新到达的 `run()` 会在入口直接拒绝，不会重新启动 exec；
4. 已关闭 runner 的后续重复 `close()` 不会重复执行 backend 清理。

这闭合了上一节记录的“关闭期间 fallback 重跑 prompt”主路径。该结论来自当前
控制流静态检查；没有运行 fixture 或真实 Codex 进程验证。

### 7.2 仍确认的问题

#### R3-A（P2）：stop/restart 期间仍可接纳新的 Web turn

`src/server/account-manager.ts:215-227` 仍没有账号级 stopping/admission 标记。
`continueSession()` 只检查 `closingAccounts`（约 `431-433`），而
`stopAccount()` 不会加入该集合。因此并发时序仍然可达：

1. `stopAccount()` 关闭旧 runner；
2. 新的 Web `continueSession()` 通过入口检查；
3. `runnerForAccount()` 因 map 已删除而创建新 runner；
4. stopAccount 后续的等待/第二次 close 与新 turn 交错。

这不会再因为 `HybridCodexRunner.closed` 在同一个实例上启动 fallback，但仍可能让
新 turn 在停服或重启边界被新 runner 接受后立即关闭、失败或使用边界配置。是否
具体表现为用户可见错误需并发测试确认。R3 仍不能清空。

#### R3-B（P3）：底层 CodexExecRunner.close() 本身没有 closed 门禁

`src/codex/exec-runner.ts:149-153` 仍只杀掉 `activeRuns`，没有设置 closed 状态；
直接持有 `CodexExecRunner` 引用的调用方在 `close()` 后仍可调用 `run()`。当前生产
路径通过 `HybridCodexRunner.closed` 保护，因此这不是当前停服 fallback 主路径的
复现缺陷，而是底层 runner API 的生命周期契约缺口。

### 7.3 潜在风险与未验证项

- `onThreadId` 回调异常仍发生在 `turn/start` 包装之外
  (`src/codex/app-server-runner.ts:154-168`)；若本地 thread 写回失败，Hybrid
  仍可能把普通回调错误视为可 fallback。该路径依赖持久化异常，未运行验证。
- `Hybrid.stop()` 的 `Promise.all` 组合失败语义未改变；一个 backend reject 时不会
  返回另一个 backend 已成功停止的 boolean。
- child.kill 后仍未等待进程树收敛；本补丁未涉及该资源生命周期问题。
- 本轮未运行测试、类型检查、构建、服务或真实 Codex/微信调用。

### 7.4 补丁复审结论

**`HybridCodexRunner.closed` 补丁静态通过，上一节“close 后自动 fallback”问题可
标记为已修复；R3/R9 整体仍不可清空。**

清单应保留：

1. stop/restart 账号级 admission gate；
2. exec/fallback 的 `onThreadId` 契约和首轮 stop 语义；
3. stop boolean 失败组合与关闭竞态测试；
4. 底层 exec runner 关闭契约及进程树清理。

## 8. 最终复核

- 复核时间：2026-10-14 00:35（Asia/Shanghai）
- 复核对象：`stoppingAccounts` admission 补丁，以及此前 `HybridCodexRunner.closed`
  / fallback 防护补丁
- 复核方式：重新读取当前工作区源码并追踪停止、启动、Web、微信和 Codex 调用链

### 8.1 停服期间 fallback 主路径已闭合

当前 `HybridCodexRunner` 在 `run()` 入口检查 `closed`（
`src/codex/runner.ts:43-46`），`close()` 先设置该状态并幂等关闭两个 backend
（`89-94`），`isSafeToFallback()` 也排除 `runner closed` 错误（`97-105`）。

因此，`stopAccount()` 先关闭现有 runner 时：

1. 正在等待 app-server 的 turn 收到 runner closed 错误；
2. 该错误不会进入 exec fallback；
3. 在关闭之后才开始的同一 runner `run()` 会直接拒绝；
4. `CodexExecRunner.close()` 即使本身没有 closed 状态，也不会被生产中的
   `HybridCodexRunner.run()` 绕过。

这说明上一节记录的“由 stopAccount 直接触发的 close 后自动 fallback”主路径已经
静态闭合。它尚未通过运行测试或真实 Codex 调用验证。

### 8.2 Web admission race 已修复

`AccountManager` 新增 `stoppingAccounts`（`src/server/account-manager.ts:100-101`）。
`stopAccount()` 在进入关闭流程后立即加入账号 key，并在 `finally` 删除
（`216-234`）。`continueSession()` 在读入状态前检查该集合并拒绝新的 Web turn
（`430-442`）。

因此，之前“stopAccount 已关闭 runner，但新的 Web continueSession 仍能创建新
runner”的时序，在当前源码中不再成立。该补丁也覆盖了 stopAccount 异常退出时的
标记清理。

### 8.3 仍确认的问题：startAccount 没有 stopping admission

`startAccount()` 只调用 `ensureAccountOpen()`（`src/server/account-manager.ts:159-161`），
而 `ensureAccountOpen()` 仅检查 `closingAccounts`（`565-569`），没有检查
`stoppingAccounts`。因此仍可构造以下并发时序：

1. `stopAccount(accountId)` 加入 `stoppingAccounts`、关闭旧 runner，并开始等待；
2. 并发 `startAccount(accountId)` 通过 `ensureAccountOpen()`；
3. `startAccount()` 创建新的 `RuntimeEntry` 和新的账号 runner；
4. 原 `stopAccount()` 继续执行最后的 `closeAccountRunner(accountId)`，关闭刚创建的
   新 runner。

这会让新 entry 的 monitor 持有一个已关闭 runner，且新账号刚启动就可能收到
`Codex runner is closed`。如果同时发生于 `restartRunning()`、手动启动接口或凭据
刷新，具体用户表现需并发运行验证，但 admission 缺口是当前代码可直接确认的。

### 8.4 仍有潜在风险：fallback 判断存在窄 TOCTOU 窗口

`HybridCodexRunner.run()` 在 app-server 抛出错误后先调用
`isSafeToFallback(error)`，再调用 `exec.run()`（`src/codex/runner.ts:51-61`）。
如果先发生一个不含 timeout/interrupted/runner-closed 的可 fallback 错误，随后另一个
线程调用 `close()`，最后才执行 `exec.run()`，当前代码不会再次检查 `this.closed`；
底层 `CodexExecRunner` 也没有 closed 门禁（`src/codex/exec-runner.ts:149-153`）。

这是一个依赖精确时序的潜在停服竞态。直接由 `close()` 产生的错误已经被阻断，但
“其他 app-server 错误与 close 交错”仍可能启动 fallback。建议在 fallback 前再次
检查 closed，或让 exec runner 自身具备不可重启的关闭状态。

### 8.5 其他复核结论

- 微信和 Web turn 仍使用一致的 `session -> account` 协调顺序；未发现锁反转死锁。
- 微信入口没有直接检查 `stoppingAccounts`；但已运行 monitor 会收到 abort，且其
  已持有的 service 使用的是已关闭 runner，因此不会重新创建账号 runner。批次中已
  拉取但尚未处理的消息仍可能执行命令/回复逻辑，属于待验证的停止边界。
- `stop()` boolean 仍表示至少一个 backend 接受停止动作，不表示 turn 已完成；
  `Promise.all` 的一个 backend reject 仍会让整体 stop reject。
- app-server 首轮 thread 仍在 `turn/start` 前通过 `onThreadId` 写回；exec/fallback
  路径仍没有同等的执行中 thread 回调。

### 8.6 最终结论

**R3/R9 仍不可清空。**

本轮可以确认关闭 fallback 主路径和 Web admission race 已修复；仍需处理：

1. `startAccount()` 在 `stoppingAccounts` 期间的并发启动竞态；
2. fallback 前的 closed 二次检查或底层 exec closed 门禁；
3. 微信已拉取批次在停服边界的行为；
4. stop boolean 组合失败和进程树清理测试。

本轮未运行测试、类型检查、构建、服务或真实 Codex/微信调用。

## 12. 当前工作区最终状态（2026-10-14 00:46 +08:00）

本节以当前工作区源码为准，覆盖本文件中较早生成且可能被并发写入打乱顺序的
第 9/10 节旧结论。

- `stoppingAccounts` 当前是 `Map<string, number>`，`stopAccount()` 使用按账号计数
  的进入/退出逻辑；并发重复停止不会由先完成的调用提前释放门禁。
- `ensureAccountOpen()`、`startAccount()`、`refreshAccount()` 和
  `continueSession()` 都会在账号停止期间拒绝新的生命周期或 Web turn 进入。
- `HybridCodexRunner.closed`、fallback 前二次关闭检查，以及
  `CodexExecRunner` 的 closed/run 门禁已通过静态复核。
- 当前未发现新的已确认业务缺陷；仍保留微信已拉取批次边界、exec 首轮 thread/stop
  契约、`stop()` 组合错误语义和进程树收敛等潜在风险或未验证项。

因此，R3/R9 的已确认主路径问题已闭合；是否将其从维护清单移除仍取决于后续测试
和真实 Codex/微信流程验证。本审查未运行测试、构建或真实服务。

## 11. 终审结论：并发停止计数补丁

- 复核时间：2026-10-14 00:42（Asia/Shanghai）
- 复核对象：`stoppingAccounts` 从 Set 改为按账号引用计数 Map 的补丁
- 复核方式：只读源码复核、并发时序推演和 runner 生命周期检查

### 11.1 并发 stopAccount 门禁已闭合

`stoppingAccounts` 当前为 `Map<string, number>`（
`src/server/account-manager.ts:100-101`）。`stopAccount()` 进入时将对应账号计数
加一（`216-219`），在 `finally` 中减一；只有剩余计数为零时才删除 map 项
（`232-238`）。

因此，两个或更多相同账号的 `stopAccount()` 并发执行时，较早完成的调用不会提前
释放停止门禁；`startAccount()`、`refreshAccount()`、会话写入口仍会被
`ensureAccountOpen()` 拒绝，直到最后一个停止调用完成。此前第 10 节记录的 Set
计数竞态已由当前补丁修复。

### 11.2 当前未发现 R3 范围内的已确认业务缺陷

结合本轮和前述源码复核，以下控制流已静态成立：

- 账号级 runner 隔离；
- 微信/Web 使用一致的 `session -> account` 协调顺序；
- 单次及并发停止期间的 admission gate；
- stopAccount 无 entry 时也会关闭账号 runner；
- app-server interrupted/turn-started 不自动 fallback；
- runner close 后 Hybrid 与底层 exec 都拒绝新执行；
- fallback 前的 closed 二次检查与底层 exec 门禁；
- app-server 首轮 thread 在 `turn/start` 前通过 `onThreadId` 写回；
- no-thread `stop()` 不会选择其他活动 exec 任务。

本轮没有发现新的可由当前源码直接确认的 R3 业务缺陷。此前关于“close 后 fallback”
和“重复 stop 提前释放门禁”的结论应以本节最新状态为准。

### 11.3 仍属潜在风险或未验证项

- 微信 monitor 已拉取批次在停止边界的命令/回复行为尚未运行验证；
- exec/fallback 首轮没有执行中 `onThreadId` 回调，执行中的 `/stop` 仍受 thread
  可见性限制；
- `Hybrid.stop()` 的一个 backend reject、另一个 backend 成功时的结构化结果未测试；
- `child.kill()` 未等待进程树完全收敛；
- app-server 非 timeout 普通错误的 fallback 是否会产生重复副作用，仍需专门
  transport 断开时序测试；
- 本轮及前轮均未运行测试、类型检查、构建、服务或真实 Codex/微信调用。

### 11.4 是否可清空 R3

**静态代码层面：R3 的已确认问题已清空。**

**维护清单层面：建议先保留为“待运行验证”，不要把未执行的测试写成已验证通过。**
完成 R3 的最后证据仍应包括中断不 fallback、关闭期间不启动 exec、并发 stop
门禁、微信/Web 入口协调和 transport 断开场景测试。

## 9. 历史复核：stopping gate 完整性（已由第 11 节更新）

- 复核时间：2026-10-14 00:39（Asia/Shanghai）
- 复核对象：`ensureAccountOpen()` 纳入 `stoppingAccounts` 后的最终工作区状态
- 复核方式：重新读取 `AccountManager` 全部生命周期入口，并复核 runner/fallback 关闭边界

### 9.1 已确认通过

当前 `ensureAccountOpen()` 同时检查 `closingAccounts` 和
`stoppingAccounts`（`src/server/account-manager.ts:565-572`）。因此以下入口在
账号停止期间都会拒绝新操作：

- `startAccount()`（约 `159-161`）；
- `refreshAccount()`（约 `149-156`，并且重新启动仍经过 `startAccount()`）；
- 重命名、会话创建/激活/重置/删除、发送者授权变更等调用
  `ensureAccountOpen()` 的入口；
- `continueSession()`（约 `430-442`）显式检查停止状态。

`stopAccount()` 在 `try/finally` 中加入并清理 `stoppingAccounts`
（`216-234`），所以正常完成和异常退出都会释放单次停止门禁。此前记录的
“停止期间新 Web turn 或新 startAccount 创建 runner”的单次调用时序已闭合。

直接由 `closeAccountRunner()` 触发的 fallback 主路径也仍已闭合：`HybridCodexRunner`
在入口拒绝 closed runner，且 `isSafeToFallback()` 排除 runner closed 错误
（`src/codex/runner.ts:43-66、89-105`）。

### 9.2 历史问题：并发 stopAccount 的共享 Set 计数不足（已修复）

本节反映 Map 引用计数补丁之前的状态。当时 `stoppingAccounts` 是 `Set<string>`，
而不是每账号的 in-flight stop promise 或引用计数。
如果同一账号同时进入两次 `stopAccount()`：

1. 第一个调用加入账号 key；
2. 第二个调用再次加入同一个 key；
3. 第一个调用先完成，在 `finally` 删除 key；
4. 第二个调用仍在等待 monitor/coordinator 或执行最后清理，但新的
   `startAccount()` 已可通过 `ensureAccountOpen()`，并可能创建 runner；
5. 第二个 `stopAccount()` 的最后 `closeAccountRunner()` 可能再关闭该新 runner。

该历史生命周期竞态已由第 11 节的 Map 引用计数补丁修复；当前状态以第 11 节为准。

### 9.3 潜在风险与未验证项

- `HybridCodexRunner.run()` 在 app-server 返回可 fallback 的普通错误后，到执行
  `exec.run()` 之间仍没有再次检查 `closed`（`runner.ts:51-61`）。若此窗口内发生
  `close()`，理论上仍可启动 fallback；这是窄 TOCTOU 潜在风险。
- 微信 monitor 在停止时会收到 abort，但已拉取批次的后续消息仍可能进入
  `BridgeService.handleMessage()`；service 没有直接读取 `stoppingAccounts`。其持有的
  runner 已关闭，因此不会新建账号 runner，但命令/回复等边界行为尚未通过运行验证。
- `CodexExecRunner.close()` 仍无独立 closed 门禁；生产入口由 Hybrid 门禁覆盖，直接
  使用底层类的生命周期契约仍未统一。
- `stop()` 的 boolean 仍不是完成确认，且 `Promise.all` 的单 backend 失败组合未覆盖。
- 未运行测试、类型检查、构建、服务或真实 Codex/微信调用。

### 9.4 终审结论

**R3/R9 仍不可清空。**

账号停止期间的单次 admission gate 已通过；仍需最小处理或明确接受：

1. 并发 `stopAccount()` 的 per-account in-flight/引用计数门禁；
2. fallback 前对 `closed` 的二次检查（或底层 exec closed 状态）；
3. 微信已拉取批次和 stop boolean 组合的测试；
4. 进程树关闭收敛验证。

## 10. 最终补丁复核：fallback 与底层 exec 生命周期

- 复核时间：2026-10-14 00:40（Asia/Shanghai）
- 复核对象：`HybridCodexRunner` fallback 前二次关闭检查，以及
  `CodexExecRunner` 的 closed/run 门禁
- 复核方式：只读源码复核、同步调用顺序分析和生命周期边界追踪

### 10.1 已确认通过

`HybridCodexRunner.run()` 在 app-server 异常被判定为可 fallback 后，先再次检查
`this.closed`（`src/codex/runner.ts:51-60`）；`CodexExecRunner.run()` 自身也在
同步函数入口检查 `closed`，closed 时返回拒绝的 Promise
（`src/codex/exec-runner.ts:75-84`）。在第二次检查与 `exec.run()` 调用之间没有
异步等待，因此当前 Node 单线程调用路径不会让 `close()` 插入该关键区间。

`CodexExecRunner.close()` 现在具备幂等 closed 状态（约 `153-159`），会先标记
closed，再杀掉活动子进程。结合 Hybrid 的 runner 入口门禁，以下路径均已静态闭合：

- stopAccount 关闭 runner 后，已在途的 app-server turn 不会启动 exec fallback；
- close 后新到达的 Hybrid run 不会创建 exec 子进程；
- fallback 判定后、exec 启动前的窄关闭窗口不会绕过底层 exec 门禁。

因此，前几节记录的“停服直接 fallback”以及“fallback 前 closed TOCTOU”不再是
当前代码中的待修复问题。仍未运行 fixture 或真实 Codex 进程验证。

### 10.2 历史结论：重复 stopAccount 的 Set 计数竞态（已由第 11 节覆盖）

本节记录的是 Map 引用计数补丁之前的历史状态。当时 `stoppingAccounts` 是
`Set<string>`，`stopAccount()` 每次调用都
`add()`，并在各自 `finally` 中直接 `delete()`（
`src/server/account-manager.ts:216-234`）。两个相同账号的 stop 请求并发时，
第一个请求结束即可删除标记，即使第二个请求仍在等待 monitor/coordinator。此时新的
`startAccount()` 可以通过 `ensureAccountOpen()`，随后第二个 stop 的最终
`closeAccountRunner()` 可能关闭新建 runner。

该历史竞态已由第 11 节的 per-account 引用计数修复。当前状态请以第 11 节为准。

### 10.3 其他潜在风险与未验证项

- 微信 monitor 已拉取批次在 stop 边界仍可能继续调用 service；service 不直接读取
  `stoppingAccounts`。其 runner 已关闭，不会重新创建 Codex runner，但命令/回复
  的停止边界未运行验证。
- `onThreadId` 仅 app-server 路径提供；exec/fallback 首轮执行中仍不能及时持久化
  thread，因而无法稳定支持执行中的 `/stop`。
- `stop()` boolean 仍只表示 backend 接受停止动作；`Promise.all` 的一侧失败组合
  没有结构化结果测试。
- `child.kill()` 仍未等待进程树完全收敛。

### 10.4 最终结论

**历史结论，已由第 11 节更新。当前状态请以第 11 节的最终复核为准。**

清单最后应保留：

1. 为重复 `stopAccount()` 增加 per-account in-flight/引用计数门禁；
2. 补微信停止边界、stop boolean 组合和进程树清理测试；
3. 明确 exec 首轮 `onThreadId`/`/stop` 契约。

本轮未运行测试、类型检查、构建、服务或真实 Codex/微信调用。
