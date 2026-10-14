# R6 最终修复审核结论：消息确认与状态恢复

- 审查时间：2026-10-14 01:39:52 +08:00
- 审查时区：Asia/Shanghai
- 审查对象：当前工作区 R6 修改后的 `RuntimeStateStore`、Weixin account parser、
  `AccountManager` 的 `summary()`/`removeAccount()`/`storeFor()` 及相关测试
- 审查方式：只读源码、调用链追踪、静态类型边界与缓存生命周期检查
- 限制：未修改业务代码；未安装或升级依赖；未提交 Git；未运行测试、typecheck、
  build、服务或真实损坏文件恢复流程

## 结论

**R6 本次要求的核心修改静态通过，可以在维护清单中标记为“核心静态通过”，
继续后续维护。**

已确认的范围包括：

1. Runtime state 合法 JSON 的结构错误会在加载边界被拒绝，并给出文件路径和字段路径；
2. Weixin account 文件不再只依赖泛型断言，而是执行运行时字段校验；
3. `AccountManager.summary()`、`removeAccount()` 和 `storeFor()` 在同一
   `AccountManager` 实例内复用统一的 `RuntimeStateStore`；
4. 删除完成后会清理 `entries` 和 `stores` 中的账号引用；
5. 新增测试覆盖了代表性的坏 runtime/account 文件及错误上下文。

“静态通过”不等同于测试或生产恢复流程已验证。跨字段一致性、坏账号隔离、磁盘
耐久性和多进程状态写入仍应保留为后续建议。

## 1. RuntimeStateStore 结构校验

`src/state/runtime-state.ts:54-59` 从 `readJsonFile<unknown>()` 读取状态，再传入
`normalizeRuntimeState(value, paths.statePath)`；因此 TypeScript 泛型不会把未知 JSON
直接伪装成 `RuntimeState`。

当前校验边界：

- `src/state/runtime-state.ts:329-331` 要求顶层是非数组对象；
- `:333-336`、`:362-376` 校验字符串数组和字符串值映射，拒绝数组、数字和其他
  非字符串值；
- `:378-397` 校验每个 session 的必需字段、可选字符串字段和 `streamReplies`
  布尔字段；
- `:400-409` 校验 `pendingDeliveries` 为数组且每项字段为字符串；
- `:339-344` 校验存在时的 `lastActiveSenderId` 和 `syncKey`；
- 缺失的历史可选字段仍使用空数组、空对象或 `undefined` 的兼容默认值；
- 未知字段不会被拒绝，保留未来字段的向后兼容性。

这能在加载阶段阻断以下合法 JSON 错结构，而不是让错误数据进入排序、会话查找或
微信上下文发送路径：

```json
{"sessions":[null]}
{"activeSessionIds":[]}
{"contextTokens":{"alice":123}}
```

错误统一包含 `Invalid runtime state in <file>: invalid <field>`，便于定位。

## 2. Weixin account 运行时校验

`src/weixin/accounts.ts:125-165` 的 `listAccounts()` 现在对每个文件调用
`parseWeixinAccount()`：

- `:136-140` 要求顶层是非数组对象；
- `:141-145` 要求 `accountId`、`token`、`baseUrl`、`cdnBaseUrl`、`savedAt`
  为非空字符串；
- `:146-148` 要求存在的 `enabled` 为布尔值，缺失时保持历史默认 `true`；
- `:149-152` 对 `botId`、`userId`、`displayName` 等可选字段做字符串校验；
- `:154-164` 返回明确构造的 `WeixinAccount`，不把未校验的记录对象继续传递。

该策略没有额外收紧 URL、时间或账号文件名语义，兼容现有登录、重扫和历史账号
文件。错误包含具体文件路径及字段名。

## 3. AccountManager store/cache 生命周期

### 3.1 统一读取路径

`src/server/account-manager.ts:555-567` 的 `storeFor(accountId)` 按以下顺序取 store：

1. 运行中 `entries[canonicalAccountId].store`；
2. `stores` 缓存；
3. 按账号状态路径创建新的 `RuntimeStateStore` 并立即放入 `stores`。

`startAccount()` 在 `:165-169` 创建运行时 store 后写入 `stores`，因此运行中的
entry 和缓存指向同一实例。`summary()`（`:632-643`）使用
`entry?.store ?? this.storeFor(account.accountId)`，不再为同一账号无条件创建新的
未缓存 store。`listSessions()`、会话入口及发送者权限入口也通过 `storeFor()` 取得
同一缓存。

在当前单进程 `AccountManager` 调用链中，未发现 summary 读取旧快照、再由另一 store
覆盖新状态的确定性主路径。

### 3.2 removeAccount 顺序与清理

`src/server/account-manager.ts:242-271` 当前流程为：

1. `removeAccount()` 先登记关闭状态，再调用 `stopAccount()`；
2. `stopAccount()` 等待 monitor、账号级 turn 和 session 级 turn；
3. 通过 entry store 或 `storeFor()` 取得该账号唯一状态实例；
4. 处理 retained history 或彻底删除；
5. 删除账号文件及非保留模式下的 runtime/inbound 目录；
6. 最后删除 `entries` 与 `stores` 中的账号引用。

这保证删除前仍能从相同 store 取得 session 列表，删除后不会继续保留该账号的
内存缓存。`retainHistory: true` 保留 runtime/inbound 是产品语义，不属于缓存泄漏。

### 3.3 删除失败边界

若同步删除文件或目录在步骤 4-5 中抛错，`entries`/`stores` 清理位于后续步骤，
因此可能暂时保留已停止账号的内存引用；`finally` 会清除关闭标志。该行为是失败
恢复和重试策略缺口，不是本次正常删除主路径中的缓存不一致。建议后续增加删除失败
后重试测试，并明确是否需要在异常路径主动清理或保留 store。

## 4. 测试覆盖

当前已看到的针对性测试：

- `test/runtime-state.test.ts:139-149`：合法 JSON `sessions: [null]` 被拒绝，错误
  包含 `state.json` 和 `sessions[0]`；
- `test/accounts.test.ts:138-149`：`accountId: null` 被拒绝，错误包含账号文件
  路径和字段；
- `test/account-manager.test.ts:100-178`：账号启动/停止、保留历史和彻底删除；
- `test/account-manager.test.ts:339-376`：运行中的 Web turn 等待、账号关闭门禁和
  生命周期写入口拒绝。

测试源码足以证明回归意图，但本次没有运行测试，不能宣称这些断言已经在当前环境
通过。

未覆盖的建议矩阵：

- `contextTokens`、`activeSessionIds` 非字符串映射值；
- 缺字段或错误可选字段类型的 session；
- `pendingDeliveries` 坏元素；
- account 的 `enabled` 非布尔值、可选字段错误类型、必需字符串为空；
- summary 在“未启动但已有缓存”和“停止后再次读取”两种状态下的显式单例复用；
- 删除失败后 entry/store 的重试和清理；
- 多个账号中单个坏账号对 `startAll()` 的隔离策略。

这些属于测试和运维策略缺口，不改变当前核心静态结论。

## 5. 剩余风险与改进建议

### P2：跨字段一致性尚未检查

当前校验字段类型，但没有验证 session ID 唯一性，也没有验证
`activeSessionIds[senderId]` 是否指向存在且属于同一 sender 的 session；pending
delivery ID 也未检查唯一性。损坏文件可能因此形成孤立活动映射或状态错配，但不会
推翻本次已修复的类型崩溃问题。建议后续单独设计非破坏性策略，不要在没有迁移合同
时自动重写原状态。

### P2：单个坏账号文件可能阻断全局启动

`listAccounts()` 对结构错误账号直接抛错，`startAll()` 枚举账号时可能因此不能
启动其他健康账号。这是明确的 fail-closed 产品选择，而不是 parser 未校验缺陷。
后续需决定继续阻断并提示修复，还是隔离坏账号并保留可恢复错误状态。

### P3：磁盘耐久性与外部多实例

当前 `writeJsonFile()` 仍没有 fsync、备份或跨进程文件锁；导出的
`RuntimeStateStore` 也无法阻止外部工具持有旧快照后整体写回。服务进程锁降低常规
双实例概率，但没有覆盖外部脚本或残留进程。

### P3：用户可见错误脱敏

HTTP 层仍可能把包含绝对路径的底层结构错误消息返回给本地浏览器。服务当前是本地
边界，未据此推断远程漏洞；建议后续保留日志详细信息，向用户返回稳定错误类别。

### R3 既有边界，不归因于 R6

当前 `stopAccount()` 会在等待 turn 前关闭账号 runner
（`src/server/account-manager.ts:223`），这会终止正在运行的 Codex backend。该停止
语义已在 R3/R9 审核记录中单独跟踪；本次 R6 的 schema/cache 修改没有新增或扩大
该行为，因此不作为 R6 blocker。

## 6. 安全评估

- 未发现本轮 type guard、账号解析或 store 复用引入授权绕过、命令执行或任意文件
  读取新路径；
- fail-closed 解析降低了错误类型进入微信/Codex 调用链的可用性和状态完整性风险；
- 账号 token 仍为本地 JSON 明文，文件权限、加密和备份不在本项修复范围；
- 本文没有把未运行的测试或恢复流程写成已验证事实。

## 7. 最终判定

| 检查项 | 判定 | 依据 |
| --- | --- | --- |
| RuntimeState 顶层和字段类型校验 | 静态通过 | `normalizeRuntimeState` 及字段读取函数 |
| Weixin account 运行时类型校验 | 静态通过 | `parseWeixinAccount` |
| summary/storeFor 单例复用 | 静态通过 | entry → cache → create-and-cache |
| removeAccount 删除前后缓存生命周期 | 正常主路径静态通过 | stop/wait/delete/entries+stores cleanup |
| 代表性坏文件回归测试 | 已添加，未运行 | runtime/accounts 测试行号 |
| 跨字段一致性、坏账号隔离、耐久性 | 后续建议 | 不属于本次最小修复 |

**建议将 R6 标记为“核心静态通过，可继续”；保留上述 P2/P3 作为后续维护项，
不要声称已完成运行时测试或完整恢复验证。**
