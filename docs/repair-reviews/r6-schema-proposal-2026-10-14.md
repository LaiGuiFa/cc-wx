# R6-2/R6-3 状态与账号 Schema 校验建议

- 形成时间：2026-10-14 00:47（Asia/Shanghai）
- 审查对象：`E:\cc-wx-main` 当前工作区
- 范围：合法 JSON 但结构错误的 `runtime/<account>/state.json`、`accounts/<account>.json`，以及最小运行时校验方案
- 方式：只读源码阅读、调用关系追踪和静态兼容性/安全评估
- 限制：未修改业务代码；未安装或升级依赖；未提交 Git；未运行测试、typecheck、build 或真实数据迁移

## 结论摘要

当前工作区已经包含一版本地 type-guard 校验实现，R6-2/R6-3 的核心缺口不再是“完全没有校验”：

- `RuntimeStateStore` 在 `src/state/runtime-state.ts:329-414` 对顶层对象、字符串数组/映射、会话元素和 `pendingDeliveries` 做显式运行时检查；`sessions: [null]`、`activeSessionIds: []` 等输入会被拒绝。
- `listAccounts()` 在 `src/weixin/accounts.ts:125-165` 通过 `parseWeixinAccount()` 检查必需字符串字段、可选字符串字段和 `enabled` 类型；`{}`、`{"accountId":null}` 等账号文件会被拒绝，并包含文件路径与字段名。

因此，后续不应再引入大而全的迁移框架或把错误条目静默丢弃。最小方案是保留当前本地校验方式，补齐测试、错误分类和少量跨字段一致性检查；确认兼容现有文件格式后再决定是否增加备份/迁移。

## 1. 当前实现核对

### 1.1 RuntimeState

入口：`src/state/runtime-state.ts:54-59`。

`RuntimeStateStore` 使用 `readJsonFile<unknown>(paths.statePath, {})`，再将结果传给 `normalizeRuntimeState(value, filePath)`。当前校验特点：

- 顶层必须是非数组对象（`329-332`）；缺失字段仍按旧行为使用空数组/空对象默认值。
- `pairedSenderIds`、`processedMessageIds` 必须是字符串数组；重复值去重，处理过的消息仍限制为最后 1,000 个（`333-350`、`362-368`）。
- `contextTokens`、`activeSessionIds` 必须是“字符串值的普通对象”，数组和非字符串值被拒绝（`335-336`、`370-376`）。
- `sessions` 必须是数组，每项必须有 `id`、`senderId`、`title`、`workspace`、`createdAt`、`updatedAt` 字符串；可选 thread、preview、model、effort 必须为字符串，`streamReplies` 必须为布尔值（`378-397`）。
- `pendingDeliveries` 每项必须有 `id`、`senderId`、`text`、`createdAt` 字符串（`400-409`）。
- `lastActiveSenderId`、`syncKey` 如存在必须为字符串（`339-344`）。

这是一种“结构错误即拒绝加载”的策略，而不是自动修复。它不会因为未知字段而拒绝文件，保留了未来字段向后兼容性。

### 1.2 WeixinAccount

入口：`src/weixin/accounts.ts:125-165`。

当前 `parseWeixinAccount()`：

- 顶层必须是非数组对象（`136-140`）。
- `accountId`、`token`、`baseUrl`、`cdnBaseUrl`、`savedAt` 必须是非空字符串（`141-145`）。
- `enabled` 缺失时按历史行为默认为 `true`；若存在则必须为布尔值（`146-148`、`163`）。
- `botId`、`userId`、`displayName` 可以缺失，但存在时必须为字符串（`149-152`）。
- 返回新对象而不是把未校验的 `Record<string, unknown>` 继续向下传递（`154-164`）。

该方案与现有登录/重扫流程兼容：`login.ts` 生成的账号包含必需字段，历史账号缺失 `enabled` 或可选标识时仍可读取。

## 2. 已确认的收益

### 2.1 目标异常输入被阻断

以下合法 JSON 现在不会继续流入业务层：

```json
{"sessions":[null]}
{"activeSessionIds":[]}
{"contextTokens":{"alice":123}}
{}
{"accountId":null}
{"token":"t","baseUrl":"https://x","cdnBaseUrl":"https://cdn.x","savedAt":"now"}
```

前两类分别会在 runtime state 读取时给出字段路径，后两类会在账号读取时给出必需字段错误。这样可避免 `listSessions()` 的 `updatedAt.localeCompare()`、会话查找、`WeixinApiClient` 构造等位置接收到错误类型。

### 2.2 错误上下文可定位

runtime 错误通过 `invalidRuntimeState(filePath, field)` 生成 `Invalid runtime state in <path>: invalid <field>`；账号错误通过 `Invalid WeChat account in <path>: ...`。错误上下文包含具体文件和字段，便于本地修复。

### 2.3 没有新增依赖耦合

项目虽然已有 `zod`（`package.json`），但当前实现使用本地 type guard，没有让状态层依赖 HTTP 层 schema 或引入新的运行时包。这符合“最小修改”和现有 state 模块的低依赖边界。

## 3. 仍需明确的边界与小幅改进

### R6-S1 · P2 · 缺少跨字段一致性校验

当前校验保证字段类型正确，但没有检查：

- `sessions` 的 `id` 是否唯一；
- `activeSessionIds[senderId]` 是否指向存在且 `senderId` 相同的 session；
- `contextTokens` 的 key 是否为空；
- `pendingDeliveries` 的 `id` 是否唯一。

这些不是本次“null/数组/缺字段”核心问题，但损坏文件仍可能形成不可见的活动会话或覆盖关系。建议下一小步只增加非破坏性检查：发现孤立 `activeSessionIds` 时删除该映射并记录警告，发现重复 session ID 或重复 delivery ID 时拒绝加载；不要在没有迁移策略时自动重写整个文件。

### R6-S2 · P2 · 账号字段语义尚未全部验证

`parseWeixinAccount()` 目前只验证非空字符串，没有验证 `baseUrl`/`cdnBaseUrl` 是否为合法 HTTPS URL、`savedAt` 是否为日期、`accountId` 是否与文件名一致。这是有意保持现有上游兼容性的保守选择：登录响应允许 redirect host/base URL，严格域名/协议校验属于另一项上游信任策略，不应混入本次 schema 修复。

建议本项先保持“类型+非空”边界；若后续要收紧 URL、时间或文件名约束，单独建立迁移/兼容测试，不要把该建议写成当前缺陷。

### R6-S3 · P2 · 失败策略是拒绝整个文件，需补产品文案和恢复路径

当前实现遇到一个坏账号文件时，`listAccounts()` 会抛错，`AccountManager.startAll()` 可能因此无法启动剩余账号；坏 runtime state 会使对应账号的 store 初始化失败。静态上这是明确且安全的 fail-closed 行为，但尚未有隔离启动或人工修复工具。

最小建议：

1. 保持拒绝加载，避免静默跳过账号或丢失消息状态；
2. 在上层把错误映射为“某文件结构损坏”的稳定用户提示，内部日志保留路径和字段；
3. 增加文档化的备份/移动坏文件后重试流程；
4. 暂不自动覆盖原文件，也不把非法数据归一化成空状态。

## 4. 推荐的最小实施顺序

当前源码已经有主实现，后续按以下顺序补齐即可：

1. **测试先行**：在 `test/runtime-state.test.ts` 增加 `sessions: [null]`、`activeSessionIds: []`、错误 `contextTokens`、缺字段 session 的拒绝测试；在 `test/accounts.test.ts` 增加 `{}`、`accountId: null`、非布尔 `enabled`、可选字段错误类型的拒绝测试。
2. **统一错误断言**：断言错误同时包含文件路径和字段名；不要依赖底层 `TypeError` 文案。
3. **补跨字段检查**：只处理 session ID/活动映射的一致性，保留未知字段和旧版缺省字段兼容。
4. **再做上层恢复策略**：决定 `startAll()` 遇到单个坏账号时是阻断启动还是隔离该账号；这是产品/运维合同，不应由底层 parser 隐式决定。
5. **受控验证**：在授权后运行 typecheck/test；本建议本身没有执行这些命令。

## 5. 安全评估

- 当前校验降低了错误类型导致的启动崩溃、状态错配和错误 token 传递风险。
- 未发现通过这些 JSON 字段可直接绕过 sender 授权的路径；`pairedSenderIds` 仍由业务层使用，若文件被本地攻击者修改，文件权限/本机信任边界仍是独立问题。
- 账号 token 仍存储在 JSON 中；schema 校验不提供加密或权限保护，不能把它描述为凭据安全修复。
- 错误消息仍可能由 `http-server.ts` 原样返回，绝对路径暴露风险需在 R6-4 单独处理。

## 6. 是否可继续

**可以继续，但建议先补测试和跨字段最小检查后，再把 R6-2/R6-3 标记为静态通过。** 当前主校验已经覆盖本任务点名的 `sessions/null`、`activeSessionIds` 数组和账号字段缺失场景；剩余工作主要是回归证据、失败恢复策略和字段间一致性，不需要引入新库或重写状态层。
