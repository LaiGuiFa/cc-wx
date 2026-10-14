# R6-2/R6-3 Schema 校验实现审核结论

- 审查时间：2026-10-14 01:06（Asia/Shanghai）
- 审查对象：`E:\cc-wx-main` 当前工作区
- 审查范围：`src/state/runtime-state.ts`、`src/weixin/accounts.ts` 及新增的结构错误回归测试
- 审查方式：只读源码、调用关系和安全边界检查
- 限制：未修改业务代码；未安装或升级依赖；未提交 Git；未运行测试、typecheck、build 或真实损坏文件恢复流程

## 结论摘要

**R6-2/R6-3 的核心 schema 校验修复静态通过，可以继续后续维护工作；但测试覆盖仍不完整，第 6 项不宜在清单中宣称“所有恢复风险已解决”。**

当前实现已经阻断本次问题点名的合法 JSON 错结构：`sessions: [null]`、`activeSessionIds: []`、字符串映射中的非字符串值，以及账号必需字段缺失或可选字段类型错误。错误消息包含具体文件路径和字段路径，未引入新的运行时依赖，也保留了历史上缺失可选字段的默认行为。

## 1. 已确认的修复

### 1.1 RuntimeState 结构检查

- `src/state/runtime-state.ts:329-355` 要求顶层为非数组对象，并对各字段使用明确的读取函数。
- `src/state/runtime-state.ts:362-376` 拒绝 `activeSessionIds: []`、数组元素非字符串以及映射值非字符串。
- `src/state/runtime-state.ts:378-397` 拒绝 `sessions` 中的 `null`、缺失必需字段或错误可选字段类型。
- `src/state/runtime-state.ts:400-414` 对 `pendingDeliveries` 的数组和每项字段做类型检查。
- 缺少的旧字段仍回退为空数组/对象，符合已有状态格式的向后兼容语义。

因此，原先会在 `listSessions()` 排序、活动会话查询或消息发送路径中产生未定义行为的输入，现在会在 `RuntimeStateStore` 构造阶段 fail closed。

### 1.2 WeixinAccount 结构检查

- `src/weixin/accounts.ts:125-133` 读取账号文件后立即调用 `parseWeixinAccount()`，不再把泛型断言结果直接传入业务层。
- `src/weixin/accounts.ts:136-164` 要求 `accountId`、`token`、`baseUrl`、`cdnBaseUrl`、`savedAt` 为非空字符串。
- `enabled` 缺失仍默认为 `true`；存在但不是布尔值时拒绝。
- `botId`、`userId`、`displayName` 保持可选，但存在时必须是字符串。

这与 `login.ts` 生成账号和 `saveScannedAccount()` 的重扫/恢复流程相容；本次没有擅自加入域名、日期或文件名约束。

### 1.3 回归测试已开始覆盖错误上下文

- `test/runtime-state.test.ts:139-149` 验证 `sessions: [null]` 被拒绝，并包含 `state.json` 路径及 `sessions[0]` 字段。
- `test/accounts.test.ts:138-149` 验证 `accountId: null` 被拒绝，并包含具体账号文件名与字段。

测试源码断言的是稳定错误结构，而不是 Node 底层 `TypeError` 文案，方向正确。

## 2. 未闭合但不阻塞本次主修复的问题

### R6-S1 · P2 · 尚无跨字段一致性校验

当前 type guard 只验证字段类型，未验证：

- session ID 唯一性；
- `activeSessionIds[senderId]` 是否指向存在且属于同一 sender 的 session；
- pending delivery ID 唯一性。

这些输入不会造成本次已修复的 `null`/数组类型崩溃，但可能产生不可见活动会话或映射错配。建议作为后续独立小项处理，避免在本次修复中自动重写用户状态文件。

### R6-S2 · P2 · 单个坏账号仍可能阻断全局启动

`listAccounts()` 发现任一合法 JSON 但结构错误的账号文件会直接抛出；`AccountManager.startAll()` 在枚举账号时调用 `listAccounts()`，因此可能无法启动其他健康账号。这是当前明确的 fail-closed 产品行为，不应误称为 parser 缺陷。

后续需由产品/运维合同决定：继续阻断并提示修复，还是隔离坏账号后启动其余账号。若选择隔离，必须保留错误状态和可恢复路径，不能静默丢弃。

### R6-S3 · P2 · 测试矩阵仍偏窄

当前新增测试未覆盖：

1. `activeSessionIds` 为数组；
2. `contextTokens` 含数字或数组；
3. 缺字段或错误类型的 session；
4. `pendingDeliveries` 的坏元素；
5. 账号 `enabled` 非布尔值、可选字段非字符串、空必需字符串；
6. 合法旧格式缺失 `enabled`/可选字段仍可加载。

这些是建议的最小补充，不影响当前主路径静态结论。

## 3. 安全风险评估

- 结构校验降低了状态错配、启动崩溃和错误 token 类型流入 `WeixinApiClient` 的风险。
- 未发现该改动引入授权绕过、命令执行或任意文件访问路径。
- 账号 token 仍以 JSON 明文保存；校验不提供加密或文件权限保护。
- `http-server.ts` 仍可能把包含绝对路径的底层错误消息原样返回，属于 R6-4 的独立信息暴露问题。
- 备份、fsync、损坏文件隔离和多进程并发写入仍未解决。

## 4. 是否可继续

**可以继续。** 建议维护清单将 R6-2/R6-3 标记为“核心静态修复通过，测试矩阵和恢复策略待补”，再进入下一项；不要把跨字段一致性、坏账号隔离和磁盘耐久性风险混写成已解决。

本结论是静态审核结果，不代表新增测试已经实际执行通过。
