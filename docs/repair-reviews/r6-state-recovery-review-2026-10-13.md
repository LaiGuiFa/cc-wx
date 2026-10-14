# 第 6 项修复审核结论：状态缓存与 JSON 恢复

- 审查时间：2026-10-14 00:02（Asia/Shanghai）
- 审查对象：`E:\cc-wx-main` 当前工作区
- 审查范围：R4/R7 对应的账号级 `RuntimeStateStore` 缓存、账号移除后的缓存清理、JSON 损坏错误上下文及相关恢复边界
- 审查方式：只读源码阅读、调用关系追踪和静态逻辑/安全检查
- 限制：未修改业务代码；未安装或升级依赖；未提交 Git；未运行测试、typecheck、build、服务或真实账号流程

## 结论摘要

账号级 `RuntimeStateStore` 的主要缓存修复在 AccountManager 内部调用链上成立：启动账号时建立一个 store，Web/微信入口复用该实例，停止账号后继续保留，彻底移除账号后清理 `entries` 和 `stores`。`readJsonFile()` 现在也会在 JSON 语法错误中带上文件路径和原始异常原因，诊断性比原实现更好。

第 6 项仍不能标记为完全通过。当前存在一个可由源码确定的账号移除竞态：`startAccount()` 没有检查 `closingAccounts`，因此移除流程等待或删除目录期间仍可能启动新的 monitor/store；删除完成后该 monitor 的回调可以再次写出已删除的状态文件。除此之外，JSON 解析后的对象只做顶层默认值合并，没有逐项 schema 校验；损坏但语法合法的状态或账号文件仍可能让启动、列表接口或消息处理直接失败。

**建议：先修复账号启动与移除的竞态，再继续清单后续工作；第 6 项在补齐结构校验和回归测试前不要关闭。**

## 1. 已确认的改进

### 1.1 AccountManager 复用每个账号的 RuntimeStateStore

依据：

- `src/server/account-manager.ts:98` 定义 `stores: Map<string, RuntimeStateStore>`。
- `src/server/account-manager.ts:163-166` 在 `startAccount()` 中创建 store，并同时写入 `stores` 和 `RuntimeEntry`。
- `src/server/account-manager.ts:169-180` 将同一个 store 传给 `BridgeService` 和 monitor 回调。
- `src/server/account-manager.ts:525-536` 的 `storeFor()` 优先取运行中 entry 的 store，其次取缓存，最后才创建并缓存新实例。

这消除了原来“同一账号停止后，每次 Web 调用都可能从磁盘载入不同内存快照”的主要路径。同步的状态修改也会由同一个实例执行并写回，账号内部的 Web/微信入口不会仅因各自调用 `storeFor()` 而创建两个 store。

### 1.2 停止账号时等待该账号的会话尾节点

`src/server/account-manager.ts:210-221` 在终止 monitor 后，从 entry 或缓存取得 store，并将该账号的会话 ID 交给 `SessionTurnCoordinator.waitForSessions()`，随后关闭账号 runner。这个顺序使停止流程不会在已知会话任务仍运行时直接返回。

这是静态调用关系上的改进；它不等价于对未知 session、外部直接创建的 store 或无法结束的 Codex 子进程提供强制截止时间。

### 1.3 彻底移除账号后清理缓存

`src/server/account-manager.ts:224-255` 的主路径如下：

1. 登记 `closingAccounts`；
2. 停止 monitor 并等待会话；
3. 根据 `retainHistory` 保留或删除历史；
4. 删除账号文件；彻底删除时移除 runtime 和 inbound 目录；
5. 删除 `entries` 与 `stores` 中的账号实例；
6. 在 `finally` 中清理关闭标记。

`retainHistory: true` 保留 runtime/inbound 是当前产品语义，便于同一微信身份重新扫码后恢复历史；`false` 删除两个目录，且测试已有对应断言（`test/account-manager.test.ts:157-178`）。

### 1.4 JSON 语法错误包含文件路径

`src/state/json-store.ts:8-18` 对 `JSON.parse()` 的 `SyntaxError` 抛出：

```text
Invalid JSON in <filePath>
```

同时通过 `cause` 保留原始异常。相较于只返回通用 parse 错误，这能直接区分 `config.json`、账号文件和某个账号的 `runtime/.../state.json`。这是已确认的诊断改进，但不是损坏文件自动恢复。

## 2. 已确认的问题和潜在风险

### R6-1 · P1 · removeAccount 与 startAccount 仍可交错

**代码依据**

- `removeAccount()` 在 `src/server/account-manager.ts:224-234` 设置 `closingAccounts` 后调用 `stopAccount()`，等待当前 store 的 session 尾节点。
- `startAccount()` 在 `src/server/account-manager.ts:156-166` 只检查 entry 是否为 `running` 或 `starting`，没有检查 `closingAccounts`。
- `startAccount()` 在 `src/server/account-manager.ts:182-206` 启动新的 monitor；其 `onSyncKey`、`claimMessage` 和错误回调仍闭包引用新建的 store。
- `src/state/json-store.ts:22-27` 的 `writeJsonFile()` 会自动创建父目录。

**可确定的时序**

1. 请求 A 进入 `removeAccount()`，账号被加入 `closingAccounts`，旧 monitor 被停止，entry 状态变为 `stopped`。
2. 在删除账号文件和 runtime 目录之前，请求 B 调用 `startAccount()`。由于没有关闭状态检查，B 可以创建新的 store、entry 和 monitor。
3. A 随后删除账号文件/目录并删除 map 中的 entry/store。
4. B 的 monitor 若在此后收到同步 key 或消息，仍可通过 store 的 `save()` 调用 `writeJsonFile()`，把已删除的 runtime 目录重新创建。

这是账号删除语义的完整性问题：删除请求返回后，账号状态可能被后台 monitor 重新写出；新 monitor 也可能继续持有旧凭据和网络请求。源码可以证明该竞态条件，不能仅归为理论上的“无锁”问题。

**建议**

- 在 `startAccount()` 和 `refreshAccount()` 的公共入口检查 `closingAccounts`。
- 保留 `removeAccount()` 内部停止动作的专用路径，避免为了加门禁而阻止它自身调用 `stopAccount()`。
- 在删除前后增加 entry/controller 身份检查，确保只有当前移除流程创建的 runner/monitor 能被关闭和清理。

### R6-2 · P2 · 语法合法但结构损坏的 runtime state 没有逐项校验

**代码依据**

- `src/state/runtime-state.ts:54-59` 直接把 `readJsonFile()` 的结果交给 `normalizeRuntimeState()`。
- `src/state/runtime-state.ts:329-341` 只判断若干顶层字段是否为数组或对象。
- `sessions` 和 `pendingDeliveries` 只检查“是数组”，没有检查每个元素的字段和类型。
- `contextTokens`、`activeSessionIds` 接受任意对象，包括数组；`pairedSenderIds` 也没有过滤非字符串成员。

**可确定的失败方式**

- `state.json` 为 `{"sessions":[null]}` 时，`listSessions()` 的排序回调访问 `updatedAt`，可直接抛出类型错误。
- `sessions` 中缺少 `senderId`、`workspace` 或时间字段时，后续会话归属、排序和 Codex 调用会收到未验证值。
- `activeSessionIds` 为数组或含非字符串值时，`Object.values()` 及会话激活判断可能产生错误状态。
- `contextTokens` 中含非字符串值时，消息发送回调可能把错误类型当作微信上下文 token。

这些输入不需要 JSON 语法错误，因此 `Invalid JSON in ...` 的错误包装不会覆盖它们。它们可能来自手工编辑、部分写入后的损坏或未来 schema 演进，实际外部可控性尚未验证。

**安全影响**

主要是可用性和状态完整性风险，可能阻断账号启动或 Web 列表/消息处理。当前源码不足以证明它能绕过微信授权或直接泄露 token；错误类型仍应在边界上拒绝，而不是继续执行。

**建议**

- 对 `RuntimeState` 的会话、sender、映射和 pending 项做最小逐项校验。
- 对无效条目采用“丢弃并记录”或“拒绝启动并给出可恢复错误”的明确策略，保留原文件备份/人工修复路径需另行设计。
- 为合法 JSON 的坏结构补充回归测试，覆盖空值、错误类型和缺字段。

### R6-3 · P2 · 账号 JSON 仍只有 TypeScript 断言

`src/weixin/accounts.ts:125-131` 通过 `readJsonFile<WeixinAccount>()` 读取每个账号文件后，直接访问 `account.enabled`，并在排序中调用 `a.accountId.localeCompare(...)`。`readJsonFile` 的泛型不会在运行时验证字段。

例如合法 JSON `{}` 或 `{"accountId":null}` 不会触发 JSON 语法错误，但会在 `.sort()` 或后续 `loadAccount()` 路径抛出类型错误。`AccountManager.startAll()` 首先调用 `listAccounts()`；因此单个损坏账号文件可能使整个账号启动阶段失败，且错误不会指出具体字段不符合要求。

这属于恢复和运维风险，不应声称已由 `json-store` 的错误上下文修复。

### R6-4 · P3 · JSON 错误路径可能通过本地 HTTP 原样返回

`src/server/http-server.ts:83-85` 将未处理异常的 `error.message` 放入 JSON 响应；`src/state/json-store.ts:16` 的错误消息包含绝对路径。因而 `/api/bootstrap`、`/api/accounts` 或其他触发配置/账号读取的请求可能向本地浏览器返回用户目录路径。

服务当前绑定 `127.0.0.1`，且源码没有证明远程客户端能直接访问；因此这里是本地信息暴露和诊断边界问题，不应定性为远程漏洞。建议日志保留完整路径，用户可见响应使用稳定错误码或脱敏文本。

### R6-5 · P3 · 单例缓存不覆盖外部直接创建的 RuntimeStateStore

`AccountManager.stores` 只约束 AccountManager 自己的入口。`RuntimeStateStore` 仍是导出类，任何其他进程或工具若对同一 `state.json` 建立另一个实例，仍可能持有旧快照并整体写回覆盖新状态。服务进程锁降低了正常双实例概率，但它不是文件级写锁，也没有解决外部脚本或异常残留进程的并发写入。

这是多实例边界的潜在风险；当前源码不能证明生产部署一定会触发，故不应作为本次修复的已确认回归。

## 3. 缓存清理的剩余边界

- `removeAccount()` 只有在删除目录和账号文件都成功后才执行 `entries.delete()`、`stores.delete()`。若中途同步删除失败，`finally` 会清除 `closingAccounts`，但已停止的 entry/store 可能仍留在内存中；后续重试可能看到旧缓存。该行为属于失败恢复缺口，尚未由测试验证。
- `summary()`（`src/server/account-manager.ts:599-605`）在没有 entry 时直接 `new RuntimeStateStore(...)`，没有读取 `stores` map。当前正常公共路径通常会有 stopped entry 或先经过 `storeFor()`，因此未发现确定性数据丢失；但它没有完全遵循“每账号单例 store”约束，建议统一为 `entry?.store ?? this.stores.get(...) ?? create-and-cache`。
- `retainHistory: true` 有意保留状态和 inbound 文件；这不是缓存泄漏，但删除对话的产品文案和保留范围应保持一致。

## 4. 测试与验证边界

本次未运行测试、typecheck、build、npm audit、服务或网络集成。当前源码已有：

- `test/account-manager.test.ts:157-178` 覆盖保留历史与彻底删除目录；
- `test/account-manager.test.ts:339-366` 覆盖已有 Web turn 和账号移除之间的等待/拒绝；
- `test/runtime-state.test.ts` 覆盖正常会话、同步 key 和去重持久化。

尚未看到针对以下边界的自动化覆盖：

1. `removeAccount()` 期间并发 `startAccount()`/`refreshAccount()`；
2. 删除目录后旧或新 monitor 回调重新写出 state；
3. 合法 JSON 但错误结构的 runtime/account 文件；
4. 单个损坏账号文件对 `startAll()` 和 HTTP 错误响应的影响；
5. 删除失败后的 entry/store 重试和清理行为。

## 5. 是否可继续

**可以继续推进后续审查或修复，但第 6 项不能标记为完全通过。**

继续前的最低条件是先处理 R6-1 的账号关闭竞态；否则彻底删除仍可能被并发启动流程恢复。R6-2/R6-3 属于结构校验和恢复能力缺口，可在不改变现有数据格式的前提下作为下一小步修复，但在问题清单全部清空前必须给出明确策略和回归测试证据。

本结论仅代表当前源码的静态判断，不代表运行时测试或真实文件损坏场景已经验证。

## 6. 复核更新（2026-10-14 00:28 +08:00）

本次按当前工作区重新核对 R6-1。结论需要更新：

### R6-1 账号移除期间启动竞态：当前静态主路径已闭合

当前 `src/server/account-manager.ts` 已在两个入口加入关闭门禁：

- `refreshAccount()` 在 `src/server/account-manager.ts:148-155` 首先调用 `ensureAccountOpen(accountId)`，然后才停止并重新启动账号；
- `startAccount()` 在 `src/server/account-manager.ts:158-160` 首先调用 `ensureAccountOpen(accountId)`，再执行 `setAccountEnabled()`/`loadAccount()`、创建 store 和启动 monitor；
- `ensureAccountOpen()` 在 `src/server/account-manager.ts:556-560` 检查 `closingAccounts`；
- `removeAccount()` 在 `src/server/account-manager.ts:231-238` 设置 `closingAccounts` 后再进入停止和删除流程；
- 已有回归测试 `test/account-manager.test.ts:368-376` 验证移除期间调用 `startAccount()` 会被拒绝。

由于 JavaScript 单线程执行模型下，`startAccount()` 从门禁检查到建立 entry/store 的这段代码没有 `await`，移除流程不能在该同步区间中间插入。若启动请求已经先进入该区间，后续 `removeAccount()` 会看到该 entry，并由 `stopAccount()` 中止 monitor、等待账号级和 session 级 turn；若移除先登记关闭标记，后续 `startAccount()`/`refreshAccount()` 会在门禁处失败。因此，原先“删除后新 monitor 重新写回 runtime”的 R6-1 时序在当前代码主路径上不再成立。

**安全/稳定性判断**：该补丁降低了删除后状态目录被后台 monitor 重建、旧账号凭据继续运行的风险。静态分析未发现同一入口仍可绕过 `ensureAccountOpen()` 的路径。尚未执行运行时并发测试，不能把该结论扩大为所有外部调用方或多进程场景的证明。

### 仍保留的边界

1. `restartRunning()`/`startAll()` 本身不直接检查 `closingAccounts`，但它们最终调用已设门禁的 `startAccount()`；当前单线程调用链下会得到同样拒绝。
2. `stopAccount()` 有意不调用 `ensureAccountOpen()`，供 `removeAccount()` 内部完成关闭；因此不能把它作为普通“启动/修改”入口复用而绕过产品层关闭语义。
3. 删除操作中途失败时，`finally` 仍会清除关闭标记；停止后的 `entry`/`stores` 可能保留在内存中，后续重试行为仍需测试。

### R6-2/R6-3 等未修复风险仍然有效

本次复核没有改变后文前述判断：

- **R6-2（P2）**：`RuntimeStateStore.normalizeRuntimeState()` 仍只做顶层类型判断，`sessions`、`pendingDeliveries`、`contextTokens`、`activeSessionIds` 缺少逐项 schema 校验；合法 JSON 的错误结构仍可能在排序、会话归属或消息发送时触发异常。
- **R6-3（P2）**：`listAccounts()` 对账号 JSON 使用 TypeScript 泛型断言，没有运行时字段校验；合法但损坏的 `{}` 等内容仍可能使 `startAll()` 或账号列表失败。
- **R6-4（P3）**：`http-server.ts` 仍把底层错误消息原样放入响应，`Invalid JSON in ...` 可能暴露本地绝对路径。
- **R6-5（P3）**：导出的 `RuntimeStateStore` 仍不能防止外部多实例对同一文件持有旧快照并整体写回。

**更新后的决定：R6-1 主路径可以标记为静态通过；第 6 项整体仍不能关闭，必须继续处理 R6-2/R6-3，并补充损坏 JSON、删除失败恢复和并发回归验证。**
