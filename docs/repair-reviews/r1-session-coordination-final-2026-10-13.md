# R1 会话协调修复最终审核结论

- 审查时间：2026-10-14 00:10:03 +08:00
- 审查时区：Asia/Shanghai
- 审查对象：当前工作区 R1 修复后的 `SessionTurnCoordinator`、`AccountManager`、
  `BridgeService`、`RuntimeStateStore` 及相关测试
- 审查方式：只读源码审查、调用链追踪、静态逻辑检查、并发时序推演
- 限制：未修改业务代码；未安装或升级依赖；未提交 Git；未运行测试、构建或服务

## 结论

**R1 的三个 P1 状态一致性问题已在当前代码中得到最小范围的静态修复，可以将
R1 从维护清单中标记为完成，并继续后续项目。**

本次结论只表示源码和已有测试用例的静态复审通过，不表示测试、构建或生产运行已经
验证。仍有三个 P2 级别的维护建议：账号 ID 规范化别名与关闭门禁的键不完全一致，
协调器键没有显式包含账号维度，以及只读 API 在关闭/删除交错时的错误映射。它们属于边界隔离、
可维护性和可观察性改进，不足以否定
本次 R1 的核心修复结论。

## 复审范围与基线

此前 R1 审核确认了以下问题：

1. 运行中的 `resetSession` 可能清除 thread 后又被旧任务写回。
2. 运行中的 `deleteSession` 可能让 Codex 已完成但状态回写失败。
3. `removeAccount` 只等待微信 monitor，Web turn 可能在删除目录后重新写出状态。

本次复审重点核对：

- `closingAccounts` 是否在关闭流程最早阶段建立并覆盖所有状态写入口；
- `removeAccount` 的 `stop → wait → delete → cleanup` 顺序；
- `SessionTurnCoordinator` 尾 Promise、等待和释放行为；
- `RuntimeStateStore` 与 `entries`、`stores` 的生命周期；
- Web 与微信是否以明确的 session id 入队和写回；
- reset/delete 是否拒绝运行中或排队中的任务。

## 已确认通过的修复

### 1. Web 与微信使用同一 session 队列

- `src/server/account-manager.ts:104` 创建一个 `SessionTurnCoordinator`；
- `src/server/account-manager.ts:171-179` 默认构造 `BridgeService` 时传入同一协调器；
- `src/server/account-manager.ts:437` 的 Web `continueSession` 按 `session.id` 入队；
- `src/bridge/service.ts:426-429` 的微信 `runCodexTurn` 按已捕获的 session id 入队。

任务体在真正开始执行时重新读取同一个 session：

- Web：`src/server/account-manager.ts:438`；
- 微信：`src/bridge/service.ts:380-383`。

Codex 返回后也按这个固定 session id 写回：

- Web：`src/server/account-manager.ts:455-459`；
- 微信：`src/bridge/service.ts:407-410`。

因此，等待期间切换活动 session 不会把结果写入新的活动 session。相同 session 的
Web/微信任务通过同一尾 Promise 串行，不同 session 可以并行。

### 2. reset/delete 在运行期间明确拒绝

- `src/server/account-manager.ts:350-356` 的 `resetSession` 先调用
  `ensureAccountOpen`，再检查 `turnCoordinator.isActive(sessionId)`；
- `src/server/account-manager.ts:359-365` 的 `deleteSession` 使用相同门禁；
- 活动或排队中的任务会收到明确的“Session is responding”错误，状态不会在任务中途
  被清空或删除；
- `test/account-manager.test.ts:320-337` 覆盖运行期间 reset/delete 被拒绝，以及
  任务结束后 reset 正常生效。

这闭合了旧审核中的 R1-A 和 R1-B 时序。该检查发生在修改 runtime state 之前，
因此不会出现“先删除、后发现正在执行”的窗口。

### 3. 账号关闭门禁覆盖状态写入口

`removeAccount` 在第一次异步等待之前就登记关闭状态：

- `src/server/account-manager.ts:226-232` 加入 `closingAccounts`；
- `src/server/account-manager.ts:255-257` 在所有退出路径清理标志。

当前已检查关闭状态的入口包括：

- 启动和刷新：`src/server/account-manager.ts:147-159`；
- 创建、重命名、运行时配置、激活、重置、删除 session：
  `src/server/account-manager.ts:316-365`；
- Web turn：`src/server/account-manager.ts:425-428`；
- 账号重命名和发送者权限修改：`src/server/account-manager.ts:260-267`、
  `508-528`。

因此，关闭流程开始后，新的 Web turn、账号重新启动、账号资料修改和发送者权限修改
不会再建立新的状态写入路径。新增测试
`test/account-manager.test.ts:368-376` 覆盖关闭期间的启动和重命名拒绝；Web turn
拒绝由 `356-366` 覆盖。

### 4. removeAccount 的关闭顺序能够阻止删除后回写

当前顺序为：

1. 登记 `closingAccounts`；
2. `stopAccount(accountId, false)`；
3. `stopAccount` 中 abort monitor、等待 `entry.task`；
4. 等待该账号所有已有 session 的 coordinator 尾节点；
5. 处理保留历史或 retained account；
6. 删除账号记录；
7. 非保留模式下删除 runtime 和 inbound 目录；
8. 删除 `entries`、`stores` 中的账号引用；
9. `finally` 清除关闭门禁。

对应代码：

- `src/server/account-manager.ts:231-257`；
- `src/server/account-manager.ts:212-223`；
- `src/bridge/session-turn.ts:29-39`。

`stopAccount` 等待 monitor 任务结束后再次调用 `waitForSessions`。这个顺序覆盖了
两类并发：

- monitor 已经收到消息并进入 BridgeService 的微信 turn；
- Web turn 已经取得 store 并在 coordinator 中排队或执行。

删除目录发生在所有已观测 session 尾节点结束之后。既有回归测试
`test/account-manager.test.ts:339-354` 验证 Web turn 完成后才删除状态文件，
因此旧审核中的 R1-C 主路径已闭合。

### 5. 协调器释放和等待逻辑没有发现新的死锁

`src/bridge/session-turn.ts:10-27` 在任务成功、抛错或拒绝时都通过 `finally`
释放当前尾节点，并且只在 map 中仍指向自身时删除尾节点。后继任务不会因为前一个
任务的业务异常永久卡住。

`waitForSessions` 会在尾节点完成后再次检查 map，能够覆盖“等待期间已有后继任务已
登记”的情况。关闭门禁又阻止了关闭开始后新增业务任务，因此删除前不会漏掉由本
AccountManager 入口启动的后继 turn。

### 6. store/cache 生命周期在当前关闭路径上保持一致

- 活动账号优先使用 `entries[accountId].store`：
  `src/server/account-manager.ts:530-536`；
- 未运行账号使用 `stores` 缓存或按路径重新加载：
  `src/server/account-manager.ts:537-541`；
- `removeAccount` 删除文件后清理 `entries` 和 `stores`：
  `src/server/account-manager.ts:243-254`；
- 已运行账号的 store 是同一个实例，Web 和微信写回不会因为关闭流程切换到另一个
  snapshot。

在当前同步 JSON 写入实现下，`RuntimeStateStore.save()` 会在每次状态变更时写回：
`src/state/runtime-state.ts:28-31`。本次复审没有发现关闭顺序会重新创建已删除
目录的可达主路径。

## 残余风险（不阻塞 R1）

### P2：关闭门禁使用 canonical account id，而入口先检查原始参数

`removeAccount` 使用已加载账号的 `account.accountId` 登记
`closingAccounts`（`src/server/account-manager.ts:227-232`），而多数入口在
`ensureAccountOpen(accountId)` 之前还没有把参数规范化。底层 `loadAccount` 会接受
规范化别名（`src/weixin/accounts.ts:166-180`），例如一个包含文件名不安全字符的
账号 ID 可能通过规范化后的别名访问同一账号。

在这种数据条件下，关闭期间使用别名调用 `startAccount`、`refreshAccount` 或其他
写入口，理论上可能绕过 `closingAccounts` 的 Set 查找；这是由参数规范化顺序造成的
边界风险。当前生产账号 ID 通常来自微信标识，未从静态代码证明该条件必然出现，也
未把它认定为 R1 已确认缺陷。

建议后续将所有生命周期入口先通过 `loadAccount` 解析 canonical id，再执行门禁检查，
或让 `ensureAccountOpen` 内部统一调用相同的规范化逻辑。建议配套增加一个带别名账号
ID 的并发移除测试。

### P2：协调器 key 没有显式包含 accountId

`src/bridge/session-turn.ts:4-7` 只以 `sessionId` 为 key。当前 session id 使用
随机 UUID（`src/state/runtime-state.ts:212-230`），跨账号碰撞概率极低，因此未发现
现实中的跨账号数据串扰。固定测试数据或迁移数据若复用 session id，会造成无意义的
跨账号串行。后续可考虑在 AccountManager 层传入 `accountId + sessionId` 命名空间。

### P2：只读 API 在关闭/删除交错时可能返回错误

`getSessionMessages`、`getSessionAttachment` 和
`isSessionStreamEnabled` 没有调用 `ensureAccountOpen`。关闭期间它们仍可能读取正在
删除的 runtime，关闭完成后再读取则会因账号不存在或 session 不存在而报错。这些
入口不写入状态，也不会重新创建已删除目录，属于可观察性和 HTTP 错误映射问题，不属于
本次状态完整性缺陷。

## 安全风险评估

- 未发现本次 R1 修复引入任意代码执行、路径穿越、认证绕过或凭据泄露。
- 关闭门禁阻止新的状态写入和新的账号启动，降低了删除后残留状态和旧任务覆盖的
  风险。
- P2 账号 ID 别名问题只有在账号标识包含可被 `normalizeAccountId` 改写的字符且调用
  方使用别名时才成立；当前没有运行时证据证明可由远程未授权请求稳定触发。
- 本文结论来自静态检查。没有进行动态竞态、压力、HTTP 状态码或跨平台进程验证。

## 验证记录

已静态检查：

- `src/server/account-manager.ts` 的账号关闭门禁、stop/wait/delete 顺序和 store 清理；
- `src/bridge/session-turn.ts` 的尾 Promise 登记、释放和等待；
- `src/bridge/service.ts` 的微信 session 捕获与按 session 写回；
- `src/state/runtime-state.ts` 的 session 状态写回；
- `test/account-manager.test.ts:320-376` 的 reset/delete、Web turn 等待、关闭门禁测试；
- `test/session-turn.test.ts` 的同 session 串行和异 session 并行测试。

未执行：

- `npm test`、TypeScript 编译、构建、服务启动；
- 真实 Web 与微信交错请求；
- 账号别名、重复移除、HTTP 错误码和异常清理路径的动态验证。

## 最终判定

| 项目 | 判定 | 依据 |
| --- | --- | --- |
| Web/微信同 session 串行 | 通过（静态） | 两入口使用同一 coordinator 和明确 session id |
| reset/delete 运行中保护 | 通过（静态） | `isActive` 门禁和回归测试 |
| removeAccount 删除前等待 | 通过（静态） | stop monitor、等待 turn、再删除目录 |
| 删除后旧 Web turn 重建状态 | 未发现可达主路径 | 关闭门禁覆盖新入口，删除前等待已有 turn |
| 账号关闭期间重新启动/修改 | 通过（静态） | start/refresh/rename/allow/remove 等入口统一门禁 |
| 账号 ID 规范化别名 | P2 潜在风险 | 门禁检查发生在 canonical 解析之前 |
| 运行时动态验证 | 未完成 | 按审查限制未执行测试和服务 |

**R1 可以清空。** 建议在 `docs/maintenance-fix-checklist-2026-10-13.md` 将第 1
项标记为“已完成（静态复审通过；保留 P2 后续建议）”。账号 ID canonical 化和只读
API 的关闭期错误映射可在后续维护批次处理，不应重新打开本次 R1 的 P1 修复。
