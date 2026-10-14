# 第 7 项修复审核结论：日志、前端刷新与依赖维护

- 审查时间：2026-10-13（Asia/Shanghai）
- 审查范围：R13/R14/R15 对应的当前工作区源码，重点是前端 `refreshData` 请求防重入，以及日志、依赖锁定和 Web 更新链路
- 审查方式：只读源码阅读、调用关系追踪和静态逻辑/安全边界检查
- 限制：未修改业务代码；未安装或升级依赖；未提交 Git；未运行测试、typecheck、build、npm audit、服务或真实更新流程

## 结论摘要

**第 7 项可以继续推进，前端刷新防重入的主路径静态通过。**

当前 `src/web/app.js` 已增加全局 `refreshDataPromise`：

1. 首个 `refreshData()` 调用创建 `refreshDataImpl(notify)` Promise；
2. 后续重叠调用直接复用同一 Promise，不再并发请求 `/api/accounts` 和 `/api/sessions`；
3. `finally` 清理引用，完成后下一轮刷新可以正常启动；
4. `refreshDataImpl()` 仍在 `Promise.all` 中同时请求两个只读接口，且只在两个结果都成功后更新前端状态。

静态审查没有发现该改动引入确定性的安全漏洞或 Promise 永久占用问题。日志落盘、依赖审计和更新供应链没有看到本次工作区新增的修复改动，以下仍按“现状风险/后续建议”记录，不能视为已经解决。

## 1. 已确认的正确修复

### 1.1 `refreshData` 已合并重叠调用

- 位置：`src/web/app.js:29-30, 292-300`
- `refreshDataPromise` 是模块级单一 Promise 槽位。
- 首次调用把 `refreshDataImpl(notify).finally(...)` 赋值给该槽位。
- 槽位存在时直接返回既有 Promise，因此 5 秒定时器、手动刷新按钮、登录确认后的刷新以及账号/会话操作后的刷新不会同时发起相同的刷新请求。
- `finally` 无论成功或失败都会清空槽位，异常不会使后续刷新永久停摆。

这是对原架构审查中“每 5 秒刷新但没有 in-flight 保护”的直接修复。

### 1.2 状态提交仍保持成对更新

- 位置：`src/web/app.js:302-328`
- 账号与会话请求使用 `Promise.all`；只有两者均成功时才写入 `state.accounts`、`state.sessions` 并触发列表渲染。
- 请求失败时，仅在 `notify` 为真时显示错误提示，不会把部分结果写入全局状态。
- `loadSelectedSessionMessages()` 自身用 `state.selectedSessionKey` 检查响应是否仍对应当前会话（`src/web/app.js:711-736`），因此刷新防重入不会取消或覆盖已切换会话的历史请求。

### 1.3 更新检查自身已有并发保护

- 位置：`src/web/app.js:138-149, 151-175`、`src/server/update-manager.ts:78-119`
- 前端分别用 `state.updateChecking`/`state.updateInstalling` 避免手动检查与安装重叠。
- 后端 `UpdateManager.check()` 通过 `checkPromise` 合并并发检查；`installLatest()` 用 `installing` 拒绝并发安装。
- 更新版本和 registry 在服务端经过稳定版本及固定 registry 校验，安装后由更新器验证版本和入口文件（`src/server/update-manager.ts:165-182, 357-456`）。

这部分不是本次新增改动，但当前链路没有因 `refreshData` 修复而被破坏。

## 2. 已确认的现状限制（不是本次回归）

### R7-1（P2）：请求去重不是取消或响应版本控制

`refreshDataPromise` 只合并“同时发生”的刷新；它不会取消已经开始的请求，也没有按刷新序号校验旧响应。当前单一 Promise 槽位使同一时刻最多存在一个 `refreshDataImpl`，因此在该函数内部没有旧刷新覆盖新刷新的路径；但其他接口仍可能独立更新相同状态，且历史消息请求仅按 session key 判断，不按请求代次判断。

依据：

- `src/web/app.js:292-328`
- `src/web/app.js:711-736`

这属于后续可维护性和状态一致性边界，当前代码不足以证明存在可利用数据泄露。

### R7-2（P2）：`notify` 语义取决于首个调用者

如果后台定时器先创建了刷新 Promise，随后用户点击“刷新”，后续调用会直接复用后台 Promise，`notify=true` 不会补发“状态已刷新”或错误 toast，因为实际执行使用的是首个调用者传入的 `notify=false`。这是可观察的 UX 差异，不是数据正确性或安全缺陷。

依据：`src/web/app.js:292-299, 325-328`。

建议后续将提示行为从共享请求 Promise 中解耦，或只让显式手动刷新在拿到复用 Promise 后自行决定提示；不建议在本项中扩大改动。

### R7-3（P2）：`loadSelectedSessionMessages` 仍可能重复请求

`refreshDataImpl()` 在会话 `updatedAt` 变化时调用 `void loadSelectedSessionMessages()`（`src/web/app.js:312-321`），而手动刷新按钮和会话选择也可调用同一函数。该函数没有 in-flight Promise 槽位；它通过 session key 防止旧会话写入，但同一会话的多个历史请求仍可能重叠。

当前未确认其会造成错误状态覆盖：后端通常返回完整历史，且请求响应会重新检查 `selectedSessionKey`。但这不是“所有前端刷新类请求都已防重入”，应列为后续测试/改进项。

## 3. 日志与错误可运维性

### 已确认现状

- `src/state/paths.ts:17,29,41` 定义了 `logsDir`，但当前源码未发现对应日志文件创建、轮转或结构化 logger 实现。
- 运行日志主要使用 `console.log`/`console.warn`/`console.error`，例如 `src/weixin/monitor.ts:52-85`、`src/bridge/service.ts:391-528`、`src/server/index.ts:45-94`。
- 多处错误直接把 `error.message` 返回 Web 或微信，例如 `src/server/http-server.ts:83-85, 642-643`、`src/bridge/service.ts:448`。这可能暴露本地路径、上游响应或命令信息，具体敏感程度取决于错误来源。

### 判断

这是 R13 中仍存在的可运维性/信息暴露风险，但本次未发现新增日志实现或错误处理改动，不能声称已修复。由于服务绑定 `127.0.0.1`，远程可利用性尚未由源码证明；本机多用户、浏览器页面或微信授权用户场景仍值得收敛。

建议后续：

1. 明确区分用户可见错误和内部日志错误，避免直接回传底层路径/命令；
2. 再考虑以现有 `logsDir` 为边界增加结构化、轮转和敏感字段脱敏；
3. 为错误分类和日志保留期限增加测试/运维说明。

## 4. 依赖与更新维护

### 已确认现状

- `package.json` 声明 Node `>=22`，依赖使用 caret 范围；`package-lock.json` 为 lockfile v3，并记录 resolved URL 与 integrity。
- 当前快照没有 `node_modules`；本次未执行 `npm audit`，因此不能判断依赖是否存在已知漏洞或是否可直接升级。
- 没有发现 CI workflow、依赖自动更新配置或覆盖率门禁；`package.json` 只提供 `test`、`typecheck`、`build` 等本地脚本。
- 更新器固定允许 `registry.npmjs.org` 和 `registry.npmmirror.com`，并检查稳定三段版本；安装参数包含 `--no-save`、`--package-lock=false`、`--no-audit`、`--no-fund`（`src/server/update-manager.ts:8-10, 200-239`）。

### 安全判断

- registry allowlist、严格版本解析和安装后版本/入口校验降低了任意 registry/版本注入风险。
- 仍没有项目级回滚或完整性证明；npm 包及 registry 本身仍是供应链信任根。安装超时通过 `child.kill()` 结束子进程，但源码未证明能终止所有子进程树。
- 这些是潜在供应链/恢复风险，不能在未运行更新流程和审计工具的情况下定性为已确认漏洞。

建议后续：

1. 在隔离环境补做 `npm audit`、锁文件一致性及最小权限安装验证；
2. 增加更新失败后恢复/重启失败测试；
3. 在不改变现有 registry 策略前提下补充更新器的供应链和进程树边界说明。

## 5. 测试与验证边界

本次未运行任何测试、构建、typecheck、npm audit、服务或真实网络集成。静态上可见：

- `test/update-manager.test.ts` 覆盖 registry 选择、并发检查合并、版本校验和跨平台命令构造；
- 未见针对 `src/web/app.js` 的浏览器单元/E2E 测试，因此 `refreshDataPromise` 的定时器/手动点击交错行为尚未由自动化测试证明；
- 未见日志脱敏、日志轮转、依赖漏洞门禁或更新失败恢复的自动化覆盖。

## 6. 安全风险评估

未发现本次前端 Promise 去重改动引入认证绕过、任意文件访问、XSS 或命令执行路径。主要剩余风险为：

- 用户提示与共享刷新 Promise 的时序差异；
- 历史消息请求仍可能重复；
- 底层错误消息和日志的过度暴露；
- 依赖/更新供应链缺少动态验证与回滚。

这些结论均基于静态代码分析，不能替代运行时验证。

## 7. 是否可继续

**可以继续下一项。**

理由：

1. `refreshData` 的 in-flight 合并逻辑闭合，成功/失败均释放槽位；
2. 当前未发现因该改动导致的确定性状态覆盖或安全回归；
3. 日志、依赖和更新方面的问题仍是后续维护建议，不阻塞继续处理其他修复项；
4. 后续应优先补充前端交错刷新测试、错误脱敏策略和更新失败恢复验证。

