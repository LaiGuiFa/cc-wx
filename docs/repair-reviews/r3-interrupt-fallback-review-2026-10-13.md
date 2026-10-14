# R3 修复审核结论：中断、失败和 fallback 分类

- 审查时间：2026-10-13 18:25（Asia/Shanghai）
- 审查对象：当前工作区 R3/R9“中断、失败和 fallback 分类”修复
- 审查方式：只读源码审查、调用链追踪、静态逻辑与安全边界检查
- 审查范围：`src/codex/runner.ts`、`src/codex/app-server-runner.ts`、`src/codex/exec-runner.ts`、`src/bridge/service.ts`、`src/bridge/session-turn.ts`、`src/server/account-manager.ts` 及相关测试/fixture
- 限制：未修改业务源码；未安装或升级依赖；未提交 Git；本次未运行测试、构建、服务或真实微信/Codex 调用。因此以下结论仅表示静态审查结果，不代表运行验证通过。

## 结论摘要

当前实现已经完成了 R3 中最关键的一部分：`HybridCodexRunner` 不会把显式的
`CodexTurnInterruptedError` 自动回退到 `codex exec`，`turn/completed` 的
`status === "interrupted"` 也会被转换为专门的中断错误。app-server 的
`turn/interrupt` 请求使用 `threadId + turnId`，并且有对应 fixture/测试覆盖。

但 R3/R9 仍不能判定为完整通过：

1. `/stop` 只能使用当前 sender 的状态文件中保存的 thread id；如果调用方没有
   thread id，app-server stop 直接返回。它不会按 session/task token 定位，也不会
   给调用方反馈“没有可停止任务”。
2. app-server 请求或 turn 超时会调用 `failTransport(error, true)`，拒绝该 runner
   上所有 pending request/turn waiter。当前 runner 是跨账号共享的，因此一个任务的
   超时可能取消同一 runner 上其他账号的等待任务。这是已确认的共享故障域行为。
3. `codex exec` 的手动 stop 和 timeout 都只设置 `stopped = true` 后 `child.kill()`，
   最终通常以普通 `Error("codex exec run was interrupted")` 或
   `Error("codex exec timed out ...")` 结束，并未使用统一的中断/超时错误类型。
   因此 Hybrid 只对 app-server 专用中断做了明确分类；exec 侧状态仍依赖消息文本。
4. fallback 安全性仍主要依赖 `isSafeToFallback` 的错误消息正则。未知的协议错误、
   子进程退出、启动失败和部分运行失败均可能进入 exec fallback；虽然这符合“auto”
   的可用性目标，但不等价于确认原 turn 没有产生副作用。

**结论：R3 静态部分未发现“显式中断后立即重跑 exec”的确定性缺陷，但仍存在
超时共享影响、exec 状态分类不统一及 stop 目标边界。建议标记为“部分通过，不能
清空该项”，先补齐错误契约和共享 runner 的取消语义，再继续后续修复。**

## 1. 已确认的正确点

### 1.1 app-server interrupted 不会自动 fallback

`src/codex/app-server-runner.ts:497-505` 将完成状态分类为：

- `completed`：resolve 正常结果；
- `interrupted`：reject `new CodexTurnInterruptedError()`；
- 其他状态：reject 普通 Error，消息包含实际状态或服务端 error。

`src/codex/runner.ts:42-46、85-89` 首先以 `instanceof CodexTurnInterruptedError`
拒绝 fallback，其次对包含 `interrupted`、`timed out`、`ended with status` 或 request
timeout 的错误文本拒绝 fallback。因此，当前已确认的 app-server 中断路径不会再次
调用 `CodexExecRunner.run()`。

这解决了原审查中最危险的“用户请求停止后因异常分类不清而重复执行”的主要风险。
不过基于消息正则的部分仍有维护风险，详见第 3 节。

### 1.2 app-server stop 使用当前活动 turn 的复合目标

`src/codex/app-server-runner.ts:229-242` 要求：

1. runner 已初始化且子进程仍在运行；
2. 调用方提供 `threadId`；
3. `activeTurns` 中存在该 thread 对应的 `turnId`；
4. 发送 `turn/interrupt` 参数 `{ threadId, turnId }`。

`test/codex-app-server.test.ts:101-119` 使用 `thread-stop` 启动 hold turn，轮询调用
`runner.stop("thread-stop")`，并断言最终错误为 interrupted。对应 fixture 会校验
`turn/interrupt` 使用的是正确的 `turnId`，因此这条协议拼装在静态测试设计上有明确
回归保护（本次未实际运行）。

### 1.3 exec stop 会定位线程匹配的活动子进程

`src/codex/exec-runner.ts:122-130` 在提供 thread id 时从活动运行列表反向查找相同
`threadId`，否则选择最近一个活动运行；命中后设置 `stopped` 并杀掉子进程。
`close()` 会杀掉当前列表中的活动子进程（`132-136`）。活动运行在 `close` 事件中
移除（`83-87、103-106`），正常情况下不会永久留在 `activeRuns`。

### 1.4 streaming fallback 不会把 exec 输出伪装为 delta

`src/codex/runner.ts:48-52` 在 fallback 调用中清除 `onDelta`/`onProgress`。
`test/codex-app-server.test.ts:161-181` 也明确断言 fallback 不产生 delta，并只返回
最终答案。这避免了 app-server 已经发送部分 progress 后又把 exec 结果当作同一条流
继续发送的直接混淆。

## 2. 已确认的问题

### R3-A（P1）：单次 app-server 超时会终止共享 runner 上所有等待任务

证据链：

1. `AppServerCodexRunner.request()` 在 `src/codex/app-server-runner.ts:308-329`
   为每个请求设置 timer；超时后删除该 request、reject 当前请求，并调用
   `failTransport(error, true)`。
2. `waitForTurn()` 在 `471-480` 对 turn 设置同样的总超时；超时后 reject 当前
   waiter，再调用 `failTransport(error, true)`。
3. `failTransport()` 在 `580-607` 会拒绝 `pending` 中所有 JSON-RPC 请求和
   `turnWaiters` 中所有活动 turn，并清空全局活动映射。
4. `src/server/account-manager.ts:129-133、166-174` 为多个账号注入同一个
   `runnerFor(config)` 返回的 `HybridCodexRunner`，因此其内部 app-server runner
   是共享故障域，而不是账号隔离实例。

这不是“可能存在”的描述，而是代码明确表达的行为。影响是否能在真实部署中被观察，
取决于多个账号/turn 是否会同时占用该共享 app-server，以及其中一个是否达到
timeout；本次没有运行并发场景。对用户而言，某个账号的慢/卡住 turn 可能让其他
账号得到同样的 timeout 错误。

**建议**：短期至少把 timeout 错误分类为 transport/turn timeout 并记录受影响的
thread ids；中期按账号或按可取消任务隔离 runner，或引入带 task token 的逐 turn
取消协议。不能仅通过扩大 fallback 正则解决，因为 app-server 传输已被主动关闭。

### R3-B（P1/P2）：exec 手动 stop 与 timeout 没有统一错误类型，状态可能误分类

`src/codex/exec-runner.ts:89-93` 的 timeout 路径设置 `activeRun.stopped = true`，
杀进程并立即 reject `Error("codex exec timed out ...")`。随后 `close` 事件仍会
执行；由于 promise 已 reject，后续 reject 会被忽略，但调用方只看到普通 Error。

手动 stop (`122-130`) 同样只设置 `stopped` 和 `kill()`。`close` 回调在
`108-113` 依据 `activeRun.stopped` 返回普通
`Error("codex exec run was interrupted")`。该错误没有 `CodexTurnInterruptedError`
或专门的 `CodexExecTimeoutError` 身份，Hybrid 的 fallback 判断只会在 app-server
catch 中运行，所以 exec 直接模式的上层只能依赖错误文本。

这会使 Web/微信错误展示、停止状态、可重试策略和后续 metrics 难以区分“用户停止”
与“系统超时”。当前未发现因此已经造成错误回退的确定性路径，但这是 R3 目标尚未
完成的已确认契约缺口。

**建议**：定义跨 backend 的错误分类（至少 interrupted、timeout、transport、
+process-failure、turn-failure），并保证 `exec` 和 app-server 使用同一公共类型；
timeout 应等待子进程 close/完成清理后再结算 promise，避免继续运行的子进程与已返回
调用方之间出现状态脱节。

### R3-C（P2）：stop 只接受显式 threadId，无法表达“当前活动任务”或无任务状态

`src/bridge/service.ts:120-123` 调用
`this.runner.stop(this.options.stateStore.getThread(message.senderId))`。当该 sender
没有 thread id 时，`getThread()` 返回空值，app-server 的 `stop()` 在
`229-239` 直接 return；exec 的 `stop(undefined)` 则可能停止 `activeRuns` 中最近
一个任务（`exec-runner.ts:122-125`）。

因此两个 backend 的“无 thread id”语义不一致：

- app-server：什么都不做；
- exec：停止最近一个活动进程。

在 Hybrid runner 中，`stop()` 会并行调用两个 backend (`runner.ts:60-65`)；这可能导致
app-server 不停任何任务，而 exec 停掉另一个 thread 的最近任务。当前 service 的
`/stop` 没有把 session id、turn id 或任务 token 一并传递，也不返回“目标不存在”
的结构化结果。该差异是代码可直接确认的；是否会误停另一个任务取决于多任务并发
和调用时的 session 状态，本次未执行并发运行验证。

**建议**：stop API 必须要求或携带唯一任务标识；无标识时应返回 `no-active-turn`，
不能让 exec 选择全局最近任务。若产品确实需要“当前会话停止”，应在桥接层维护
session -> backend/thread/turn 映射，而不是复用持久化 thread id。

### R3-D（P2）：fallback 条件仍依赖错误文本，未知失败可能触发重复执行

`src/codex/runner.ts:42-57、85-89` 对 app-server 的所有异常进入统一 catch，并仅用
类型和消息正则决定是否 fallback。除明确中断/超时/非 completed 状态外，以下错误
会被视为可 fallback：

- `thread/start`、`thread/resume`、`turn/start` 的协议错误；
- app-server 子进程异常退出；
- JSON 传输断开；
- 未匹配现有正则的服务端 turn failure。

这些错误有些发生在 turn 已被 Codex 接受或已产生外部副作用之后。代码没有一个
“未开始 turn / 已开始但无最终结果 / 已中断”的结构化提交状态，因此不能从静态上
证明 exec 重跑不会重复副作用。现有 `test/codex-app-server.test.ts:121-138`
只覆盖 fixture 的启动失败并 fallback 到 exec 的成功路径，未覆盖“turn 已开始后
transport 断开”的幂等性。

这应定性为**潜在重复执行风险**，不是已确认的重复副作用漏洞。实际影响依赖 Codex
命令是否已经执行写操作以及 app-server 在失败时的协议时序。

**建议**：让 app-server runner 返回带阶段/可重试性元数据的错误，只有启动前错误
才自动 fallback；turn 已发出但未完成的错误默认不 fallback，或要求用户显式重试。
错误消息正则只能作为兼容旧错误的临时兜底。

## 3. 潜在风险与边界

### 3.1 `failTransport` 的 child.kill 没有等待进程树收敛

`src/codex/app-server-runner.ts:586-588` 和 `src/codex/exec-runner.ts:89-92、
122-129` 直接调用 `child.kill()`，没有等待 `close`、没有 Windows 进程树终止，也
没有验证后代进程是否退出。该实现可能留下 Codex 后代进程或短暂占用资源；但从静态
代码不能确认当前 Codex CLI 一定会派生需要独立清理的子进程，因此标记为潜在资源/
兼容性风险。

### 3.2 app-server 的活动状态以 thread 为 key，只支持每个 thread 一个 active turn

`activeTurns: Map<string,string>` (`app-server-runner.ts:108`) 每个 thread 只能保存
一个 turn id。若协议允许同一 thread 并发 turn，后启动的 turn 会覆盖前一条；stop
和 timeout 的映射会不准确。`SessionTurnCoordinator` 通常按 session 串行，但
Web/其他调用方仍需遵守这一假设。当前未从项目代码证明 Codex 允许同 thread 并发，
因此属于待验证兼容性风险。

### 3.3 finishTurn 等待 progress chain 后才结算

`app-server-runner.ts:457-458、483-506` 在收到 `turn/completed` 后清除 waiter
timer，再等待已排队的 progress callback chain。若 callback 卡住或外部微信网络调用
迟迟不返回，turn promise 可以在应用层继续等待，且不再受 turn timeout 保护。这是
R9 网络取消边界的潜在阻塞点，不能仅凭静态分析断言一定泄漏。

### 3.4 fallback 警告进入最终回答

`runner.ts:53-56` 把 “used codex exec fallback” 拼入 `result.text`。这会把内部
后端选择泄露到用户消息，并可能影响下游 action block/前端展示。它不是安全漏洞，
但会使用户把 fallback 当成模型回答内容，建议未来改为结构化诊断字段。

### 3.5 `CodexTurnInterruptedError` 目前只覆盖 app-server

`src/bridge/errors.ts:8-15` 只按 `timed out|timeout` 文本把超时映射为超时提示，
其他 stop/interrupt 仍归为通用失败。由于 exec 没有公共错误类型，用户无法稳定地区分
“已按停止”与“处理失败”。这是用户体验和可运维性风险，不是直接权限问题。

## 4. 测试与验证现状

### 已存在的静态覆盖点

- `test/codex-app-server.test.ts:101-119`：app-server interrupt 使用 thread/turn
  目标，且最终错误包含 interrupted。
- `test/codex-app-server.test.ts:121-138`：auto backend 在 fixture 启动失败时使用
  exec fallback。
- `test/codex-app-server.test.ts:161-181`：streaming fallback 不产生 delta。
- `test/codex-exec.test.ts:178-189`：exec runner stop 会使 hold fixture 结束；
  但断言只匹配 `exited with code`，没有确认中断类型或进程树清理。
- `test/fixtures/fake-codex-app-server.mjs:233-244`：fixture 校验 interrupt 的
  `threadId` 和 `turnId`。

### 本次未验证与明显缺口

- 本次未运行 `npm test`、`npm run typecheck`、`npm run build`、`npm audit`。
- 没有测试多个账号共享 app-server 时，一个 turn timeout 对其他 waiter 的影响。
- 没有测试“turn 已开始、transport 断开”时 auto backend 是否错误重跑 exec。
- 没有测试 `/stop` 在无 thread、旧 thread、多个 exec 活动任务时的目标语义。
- 没有测试 exec timeout 与手动 stop 的结构化状态、重复 close/error 事件及子进程树。
- 没有测试 `finishTurn` 中 progress callback 永不返回时的 timeout/关闭行为。

## 5. 安全影响评估

本次静态审查未发现可直接确认的权限绕过或远程代码执行漏洞。主要安全相关影响是：

- **重复副作用风险**：fallback 可能在 app-server 已接受 turn 后重新提交相同 prompt；
  若 prompt 会写文件、执行命令或发送附件，可能产生重复操作。当前只能根据错误
  分类和时序推断，尚未由代码单独证明实际可利用。
- **跨任务停止风险**：`exec.stop(undefined)` 选择最近活动运行；当上层没有提供
  thread id 且存在多个活动任务时，理论上可能停止另一个任务。实际并发前提和用户
  可达路径需通过专门测试确认。
- **资源/可用性风险**：共享 app-server transport 的 timeout 会清空其他任务，
  造成跨账号拒绝服务式影响；这是本地服务内部故障隔离问题，不是远程攻击结论。

## 6. 最小改动建议

按风险和兼容性排序：

1. **先统一错误契约**：新增跨 backend 的 interrupted/timeout/transport/process/
   turn-failure 类型或稳定 `code`，保持现有用户文案兼容。
2. **修正 stop 目标**：桥接层传入 session/task token；无目标时两个 backend 都返回
   `no-active-turn`，禁止 exec 默认停止全局最近任务。
3. **收紧 auto fallback**：仅对连接/启动且确认 turn 尚未提交的错误 fallback；
   turn/start 后的未知失败默认不自动重跑。
4. **隔离 timeout 故障域**：至少记录并清理受影响 turn；中期评估按账号拆分
   app-server runner，或实现可取消的单 turn transport。
5. **补测试后再宣称通过**：覆盖中断不 fallback、timeout 不误停其他任务、多个
   exec 活动运行、transport 断开后的 no-fallback 和关闭清理。

## 7. 是否可继续下一项

**暂不可继续清空 R3。**

理由：

- 显式 app-server interrupted 不 fallback 已静态成立；
- 但 timeout 会清空共享 runner 的其他 waiter，stop 目标在 app-server/exec 间不一致，
  exec 侧没有统一错误状态，fallback 仍依赖文本且无法识别“turn 已提交但失败”；
- 这些问题直接属于 R3/R9 的目标范围，不是可忽略的文档或测试增强。

下一步应由实现侧先处理第 6 节中的前两项（错误契约、stop 目标），再由子代理复审；
在修复完成并记录新的审核结论前，不建议把维护清单第 3 项标记为完成。
