# R3/R9 第二轮修复审核结论：中断、fallback 与 runner 生命周期

- 审查时间：2026-10-14 00:01（Asia/Shanghai）
- 审查对象：当前工作区 R3/R9 修复后的账号 runner 隔离、停止/重启生命周期、中断与 timeout 分类
- 审查方式：只读源码审查、调用链追踪、静态逻辑与安全风险评估
- 审查范围：`src/server/account-manager.ts`、`src/codex/runner.ts`、`src/codex/app-server-runner.ts`、`src/codex/exec-runner.ts`、`src/bridge/service.ts`、`src/bridge/session-turn.ts`，以及 `test/account-manager.test.ts`、`test/codex-app-server.test.ts`、`test/codex-exec.test.ts`
- 限制：未修改业务源码；未安装或升级依赖；未提交 Git；本次未运行测试、构建、服务或真实微信/Codex 调用。因此“通过”仅指静态审查通过，不代表运行验证通过。

## 结论摘要

本轮确认以下修复已经落地：

1. 生产路径中 `AccountManager` 为每个账号创建并缓存独立的 `HybridCodexRunner`；一个账号的 app-server transport 失败不会直接清空其他账号 runner 的等待队列。
2. `stopAll()`、`restartRunning()`、`stopAccount()` 会在账号停止阶段关闭对应 runner；`closeRunners()` 还会关闭 utility runner。
3. app-server 的 `turn/completed` 状态 `interrupted` 会转换为 `CodexTurnInterruptedError`，`turn/start` 失败会转换为 `CodexTurnStartedError`，这两类错误不会进入 auto fallback。
4. `CodexExecRunner.stop()` 与 app-server `stop()` 在没有 `threadId` 时都直接 no-op，不再由 exec 随意选择全局最近任务。

但 R3/R9 仍**不能清空**。本轮仍确认或保留以下问题：

- **P1：停服/重启关闭 runner 的顺序不安全。** `stopAccount()` 先等待 monitor task 完成，再关闭 runner；而 monitor 可能正在等待一个不可取消的 Codex turn，导致 stop/restart/shutdown 长时间阻塞，runner 无法及时释放。
- **P2：timeout 故障域已从“跨账号”缩小为“同账号”。** 每账号 runner 已隔离，但同一账号的多个 session 仍共享一个 app-server transport；一个 session 的 timeout 会通过 `failTransport()` 拒绝该账号 runner 上所有 pending request/turn waiter。
- **P2：首轮新会话无法通过 `/stop` 定位。** `BridgeService` 只把持久化 `stateStore.getThread(senderId)` 传给 runner；首轮 turn 在完成前尚无 threadId，因此 `/stop` 对 app-server 和 exec 都是 no-op。WeChat monitor 又按消息顺序等待当前处理结束，命令不能抢占当前 turn。
- **P2：turn 已提交后的未知 transport 失败仍可能 fallback。** `HybridCodexRunner` 对 app-server 异常主要依靠类型和错误文本正则；子进程在 `turn/start` 成功后异常退出时，错误文本未必匹配禁止 fallback 的正则，仍可能重新执行 exec。此项是潜在重复副作用风险，尚未由静态代码证明一定发生。
- **P3：exec/app-server 进程清理仍未等待进程树收敛。** `child.kill()` 后没有等待 `close`、进程树结束或 Windows 后代进程退出。

因此，本轮结论为：**账号隔离和 no-thread stop 修复通过；R3/R9 整体部分通过，仍不可标记完成。**

## 1. 已确认的修复

### 1.1 账号 runner 已按账号隔离

`src/server/account-manager.ts:107` 声明 `accountRunners: Map<string, HybridCodexRunner>`。
`runnerForAccount()`（约 `573-579`）按 `accountId` 查找或创建 runner，并在
`startAccount()`（约 `166-176`）把该 runner 注入对应 `BridgeService`。

因此，默认 `runnerFactory` 每次创建的新 `HybridCodexRunner` 与账号 key 绑定：

- `account-one` 的 app-server/exec 子进程属于 `account-one` runner；
- `account-two` 的 timeout 或 `close()` 不会调用 `account-one` runner 的
  `failTransport()`。

这修复了上一轮“所有账号共享单一 runner”的已确认故障域问题。需要注意：
`test/account-manager.test.ts` 的 fixture 用 `runnerFactory: () => runner` 返回同一个
测试 double，不能证明实例隔离；实例隔离结论来自生产默认 factory 与 map 实现，而非该测试。

### 1.2 stopAll/restartRunning/stopAccount 的 runner 清理路径

- `stopAll()`（约 `131-135`）停止运行中的账号后调用 `closeRunners()`。
- `restartRunning()`（约 `138-145`）先停止原运行账号，再关闭所有 runner，最后重新启动这些账号。
- `stopAccount()`（约 `210-221`）在等待 monitor 与 session turn 后调用
  `closeAccountRunner(accountId)`。
- `closeRunners()`（约 `592-597`）关闭所有账号 runner 和 utility runner，并清空 map。

如果当前没有正在执行的 turn，这些路径能释放 app-server transport 与 exec 子进程，
并避免下次启动复用已关闭的 runner。`HybridCodexRunner.close()` 同时关闭 app-server
和 exec backend。

### 1.3 app-server 中断与 turn-started 分类

`src/codex/app-server-runner.ts:513-524` 将 `completion.status === "interrupted"`
转换为 `CodexTurnInterruptedError`；其他非 completed 状态转换为普通错误。
`run()` 中 `turn/start` 请求（约 `156-167`）的异常被包装为
`CodexTurnStartedError`。

`src/codex/runner.ts:42-51、90-97` 对这两个专用错误明确禁止 fallback，并对旧错误
文本保留 timeout/interrupted/status 的兼容正则。这意味着已明确判定为用户中断或
turn/start 失败的 app-server 路径不会自动重跑 exec。

### 1.4 exec 无 threadId 时不再误停全局最近任务

`src/codex/exec-runner.ts:136-140` 先检查 `!threadId` 并直接返回；有 threadId 时
才按 `activeRuns` 中相同 thread 查找。app-server 的 `stop()`（约 `249-258`）同样
要求非空 threadId 和活动 turn。`HybridCodexRunner.stop()` 并行调用两个 backend，
因此 no-thread 语义现在一致：**不停止任何任务**。

## 2. 已确认的问题

### R3/R9-A（P1）：stopAccount 等待当前消息完成后才关闭 runner

`src/server/account-manager.ts:210-221` 的顺序是：

1. `entry.controller.abort()`；
2. `await entry.task`；
3. `waitForSessions(...)`；
4. `closeAccountRunner(accountId)`。

`src/weixin/monitor.ts:67-88` 在处理一条消息时会 `await options.onMessage(normalized)`。
`BridgeService.runCodexTurn()` 又会等待 `runner.run()` 和回复/附件发送完成。因此，如果
当前微信消息正处于 Codex turn，abort monitor signal 不会取消已经执行的
`runner.run()`；`entry.task` 只有在该 turn 返回或失败后才能完成。

结果是，停止账号、配置触发的 `restartRunning()` 和进程 shutdown 都可能在
`closeAccountRunner()` 前等待一个长时间或无期限的 Codex turn。该问题是代码顺序
直接确定的，不需要假设 Codex 一定卡住；是否实际卡住取决于后端响应和 timeout。

**建议**：在等待 `entry.task` 之前先对该账号 runner 发出关闭/取消信号，并让关闭操作
等待子进程终止；同时保留 session coordinator 的 drain 作为正常完成路径。需要明确
关闭后如何把正在处理的 turn 归类为 interrupted，避免 monitor 把停服当作普通失败。

### R3/R9-B（P2）：timeout 仍会影响同账号的其他 session

账号 runner 已隔离跨账号故障，但 `AppServerCodexRunner` 内部仍使用共享 map：

- `pending` 保存该 app-server 的所有 JSON-RPC 请求；
- `turnWaiters` 保存该 app-server 的所有 turn；
- `failTransport()`（约 `574-607`）会拒绝全部 pending/waiter 并清空活动状态。

`SessionTurnCoordinator` 只按 `sessionId` 串行（`src/bridge/session-turn.ts:8-35`），
不同 session 可以同时运行。因此，同一账号的两个 Web session 并发时，一个 session
的 request/turn timeout 仍会取消同账号另一个 session 的等待任务。此项的影响范围
已由上一轮的“跨账号”缩小为“账号内共享 transport”，但仍是可用性风险。

**建议**：短期记录 timeout 影响的 thread/session，并在产品语义上明确“账号级 app-server
故障”；中期按 session 隔离 transport，或实现单 turn 可取消而不清空整个 runner。

### R3-B（P2）：首轮无 threadId 的 stop 是可达的 no-op

`src/bridge/service.ts:113-125` 的 `/stop` 只读取
`stateStore.getThread(message.senderId)`。首轮任务尚未返回 threadId 并写入
`setSessionThread()`（`runCodexTurn()` 约 `318-326`），所以 stop 调用得到
`undefined`。两个 backend 均按上一节的 no-thread 规则直接返回。

同时，`monitorWeixin()` 对同一账号按批次逐条 `await onMessage`，因此来自微信的
`/stop` 消息也不能在当前 turn 完成前被处理。该行为使“停止当前任务”只对已经有
持久化 threadId 且命令能够被调度到的场景有效。

**建议**：为正在运行的 session 保存本地 task/turn token，stop 通过该 token 取消；
至少要在无目标时返回结构化 `no-active-turn`，而不是发送看似成功的“Stop signal sent.”。

## 3. 潜在风险

### R3-C（P2）：turn 已提交后的 transport 失败仍可能触发 fallback

`src/codex/runner.ts:42-57、90-97` 对 app-server 异常统一 catch。明确的
`CodexTurnInterruptedError`、`CodexTurnStartedError` 和匹配正则的 timeout/status
错误不 fallback；但 `AppServerCodexRunner.handleChildFailure()` 在 turn 已开始后
生成的错误可能类似 `Codex app-server exited with code ...`，该文本不一定匹配
`isSafeToFallback()` 的拒绝条件。

如果此时 Codex 已接受 turn 但 transport 丢失，auto backend 可能执行 `codex exec`
重新提交同一 prompt。是否产生重复文件修改、命令执行或附件发送，取决于实际
Codex 时序和 prompt 副作用，本次静态审查不能确认已发生，因此标记为潜在风险而非
确定漏洞。

**建议**：让 app-server runner 返回“turn 尚未提交/已提交但结果未知”的结构化阶段，
只允许前者自动 fallback；后者默认向上报告并要求显式重试。

### R3-D（P3）：child.kill 未等待进程树终止

`src/codex/app-server-runner.ts:586-588`、`src/codex/exec-runner.ts:89-107、141-151`
直接调用 `child.kill()`，没有等待 `close`，也没有 Windows 进程树终止或后代进程
检查。当前代码能在正常 close 事件中从 `activeRuns` 移除 exec 任务，但不能静态证明
Codex CLI 不会留下后代进程，因此这是资源和跨平台兼容性风险。

## 4. 测试覆盖与验证缺口

已有测试/fixture 静态覆盖：

- `test/codex-app-server.test.ts:101-119` 覆盖 app-server interrupt 的
  threadId/turnId；
- `test/codex-app-server.test.ts:121-138` 覆盖启动失败 fallback；
- `test/codex-exec.test.ts:174-190` 覆盖 exec stop fixture；
- `test/account-manager.test.ts:95-121` 覆盖多个账号启停，但 runner factory 返回
  同一个 double，未断言每账号获得不同 runner。

尚未覆盖：

- 一个账号的 monitor 正在执行长 turn 时调用 `stopAccount()`、`stopAll()` 或
  `restartRunning()`，以及 runner 是否先被取消；
- 两个账号/两个 session 并发时 timeout 的故障域；
- 首轮无 threadId 时 `/stop` 的 no-op 语义；
- turn 已开始后 app-server 子进程退出是否禁止 fallback；
- child.kill 后 close、重复 error/exit、Windows 进程树收敛。

本轮未运行 `npm test`、`npm run typecheck`、`npm run build` 或真实服务。

## 5. 安全风险评估

本轮未发现新的直接权限绕过、远程代码执行或跨账号数据读取漏洞。主要安全/
可用性影响为：

- transport 失败后的潜在重复 Codex 执行，可能重复产生文件或命令副作用；
- 关闭流程被卡住时，旧 runner/子进程可能继续占用资源，形成本机可用性风险；
- stop 语义在首轮任务中无效，但当前实现不会误停另一个有 threadId 的任务。

## 6. 是否可清空 R3

**不可清空。**

可标记为“已通过”的子项：

- 跨账号 `HybridCodexRunner` 隔离；
- `stopAll/restartRunning` 的 runner map 清理路径；
- app-server interrupted/turn-started 不 fallback；
- exec 与 app-server 的 no-thread stop 一致性。

仍需先处理或明确验收的 R3/R9 子项：

1. 停服/重启应先取消或关闭 runner，再等待 monitor/session drain，避免长 turn 阻塞关闭；
2. 决定并测试同账号多个 session 的 timeout 隔离策略；
3. 为首轮任务提供可取消 task token，或明确 `/stop` 只能停止已有 thread；
4. 将 turn 已提交后的 transport 失败从 auto fallback 中排除；
5. 增加进程关闭与子进程树收敛测试。

在以上问题未有实现和审核结论前，不建议把维护清单第 3 项标记为完成。
