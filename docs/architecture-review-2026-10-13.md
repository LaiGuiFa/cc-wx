# cc-wx 架构与长期维护审查

- 审查日期：2026-10-13
- 文档整理时间：2026-10-14 01:32:00 +08:00
- 时区：Asia/Shanghai
- 项目版本：0.3.8（以本地 package.json 为准）
- 审查对象：E:\cc-wx-main 当前源码快照
- 审查方式：只读静态代码审查，核对文档、入口、关键调用链、状态持久化、前端、依赖锁文件及测试源码
- 操作范围：审查期间未修改业务源码、安装或升级依赖、启动项目、执行测试或构建、提交 Git；本文件是按用户后续要求新增的审查记录

## 1. 结论与证据边界

项目模块划分清楚，微信接入、桥接逻辑、Codex 后端、状态管理和本地 Web 管理基本分层。测试覆盖了多种协议与历史兼容行为，适合继续采用局部维护方式，不建议以本次审查为理由进行整体重构。

长期维护的主要薄弱点是会话任务的并发与中断语义、桥接进程的文件读取权限、附件和登录记录的生命周期，以及真实 Codex CLI 和跨平台运行验证。

本文采用以下分类：

- **已确认问题/行为**：可由当前源码直接确定；不代表已在真实环境复现。
- **潜在风险**：源码中存在触发条件或保护缺口，但实际影响仍取决于调用时序、外部协议、操作系统或部署配置。
- **改进建议**：有助于维护的措施，不自动视为当前缺陷。

优先级定义：P1 为应优先处理的安全或核心稳定性问题；P2 为后续维护版本应处理的可靠性和资源问题；P3 为运行边界、兼容性及维护体验问题。本文没有确认任何无需授权即可利用的公网攻击路径。

已阅读 README.md、package.json、CHANGELOG.md、目录结构、核心后端源码、前端 app.js 和 index.html、构建资源复制脚本及主要测试。文档说明与实现不一致时，以源码为依据。

本地目录没有 .git，无法提供 commit SHA、分支或 Git 差异基线。当前没有 node_modules 和 dist，本次未运行测试、typecheck、build、npm audit 或真实微信/Codex 集成测试，因此不声称这些检查通过，也不声称依赖没有已知漏洞。

## 2. 架构概览

### 2.1 模块关系

```text
微信 iLink API / CDN                   浏览器 Web UI
          |                               |
          v                               v
 WeixinApiClient / media          localhost HTTP API
          |                               |
          +------------ AccountManager ---+
                             |
              +--------------+----------------+
              |                               |
    每账号 monitorWeixin             Web 会话管理/继续聊天
              |
    每账号 BridgeService
       |      |       |
       |      |       +-- PromptBuffer
       |      +---------- AccessController
       +----------------- RuntimeStateStore（每账号）
              |
              +------------- HybridCodexRunner（管理器共享）
                                  |
                    +-------------+-------------+
                    |                           |
             app-server stdio             codex exec/resume
                    |
             Codex 自身 thread 历史
```

| 模块 | 实际职责 | 主要源码位置 |
| --- | --- | --- |
| 服务入口 | 参数、环境变量、进程锁、HTTP 启动、账号启动、退出与重启 | [server/index.ts](../src/server/index.ts)、[arguments.ts](../src/server/arguments.ts) |
| 账号管理 | 每账号 monitor、BridgeService、状态存储；Web 会话管理；共享 runner | [account-manager.ts](../src/server/account-manager.ts) |
| 微信登录 | 二维码申请、状态轮询、重定向、账号身份复用与凭据保存 | [login.ts](../src/weixin/login.ts)、[login-manager.ts](../src/server/login-manager.ts)、[accounts.ts](../src/weixin/accounts.ts) |
| 微信消息 | getupdates、同步游标、去重、归一化、错误隔离与退避 | [api.ts](../src/weixin/api.ts)、[monitor.ts](../src/weixin/monitor.ts)、[messages.ts](../src/weixin/messages.ts) |
| 桥接业务 | 授权、命令、prompt 缓冲、附件输入、进度与最终回复、媒体动作 | [service.ts](../src/bridge/service.ts)、[access.ts](../src/bridge/access.ts)、[prompt-buffer.ts](../src/bridge/prompt-buffer.ts)、[actions.ts](../src/bridge/actions.ts) |
| Codex 后端 | app-server 请求与通知、thread/turn、历史和模型；exec 回退 | [runner.ts](../src/codex/runner.ts)、[app-server-runner.ts](../src/codex/app-server-runner.ts)、[exec-runner.ts](../src/codex/exec-runner.ts) |
| 状态持久化 | 配置、授权、会话映射、同步 key、处理过的消息 ID；同步 JSON 写入 | [config.ts](../src/state/config.ts)、[runtime-state.ts](../src/state/runtime-state.ts)、[json-store.ts](../src/state/json-store.ts) |
| 附件传输 | CDN 下载/上传、AES-128-ECB、文件名清洗、落盘；Web multipart 和附件预览 | [media.ts](../src/weixin/media.ts)、[http-server.ts](../src/server/http-server.ts)、[account-manager.ts](../src/server/account-manager.ts) |
| Web API | 本地监听、Host/修改请求保护、账号/会话/配置/更新路由、NDJSON | [http-server.ts](../src/server/http-server.ts) |
| 前端 | 账号、会话、设置；周期刷新；Markdown；上传、进度流和更新重连 | [app.js](../src/web/app.js)、[index.html](../src/web/index.html)、[styles.css](../src/web/styles.css) |
| 更新 | 固定 registry 查询、版本检查、当前 npm runtime 更新、安装验证与重启 | [update-manager.ts](../src/server/update-manager.ts)、[restart.ts](../src/server/restart.ts)、[restart-helper.ts](../src/server/restart-helper.ts) |

### 2.2 状态和会话归属

默认数据根目录为 ~/.cc-wx；账号凭据与受管会话状态分开保存：

```text
accounts/<account-id>.json       微信 token、接口地址、身份、备注、启用状态
runtime/<account-id>/state.json  授权、context token、sync key、去重 ID、会话
inbound/<account-id>/            微信入站附件
inbound/<account-id>/web/...     Web 上传，按 session 和单次提交分目录
retained-accounts.json           账号恢复索引，不保存登录 token
config.json                     全局工作区及 Codex 配置
logs/                           路径已定义，未发现日志落盘实现
```

依据：state/paths.ts:20-42、weixin/accounts.ts:7-24、state/runtime-state.ts:7-51。

ManagedSession 保存 senderId、workspace、threadId 和会话级模型/推理强度/进度覆盖值。每个联系人有一个活动会话映射；聊天历史通过 Codex thread/read 获取，不由本项目独立保存全文。reset/delete 只改变本项目的映射，不删除 Codex 自身历史。

账号拥有独立的 monitor、BridgeService 和 RuntimeStateStore，但 AccountManager.runnerFor() 缓存的是一个共享 HybridCodexRunner（account-manager.ts:511-518）。因此账号状态隔离不等于 Codex 传输故障或资源占用完全隔离。

### 2.3 已实现的保护

- HTTP 绑定 127.0.0.1，并精确校验 Host；修改请求要求本地/缺省 Origin 与随机 request token（http-server.ts:61-91、113-130、432-442）。
- 未知微信联系人默认拒绝，管理页允许后才能触发 Codex（service.ts:48-59、access.ts:20-36）。
- publicAccount() 删除 token；保留账号索引只保存稳定身份及备注（accounts.ts:92-106、159-164）。
- Markdown 经 DOMPurify 清洗，禁止 style/img；外链加 noopener/noreferrer；服务设置 CSP、nosniff、frame 防护（app.js:1426-1443、http-server.ts:423-430）。
- 普通消息处理错误与单个轮询失败有隔离和退避；JSON 写入采用临时文件加 rename；正常关闭路径清理 runner（monitor.ts:38-93、json-store.ts:19-24、account-manager.ts:126-140）。

这些是源码确认的防护，未做浏览器攻击测试、操作系统权限审计或动态验证。

## 3. 关键调用链

### 3.1 服务启动和关闭

```text
server/index.run -> main
  -> resolveStatePaths
  -> acquireServiceProcessLock
  -> new AccountManager
  -> startLocalHttpServer
  -> AccountManager.startAll -> startAccount（启用账号）

SIGINT/SIGTERM
  -> stopAll -> stopAccount -> monitor AbortController.abort
  -> closeRunner -> HTTP close -> release process lock
```

源码：server/index.ts:10-73、server/process-lock.ts:15-53、server/account-manager.ts:120-211。stopAccount 等待 monitor task；它并没有把 abort 传播到当前 BridgeService 内的 Codex turn 和全部网络调用。

### 3.2 微信接入和身份恢复

```text
POST /api/logins -> LoginManager.start -> createQrLoginSession
GET /api/logins/:id -> LoginManager.poll -> WeixinQrLoginSession.poll
  -> confirmed -> saveScannedAccount -> AccountManager.refreshAccount
  -> 停止旧 monitor -> 使用刷新后的凭据启动 monitor
```

源码：http-server.ts:187-194、login-manager.ts:38-65、weixin/login.ts:50-105、weixin/accounts.ts:43-76。重复扫码按 bot ID、稳定 user ID 或唯一保留身份复用账号；多候选时不猜测匹配。

### 3.3 微信入站及消息处理

```text
monitorWeixin -> WeixinApiClient.getUpdates
  -> 保存下一 sync key
  -> normalizeWeixinMessage
  -> claimProcessedMessage（处理前持久化）
  -> BridgeService.handleMessage
      -> rememberContextToken -> requireAccess -> ensureActiveSession
      -> 命令，或下载附件/加入缓冲/执行 Codex
```

源码：monitor.ts:38-93、messages.ts:27-52、account-manager.ts:176-189、service.ts:48-79。**同一账号的 monitor 会 await 当前消息处理，不会并发处理后续轮询批次。** 不同账号及 Web 请求可以并发。

### 3.4 Codex 调用、中断和回退

```text
BridgeService.runCodexTurn / AccountManager.continueSession
  -> HybridCodexRunner.run
      -> AppServerCodexRunner.ensureConnected -> initialize -> initialized
      -> thread/start 或 thread/resume -> turn/start
      -> item/* -> turn/completed -> final text
      -> 异常时，auto（或允许回退的路径）调用 codex exec/resume

/stop -> HybridCodexRunner.stop -> app-server interrupt + exec kill
```

源码：service.ts:366-413、account-manager.ts:376-429、runner.ts:34-63、app-server-runner.ts:114-160、222-238、260-301。

实际行为：backend=exec 且有 onProgress/onDelta 时仍优先 app-server；历史、模型及 runtime 查询也依赖 app-server。codexExecSandbox 只传给 exec runner，app-server 使用 Codex 自身配置并设置 approvalPolicy=never，二者不能视为统一的 sandbox 控制。

### 3.5 附件和回传

```text
微信附件 -> media ref -> CDN fetch -> AES 解密（有 key 时）-> 本地文件
Web multipart -> 数量/总大小校验 -> 账号/session/UUID 目录
本地附件路径 -> buildPrompt -> Codex tools 读取

Codex final text -> parseActionBlocks（也提取本地 Markdown 链接）
  -> 微信：sendLocalMediaFile -> 加密上传 CDN -> 原生媒体消息
  -> Web：历史解析 -> 附件索引 URL -> 本地文件 stream/range 响应
```

源码：media.ts:90-140、257-325、http-server.ts:490-533、account-manager.ts:350-374、431-455、actions.ts:85-105、130-151。

### 3.6 前端和更新

bootstrap 返回 token、配置、Codex 状态及模型、账号、会话；前端每 5 秒刷新账号/会话。Web 发消息使用 multipart，可请求 NDJSON progress/done。更新由 Web 发起，UpdateManager 验证稳定版本和固定 registry，定位正在运行的 npm prefix，安装后验证 package 版本及入口，再启动 detached restart helper。

源码：http-server.ts:132-177、app.js:115-130、996-1065、200-256、update-manager.ts:89-114、357-456。

## 4. 风险清单与优先级

### R1 · P1 · 会话任务与状态变更缺少统一协调

**已确认行为**：Web continueSession 和微信 runCodexTurn 直接调用共享 runner；respondingSessions 是计数器而非锁。Web activate/reset/delete 在执行中也没有忙状态保护（account-manager.ts:305-328、376-429、500-513；service.ts:366-397）。

**代码可确定的条件性问题**：微信任务记录开始时的 session，但完成时使用 setThread(senderId)，该方法写入“当时的活动会话”。若用户从 Web 在等待期间切换活动会话，旧任务的 thread 会写入新活动会话（service.ts:367、396-397；runtime-state.ts:128-139）。

**潜在影响**：两个 Web 标签页、直接 API 或 Web/微信交错可能为无 thread 的同一会话创建不同 thread；既有 thread 的并发行为取决于 CLI，可能乱序或拒绝。删除会话后任务仍可能继续或保存失败。不同微信账号可并发，但同一账号的 monitor 本身串行。

**建议/验证**：以 accountId+sessionId 串行协调两条入口；返回按开始时的 sessionId 写回，复用已有 setSessionThread；执行中切换/reset/delete 明确采用拒绝或等待策略。验证 Web/微信交错、两个 Web 提交及任务期间切换会话，检查 thread 归属。

### R2 · P1 · 自动文件回传没有桥接层权限范围检查

**已确认行为**：动作只校验绝对路径，包括 Windows/UNC 路径；本地 Markdown 链接也会转为发送动作。微信发送直接 fs.readFileSync(path)；Web 助手附件通过 stat 判断可用后提供下载，不检查 workspace 或真实路径范围（actions.ts:29-52、85-105；service.ts:399-425；media.ts:265；account-manager.ts:369-370、551-571）。

**潜在影响**：桥接进程按自身 OS 权限读文件，无法仅依赖 Codex sandbox 约束。若 Codex 输出了敏感绝对路径，可能自动外发或成为 Web 附件；并非已确认任意未授权联系人可以利用。支持发送下载目录/桌面文件属于已有功能，简单限制为 workspace 会改变行为。

**建议/验证**：先明确当前授权用户需要的发送范围，再以最小策略限制目录、普通文件、大小及 realpath，兼顾原有回传功能。用工作区外文件、敏感目录和符号链接验证，避免仅依靠 prompt 指令。

### R3 · P1 · 中断、失败和自动重试语义不可靠

**已确认行为**：同账号 monitor 等待整个 Codex turn，因此微信 /stop 无法在该账号任务仍执行时被 monitor 处理（monitor.ts:61-87；service.ts:113-115）。runner 的 catch 对所有 app-server 异常回退 exec，包括 interrupted 和已执行部分任务后的失败（runner.ts:39-53；app-server-runner.ts:497-501）。app-server stop 在指定 thread 不活跃时会选择共享 activeTurns 的最后一项（app-server-runner.ts:227-232）。

**潜在影响**：中断后重新执行、部分成功任务重复产生副作用；停止不活跃会话可能波及其他账号的活动任务。请求或 turn 超时还会 failTransport，终止共享 app-server 的所有 pending/waiter（app-server-runner.ts:311-315、469-473、576-603）。

**建议/验证**：区分启动/握手失败、执行失败、中断；仅在确认任务未开始时自动回退。明确任务所属账号/session/turn，未知目标不回退到其他任务；让控制命令可及时处理。验证中断不产生 exec 重跑，单账号 stop 不影响另一账号。

### R4 · P2 · 消息确认时点和回复补偿存在缺口

**已确认行为**：先保存 batch sync key，再逐条处理；处理前 claimProcessedMessage 即持久化 ID，失败后没有撤销 claim。pendingDeliveries 虽定义和加载，但没有写入、消费或恢复逻辑（monitor.ts:45-48、72-85；runtime-state.ts:35-40、104-112、340）。stale context 的回复失败只记录警告并返回（service.ts:497-508）。

**潜在影响**：服务在批次中退出，或 Codex/发送失败后，消息可能无法自动恢复；是否重新下发依赖微信游标协议。不能把 claim 等同于业务成功，也不宜直接自动重试可能已修改文件的 Codex 任务。

**建议/验证**：明确接收、执行、回复完成三个状态；优先保存可恢复的最终回复，避免重跑业务。模拟批次中途退出、sendText 失败和旧 context，核对重启后行为。

### R5 · P2 · 附件内存、磁盘与失败清理缺少全局边界

**已确认问题/行为**：微信多附件逐个写盘，后续失败时不回滚之前文件；BridgeService 未获得完整结果就进入错误处理。入站 response.arrayBuffer 在读取完成后检查大小；出站同步全量读取、加密，没有对应出站大小限制。Web 上传亦全量解析并生成 Buffer（media.ts:97-109、132-140、174-192、265-268、336；service.ts:329-351；http-server.ts:470-530）。

**潜在影响**：缺失/不可信 Content-Length 时，100 MiB 限制无法阻止读取阶段的内存增长；明密文、多次复制、多账号并发使峰值叠加。失败、缓冲超时和会话删除后可留下孤立附件。removeAccount(false) 删除 runtime 目录，没有删除 inbound 目录（account-manager.ts:214-229）。保留附件可能是策略，但应与“彻底删除”文案明确对齐。

**建议/验证**：先增加读取过程上限、出站 stat/size 检查和并发限制；清理本次失败文件，再设计可预览的 TTL/容量策略，避免删除仍被历史引用的文件。验证分块超限、第二附件失败、大文件并发和账号删除的数据范围。

### R6 · P2 · 登录记录无限保留且轮询可能重入

**已确认问题**：LoginManager.sessions 只 set/get，不删除 confirmed/expired，也没有容量上限；二维码渲染失败时记录已经插入（login-manager.ts:24、38-65）。

**潜在风险**：前端每 1.8 秒发一次 poll，没有 in-flight 保护，后端 poll 在 await 前也不设置互斥。网络慢时并发轮询可能重复保存凭据和 refreshAccount；终态在账号刷新成功前就写入，刷新失败后的重试可能直接返回 confirmed（app.js:1161-1200；login-manager.ts:50-65）。

**建议/验证**：到期/终态后限时淘汰，失败撤销记录；复用同一 poll Promise；确认账户刷新成功后再提交终态。验证慢响应、重复 poll、刷新失败和反复创建二维码。

### R7 · P2 · 状态持久化的恢复和多实例快照风险

**已确认行为**：同步临时文件加 rename，未做 fsync、备份或残留临时文件清理；JSON 损坏会抛错，账号文件基本使用类型断言，sessions 等内容缺少逐项 schema 校验（json-store.ts:8-24；accounts.ts:125-131；runtime-state.ts:329-342）。启动多账号时一个坏文件可能使 startAll 失败。

**潜在风险**：未启动账号的 storeFor 每次可能新建 RuntimeStateStore；异步 Web 请求可持有不同内存快照，任务完成后的整体写回可能覆盖期间修改（account-manager.ts:387-411、477-480）。正常单进程、共享 store 的同步修改不会因为“没有锁”就自动产生竞争；临时文件同毫秒命名本身也不是已证实缺陷。

**建议/验证**：先统一账号 store 实例，逐项 schema 校验并报告可恢复错误；再评估备份/版本和耐久性。验证停止账号上的 Web turn 与改名/配置交错、损坏 JSON、rename 失败和异常退出恢复。

### R8 · P2 · CLI 协议与后端配置存在维护缺口

**已确认行为**：initialize 上报版本硬编码 0.2.0；协议字段和 server request 处理手写，未知请求返回 -32601。backend=exec 且传 progress 时仍用 app-server；历史/模型查询没有 exec 替代；codexExecSandbox 不控制 app-server（app-server-runner.ts:284-295、373-455、529-566；runner.ts:23-76）。

**潜在风险**：fixture 证明的是项目自定义协议假设，没有证明当前/未来真实 CLI 兼容。模型/effort 元数据缓存和提供方手工模型列表也可能漂移。不能据此确定某个真实 CLI 版本已不兼容。

**建议/验证**：记录支持的 CLI 版本和能力，使用 package 版本做 initialize 元数据；明确 exec/progress/sandbox 的实际语义。以受控环境验证新建、resume、模型、历史、中断、approval 与断线，不使用自动回退掩盖执行失败。

### R9 · P2 · 网络调用缺少统一截止时间和取消传播

**已确认行为**：getupdates 接收 monitor AbortSignal，但发送文本/typing/上传接口没有传入统一超时；登录 GET、CDN fetch 也未设置服务层截止时间。typing 定时器每 5 秒启动一次调用，不等待上次结束；finishTurn 在清除 turn 定时器后等待 progress callback chain（api.ts:26-32、205-239；login.ts:146-155；media.ts:180、337；service.ts:429-451；app-server-runner.ts:452-454、486-488）。

**潜在影响**：网络缓慢时 typing 请求叠加；send/上传或 progress 不结束可延长任务甚至阻塞正常关闭。stopAll 先等待 monitor，之后才 closeRunner，不能保证立即终止正在处理的微信任务（account-manager.ts:126-130、203-210）。没有应用级 timeout 不等于底层永远不会超时。

**建议/验证**：为操作建立合理截止时间，传播账号/任务取消信号，typing 保证单个在途请求；定义有截止时间的退出流程。用永不结束的 mock fetch 和慢 progress 验证关闭。

### R10 · P3 · 工作目录白名单不是完整的文件权限边界

**已确认行为**：isWorkspaceAllowed 用 resolve/relative 判断，没有 realpath；只在 bind/create 时检查，已有会话继续执行时未重新验证白名单（config.ts:70-77；service.ts:122-133、372-383；account-manager.ts:287-296、397-400）。

**潜在影响**：symlink/junction 指向列表外；收缩允许列表后，既有会话仍沿用旧 workspace。该列表目前约束 cwd 选择，不能当作 Codex 所有文件读取权限的完整边界。

**建议/验证**：说明白名单语义，验证目录实际存在和真实路径，决定配置变更后旧会话是否冻结/重新授权。避免将此策略与 R2 的文件回传策略混为一谈。

### R11 · P3 · 本地 Web 信任边界与 GET 副作用

**已确认行为**：普通 GET 不要求 token，bootstrap 返回 token；Origin 校验主要用于修改请求。GET 登录 poll 确认时会写凭据并刷新账号。bootstrap/runtime/model 查询还可能启动 Codex 子进程（http-server.ts:113-150、191-194；login-manager.ts:60-63）。

**潜在风险/边界**：本机进程可以读取管理 API，不能视为用户认证；HTTP 未开放 CORS，外部网页能否读返回值受浏览器同源策略限制，不能推断为已确认跨站 token 窃取。QR session UUID 也限制了已知 session 的访问。

**建议/验证**：保留 localhost、Host、token、CSP；若将来有远程管理需求，单独设计认证。验证非本机 Host/Origin、缺失 token、读取接口和扫码 GET 的实际副作用。

### R12 · P3 · 子进程和文件响应资源回收仍需验证

**已确认行为**：exec/app-server timeout 与 close 使用 child.kill，未等待整个进程树退出；exec stdout/stderr 和 app-server turn raw events 没有统一大小上限。附件 read stream 仅绑定自身 error，未显式在响应 close 时 destroy（exec-runner.ts:89-110、118-128；app-server-runner.ts:504-513、576-603；http-server.ts:638-647）。

**潜在影响**：派生子进程残留、长输出内存增长、客户端中断下载后的资源持续占用。实际表现依赖操作系统、CLI 和 stream 时序，未确认真实泄漏。

**建议/验证**：限定输出与事件缓存；明确进程终止/等待和断连 stream 清理。进行派生进程、超时和 Range 下载断连测试。

### R13 · P3 · 日志和错误信息的可运维性不足

**已确认行为**：logsDir 仅定义，日志输出到 console；普通微信错误使用脱敏文案，但媒体发送失败直接回传底层 error.message，Web API 也返回底层错误。fallback 警告拼入最终答案（paths.ts:29、41；monitor.ts:52、81；errors.ts；service.ts:425；http-server.ts:83-85；runner.ts:50-53）。

**潜在影响**：错误可能包含路径或上游响应信息；日志无统一关联 ID、轮转和结构化输出。若启动方负责日志采集，该问题可部分缓解。

**建议/验证**：先统一错误分类、敏感信息清洗和 account/session/task 关联字段；保留历史日志语义，不进行大范围重写。fallback 状态可逐步改为元数据，避免污染最终回复。

### R14 · P3 · 上游 URL、凭据权限与自更新供应链需要明确策略

**已确认行为**：登录接受 redirect_host/baseurl/cdn 地址，媒体使用 full_url/upload_full_url；未做固定域名/地址校验。JSON 文件写入未显式设置私有权限。更新允许 official/npmmirror，选中有效 registry 后安装到当前 runtime，验证版本及入口，但无项目层面的回滚（login.ts:59-61、124-150；media.ts:123、180、337-365；json-store.ts:22；update-manager.ts:116-185、357-456）。

**潜在风险**：上游字段异常或被控制时的 URL/SSRF/token 发送边界；共享机器默认权限不私密；更新中断留下部分 runtime。未确认微信用户可控制这些上游字段，也未审计实际 ACL/umask 或 registry 完整性，不定性为可利用漏洞。AES-ECB/MD5 用于现有传输协议，不应脱离协议直接更换。

**建议/验证**：记录上游信任范围；评估 HTTPS/域名及重定向策略、私有文件权限、备份与失败恢复。更新测试应在隔离 runtime 中进行，不能直接改动生产安装。

### R15 · P3 · 前端重复规则和刷新时序增加维护成本

**已确认行为**：附件数量/大小在前后端重复定义；前端 5 秒 setInterval refresh，无 in-flight/取消和同 key 请求版本控制；聊天记录整段 render。Markdown 有清洗及外链防护，未确认 XSS（app.js:24-25、128、291-317、700-725、764-766、1077-1093、1426-1443；http-server.ts:39-40、490-530）。

**潜在影响**：多次刷新返回乱序导致短暂旧状态，长历史渲染成本上升；前后端限制可能漂移。后端仍执行上传限制，不能判定前端绕过造成无限上传。

**建议/验证**：优先限制刷新重入/过期响应；后续按实际历史规模增加分页，再统一能力元数据。无需因单文件约 1452 行就立即换框架。

## 5. 测试、构建与依赖现状

### 5.1 当前能力

- 25 个 test/*.test.ts 文件，静态统计 136 个顶层 test() 调用；这是源码数量，不是通过数量或覆盖率。
- node:test + tsx；fake Codex 子进程验证 app-server/exec 协议；mock fetch 验证微信 API/CDN；临时目录和本地 HTTP 验证状态/API。
- 覆盖授权、命令、会话、身份复用、媒体/AES、大小边界、同步 key/去重、fallback、中断、HTTP token、multipart、NDJSON、Range、npm runtime 定位及 Windows 隐藏窗口。
- tsconfig 开启 strict，编译 ES2022/NodeNext；include 仅 src/**/*.ts，test 被排除，前端 app.js 也不在该类型检查范围内。
- build = tsc + copy:web；prepack = clean + build；资源复制包括 lucide、marked、DOMPurify，并 chmod 服务入口。
- 未发现 CI workflow、coverage 门槛、lint 或浏览器 E2E 配置。

依据：package.json:36-64、tsconfig.json、scripts/copy-web-assets.mjs、test/codex-app-server.test.ts、test/http-server.test.ts、test/account-manager.test.ts。

**未执行**：npm test、npm run typecheck、npm run build、npm audit、启动服务、真实 CLI/微信调用。当前缺少 node_modules/dist；历史计划文档中的 passed 只代表当时记录，不能证明当前快照通过。

### 5.2 依赖维护

6 个直接运行依赖：dompurify、lucide、marked、open、qrcode、zod；4 个开发依赖：@types/node、@types/qrcode、tsx、typescript。package-lock.json 为 lockfileVersion 3，固定了解析版本与 integrity。

锁文件中的直接运行依赖版本分别为 dompurify 3.4.12、lucide 0.468.0、marked 18.0.6、open 10.2.0、qrcode 1.5.4、zod 4.4.3；这里只记录本地快照，不表示最新或安全版本。Codex CLI 是外部前置条件，没有在依赖中锁定支持版本。

建议定期对锁文件做只读漏洞与许可证核查，以小批次更新并验证 UMD 资源路径、ESM 和 Node 支持；不要仅因版本号较旧就全部升级。

### 5.3 关键验证缺口

| 验证领域 | 当前不足 | 建议最小验证 |
| --- | --- | --- |
| 会话并发 | 主要是单次任务与状态测试 | Web/微信交错、两次新会话提交、期间 activate/reset/delete |
| 中断/回退 | 单独验证 runner interrupt 和启动失败 fallback | interrupted 不重跑 exec，运行中 /stop，跨账号 stop |
| 可靠投递 | 测试去重，没有完整恢复合同 | batch 中途退出、回复失败、stale context、重启 |
| 文件权限 | 测试绝对路径与正常附件 | 外部敏感文件、symlink/junction、白名单收缩 |
| 资源 | 小 Buffer 和有限 fixture | 分块超限、慢 fetch、大附件并发、登录清理、进程树 |
| CLI 兼容 | 自定义 fake 协议 | 支持版本的真实 CLI，在受控目录执行 smoke |
| 前端 | API 与 HTML 断言为主 | 浏览器扫码状态、流断线、过期刷新响应、移动端 |
| 存储 | 正常 JSON 读写为主 | 多 store 快照、坏 JSON、rename 失败、异常退出 |
| 发布/更新 | npm 定位和 mock 安装测试 | 隔离安装、失败恢复、缺失资源、更新重连 |
| 平台 | 有路径/Windows 参数测试 | Node 22 基线与 Windows/macOS/Linux CI |

测试源码广度较好，但没有覆盖率数据，无法据此给出“高覆盖率”结论。

## 6. 可维护性评估与优先处理的五项

优点：模块责任可识别；构造参数支持 mock 注入；受管会话与 Codex 自身历史区分清楚；较多历史兼容问题有针对性测试；不依赖大型服务框架或数据库，局部维护成本较低。

限制：微信和 Web 各有 turn 编排逻辑，却共享会话状态与 runner；停止、配置重启和异步返回之间缺少明确合同；状态文件依赖未验证的外部/磁盘结构；前端为单文件全局状态；CLI 是未锁定的外部协议。按本机低并发使用，结构足以继续维护；多联系人、多标签页和功能扩展前应先补这些边界。

| 顺序 | 优先事项 | 对应风险 | 最小目标 |
| --- | --- | --- | --- |
| 1 | 会话任务串行化与准确写回 | R1 | 两条消息入口协调；按开始时的 sessionId 保存 thread |
| 2 | 文件回传权限范围 | R2、R10 | 明确兼容策略；真实路径、普通文件与大小校验 |
| 3 | 中断、失败和 fallback 分类 | R3、R9 | stop 可及时处理且不波及其他任务；中断不重跑 |
| 4 | 附件及登录资源生命周期 | R5、R6、R12 | 失败回滚、读取上限、取消、终态淘汰 |
| 5 | Codex 合同与跨平台验证基线 | R8、测试缺口 | 支持版本清单；CI；真实 CLI 受控 smoke |

这五项延续前述审查重点，将中断可靠性从并发问题中单独列出。状态存储恢复、日志和依赖维护随后处理，不建议首先更换数据库、前端框架或整体架构。

## 7. 分阶段维护路线

### 阶段一：核心安全和会话稳定性

1. 为微信/Web 引入最小的 accountId+sessionId 协调，复用 setSessionThread，明确任务中 reset/delete/activate 合同。
2. 明确文件发送的授权目录和兼容范围，增加真实路径、普通文件、大小检查，共用于微信回传与 Web 附件。
3. 将 runner 错误分为启动失败、运行失败、中断、超时；自动 fallback 只覆盖安全重试场景。
4. 明确 stop 目标，支持运行中控制命令，传播取消和关闭截止时间。

验收：不串会话；同会话重复提交有确定顺序/拒绝行为；中断不重跑、不跨账号；未经允许的本机文件不能回传。保持现有数据结构和公开接口，除非需求确认必须调整。

### 阶段二：资源与恢复能力

1. 部分附件失败回滚；流式/分块读取上限与出站 size 检查；限制重资源操作并发。
2. 登录记录 TTL/终态淘汰及 poll 互斥；typing 单请求；断连清理 stream 和子进程。
3. 统一账号 store 实例，补本地 JSON schema 校验和可恢复错误，先验证再决定备份/迁移。
4. 明确消息 claim 与回复补偿语义；先恢复发送，避免无条件重新执行 Codex。
5. 设计附件保留/清理规则，清理前列出引用和预期删除范围。

验收：慢网及失败可在有限时间结束；磁盘/内存增长有上限；账号刷新和重启不丢失可恢复状态；删除范围符合文案。

### 阶段三：测试、CLI 兼容和发布保障

1. 获得执行授权后，在受控环境验证 typecheck、test、build；将基线加入 Node 22 和跨平台 CI。
2. 针对前述风险补行为测试，不增加仅重复实现的断言。
3. 维护真实 CLI 支持矩阵和 fixture 协议；验证 thread/turn/history/model/approval、断线与 exec fallback。
4. 增加少量浏览器 E2E，覆盖本地 API 防护、会话交错、流断线、QR 和更新重连。
5. 在隔离 runtime 验证打包资源与更新失败恢复，再决定是否需要 rollback。

验收：发布前有可追溯的测试结果、CLI 版本、平台和 artifact 验证；不能用单一 fake 通过替代实际兼容证明。

### 阶段四：可运维性与长期演进

1. 增加最小结构化日志、关联 ID 和统一脱敏；按部署需要选择轮转或外部采集。
2. 将 fallback 等诊断信息逐步转为状态元数据，保持最终答案内容稳定。
3. 文档化账号生命周期、会话任务和 runner 合同；需要 schema 变化时再引入明确迁移版本。
4. 按实际规模统一前后端能力限制、修正刷新重入、增加历史分页；不要提前换框架。
5. 定期检查依赖、上游端点和 CLI 合同；小批次升级并验证。

所有后续实施均应先确认具体问题、影响范围和方案，再进行最小修改。本次审查不授权这些实施，也不把建议列为已完成事项。

## 8. 对原审查表述的校准

- 同一账号不同微信轮询批次不会并发执行消息处理；并发风险来自不同账号，以及 Web 与微信/其他 Web 请求交错。
- 同一共享 store 的同步 JSON 写入不应仅因无锁就认定覆盖丢失；需要区分多 store 快照、异步任务写回和持久化失败。
- 任意绝对路径回传是已确认行为，实际泄露利用仍需明确 Codex 输出和授权条件；允许工作目录也不是完整 sandbox。
- localhost GET 不要求 token 不等于外部网页能读 token；同源策略与实际防护必须同时考虑。
- 没有明确 timeout/进程树终止/清理钩子属于代码缺口，真实挂起、泄漏、CLI 不兼容和依赖漏洞都未在本次运行验证。

## 9. 当前快照复审汇总（2026-10-14）

### 9.1 复审范围与证据边界

- 复审时间：2026-10-14 01:32:00 +08:00
- 复审对象：当前工作区修复后的 `src/`、`test/` 及 `docs/repair-reviews/`
- 复审方式：只读源码复核、调用链追踪、静态异常/并发/资源边界分析
- 未执行：测试、TypeScript 类型检查、构建、`npm audit`、服务启动、真实微信调用、真实 Codex CLI 调用和跨平台进程验证

本节覆盖前述修复清单第 1 至第 7 项的最新静态复审结果。结论中的“通过”只表示
源码路径和已有测试源码在静态层面没有发现新的阻断问题，不表示测试已经通过或生产行为已经验证。
各项详细证据见：

- `docs/repair-reviews/r1-session-coordination-final-2026-10-13.md`
- `docs/repair-reviews/r2-file-scope-review-2026-10-13.md`
- `docs/repair-reviews/r3-current-gap-audit-2026-10-14.md`
- `docs/repair-reviews/r4-resource-lifecycle-review-2026-10-13.md`
- `docs/repair-reviews/r5-codex-contract-review-2026-10-13.md`
- `docs/repair-reviews/r6-final-review-2026-10-14.md`
- `docs/repair-reviews/r7-ops-frontend-review-2026-10-13.md`

### 9.2 已静态闭合的核心问题

1. **会话任务和状态写回（R1）**

   Web 与微信任务现在按明确的 `sessionId` 进入同一账号级/会话级
   `SessionTurnCoordinator`，完成后按任务开始时捕获的会话写回 thread。运行中的
   `resetSession`、`deleteSession` 会被拒绝；`removeAccount` 在删除状态目录前等待已登记
   的任务，并在结束后清理 `entries` 与 `stores`。

2. **文件回传范围（R2）**

   当前路径检查和附件访问边界已通过静态复审，未发现修复后新增的任意文件读取或路径穿越主路径。
   真实路径、符号链接、外部目录和大文件行为仍需要受控运行验证；这不改变既有功能对绝对路径的支持语义。

3. **中断、失败和 fallback（R3）**

   账号停止期间拒绝新任务；app-server 关闭后不会直接启动 exec fallback；exec 首轮
   `thread.started` 可通过 `onThreadId` 回调在运行中写回；微信 monitor 在 batch item
   边界检查 abort；`HybridCodexRunner.stop()` 使用 `Promise.allSettled()` 保留部分成功结果；
   app-server thread 写回异常被归类为不可 fallback 的 `CodexTurnStartedError`。

4. **附件、登录和资源生命周期（R4/R5/R6/R12）**

   账号关闭路径已补充 turn 等待和终态资源清理，主要失败路径不会在已知任务结束前删除其状态。
   附件失败回滚、登录记录 TTL、统一取消传播、进程树收敛和出站大小边界仍属于后续维护范围。

5. **Codex 合同与跨平台基线（R8）**

   当前 runner 的 app-server/exec 分工、关闭状态和 fallback 分类已经完成静态复核。
   真实 CLI 版本、Windows `.cmd`、协议字段漂移和跨平台进程终止尚未运行验证。

6. **消息确认与状态恢复（R6）**

   账号关闭/停止门禁覆盖主要写入口；账号级 store 复用和删除清理路径已闭合；账号文件与
   runtime JSON 已加入基础运行时结构校验，坏结构不会继续流入会话处理。
   session ID 唯一性、`activeSessionIds` 跨字段一致性、坏账号隔离、fsync/备份和多进程
   文件并发仍未解决。

7. **日志、前端刷新和依赖维护（R7/R13/R14/R15）**

   前端 `refreshData` 已有 in-flight Promise 合并，成功和失败都会释放槽位。日志落盘、
   统一错误脱敏、依赖漏洞审计、更新失败恢复和浏览器行为测试仍未完成。

### 9.3 当前风险分级

#### 已确认的问题或行为

- exec 回调异常处理和 close 事件之间仍存在需要进一步复核的异步边界；详细条件见
  `r3-current-gap-audit-2026-10-14.md` 的 R3-F/R3-G。
- `monitorWeixin()` 在一个 batch 开始时保存 sync key，停止后跳过剩余消息是否会丢失，
  取决于微信游标确认语义；源码无法单独证明结果，因此只记录为待验证风险。
- 用户可见 HTTP/微信错误仍可能直接包含底层 `error.message`，可能暴露路径或上游响应内容；
  该问题属于错误映射和信息暴露边界，尚未完成脱敏修复。

#### 潜在风险

- `child.kill()` 只直接作用于子进程，未证明 Codex 派生的进程树会在所有平台收敛。
- 单个损坏账号文件可能使全局账号枚举或启动 fail closed。
- 状态 JSON 仍缺少 fsync、备份、临时文件清理和跨进程锁。
- session ID 与 `activeSessionIds` 的跨字段一致性尚未校验。
- 前端历史消息请求仍可能同一会话重叠；共享刷新 Promise 的 `notify` 语义取决于首个调用者。
- 依赖、真实 CLI 版本和更新供应链尚未经过动态审计。

#### 改进建议

- 先补最小运行验证矩阵：会话交错、中断和 fallback、batch abort、坏 JSON 恢复、附件边界、
  登录轮询和账号删除。
- 明确首轮 exec 的停止合同、微信 batch 的确认/重试合同和消息回复补偿语义。
- 对用户可见错误做分类和脱敏，保留内部关联信息用于排障。
- 在隔离环境执行 typecheck、测试、build、`npm audit` 和真实 CLI smoke，再建立 Node 22
  及 Windows/macOS/Linux 的持续验证基线。
- 维护阶段继续采用局部修改；暂不建议更换数据库、Web 框架或整体 runner 架构。

### 9.4 当前最值得优先处理的五项

| 顺序 | 优先事项 | 当前判断 | 最小下一步 |
| --- | --- | --- | --- |
| 1 | 运行验证矩阵 | 静态主路径已闭合，动态证据缺失 | 在隔离环境运行会话交错、停止、恢复和资源边界测试 |
| 2 | 错误分类与脱敏 | 存在底层错误直接回传路径 | 统一用户错误映射，内部日志保留关联上下文 |
| 3 | 首轮 exec 与微信停止合同 | 主要路径已补，边界仍未验证 | 验证 `thread.started`、batch abort、stop 组合和 close 时序 |
| 4 | 状态恢复耐久性 | 类型校验已补，耐久性未覆盖 | 评估 fsync/备份/坏账号隔离及跨字段一致性 |
| 5 | CLI、依赖和跨平台基线 | 仅有 fake fixture 和静态检查 | 锁定支持版本，做真实 CLI smoke、`npm audit` 和平台 CI |

### 9.5 分阶段维护路线

**阶段一：稳定性和安全边界。** 完成首轮 exec stop、微信停止边界、文件回传真实路径和
错误脱敏验证；补充账号/session 维度的并发与关闭测试。

**阶段二：恢复和资源。** 明确消息 claim、回复补偿和 sync key 合同；完善附件/登录清理、
读取和出站大小上限、取消传播、进程树收敛及状态文件耐久性。

**阶段三：发布和兼容。** 在隔离环境运行 typecheck、测试、build、`npm audit` 和真实
Codex CLI smoke；建立 Node 22 与目标操作系统的持续集成，并补少量 Web E2E。

**阶段四：长期维护。** 增加结构化日志和统一脱敏，记录 CLI/依赖支持矩阵，按实际数据量
修正前端历史分页与刷新版本控制；保持接口和目录结构兼容，所有修改继续遵循最小范围原则。

截至本次复审，项目适合继续进行局部功能扩展，但不应把“静态通过”表述为“测试通过”或
“已验证兼容”。所有未执行的动态检查应在后续维护窗口中单独记录结果和环境。
