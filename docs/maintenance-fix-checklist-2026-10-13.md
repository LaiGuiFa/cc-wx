# cc-wx 维护修复清单

- 制定时间：2026-10-13
- 基线审查：[architecture-review-2026-10-13.md](./architecture-review-2026-10-13.md)
- 当前状态：核心修复清单已完成（静态审查通过）；运行验证项已转入后续维护队列

## 执行规则

1. 每个问题先做最小修改，再进行静态逻辑/语法自查。
2. 自查通过后交由子代理进行代码审查和安全风险评估，并要求子代理将结论写入 `docs/repair-reviews/`。
3. 每完成两项修复，检查对应审核结论；若有问题，先修复审核意见再继续。
4. 不安装或升级依赖，不提交 Git，不把静态分析结果表述为真实运行验证。

## 问题清单

| 顺序 | 问题 | 来源 | 状态 |
| --- | --- | --- | --- |
| 1 | 会话任务串行化与准确写回 | R1 | 已完成：核心路径静态通过 |
| 2 | 文件回传权限范围 | R2、R10 | 已完成：核心路径静态通过 |
| 3 | 中断、失败和 fallback 分类 | R3、R9 | 已完成：主路径静态闭合；运行验证转后续队列 |
| 4 | 附件与登录资源生命周期 | R5、R6、R12 | 已完成：主路径静态通过 |
| 5 | Codex 合同与跨平台验证基线 | R8 | 已完成：静态合同修复完成；真实 CLI 验证转后续队列 |
| 6 | 消息确认与恢复语义 | R4、R7 | 已完成：核心状态恢复路径静态通过 |
| 7 | 日志、前端刷新与依赖维护 | R13、R14、R15 | 已完成：静态路径通过；运维审计转后续队列 |

## 审核记录

| 修复项 | 审核文档 | 结论 |
| --- | --- | --- |
| 1 | `docs/repair-reviews/r1-session-coordination-final-2026-10-13.md` | 静态通过 |
| 2 | `docs/repair-reviews/r2-file-scope-review-2026-10-13.md` | 静态基本通过 |
| 3 | `docs/repair-reviews/r3-interrupt-fallback-followup-2026-10-14.md`、`r3-current-gap-audit-2026-10-14.md` | 主路径静态闭合；剩余为潜在风险/未验证项 |
| 4 | `docs/repair-reviews/r4-resource-lifecycle-review-2026-10-13.md` | 主路径通过，终态回收已补 |
| 5 | `docs/repair-reviews/r5-codex-contract-review-2026-10-13.md` | 静态通过，运行时验证缺失 |
| 6 | `docs/repair-reviews/r6-state-recovery-review-2026-10-13.md`、`r6-schema-implementation-review-2026-10-14.md`、`r6-final-review-2026-10-14.md` | 核心路径静态通过；剩余为后续策略建议 |
| 7 | `docs/repair-reviews/r7-ops-frontend-review-2026-10-13.md` | 静态通过，运行时与依赖审计缺失 |

## 后续维护验证队列

以下项目不是当前静态审查确认的核心缺陷，不能表述为已运行验证通过：

1. 在具备依赖的环境运行 `npm test`、`npm run typecheck` 和 `npm run build`。
2. 用真实或 fixture Codex 验证 timeout、同步 `close()`、子进程树终止和 Windows 命令解析。
3. 验证微信协议中 sync key 与跳过已拉取 batch 消息之间的确认语义。
4. 补充 RuntimeState 跨字段一致性、坏账号隔离策略和 HTTP 错误脱敏的产品/运维决策。
5. 评估账号别名规范化、session key 命名空间和关闭期只读 API 的低优先级建议。

## 2026-10-14 当前安全审查批次

审查文档：`docs/security-logic-review-2026-10-14.md`

| 修复项 | 状态 | 复审 |
| --- | --- | --- |
| S1 用户可见错误分类和脱敏 | 已完成（静态） | `docs/repair-reviews/r8-current-security-fix-review-2026-10-14.md`：基本通过 |
| S2 出站媒体大小和最终附件响应边界 | 已完成常规路径（静态） | `r8`：通过常规路径；保留本地 TOCTOU P2 |
| S3 canonical account 门禁、session 状态键及历史读取 runner key | 已完成（静态） | `r8` 发现残余，`r9` 复审通过；历史读取 alias runner key 已补修 |
| S4 微信 sync key/消息确认合同 | 未修改 | 需协议/运行验证，避免推测性改动 |

本批次新增测试源码但未执行 `npm test`、typecheck、build、`npm audit` 或真实集成验证。未关闭的 P2/P3 风险继续留在后续验证队列，不得表述为运行验证通过。
