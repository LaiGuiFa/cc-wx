# 第 5 项修复审核结论：Codex 合同与跨平台验证基线

- 审查时间：2026-10-13 19:00:15 +08:00（Asia/Shanghai）
- 审查对象：当前工作区 R8“Codex 合同与跨平台验证基线”修复
- 审查方式：只读源码审查、调用链追踪、静态逻辑与跨平台路径分析
- 审查范围：`src/codex/app-server-runner.ts`、`src/codex/runner.ts`、`src/codex/exec-runner.ts`、`package.json`、app-server/exec fixture 与相关测试
- 限制：未修改业务源码；未安装或升级依赖；未提交 Git；未运行测试、typecheck、build、真实 Codex CLI 或 Windows/macOS 集成验证。因此本文是静态审核结论，不表示运行验证已通过。

## 结论摘要

本次 R8 修复已正确移除 app-server `initialize.clientInfo.version` 的硬编码值：
`src/codex/app-server-runner.ts` 会从当前项目根目录的 `package.json` 读取版本，
在读取失败或字段无效时使用 `"unknown"`。使用 `fileURLToPath(new URL(...))`
能够把 ESM 文件 URL 转换成当前操作系统可用的路径，路径中含空格、非 ASCII
字符或 Windows 盘符时不会依赖手写分隔符。基于源码，版本读取和 Windows 路径
转换逻辑没有发现确定性错误。

但 R8 不能标记为“完全闭合”。当前改动没有建立真实 Codex CLI 的协议兼容性
证据，也没有断言动态版本值的回归测试；协议字段、server-request 分支和
`resolveCodexCommand` 的 Windows fallback 仍由手写 fixture 和静态判断覆盖。
因此本项可继续后续维护，但应保留“需要受控 CLI smoke/跨平台 CI 后再关闭”的
验证缺口。

**是否可继续：可以继续。** 当前未发现必须立即返工的已确认 P1/P2 业务或安全
缺陷；建议把本项状态记为“静态通过，真实 CLI/跨平台验证待补”，不能把 fixture
通过等同于真实 Codex 版本兼容。

## 1. 已确认的正确修复

### 1.1 initialize 版本不再硬编码

位置：`src/codex/app-server-runner.ts:8、309-319、631-639`

- 模块加载时计算 `CLIENT_VERSION = readPackageVersion()`。
- `readPackageVersion()` 解析 `package.json.version`，当前仓库值来自
  `package.json:3`（`0.3.8`）。
- `initialize` 使用该值作为 `clientInfo.version`，不再固定为旧的 `0.2.0`。
- 读取失败、JSON 损坏或版本字段不是字符串时返回 `"unknown"`，不会因为元数据
  读取失败而在模块加载阶段抛出异常。

这使 npm 更新后的服务与其自身 package 版本保持一致，降低 app-server 日志或
能力协商中出现过期客户端版本的维护风险。`"unknown"` fallback 是可观察性降级，
不是权限绕过。

### 1.2 Windows URL 到文件路径的转换方式正确

位置：`src/codex/app-server-runner.ts:4、633-634`

`new URL("../../package.json", import.meta.url)` 先以 ESM URL 解析相对位置，再由
`fileURLToPath()` 转成 Windows 文件系统路径。该方式能够处理：

- Windows 盘符和反斜杠；
- URL 编码的空格或非 ASCII 文件名；
- 源码运行（`src/codex/app-server-runner.ts`）和构建后运行
  （`dist/codex/app-server-runner.js`）的同一层级关系。

当前 `package.json` 的发布入口为 `dist/server/index.js`，`dist/` 与 package 元数据
共存于包根目录；从源码静态路径关系看，`../../package.json` 在两种运行形态都
指向包根的 `package.json`。本次未执行打包或安装验证，故不把发布产物检查写成
运行事实。

### 1.3 app-server 子进程仍保持跨平台启动设置

位置：`src/codex/app-server-runner.ts:284-290`

app-server 使用 `resolveCodexCommand()` 后通过 `spawn(..., { shell: false,
windowsHide: true })` 启动；Windows 隐藏控制台窗口的行为有源码回归测试
`test/windows-hide.test.ts`。这项设置与版本读取修复没有冲突，也没有看到因
`fileURLToPath` 引入 shell 拼接或命令注入路径。

## 2. 已确认的维护缺口

### R5-A（P2，验证缺口）：动态版本没有回归断言

位置：`test/codex-app-server.test.ts:11-35`、`test/fixtures/fake-codex-app-server.mjs:38-52`

fixture 只检查 `clientInfo.name === "cc-wx"`，没有检查
`clientInfo.version` 是当前 `package.json.version`，也没有覆盖版本文件缺失或
读取失败的 `"unknown"` 分支。现有 app-server 测试因此只能证明 initialize
流程被发送，不能证明本次 R8 的核心修复不会回退到旧值。

这属于测试覆盖不足，不是已确认生产缺陷。建议导出一个纯路径/版本读取辅助函数
或在 fixture 记录 initialize 消息，再用当前 package 版本做断言；不要为测试修改
运行时 package。

### R5-B（P2，验证缺口）：真实 CLI 协议没有被验证

位置：`src/codex/app-server-runner.ts:284-325、366-455、572-598`；
`test/fixtures/fake-codex-app-server.mjs:38-228`

客户端手写了以下协议假设：

- `initialize` 省略 `jsonrpc` 字段，发送 `clientInfo` 与两个 capability；
- 之后发送 `initialized` 通知；
- 使用 `thread/start`、`thread/resume`、`turn/start`、`thread/read`、
  `thread/list`、`model/list`、`config/read`、`turn/interrupt`；
- 对 server-originated approval/input/tool 等请求返回本项目固定的拒绝或取消结果；
- 未识别的请求返回 `-32601`。

fixture 对其中一部分做了严格检查，但它是项目自定义进程，不能证明当前安装的
Codex CLI 或未来版本接受完全相同的字段名、枚举值、响应形状和 server-request
集合。当前没有真实 CLI smoke 记录，所以不能确认也不能断言存在某个具体版本
不兼容。

建议在受控临时工作区建立最小 smoke：initialize、new thread、resume、model/read、
history、interrupt、approval request、断线重连各跑一次，并记录 CLI 版本；失败时
优先修正协议适配，不要依赖 `auto` fallback 将协议错误静默转成另一种执行路径。

### R5-C（P2，现有行为）：exec 模式并不保证完全绕过 app-server

位置：`src/codex/runner.ts:42-61、72-82`；
`test/codex-app-server.test.ts:140-159`

当配置为 `backend: "exec"` 且调用传入 `onDelta` 或 `onProgress` 时，
`requiresAppServerForStreaming` 为真，代码仍调用 `this.appServer.run()`。此外，
历史、runtime 和模型列表始终调用 app-server（`runner.ts:72-82`），没有 exec
替代实现。测试明确锁定了“exec backend + streaming 使用 app-server”的现有语义。

这是已确认的产品契约，而不是本次 R8 引入的回归。它意味着文档或配置名称如果
被理解为“exec-only”，会产生误解；若后续要改变，必须单独设计兼容策略。当前
不建议在本项中擅自重构。

### R5-D（P2，现有边界）：`codexExecSandbox` 不约束 app-server

位置：`src/codex/runner.ts:30-39`、`src/codex/app-server-runner.ts:284-320`

`execSandbox` 只注入 `CodexExecRunner`。app-server 启动参数没有对应 sandbox
参数，turn 使用 `approvalPolicy: "never"` 并依赖 Codex 自身配置。因而同一全局
配置下，exec 路径和 app-server 路径的文件权限边界并不等价。这是代码明确表达的
行为，但是否造成实际越权取决于 Codex CLI 的默认 sandbox 和部署配置；本次没有
真实 CLI 运行证据，不能升级为已确认安全漏洞。

建议继续在设置页和 README 中明确“该配置只作用于 exec backend”；如果产品要求
两个 backend 一致，再单独确认 Codex app-server 的 sandbox 能力和兼容版本。

## 3. 跨平台兼容性评估

### 3.1 已确认无明显问题的部分

- `fileURLToPath` 是 Node ESM 下处理 `file:` URL 的标准转换方式；没有手工拼接
  Windows 盘符。
- app-server 和 exec 子进程均设置 `shell: false`，避免把路径或参数交给 shell
  解释。
- app-server 和 exec 均设置 `windowsHide: true`，与 Windows 无控制台窗口要求
  一致。
- `package.json.engines.node` 声明 `>=22`，使用的 URL、`structuredClone`、
  `Array.prototype.at` 等运行时能力与该下限相容。

### 3.2 潜在风险（未由当前代码单独证明）

1. `resolveCodexCommand()` 在 Windows 只有当 `CHAT_CODEX_BIN` 指向的 npm shim
   能推导出真实 `codex.js` 且文件存在时，才把命令改写为
   `node codex.js`（`exec-runner.ts:195-203`）。否则保留原始
   `codexBin`（例如 `codex.cmd`，`205`）。本项目没有在真实 Windows 主机上验证
   `spawn(..., shell:false)` 对用户自定义 `.cmd` 路径的行为，因此只能标记为
   兼容性风险，不能断言必然启动失败。
2. Windows resolver 的测试只覆盖“可找到 npm 安装的 `codex.js`”分支
   （`test/codex-exec.test.ts` 的 Windows shim 测试），没有覆盖 shim 缺失、显式
   `.cmd`、带空格路径、无 `CHAT_CODEX_BIN` 和实际子进程启动。
3. `readPackageVersion()` 将所有读取/解析错误静默转换为 `"unknown"`。如果发布产物
   意外遗漏 package 元数据，app-server 仍会启动，但诊断中缺少可追踪版本；当前
   `package.json` 会随 npm 包保留的发布事实尚未通过 `npm pack` 检查。
4. 真实 Codex CLI 在 macOS/Linux/Windows 的安装形态和 `app-server` 子命令能力
   没有版本矩阵；fixture 返回的 `platformFamily`/`platformOs` 只是固定测试值。

## 4. 安全风险评估

- 本次审查未发现由动态读取版本或 `fileURLToPath` 引入的路径注入、任意文件写入、
  命令注入或权限绕过。
- `readPackageVersion()` 只读取应用自身相对路径的 `package.json`，不接受 Web、
  微信或 Codex 输出作为路径输入。
- app-server 仍以 `shell:false` 启动，并通过结构化参数发送协议消息；版本读取
  不扩大用户可控输入面。
- 现有的 fallback 重复执行、共享 runner timeout、sandbox 语义不一致等风险仍
  存在，但属于 R3/R9 和既有 R8 边界，不能因本次版本修复而宣称已解决。

## 5. 测试与验证覆盖

### 当前已有

- `test/codex-app-server.test.ts` 覆盖 fake app-server 的 initialize、thread/turn、
  resume、history、model、interrupt 和 fallback 主流程。
- `test/codex-exec.test.ts` 覆盖 Windows shim resolver 的静态分支，以及 exec 参数
  拼装。
- `test/windows-hide.test.ts` 覆盖三个子进程入口含 `windowsHide: true`。

### 当前缺口

- 未断言 initialize 的 `clientInfo.version` 等于 `package.json.version`。
- 未覆盖 `readPackageVersion()` 的 package 缺失、无效 JSON、无效 version 分支。
- 未在 Windows/macOS/Linux 真实环境运行 app-server 或 exec。
- 未用当前实际安装的 Codex CLI 验证协议，未建立 CLI 版本兼容矩阵。
- 未验证 Windows `.cmd` fallback 分支的实际 `spawn` 行为。
- 本次未运行测试、typecheck、build、npm audit 或真实服务。

## 6. 最小改进建议

1. 增加一个不改变生产接口的版本回归断言，确保 initialize 上报当前 package
   版本；必要时将读取逻辑提取为可注入的纯函数。
2. 在 CI 中加入 Windows resolver/启动 smoke，至少覆盖 npm shim、显式 `.cmd`、
   带空格路径和 shim 不存在四种情况。
3. 记录受支持的 Codex CLI 版本与 app-server 能力矩阵；对真实 CLI 做隔离 smoke，
   不把 fixture 结果写成兼容性证明。
4. 在文档中明确 exec backend、streaming、history/model API 和 sandbox 的实际
   语义，避免“exec-only”或“统一 sandbox”误解。
5. 将未知 server request、协议错误、turn 已提交后的断线分别建模，避免依赖自动
   fallback 掩盖协议变化；此项与 R3 复审联动，不建议在本次版本元数据修复中扩大
   修改范围。

## 7. 是否可继续

**可以继续后续第 6 项。**

理由：

- 动态 package 版本读取和 Windows URL 路径转换的静态逻辑闭合；
- 未发现本次修复引入的确定性安全漏洞或确定性跨平台回归；
- R8 的真实 CLI/跨平台验证仍缺失，应保留在维护清单中作为验证任务；
- exec/app-server/sandbox 的既有语义已由代码和测试明确，不应在本项中未经确认
  进行扩大式改造。

