# R2 修复审核结论：文件回传权限范围

- 审查时间：2026-10-13 18:02（Asia/Shanghai）
- 审查对象：当前工作区 R2“文件回传权限范围”修复
- 审查方式：只读源码审查、调用链追踪、静态逻辑与安全边界检查
- 审查范围：`src/weixin/media.ts`、`src/bridge/service.ts`、`src/server/account-manager.ts`、`src/server/http-server.ts` 及相关测试
- 限制：未修改业务源码；未安装或升级依赖；未提交 Git；本次未运行测试、构建、服务或真实微信/Codex 调用。因此以下“通过”仅表示静态审查结论，不代表运行验证通过。

## 结论摘要

R2 已基本完成预期的最小权限收敛：

1. `isAllowedLocalFile` 先确认目标是普通文件，再将目标文件与允许根目录都解析为 realpath，并使用 `path.relative` 判断是否位于允许根目录内。
2. 微信发送路径在 `BridgeService.sendLocalMedia` 和 `sendLocalMediaFile` 两层检查允许根目录，越界或非普通文件会被拒绝。
3. Web 历史解析不再把任意 assistant 输出路径直接作为附件；assistant `send` 动作只有通过 `isAllowedLocalFile` 才会标记为可用并生成附件地址。
4. Web 下载入口使用账号、session、消息和附件索引定位历史附件，不接受请求方直接传入任意本机文件路径。

静态审查未发现 R2 修复引入的确定性越权路径。测试文件包含普通文件、外部文件和符号链接拒绝用例，也覆盖了 Web 附件的作用域 URL 和 Range 响应；但未运行这些测试，且仍缺少若干竞态、配置收缩和 HTTP 负向场景测试。

**结论：R2 静态审核基本通过，可以继续下一项；但应把下述 TOCTOU 和测试缺口列为后续维护事项。**

## 1. 已确认的正确点

### 1.1 realpath 与普通文件校验

`src/weixin/media.ts:72-90` 的 `isAllowedLocalFile`：

- 先通过 `fs.statSync(filePath).isFile()` 拒绝目录等非普通文件；
- 使用 `fs.realpathSync(filePath)` 解析符号链接后的真实目标；
- 对每个允许根目录使用 `fs.realpathSync(root)`；
- 通过 `path.relative(rootRealPath, fileRealPath)` 判断目标是否为根目录本身或其后代；
- 任一 `stat`/`realpath` 失败都会返回 `false`。

因此，在一次完整校验调用内，指向允许根目录外部的普通文件、目录和符号链接目标不会通过。`test/media.test.ts` 中的测试显式创建了允许根目录外文件和指向外部文件的符号链接，并断言两者被拒绝。

### 1.2 微信发送链路有入口和底层双重校验

`src/bridge/service.ts:433-446` 在解析 Codex 动作后先检查 `isAllowedLocalFile`。不满足条件时仅向微信回复拒绝信息，不进入上传。

`src/weixin/media.ts:277-289` 的 `sendLocalMediaFile` 再次检查 `allowedRoots`，之后才执行 `fs.readFileSync`、计算摘要、加密和 CDN 上传。即使未来有其他调用方直接使用底层函数，只要传入 `allowedRoots`，仍有同一范围保护。

当前生产调用方传入 `this.options.config.allowedWorkspaces`，因此文件回传范围与配置中的允许工作区一致，而不是与 Codex 输出的任意绝对路径一致。

### 1.3 Web 历史只暴露作用域附件元数据和索引 URL

`src/server/account-manager.ts:348-368` 的 `getSessionMessages` 会移除内部 `path` 字段；`getSessionAttachment` 只接受 `accountId + sessionId + messageId + attachmentIndex`，并重新读取对应 thread 历史后定位附件。

assistant 历史附件在 `src/server/account-manager.ts:382-386` 先经过 `isAllowedLocalFile`，只有仍位于当前允许工作区且仍是可读取普通文件的动作才进入附件列表。用户消息中的本地附件则先通过 `isPathWithin(inboundRoot, ...)` 限制到当前账号的 inbound 目录，再由 `sessionAttachment` 计算可用状态。

`src/server/http-server.ts:580-601` 生成的 URL 仅包含账号、会话、消息和索引；浏览器响应不会返回本机绝对路径。下载请求在 `src/server/http-server.ts:246-267` 重新调用 `getSessionAttachment`，而不是根据 URL 中的任意路径读取文件。

### 1.4 HTTP 文件响应仍有普通文件检查

`src/server/http-server.ts:604-613` 在打开流前执行 `fs.statSync(attachment.path)` 并要求 `stat.isFile()`。Range 解析、`Content-Length`、`Content-Range` 和 `Content-Disposition` 均基于该文件的当前大小，避免目录被当作文件直接返回。

`test/http-server.test.ts` 的附件用例覆盖了作用域 URL 格式和视频 Range 响应；`test/account-manager.test.ts` 覆盖了 Codex 发送的视频历史附件、附件索引越界和 Web 上传附件的路径隔离。

## 2. 已确认的剩余问题

本次未发现可在静态代码中直接证明的 R2 越权漏洞。以下是已确认的实现限制，影响测试完备性和长期维护，不应夸大为已经可利用的安全缺陷。

### R2-A（P2）：校验与读取/发送之间存在 TOCTOU 窗口

证据链：

1. `sendLocalMediaFile` 在 `src/weixin/media.ts:286-289` 先调用 `isAllowedLocalFile`，随后以原始 `input.filePath` 执行 `fs.readFileSync`。
2. Web 下载在 `getSessionAttachment` 中完成一次允许性判断后，`serveSessionAttachment` 又以路径调用 `statSync` 和 `createReadStream`（`src/server/http-server.ts:604-639`）。
3. 如果拥有本机文件系统写权限的其他进程在两次操作之间替换文件或符号链接，实际读取对象可能与校验时对象不同。

这是典型的检查后使用竞态。当前代码没有提供攻击者模型、并发文件替换测试或文件描述符级锁定，因此不能据此确认实际可利用性。对单用户本机服务而言，利用前提通常要求攻击者已经能够修改允许工作区中的目录项。

建议后续在风险可接受时采用“打开后基于同一文件描述符读取”的策略，或在上传/下载前后再次检查 realpath 和 inode/size；不要为了 R2 立即进行大范围重构。至少增加受控的替换竞态测试并记录平台差异。

### R2-B（P2/P3）：HTTP 流式发送未在打开后重新确认 realpath

`serveSessionAttachment` 的 `statSync` 只确认当前路径是普通文件，没有重复执行 `isAllowedLocalFile` 或 realpath 校验；其安全前提依赖 `AccountManager.getSessionAttachment` 返回的路径仍未被替换。该问题与 R2-A 属同一竞态族，单独修复可能造成重复逻辑。

建议统一附件打开策略，避免 `getSessionAttachment` 返回裸路径后再由 HTTP 层二次打开。若暂时保留现状，至少补充“路径被删除、替换为目录、替换为外部符号链接”的请求级负向测试，并把结果标记为平台相关的防御性检查。

## 3. 潜在风险与边界

### 3.1 配置允许根目录是能力边界

`allowedWorkspaces` 允许用户配置任意目录；当用户明确把桌面、下载目录或更宽目录加入白名单时，当前实现会按配置允许回传其中的普通文件。这是既有功能语义，不应在审查中写成绕过。R2 修复收紧的是“未在白名单内的路径”，不是强制沙箱或敏感目录策略。

### 3.2 Codex 仍可读取超出回传范围的文件

本修复只约束“桥接层自动回传/浏览器附件下载”。Codex app-server/exec 的实际沙箱和工作区读取能力由 Codex 配置及运行参数决定；`isAllowedLocalFile` 不能替代 Codex 自身沙箱，也不阻止 Codex 在允许的执行权限内读取文件并将内容写入文字回复。

### 3.3 Web GET 接口使用本机信任边界

附件 GET 请求不要求 `X-Cc-Wx-Token`，与其他只读本地 API 一致；服务仅绑定 `127.0.0.1`，且请求 Host 受限。该设计依赖本机浏览器/本机进程信任边界，不应表述为通用远程认证下载接口。本次没有做跨站浏览器或本机恶意进程测试。

### 3.4 当前配置收缩会影响历史附件可用状态

历史读取使用当前 `configProvider().allowedWorkspaces`。如果用户从配置中移除某个工作区，旧历史中的附件会保留文本/名称但变成不可用，且不再生成下载 URL。这符合最小权限方向，但属于兼容性行为变化，建议在维护文档和 UI 中保持明确。

## 4. 测试覆盖与验证边界

### 已有静态覆盖

- `test/media.test.ts`：普通文件接受、工作区外文件拒绝、外部符号链接拒绝；微信图片/视频上传协议。
- `test/account-manager.test.ts`：Web 上传附件保存与历史展示；Codex 发送附件进入历史；附件索引越界拒绝。
- `test/http-server.test.ts`：作用域附件 URL、Range 响应、附件下载路由集成路径。

### 未覆盖或本次未验证

- 本次未运行 `npm test`、`npm run typecheck`、`npm run build`、`npm audit`。
- 未验证 Windows junction、UNC 路径、大小写/大小写不敏感文件系统和根目录本身为符号链接的行为。
- 未验证“校验后替换路径”的 TOCTOU 场景。
- 未见针对 `BridgeService` 明确断言越界动作只发送拒绝消息、且不调用 CDN/微信上传的回归测试。
- HTTP 测试中的 manager 是手写 mock，不能独立证明真实 `AccountManager.getSessionAttachment` 的历史过滤逻辑。
- 未见对配置收缩后旧历史附件 URL 消失、文件被移动后仅保留元数据等边界的完整 HTTP 测试。

## 5. 安全影响评估

R2 对原先“Codex 输出绝对路径即可触发桥接发送或 Web 附件暴露”的风险进行了实质收敛：

- 越界文件和符号链接目标在微信发送前被拒绝；
- Web 历史不会直接传递本机路径；
- 下载 URL 由历史记录中的附件索引生成，不接受任意路径参数；
- 文件已不存在或不再满足允许性检查时不会生成可用附件。

剩余风险主要是本机文件系统竞态、白名单配置过宽和本地服务信任模型，静态证据不足以将其定性为当前已确认的越权漏洞。

## 6. 建议

1. **短期**：补充 BridgeService 越界发送负向测试，验证拒绝分支不会调用 `sendLocalMediaFile` 或 CDN。
2. **短期**：补充 AccountManager/HTTP 真实链路测试，覆盖 assistant 越界路径、符号链接路径、文件移动和配置收缩。
3. **中期**：评估以文件描述符为中心的打开/读取方案，降低 `isAllowedLocalFile` 后再次按路径读取造成的 TOCTOU。
4. **中期**：为 Windows junction、UNC 和大小写差异建立受控兼容测试；测试不可用平台时应明确 skip 原因。
5. **长期**：记录 `allowedWorkspaces` 的安全语义和“用户主动扩大白名单即扩大回传能力”的兼容性说明。

## 7. 是否可继续下一项

**可以继续下一项。**

理由：

- R2 的核心目标已在微信发送和 Web 历史/下载两个主要入口落地；
- 静态审查没有发现确定性的路径越权；
- 剩余 TOCTOU 属于已有路径校验模型的防御性增强，不阻塞后续维护项；
- 测试和竞态增强应进入后续维护计划，不应在本次审查中伪称已经验证。

