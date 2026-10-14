# R3 当前缺口审计：exec 首轮停止、微信批次边界与关闭收敛

- 审查时间：2026-10-14 00:49（Asia/Shanghai）
- 审查对象：当前工作区 R3/R9 相关实现及已有复审记录
- 审查方式：只读源码审查、调用链追踪、静态时序推演；未修改业务源码
- 约束：未安装或升级依赖，未运行测试、构建、服务或真实 Codex/微信调用，未执行 Git 写操作

## 结论摘要

当前工作区已经静态闭合上一轮最主要的两条停服竞态：

- `HybridCodexRunner` 在关闭后拒绝新执行，且 app-server 关闭错误不会直接触发 fallback；
- `AccountManager.stopAccount()` 使用按账号计数的 `stoppingAccounts`，停止期间拒绝新的 Web turn 和生命周期写入口。

本次没有发现新的、能够直接证明为“停服后自动启动 exec”或“单次/并发 stop 门禁提前释放”的业务缺陷。

但仍有以下当前代码可直接确认的缺口，足以保留 R3 的运行验证清单：

1. **exec 首轮 turn 没有执行中 thread 回调，导致首轮 `/stop` 无法定位活动进程。**
2. **微信 monitor 在收到 abort 后仍会继续处理已经拉取的同一批次消息。**
3. **仓库内已有 exec stop 测试与当前 no-thread stop 契约不一致，静态上无法按预期中断 fixture。**

另有两类应标记为潜在风险而非已证实故障：`Hybrid.stop()` 的 `Promise.all` 失败组合语义，以及 `child.kill()` 后没有等待整个进程树收敛。

## 1. 当前已确认的正确点

### 1.1 关闭与 fallback 主路径已闭合

`HybridCodexRunner.run()` 在入口检查 `closed`，app-server 失败后在调用 exec 前再次检查
`closed`（`src/codex/runner.ts:43-64`）。`CodexExecRunner.run()` 也在自身入口拒绝已关闭实例
（`src/codex/exec-runner.ts:75-84`），`close()` 先设置状态再杀活动子进程
（`src/codex/exec-runner.ts:153-159`）。

因此，`stopAccount()` 先关闭旧 runner 时，当前静态调用链不会因为该关闭动作启动新的 exec fallback；
fallback 前的窄同步区间也有底层 exec 门禁保护。该结论仍未通过运行 fixture 或真实进程验证。

### 1.2 账号停止 admission 使用引用计数

`stopAccount()` 进入时递增 `stoppingAccounts`，退出时仅在计数归零后删除
（`src/server/account-manager.ts:216-238`）。`continueSession()` 和 `ensureAccountOpen()` 在停止期间拒绝新请求
（`src/server/account-manager.ts:442-447、565-577`）。

因此，当前代码未再出现上一轮 Set 版本中“并发 stop 的先完成调用提前释放停止门禁”的静态路径。

## 2. 已确认问题

### R3-C（P2）：exec 首轮 thread 不可用于执行中 `/stop`

#### 证据链

1. `CodexExecRunner.run()` 只把调用方传入的 `input.threadId` 写入 `activeRuns`
   （`src/codex/exec-runner.ts:99-100`）。新 exec turn 没有传入 threadId 时，该字段保持 `undefined`。
2. `parseCodexExecOutput()` 虽然能够在进程输出中解析 `thread.started` 的 `thread_id`
   （`src/codex/exec-runner.ts:244-273`），但该值只在子进程结束后作为 `CodexRunResult.threadId` 返回；
   exec 输入类型没有 `onThreadId` 回调。
3. `BridgeService` 的 `/stop` 命令从持久化 session 读取 threadId，再传给 `runner.stop()`
   （`src/bridge/service.ts:122-124`）。当前首轮 exec 运行期间 session 仍没有 threadId，
   因而会调用 `runner.stop(undefined)`。
4. `CodexExecRunner.stop()` 对缺少 threadId 直接返回 `false`
   （`src/codex/exec-runner.ts:140-150`）；`AppServerCodexRunner.stop()` 也明确拒绝无 threadId
   （`src/codex/app-server-runner.ts:251-260`）。

#### 判断

这是当前接口和生产调用链可直接推出的确定行为，不依赖真实 Codex 响应：纯 exec backend 或 auto fallback
新建首轮任务执行期间，用户发送 `/stop` 时无法通过 session thread 定位该活动 exec 子进程。

这不等同于“所有 exec 任务都无法停止”：已有 thread 的 `exec resume` 任务可以按传入 threadId 匹配；
账号停止时的 `runner.close()` 仍会杀掉活动 child。缺口只针对“执行中但 thread 尚未持久化”的首轮 `/stop`。

#### 影响与最小建议

- 影响：用户看到“没有活动任务”或等价结果，而首轮 exec child 继续运行；若任务有文件/命令副作用，停止边界不符合用户预期。
- 最小建议：给 exec runner 增加与 app-server 一致的 `onThreadId` 通知；或明确产品契约为“首轮 exec 只能通过账号 stop/关闭终止”，并在 UI/微信命令层展示该限制。
- 验证建议：fixture 在输出 `thread.started` 后保持运行；在 thread 持久化前发送 `/stop`，断言 child 结束且 session 已记录 threadId。

### R3-D（P2）：微信已拉取批次在停止边界仍会继续交给 service

#### 证据链

1. `monitorWeixin()` 每次 poll 获取一个 `messages` 批次后，进入 `for (const raw of messages)`；循环体内没有再次检查 `options.signal.aborted`
   （`src/weixin/monitor.ts:42-61`）。
2. `stopAccount()` 的顺序是先 `closeAccountRunner()`，再 `controller.abort()`，然后等待 monitor task
   （`src/server/account-manager.ts:220-225`）。
3. 因此如果 abort 发生在同一批次的第一个消息处理期间，后续消息仍会被 normalize、claim，并调用
   `BridgeService.handleMessage()`；service 没有读取 `stoppingAccounts`。
4. 普通消息最终会调用已关闭 runner 的 `run()` 并失败；命令消息（例如 `/stop`、`/status`、`/new`）仍可能执行回复或状态逻辑。

#### 判断

“abort 后继续处理已拉取批次”是由当前循环结构直接确认的停止边界行为。尚不能仅凭静态代码断言它一定造成重复 Codex 副作用：
runner 已在 stopAccount 开头关闭，新的 Codex run 会被拒绝；但用户可见的错误回复、命令回复和批次顺序行为是可达的。

#### 影响与最小建议

- 影响：停服/重启期间可能继续消耗已 claim 的消息，并发送“任务失败”或命令响应；`claimMessage` 已写入的消息也可能不再重试。
- 最小建议：在 monitor 每个消息迭代开始处检查 `signal.aborted` 并停止后续批次处理；若要保留已开始消息，至少在 `BridgeService` 入口增加停止状态拒绝并避免发送误导性回复。
- 验证建议：构造包含两个消息的 batch，在第一个 `onMessage` 阻塞时 abort，断言第二个消息是否被处理、是否发送错误回复、是否已被 claim。

## 3. 已确认的测试/契约不一致

### R3-E（P2）：exec stop fixture 调用 no-thread stop，但当前实现必返回 false

`test/codex-exec.test.ts:178-188` 启动 `fake-codex-exec-hold.mjs`，等待 100ms 后调用
`await runner.stop()`，随后断言 `run` 以非零退出错误拒绝。当前 `CodexExecRunner.stop()` 在无 threadId 时
第一行即 `return false`（`src/codex/exec-runner.ts:140-142`），而 fixture 的 `thread.started` 输出只会在
进程结束时由 `parseCodexExecOutput()` 转为结果，不能反向更新 `activeRuns`。

因此，按静态控制流，这个测试没有真正向 hold child 发送 kill；run 会继续到 timeout（或被测试框架清理），其错误类型/消息也不保证匹配
`/exited with code/i`。本次没有运行测试，所以不把“CI 已失败”写成事实；这里确认的是测试调用与当前 API 契约存在直接矛盾。

最小处理方向二选一：

- 若产品要求首轮可停：补 `onThreadId`/活动 thread 注册，并让测试等待该回调后按 threadId stop；
- 若产品明确 no-thread 不停止：修改测试契约，断言 `stop()` 返回 `false`，再由 close/abort 场景覆盖资源清理。

## 4. 潜在风险与未验证项

### 4.1 `Hybrid.stop()` 的 `Promise.all` 失败组合

`HybridCodexRunner.stop()` 并行等待 app-server 和 exec（`src/codex/runner.ts:72-78`）。如果一侧
`appServer.stop()` 因 transport 断开或 `turn/interrupt` 请求失败而 reject，整体 promise 会 reject，即使另一侧已返回
`true` 或已成功发出 kill。当前调用方 `BridgeService.handleCommand()` 没有专门把“部分成功”转成结构化结果
（`src/bridge/service.ts:122-125`）。

这是可由代码确定的错误传播语义，但“真实场景一定存在另一侧同时活动且一侧失败”的发生频率和用户影响尚未验证，
应标记为 P3 运维/反馈风险，不作为已确认安全漏洞。

### 4.2 `child.kill()` 后没有等待进程树收敛

app-server transport 失败和 exec runner close/stop 都直接调用 `child.kill()`，未等待 child 的 `close`/`exit`，也未对
Codex CLI 可能创建的子进程树做平台相关的 group/tree termination（`src/codex/app-server-runner.ts:603-610`；
`src/codex/exec-runner.ts:107-110、145-157`）。

可以确认当前代码只发出 direct child kill 请求，不能确认后代进程一定泄漏；是否在实际 Codex CLI、Windows 和 macOS/Linux
环境下留下孤儿进程，需要运行 fixture/平台验证。建议记录为 P2-P3 资源生命周期风险，而不是已确认资源泄漏。

### 4.3 历史快照：app-server `onThreadId` 持久化回调异常的 fallback 边界

本节记录的是 01:22 改动前的历史状态。当前 `AppServerCodexRunner.run()` 已将
`onThreadId` 回调异常包装为 `CodexTurnStartedError`（见第 7.1.3 节），该历史风险不再代表当前源码。

## 5. 优先级建议（历史快照，已由第 7 节更新）

1. **P1：先补运行验证矩阵。** 覆盖首轮 exec stop、stopAccount 期间 Web/微信并发、abort 后剩余 batch、关闭期间 fallback、transport 断开。
2. **P2：明确 exec 首轮停止契约。** 首选补 `onThreadId`，使 exec/fallback 与 app-server 的 session/thread 可见性一致；若不做，必须显式记录产品限制。
3. **P2：定义微信停止边界。** monitor 在每个 batch item 前检查 abort，并决定已 claim 消息是丢弃、延后还是发送明确的“账号正在停止”响应。
4. **P2：修正 exec stop 测试契约。** 测试必须与选择的 no-thread 语义一致，否则无法作为回归保护。
5. **P3：结构化 stop 结果与进程树收敛。** 评估 `Promise.allSettled`/结果对象和平台相关的 child-process tree cleanup，避免把未验证的资源问题升级为确定缺陷。

## 6. 当前工作区修复更新（2026-10-14 01:18 +08:00）

以下内容以当前源码为准，覆盖本审查前文形成的旧测试/契约结论：

- `CodexExecRunner` 现在解析运行中的 `thread.started` 行，更新活动 run 的
  `threadId`，并通过 `onThreadId` 回调向上层暴露；首轮 exec 可以在执行中按 thread
  定位停止。
- `test/codex-exec.test.ts` 已改为等待首轮 thread 回调后调用 `stop(threadId)`，不再
  使用与当前 no-thread stop 契约冲突的无参停止调用。
- `HybridCodexRunner.stop()` 已使用 `Promise.allSettled` 汇总双后端停止结果：任一后端
  成功即返回 `true`，两侧均未停止且有异常时才抛出异常。
- app-server 的 `onThreadId` 持久化回调异常已包装为 `CodexTurnStartedError`，不会再被
  auto backend 当作普通 transport 错误触发 fallback。

上述改动均已完成 Node TypeScript 语法自查；本次仍未运行依赖测试、构建、真实 Codex
或微信服务。`child.kill()` 后的进程树收敛和微信已拉取批次停止边界仍属于运行验证项。

## 6. 审查结论

**静态代码层面：R3 的关闭 fallback、账号停止 admission 和并发 stop 计数修复均保持成立。**

**当前仍有已确认的接口/停止边界缺口（R3-C、R3-D）及一个已确认的测试契约不一致（R3-E）。**

因此，R3 不宜在维护清单中标记为“运行验证通过”；更准确的状态是：

> **主路径问题已静态闭合；exec 首轮停止、微信已拉取批次和测试契约仍待最小改动与运行验证。**

## 7. 最新改动合并复审

- 审查时间：2026-10-14 01:22（Asia/Shanghai）
- 审查对象：`src/weixin/monitor.ts` 的 batch abort 检查及对应测试、`src/codex/exec-runner.ts` 的首轮
  `onThreadId`、`src/codex/runner.ts` 的 `stop()` 聚合、`src/codex/app-server-runner.ts` 的回调错误分类
- 审查方式：只读源码复核、调用链追踪、静态异常与并发时序分析
- 限制：本轮未运行测试、类型检查、构建、服务或真实 Codex/微信调用，未修改业务源码

### 7.1 已确认闭合的问题

#### 7.1.1 微信 batch abort 检查已生效

`monitorWeixin()` 在每个 batch item 开始前检查 `options.signal?.aborted`，一旦停止即
`break`（`src/weixin/monitor.ts:61-64`）。新增测试在第一个 `onMessage` 中调用
`controller.abort()`，并断言第二条消息不会被处理（`test/weixin-monitor.test.ts:120-146`）。

这条改动静态闭合了上一节 R3-D 中“abort 后继续把同一批次后续消息交给 service”的原始路径。
仍需实际运行测试确认 fixture 与真实 API 行为一致。

#### 7.1.2 exec 首轮 thread 已能在执行中写回

`BuildCodexExecArgsInput` 增加 `onThreadId`（`src/codex/exec-runner.ts:7-17`）。
exec runner 按 stdout 行解析 `thread.started`，先把 thread id 写入 `activeRun.threadId`，
再调用回调（`src/codex/exec-runner.ts:115-136`）。新增测试等待回调取得
`thread-hold`，随后按该 thread 调用 `runner.stop(threadId)`，并断言 run 被 interrupted
（`test/codex-exec.test.ts:178-197`）。

因此，之前“首轮 exec 没有执行中 thread，`/stop` 必然传 undefined”的主路径已静态闭合。
`HybridCodexRunner` 通过展开 `input` 将回调传给 exec fallback，因此 fallback 新建 thread
也具备同样的通知路径（`src/codex/runner.ts:60-64`）。

#### 7.1.3 app-server 回调异常已被归类为 turn-started 错误

`AppServerCodexRunner.run()` 将 `onThreadId` await 包在 `try/catch` 内，并包装为
`CodexTurnStartedError`（`src/codex/app-server-runner.ts:154-159`）。`HybridCodexRunner`
对该错误禁止 fallback（`src/codex/runner.ts:104-109`）。

这闭合了“thread/start 成功但本地 thread 写回失败后又提交一个 exec fallback”的主路径。
本轮未验证持久化故障下的用户可见错误和恢复体验。

#### 7.1.4 `Hybrid.stop()` 已保留部分成功结果

`HybridCodexRunner.stop()` 使用 `Promise.allSettled()`，只要任一 backend fulfilled 为
`true` 即返回 `true`；只有没有成功停止且存在 rejected 结果时才抛出错误
（`src/codex/runner.ts:72-81`）。

这比原来的 `Promise.all()` 更符合“一个 backend 已接受停止、另一侧 transport 失败”的
停止语义。当前仍没有覆盖该组合的自动化测试。

### 7.2 仍确认的问题

#### R3-F（P1/P2）：exec `onThreadId` 同步异常可能逃逸 runner

exec stdout 事件中调用方式为：

```ts
void Promise.resolve(input.onThreadId(event.thread_id)).catch(...)
```

（`src/codex/exec-runner.ts:129-135`）。如果 `onThreadId` 回调同步抛出异常，
异常会在调用 `Promise.resolve()` 之前直接从 stdout `data` 事件处理器逃逸；`.catch()`
无法捕获。app-server 路径使用 `await` 加 `try/catch`，没有同样的同步抛错窗口。

这是当前代码可直接确认的异常处理缺陷，尚无对应测试。最小修复方向是先把回调放入
`Promise.resolve().then(() => input.onThreadId!(...))`，或使用显式 `try/catch`。

#### R3-G（P2，潜在风险）：exec 回调失败与 child `close` 存在异步竞态

exec 回调以 fire-and-forget 方式执行；`callbackFailure` 只有在回调 Promise reject
后才写入（`src/codex/exec-runner.ts:130-135`），而 `close` 事件可能先运行并在
`callbackFailure` 仍为空时解析 run（`src/codex/exec-runner.ts:148-166`）。
此后回调失败不会再改变已 settled 的 run Promise。

因此，持久化 thread 的异步回调理论上可能在 run 已成功返回后才失败，调用方看不到失败，且
session thread 可能没有成功写回。该结论依赖“回调延迟失败、child 快速退出”的精确时序，
当前只应标为潜在风险，不能写成已确认的生产故障。

### 7.3 潜在风险和未验证项

#### 7.3.1 batch abort 后的 sync key 持久化语义

`monitorWeixin()` 在处理消息前就把响应中的新 sync key 写入 `onSyncKey`
（`src/weixin/monitor.ts:45-49`）。如果一个 batch 含多条消息，第一条处理时触发 abort，
后续消息会被新检查跳过，但新 sync key 已经持久化（`src/server/account-manager.ts:189-195`）。

这是否会导致被跳过消息永久丢失，取决于微信 `getupdates` 的 cursor 语义：若返回的 sync key
代表整个 batch 已确认，则行为正确；若需要逐条确认，则可能丢消息。当前源码和现有测试没有
证明哪一种语义，暂列为待验证风险，不能写成确定缺陷。

#### 7.3.2 exec thread 事件必须以完整换行到达

exec 回调解析器只在 stdout 累积出换行后处理事件；进程结束时没有把剩余
`stdoutLineBuffer` 再解析一次（`src/codex/exec-runner.ts:115-141`）。如果 CLI 输出最后一条
`thread.started` 没有换行，执行中回调不会触发，首轮 stop 仍只能依赖 close。当前 Codex JSONL
输出通常带换行，但本项目没有对该格式作显式契约校验或测试。

#### 7.3.3 `stop()` 部分成功语义仍缺组合测试

`allSettled` 已处理“一个 backend 成功、另一个 reject”的主要传播问题，但尚无测试覆盖：

- app-server reject + exec `true`；
- app-server `true` + exec reject；
- 两侧都 reject 时抛出的错误选择；
- 两侧都 fulfilled 且均为 `false` 时返回 `false`。

这些属于测试覆盖和运维反馈风险，当前没有新的确定性业务缺陷。

#### 7.3.4 子进程树收敛仍未验证

`child.kill()` 的直接调用未改变（`src/codex/app-server-runner.ts:603-610`；
`src/codex/exec-runner.ts:108-110、176-189`），仍没有等待 `close` 或执行平台相关的
进程树终止。该问题仍只能标记为资源生命周期风险，不能据静态代码断言后代进程一定泄漏。

### 7.4 最新结论

- 原 R3-D 微信批次继续处理问题：**静态已修复，新增测试覆盖了 abort between messages。**
- 原 R3-C exec 首轮 thread 不可停止问题：**主路径静态已修复，新增 fixture 测试覆盖 thread 回调后 stop。**
- app-server `onThreadId` 回调触发 fallback：**静态已修复，已归类为 `CodexTurnStartedError`。**
- `Hybrid.stop()` 部分成功：**静态语义已改善，但组合测试未补齐。**
- 新增需优先处理的 exec 回调问题：**同步回调异常可逃逸（R3-F）；异步回调失败与 close 存在竞态（R3-G）。**

因此，R3 当前更准确的状态是：

> **主要停止路径已静态闭合；R3-F/R3-G 仍需最小异常处理修复或明确验收，sync key、换行边界、
> stop 组合语义和进程树仍待运行验证。**

## 7. 最新源码覆盖结论（2026-10-14 01:22 +08:00）

第 6 节之后已完成的源码和测试改动覆盖了 R3-C 与 R3-E：

- exec 首轮 `thread.started` 会实时写入活动 run，并通过 `onThreadId` 回调向上层传递；
- hold fixture 测试等待该回调后按 thread ID 停止，不再调用无参 `stop()`；
- `Hybrid.stop()` 的双后端结果已采用 `Promise.allSettled`；
- app-server thread 持久化回调异常已归类为不可 fallback 的 `CodexTurnStartedError`。

因此，前述 R3-C/R3-E 文字仅保留为历史审查快照，当前应以本节和源码为准。R3 目前仍
保留的运行验证项主要是微信已拉取批次停止边界、子进程树收敛以及真实 Codex/平台
fixture 行为；本次未运行测试、构建或服务。

## 8. 最新源码最终复审

- 审查时间：2026-10-14 01:36（Asia/Shanghai）
- 审查对象：当前工作区最新 `exec-runner` 回调等待改动、exec 回调失败测试、
  `removeAccount()` store 获取改动，以及 monitor batch abort 检查
- 审查方式：只读源码复核、异常传播和生命周期时序分析
- 限制：未修改业务源码；未安装依赖；未运行测试、类型检查、构建、服务或真实 Codex/微信调用

### 8.1 已确认闭合

#### 8.1.1 exec thread 回调的同步抛错已被 Promise 链捕获

当前实现使用：

```ts
threadCallbackPromise = Promise.resolve()
  .then(() => input.onThreadId!(event.thread_id))
  .then(() => undefined)
  .catch(...)
```

（`src/codex/exec-runner.ts:152-160`）。与此前直接执行
`Promise.resolve(input.onThreadId(...))` 不同，同步抛错会转为 rejected Promise，
写入 `callbackFailure`，标记 run stopped，并触发 child kill。

新增测试 `test/codex-exec.test.ts:221-236` 已覆盖同步抛错回调，并断言
`runner.run()` 最终拒绝 `persist failed`。因此，上一节 R3-F 的“同步回调异常逃逸”
主路径已静态闭合。

#### 8.1.2 child close 路径等待 thread 回调完成

`close` 事件调用异步 `finish(code)`，而 `finish` 首先
`await threadCallbackPromise`，之后才清理活动 run 并 resolve/reject
（`src/codex/exec-runner.ts:119-139、173-174`）。因此，正常 child close
先于异步 thread 持久化回调完成时，run 的最终 Promise 会等待该回调结果。

这闭合了此前“child close 先 resolve、异步回调失败随后才到达”的主要成功路径；
新增回调失败测试也提供了最小回归保护。

#### 8.1.3 removeAccount 的 store 获取覆盖无 entry 场景

`removeAccount()` 在停止账号后使用
`this.entries.get(account.accountId)?.store ?? this.storeFor(account.accountId)`
（`src/server/account-manager.ts:249-251`）。当账号没有 runtime entry 但存在缓存
store 时，`storeFor()` 会返回并注册缓存；当 entry 存在时继续使用该 entry 的 store。
当前未发现此前“无 entry 删除账号时无法读取会话”的静态缺口。

#### 8.1.4 monitor batch abort 检查保持成立

`monitorWeixin()` 仍在每条消息开始前检查 abort 并 `break`
（`src/weixin/monitor.ts:61-64`），对应测试继续断言第一条 abort 后第二条不处理
（`test/weixin-monitor.test.ts:120-146`）。

### 8.2 仍确认或需明确的边界

#### R3-H（P2，潜在生命周期风险）：`close()` 本身不等待回调或 child 收敛

`CodexExecRunner.close()` 仍为同步 `void`，设置 `closed` 后直接从
`activeRuns.splice(0)` 取出并调用 `run.child.kill()`（
`src/codex/exec-runner.ts:190-196`）。只有 child 随后触发 `close` 事件时，
该 run 自身的 `finish()` 才会等待 `threadCallbackPromise`。

因此：

- `run()` 的返回 Promise 在正常 close 事件路径上会等待 thread 回调；
- 但调用方不能 `await runner.close()` 来确认回调和 child 已收敛；
- 若 child 的 `close` 事件延迟、未到达，或后代进程仍存活，`close()` 本身立即返回。

这是生命周期 API 语义缺口和待验证资源风险，不足以静态认定为进程泄漏。账号停止路径
目前仍依赖上层 coordinator 等待 turn，而不是等待 `close()` 返回值。

#### R3-I（P3，潜在异常边界）：child `error` 事件未等待 thread callback

`child.on("error")` 处理器直接 `clearTimeout`、移除 active run 并 `reject(error)`
（`src/codex/exec-runner.ts:168-172`），没有像 `close` 路径一样等待
`threadCallbackPromise`。如果 thread 回调已排队、随后 spawn/pipe 触发 `error`，run
可能先以 child error 拒绝，回调失败或完成在之后发生；同时 active run 已被移除，
`stop(threadId)` 也不再能定位它。

该路径需要专门的 spawn-error fixture 才能验证，当前标为潜在异常处理风险。

### 8.3 未验证项

- 未运行新增的 exec 回调失败测试，不能声称测试已通过。
- 未验证 `thread.started` 不带结尾换行时首轮 `onThreadId` 是否仍能触发；
  当前解析只处理完整换行行，EOF 缓冲区未再次解析。
- 未验证微信 API 的 sync key 是否代表整个 batch；abort 跳过剩余消息后，
  sync key 已提前持久化的消息确认语义仍待真实协议/fixture 证明。
- 未验证 `Hybrid.stop()` 的四种 allSettled 组合及真实 transport 断开行为。
- 未验证 Windows/macOS/Linux 下 `child.kill()` 对 Codex 子进程树的收敛。

### 8.4 最终判断

当前 R3 的主要修复链条已进一步收敛：

- monitor batch abort：静态闭合；
- exec 首轮 thread 回调和 `/stop`：静态闭合；
- exec thread 回调同步异常：静态闭合；
- child close 先于回调完成的 run 结算：静态闭合；
- removeAccount 无 entry 的 store 获取：静态覆盖。

维护清单仍应保留：

1. `close()` 同步生命周期 API 与 child/后代进程树收敛验证（R3-H）；
2. child `error` 与 thread callback 的窄竞态（R3-I）；
3. sync key、EOF 无换行、stop 组合及真实平台 fixture 测试。

**结论：R3 主路径问题已静态闭合，但尚未达到“运行验证通过”；当前剩余项主要是
生命周期 API 和平台/协议边界风险。**

## 9. exec-runner 最新补丁复审

- 审查时间：2026-10-14 01:40（Asia/Shanghai）
- 审查对象：`processStdoutLine` 抽取、EOF 缓冲处理、child `error` 回调等待及相关测试
- 审查方式：只读源码复核、Promise/事件时序分析
- 限制：未修改业务源码；未运行测试、类型检查、构建、服务或真实 Codex/平台 fixture

### 9.1 已确认闭合

#### 9.1.1 stdout 行处理已集中并复用于 EOF

`CodexExecRunner.run()` 抽出 `processStdoutLine()`（`src/codex/exec-runner.ts:119-139`），
正常 `data` 事件逐行调用；`close` 事件会把残留的 `stdoutLineBuffer` 再处理一次
（`src/codex/exec-runner.ts:179-182`）。

因此，最后一条 `thread.started` 即使没有结尾换行，也能在 child close 前后触发
`activeRun.threadId` 更新和 `onThreadId` 回调。此前“EOF 无换行导致首轮 thread 不可停止”
的静态缺口已闭合。

#### 9.1.2 child error 路径现在等待 thread callback 并传播 callbackFailure

`child.on("error")` 改为异步等待 `threadCallbackPromise`，随后以
`callbackFailure ?? error` 拒绝 run（`src/codex/exec-runner.ts:171-177`）。
这闭合了此前 child error 先于异步 thread 持久化回调完成、导致回调失败被吞掉的主路径。

#### 9.1.3 回调异常与 close 的结算顺序保持一致

`finish(code)` 仍先等待 `threadCallbackPromise`，再检查 `callbackFailure`
并决定 reject/resolve（`src/codex/exec-runner.ts:140-160`）。因此正常 close 和
child error 两条终止路径现在都遵循“等待 thread 回调，再传播回调失败”的规则。

### 9.2 仍属潜在风险或未验证项

#### 9.2.1 timeout 路径仍不等待 thread callback

超时定时器直接 `child.kill()` 并 reject `CodexExecTimeoutError`
（`src/codex/exec-runner.ts:108-112`），没有等待 `threadCallbackPromise`，也没有
检查后续 callbackFailure。若 timeout 与异步 thread 持久化回调同时发生，调用方会先看到
timeout，回调错误可能只在后续异步链中发生。该时序需要专门 fixture，暂列潜在风险。

#### 9.2.2 `close()` 仍是同步 API，不确认 child/后代进程树收敛

`CodexExecRunner.close()` 仍立即标记 closed 并调用 `child.kill()`，没有返回可等待的
Promise（`src/codex/exec-runner.ts:200-206`）。本补丁只让 run 的 close/error 事件
等待 thread callback，不等同于等待 child `close` 或后代进程树终止。Windows 与
macOS/Linux 的实际进程收敛仍需运行验证。

#### 9.2.3 error/close 可能双重进入，但 Promise 结算本身幂等

Node `ChildProcess` 通常会在 `error` 后继续触发 `close`；当前 `error` 处理器和
`finish()` 都会执行清理并尝试 reject。原生 Promise 会忽略第二次 settle，因此未发现
用户 Promise 被二次结算的直接缺陷；但清理和日志时序仍未由测试覆盖。

#### 9.2.4 新增 EOF/error 场景尚无对应自动化测试

现有 `test/codex-exec.test.ts` 覆盖首轮 thread stop 和同步回调失败
（`178-236`），但未覆盖：

- 无换行 EOF 的 `thread.started`；
- child error 与 pending callbackFailure 的组合；
- timeout 与 pending callbackFailure 的组合；
- `close()` 后 child close 延迟及进程树收敛。

### 9.3 当前 R3 判断

- R3-F：exec `onThreadId` 同步异常逃逸，**已闭合**；
- R3-G：正常 close 先于异步回调完成的结算竞态，**已闭合**；
- R3-H：child error 不等待/不传播 callbackFailure，**已闭合**；
- EOF 无换行首轮 thread 回调，**已静态闭合**；
- timeout、同步 `close()` 生命周期和实际进程树收敛，**仍为潜在风险/未验证项**。

**最终状态：R3 主要停止与 thread 可见性路径已静态闭合，保留的事项限于
timeout/close 终止边界、平台进程生命周期及尚未运行的回归测试。**

