# cc-wx 当前代码逻辑与安全风险审查

- 审查日期：2026-10-14
- 审查时区：Asia/Shanghai
- 审查对象：`E:\codex-weixin-main` 当前工作区源码、测试源码及既有审查文档
- 参考基线：`docs/architecture-review-2026-10-13.md`、`docs/maintenance-fix-checklist-2026-10-13.md`、`docs/repair-reviews/`
- 审查方式：只读调用链追踪、状态/并发/资源边界分析、标准安全扫描及独立静态复核
- 操作限制：未安装或升级依赖；未提交 Git；本文件完成前未修改业务源码

## 1. 结论与证据边界

当前工作区已经包含上一轮对会话协调、文件回传、Codex fallback、资源生命周期、状态结构校验和前端刷新等修复。与10月13日文档相比，以下旧结论已过时或已被当前代码补齐：

- `RuntimeStateStore` 已对会话、映射、上下文 token 和 pending delivery 做逐项运行时结构校验；
- 登录轮询已合并 in-flight 请求，并对 confirmed/expired 记录做延迟清理；
- 入站附件批量失败会删除本次已落盘文件；
- 账号删除会等待 monitor 和已登记 turn，再清理 runtime/inbound 目录；
- Web 与微信 turn 已按 session 串行，reset/delete 在活动 turn 期间拒绝。

本次文档中的“已确认问题”表示由当前源码可以直接推出的行为或缺口，不等同于已经在生产环境复现。“潜在风险”表示需要特定调用时序、配置、操作系统或上游协议条件才能成立的边界，不能当作已验证漏洞。标准安全扫描和独立复核的动态能力、真实微信/Codex 集成能力、依赖漏洞数据库结果均不替代运行验证。后续修复复审记录见 `docs/repair-reviews/r8-current-security-fix-review-2026-10-14.md` 及 `r9-canonical-alias-followup-2026-10-14.md`。

## 2. 架构和主要信任边界

```text
微信 iLink / CDN -> WeixinApiClient -> monitorWeixin -> BridgeService
                                              |
浏览器 -> localhost HTTP API -> AccountManager -> RuntimeStateStore
                                              |
                                      HybridCodexRunner
                                      app-server / codex exec
```

关键边界：

1. 微信入站消息和附件进入本地状态、Codex prompt 及工作区文件。
2. 本地浏览器通过 `127.0.0.1` HTTP API 读写账号、会话、配置和附件。
3. Codex 输出可触发本地工作区切换、媒体回传和历史附件展示。
4. 账号 token、context token、sync key、会话映射和入站文件保存在本地 JSON/目录。
5. Codex 子进程继承服务进程权限；`codexExecSandbox` 只约束 exec 路径，不能替代桥接层文件范围检查。

已确认的主要控制包括：本地监听、Host/Origin/request token 检查、未知微信联系人默认拒绝、账号公开信息删除 token、Markdown 清洗、附件路径 realpath/普通文件检查、workspace allowlist、请求体/上传数量限制，以及状态 JSON 的逐项类型校验。

## 3. 已确认问题

### S1 · P1 · 用户可见错误直接回传底层错误内容

证据：

- `src/server/http-server.ts:80-84` 的兜底处理把 `error.message` 直接放入 JSON；
- `src/server/http-server.ts:271-275` 的 NDJSON 错误事件直接返回底层消息；
- `src/server/http-server.ts:657-663` 的附件 stream 错误直接返回 `error.message`；
- `src/bridge/service.ts:363-364, 468-470` 将附件下载/媒体发送错误拼进微信回复；
- `src/state/json-store.ts:16`、`src/state/runtime-state.ts:413` 的错误消息包含本地文件路径。

影响：在本机多用户、共享浏览器或已获授权的微信联系人场景中，错误可能暴露本地绝对路径、上游响应文本、命令失败细节或状态文件位置。服务当前只监听 localhost，源码不能证明存在远程直接利用，因此按本地信息暴露处理，不定性为远程认证绕过。

建议：保留内部日志中的完整错误，面向 HTTP/微信统一映射为稳定错误类别和简短提示；对路径、命令行和上游响应做脱敏。修复时保持现有状态码和重试提示语义。

### S2 · P1 · 出站媒体读取没有统一大小上限

证据：

- `src/weixin/media.ts:288-303` 的 `sendLocalMediaFile` 在允许目录和普通文件检查后直接 `fs.readFileSync`；
- `src/bridge/service.ts:454-467` 和 `src/server/account-manager.ts:654-681` 都可从 Codex 输出路径触发该读取/展示；
- 入站和 Web 上传有 `maxInboundBytes`，但出站媒体没有对应的 stat/size 上限。

影响：只要 Codex 输出一个 allowlist 内的大文件路径，服务会一次性读入内存、加密并上传；多个账号或多个回传动作可叠加内存和网络压力。allowlist 仍然有效，因此这不是任意文件读取；风险是资源耗尽和未经明确大小确认的授权回传。

建议：在 `sendLocalMediaFile` 统一加入可配置或复用现有上限的 `stat` 检查，拒绝非普通文件和超限文件，并在 Web 附件索引使用同一边界。不要改变现有允许工作区文件回传的目录语义。

### S3 · P2 · 账号关闭门禁未统一使用 canonical account id

证据：

- `removeAccount` 在 `src/server/account-manager.ts:242-247` 使用加载后的 `account.accountId` 写入 `closingAccounts`；
- `continueSession` 在 `src/server/account-manager.ts:441-445` 直接用调用方传入的 `accountId` 查 `closingAccounts`；
- `ensureAccountOpen` 在 `src/server/account-manager.ts:569-575` 也直接比较原始参数；
- `loadAccount` 在 `src/weixin/accounts.ts:211-216` 支持规范化别名匹配。

影响：当账号标识包含会被 `normalizeAccountId` 改写的字符，且调用方使用别名时，关闭期间的部分入口理论上可能绕过 Set 门禁。当前账号标识通常来自微信 bot id，源码没有证明该条件稳定可由远程用户构造，因此按边界一致性风险处理。

建议：所有生命周期/写入口先解析 canonical account，再统一进行关闭/停止检查；保持现有账号文件命名兼容，并增加别名关闭期间拒绝测试。

### S4 · P2 · 微信批次先保存 sync key，再逐条处理消息

证据：

- `src/weixin/monitor.ts:43-49` 在收到 batch 后先更新并持久化 sync key；
- `src/weixin/monitor.ts:61-90` 随后才逐条 normalize、claim 和处理消息；
- `src/state/runtime-state.ts:96-112` 的 sync key 与 processed message claim 是独立持久化状态。

影响：若进程在 batch 中途退出，或某条消息在 claim 后处理失败，重启后的恢复行为依赖微信协议对 sync key 的确认语义；源码不能证明该消息会重新下发。由于无条件重跑 Codex 可能产生副作用，本问题不能用简单重试掩盖。

建议：先通过受控协议验证 sync key 语义，再决定是延后确认、保存可恢复回复，还是建立“已接收/处理中/已回复”状态。未完成协议验证前不要擅自改变游标顺序。

## 4. 潜在风险和验证缺口

| 编号 | 风险/缺口 | 当前判断 | 最小验证 |
| --- | --- | --- | --- |
| V1 | `child.kill()` 未证明会收敛 Codex 派生进程树 | 潜在资源/进程残留 | fixture 派生子进程、超时、stop、close，并在 Windows/Unix 检查残留 |
| V2 | 出站 CDN URL 由上游响应提供，未做域名/协议 allowlist | 依赖上游信任；未证明微信用户可控 | mock 非 HTTPS/非官方域名响应，确认是否应拒绝 |
| V3 | JSON 原子替换未做 fsync、备份或跨进程锁 | 恢复/耐久性风险 | 模拟 rename/异常退出及外部并发写入 |
| V4 | `readSessionMessages` 与附件响应在关闭/删除交错时的错误映射 | 只读可观察性边界 | 运行中删除账号/会话后并发读取历史和 Range 附件 |
| V5 | 依赖、真实 Codex CLI、更新失败恢复和跨平台进程行为未动态验证 | 证据缺失，不是已确认漏洞 | 隔离环境执行 typecheck/test/build/npm audit 和真实 CLI smoke |

## 5. 已存在控制与未发现事项

- 未发现当前源码中由微信联系人直接输入触发的 shell 拼接；Codex exec 使用 `spawn(..., shell:false)`，参数以数组传递。
- 文件发送路径必须是绝对路径，并通过 `realpath`、普通文件和允许工作区检查；历史路径展示也重复检查 allowlist。
- Web 修改请求要求允许 Host、允许 Origin（缺省 Origin 兼容）和随机 request token；读取接口仍绑定 localhost。
- Markdown 使用 DOMPurify，CSP 禁止外链脚本、style 和 frame。
- 状态文件不是只做 TypeScript 断言，当前已对会话、pending delivery、字符串数组和字符串映射做运行时校验。
- 未执行 `npm test`、`npm run typecheck`、`npm run build`、`npm audit`、真实微信/Codex 调用、浏览器 E2E 或跨平台进程验证，因此不能声称它们通过。

## 6. 修复任务拆分

按最小修改和每两项复审规则，建议顺序如下：

1. **S1 错误分类和脱敏**：新增统一用户可见错误映射，覆盖 HTTP JSON/NDJSON、附件 stream 和微信回复；保留内部 console 错误。
2. **S2 出站媒体大小边界**：在 `sendLocalMediaFile` 增加普通文件/大小检查，并让 Web 历史附件使用相同上限。
3. **S3 canonical account 门禁**：统一 lifecycle 入口的 canonical account 解析和关闭/停止检查。
4. **S4 消息确认合同**：先补状态/协议验证测试或记录，未确认协议前只做不改变语义的防护性记录。
5. **V1/V3/V4 运维边界**：在完成前四项后按验证结果决定是否实施局部修复。

每完成两项修复安排一次子代理静态复审；子代理复审期间继续处理下一项，收到意见后先完成当前正在进行的修改，再合并复审结论。

## 7. 修复进度（2026-10-14）

- S1 用户可见错误脱敏：已完成；HTTP/NDJSON/微信错误路径统一使用稳定提示，内部 console 仍保留诊断信息。
- S2 出站媒体大小和普通文件边界：已完成常规路径修复；Web 响应增加最终大小检查。保留本地 workspace writer 可触发的路径型 TOCTOU 作为 P2 后续风险。
- S3 canonical account 门禁：已完成生命周期门禁、session 返回/状态键及历史读取 runner key 统一；`r9` 子代理复审通过。
- S4 微信 sync key 与消息处理确认：未改协议语义，保留为待验证风险，避免在没有协议证据时引入重复执行。
- 已新增针对 HTTP 错误脱敏和出站媒体大小拒绝的回归测试源码；按任务限制未执行测试。

## 8. 当前结论

当前代码具备可继续局部维护的结构，上一轮核心并发和文件范围修复没有发现明显回归。S1-S3 已完成局部修复，S2 的本地 TOCTOU、S4 的游标确认语义、Codex 输出上限、上游 URL 信任和动态验证仍是后续队列。标准安全扫描已启动但本轮未产生可完成报告，不能把扫描状态表述为通过。S4 需要先确认微信协议语义，不能把推测写成已修复事实。

