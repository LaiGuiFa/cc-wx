# 第 4 项修复审核结论：资源生命周期与 QR 登录并发

**审查时间：** 2026-10-13（Asia/Shanghai）  
**审查范围：** `media.ts` 多附件失败回滚、`AccountManager` 删除账号时的 inbound 清理、`LoginManager` QR 记录生命周期/并发轮询/confirmed 时序。  
**审查方式：** 只读源码审查；未安装或升级依赖，未提交 Git，未执行测试、构建或运行服务。

## 结论摘要

本次修复已覆盖三个主路径：

1. `downloadInboundAttachments()` 对已经成功落盘的前序附件执行回滚删除。
2. `AccountManager.removeAccount(..., { retainHistory: false })` 删除账号状态目录和对应 `inboundDir`。
3. `LoginManager.poll()` 通过 `pollPromise` 合并同一 QR 会话的并发轮询，并在 `refreshAccount()` 成功后才写入 `confirmed` 账号结果。

基于当前源码，**未发现需要立即阻止继续开发的已确认高危回归**。第 4 项可以继续推进，但建议在后续补充生命周期测试后再视为完全收口。

## 已确认的正确修复

### 1. 多附件失败回滚有效

- 位置：`src/weixin/media.ts:110-140`
- 每个附件成功下载并写入后才加入 `downloaded`。
- 后续任意下载、解密、写盘失败时，`catch` 遍历已完成项并执行 `fs.rmSync(item.path, { force: true })`，随后重新抛出原始错误。
- 已有回归测试：`test/media.test.ts:316-339`，第二个附件返回 HTTP 500，并断言首个附件所在目录为空。

判断：主回滚路径逻辑闭合；删除失败被刻意忽略，以保留首个下载错误。这符合错误优先级，但意味着极端文件系统故障下可能残留孤立文件，属于潜在风险而非当前确认缺陷。

### 2. 彻底删除账号时会清理 inbound 文件

- 位置：`src/server/account-manager.ts:218-248`
- 删除前先停止账号并等待 `turnCoordinator.waitForSessions(...)`。
- `retainHistory: false` 时，删除账号记录后递归删除运行时状态目录，并递归删除 `accountStatePaths(...).inboundDir`。
- 保留历史时不会删除运行时状态或 inbound 目录，符合“重新扫码恢复会话历史”的产品语义。
- 已有回归测试：`test/account-manager.test.ts:157-178` 覆盖状态目录删除；源码同时覆盖 inbound 目录清理。

判断：与当前目录布局一致，`accountStatePaths()` 将 inbound 放在 `paths.inboundDir/<safeAccountId>`，清理目标明确，没有将共享 inbound 根目录作为删除目标。

### 3. QR 同一会话的并发轮询已合并

- 位置：`src/server/login-manager.ts:51-66`
- `record.pollPromise` 在第一次轮询时创建，后续并发请求等待同一个 Promise。
- `finally` 清空 Promise，使下一轮请求可以继续轮询。
- 对 `confirmed` 和 `expired` 结果直接返回缓存状态，避免重复访问微信登录接口。

判断：同一 `id` 的并发请求不会在正常执行期间同时调用 `record.session.poll()`。这解决了前端定时器或重复 GET 造成的 QR 状态请求重叠问题。

### 4. confirmed 状态写入时序已改善

- 位置：`src/server/login-manager.ts:68-76`
- 收到 `confirmed` 后先执行 `saveScannedAccount()`，再等待 `accountManager.refreshAccount(saved.account.accountId)`。
- 只有刷新成功后才写入 `record.account`，最后将 `record.status = update.status`。
- `saveScannedAccount()` 在复用旧账号/保留历史账号时返回规范化后的账号，测试断言结果使用旧 `accountId`。

判断：不会在账号尚未刷新成功时向前端报告成功。刷新失败会使本次 `poll()` reject，`record.status` 仍保持旧状态，允许后续请求重试；不过已写入磁盘的账号文件可能已发生变化，见潜在风险。

## 潜在风险与边界

### R4-1：QR 会话记录没有过期回收

- 位置：`src/server/login-manager.ts:24-25, 39-45, 51-76`
- `sessions` 是进程内永久 `Map`。`expired`、`confirmed` 记录仅改变状态，不会从 Map 删除。
- 每次扫码都会生成新的 UUID；长期运行且频繁扫码时，Map 会持续增长，并保留 `WeixinQrLoginSession`、状态和账号对象。

影响：内存增长和过期登录记录累积。单次记录很小，短期不构成高风险；但这是确认存在的生命周期缺口。

建议：在返回 `expired`/`confirmed` 后保留短暂 TTL（例如数分钟）供前端最后一次 GET，随后删除；或增加定期清理任务。清理时需避免删除仍在执行的 `pollPromise`。

### R4-2：QR start 失败时没有显式 close/cancel 钩子

- 位置：`src/server/login-manager.ts:39-49`
- 当前 `start()` 只有在二维码生成成功后才将记录放入 Map，因此二维码生成失败不会留下 Map 记录。
- `WeixinQrLoginSession` 本身没有 abort/close API；如果底层 QR session 工厂在 `start()` 返回后持有网络资源，当前接口无法主动取消。

判断：根据当前 `createQrLoginSession()` 实现，`start()` 阶段请求已完成后没有后台轮询，因此未确认存在实际句柄泄漏。该项属于接口能力缺口，不能直接认定为泄漏。

### R4-3：confirmed 保存成功但 refresh 失败时存在磁盘/内存状态分离

- 位置：`src/server/login-manager.ts:68-76`
- `saveScannedAccount()` 在 `refreshAccount()` 之前写入账号文件。
- 如果 `refreshAccount()` 抛错，`record.status` 不会变为 `confirmed`，但账号 JSON 已保存为新凭据。
- 下次 `poll()` 会再次调用同一个 QR session；若微信端返回 confirmed 或已过期，行为取决于上游状态。重复保存通常幂等，但该组合没有专门回滚。

影响：前端可能暂时看到轮询错误，而磁盘上账号凭据已更新；服务重启后可能按新账号自动启动。当前不构成凭据泄漏，但会增加故障恢复复杂度。

建议：明确“保存账号”和“启动/刷新账号”的事务边界。最小改动可在 refresh 失败时保留 `record.status` 为 waiting 并记录可重试状态，同时增加测试验证重复 poll 不会破坏历史恢复；更强方案是先验证可启动，再提交账号持久化，但会涉及 AccountManager 接口调整。

### R4-4：删除账号等待 active session 列表的快照

- 位置：`src/server/account-manager.ts:225-228`
- 删除流程通过 `store.listSessions().map(...)` 获取一次会话 ID 快照，再交给 `turnCoordinator.waitForSessions(...)`。
- 当前 `continueSession()` 在删除开始后会被 `closingAccounts` 拒绝，且已有会话在快照中会被等待，因此代码路径下没有明显遗漏。
- 若未来新增不经过 `continueSession()` 的异步任务，快照机制可能无法覆盖新任务。

判断：这是扩展性风险，不是当前已确认缺陷。后续新增后台任务时应将任务注册到同一协调器。

### R4-5：回滚删除失败会留下残留文件

- 位置：`src/weixin/media.ts:130-137`
- 删除前序附件失败时，清理异常被吞掉，只保留原始下载异常。

影响：权限、杀毒软件占用或磁盘错误可能让部分附件残留在 inbound 目录。由于文件名含消息 ID，残留不会直接覆盖下一次下载，但会占用磁盘并可能保留敏感内容。

建议：保留当前错误语义，同时记录结构化 warning（不要将本地绝对路径回传给微信用户）；后续增加清理失败观测或周期性孤儿文件清理。

## 安全影响

- 多附件回滚降低了“失败请求留下已下载敏感附件”的残留面，但清理失败时仍可能保留文件。
- 账号彻底删除现在同步移除 inbound 文件，降低已删除账号附件被后续 Web API 读取的风险。
- QR 记录长期保留主要是资源和状态暴露面；当前 API 需要随机登录 ID，未发现仅凭代码即可绕过登录授权的路径。
- `confirmed` 结果不会在 `refreshAccount()` 失败前返回，降低前端误以为账号已可用的风险。

## 测试覆盖与缺口

现有测试已覆盖：

- 前序附件失败后的回滚目录为空：`test/media.test.ts:316-339`。
- 账号历史保留及彻底删除状态目录：`test/account-manager.test.ts:157-178`。
- QR 扫码复用旧账号及恢复保留会话：`test/login-manager.test.ts:12-119`。

尚未看到针对以下边界的专门测试：

1. 多个并发 `poll(id)` 只触发一次底层 `session.poll()`，并在 Promise 结束后恢复下一轮轮询。
2. `refreshAccount()` 抛错时 `record.status`、后续重试及账号文件状态。
3. `expired`/`confirmed` 记录是否按预期回收，及大量登录后的内存边界。
4. 删除账号时 inbound 目录中存在文件、保留历史与彻底删除的差异。
5. 回滚清理 `fs.rmSync` 失败时的日志/告警策略。

## 是否可继续

**可以继续。** 当前修复的主逻辑没有发现应立即返工的已确认错误。建议下一项工作前优先补充第 1、2、4 项测试；若项目暂不增加测试，至少在后续维护计划中记录 QR Map 回收和 refresh 失败的一致性问题。

## 审查依据

本结论基于静态阅读：

- `src/weixin/media.ts:110-171`
- `src/server/account-manager.ts:218-248, 472-495`
- `src/server/login-manager.ts:24-76`
- `src/weixin/login.ts:42-83`
- `src/state/paths.ts:21-42`
- `test/media.test.ts:316-339`
- `test/account-manager.test.ts:157-178, 339-366`
- `test/login-manager.test.ts:12-119`

