# 材料评审门禁与评测验证报告

验证日期：2026-07-31

工单：海投王-0-22

## 覆盖范围

- 真实 `AppModule` + Nest HTTP listener：批准接口只信任签名访问令牌中的主体，覆盖无令牌 401、过期令牌 401、错误受众 403、错误签名 401、缺少审批权限 403、跨租户资源 404 和合法审批者 200。
- 可部署鉴权：`AuthService` 验证 HS256 签名、`exp`、`iat`、`aud`、UUID 主体和权限声明；应用不再包含测试 token registry。测试在应用启动前注入测试签名密钥并独立签发短期令牌。
- 持久化与一致性：材料版本、Review 和审计持久化到 SQLite。批准以 `BEGIN IMMEDIATE` 开启事务，在事务内读取当前材料和 Review、校验门禁、插入材料新版本和成功审计，然后提交。
- 回滚验证：HTTP 测试在真实 SQLite 表安装一次性失败触发器，使成功审计写入失败；接口返回契约化 500，材料版本、Review 和成功审计均回滚，只在新事务中留下完整的 `material.approval_failed` 事件。另有应用重启测试确认成功批准、Review 和审计均可重新读取。
- HTTP 契约：`review_id` 在运行时强制为必填 UUID；请求拒绝未知字段。Material 成功响应只映射契约声明字段，所有错误使用带 `retryable`、`request_id` 和 `correlation_id` 的 `ErrorEnvelope`，领域门禁原因映射到共享错误码。测试以 Draft 2020-12 Schema 验证真实 HTTP Material、AuditEvent 和 ErrorEnvelope。
- Web/API 联调：Web `MaterialReviewApi` 经真实 HTTP 完成“查看 Review → 关闭 must-fix → 批准 → 查询审计”。夹具只用于预置测试前提，被验证的操作全部经过真实应用装配和 HTTP 边界。
- Provider Adapter：受控 HTTP server 覆盖 timeout、429、畸形 JSON、非预期文本、缺字段、数据最小化和日志脱敏；Provider 异常由 Review engine 失败关闭为 reviewer unavailable。
- 黄金样本：固定规范化 finding 文案、完整有序证据引用（含版本）和 finding 状态；有意更新流程见 `evals/review/README.md`。
- 全仓格式门禁：`format` 和 `format:check` 已纳入 `contracts`、`docs`、`evals`，不再遗漏本工单的契约、黄金样本和报告。

## Provider 重试、错误和用户提示

| 情况                 | 行为                                                  | 稳定分类                      | 用户可见结果                       |
| -------------------- | ----------------------------------------------------- | ----------------------------- | ---------------------------------- |
| 单次请求超时         | 立即失败，不隐式延长                                  | `PROVIDER_TIMEOUT`            | 供应商超时，批准保持阻塞           |
| HTTP 429             | 最多重试一次，遵守但限制 `Retry-After`，默认上限 1 秒 | `PROVIDER_RATE_LIMITED`       | 供应商繁忙，稍后重试               |
| 非 JSON/非预期文本   | 不尝试从自由文本猜测结果                              | `PROVIDER_MALFORMED_RESPONSE` | 输出不可读，批准保持阻塞           |
| JSON 缺字段/字段非法 | schema-shaped 校验失败                                | `PROVIDER_INVALID_RESPONSE`   | 缺少或含非法评审字段，批准保持阻塞 |
| 其他非 2xx/网络错误  | 不重试                                                | `PROVIDER_UPSTREAM_ERROR`     | 供应商不可用，批准保持阻塞         |

## 外部数据策略

- 仅发送限长并脱敏的职位标题、职位状态/风险、材料文本、材料检查摘要和匹配要求。
- 邮箱、电话和形似 secret/token/password/API key 的内容在发送前替换；材料正文上限 4,000 字符，标题/技能等字段单独限长。
- 不发送 `user_id`、Profile facts、source records、原始文件或本地凭据；payload 声明 retention requested 为 false。
- Adapter 不提供正文持久化路径。结构化日志仅含 reviewer、attempt、HTTP status 和稳定错误码，不含 URL 查询秘密、认证头、请求或响应正文。
- 真实供应商只在 `REVIEW_PROVIDER_SMOKE=1` 且 endpoint/key/model 全部安全注入时运行；单次调用、10 秒上限、不重试，只输出无敏感信息的结果摘要。

## 实际命令证据

命令均在仓库的 `tooling` 目录执行，除特别注明外。最终数字以本报告收尾时的完整运行结果为准。

| 命令                                  | 结果                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `npm.cmd run format`                  | 通过；格式化范围包含 tooling、GitHub 配置、apps、contracts、docs、evals、infra/dev 和 services          |
| `npm.cmd run lint`                    | 通过；全范围 Prettier check 和 ESLint 均为 0 问题                                                       |
| `npm.cmd run typecheck`               | 通过；local-agent、web、api 三个 workspace 均通过                                                       |
| `npm.cmd run unit`                    | 通过；12 个测试文件，106 passed、1 real-provider smoke skipped；包含 7 条真实 Nest HTTP/SQLite 联调用例 |
| `npm.cmd run quality`                 | 通过；format、lint、typecheck、unit、contract 全部退出 0；OpenAPI、领域 Schema 和事件样例有效           |
| `npm.cmd run eval:review`             | 通过；2 个评测文件，29 passed、1 real-provider smoke skipped                                            |
| `npm.cmd run build`（`services/api`） | 通过；TypeScript build 成功                                                                             |
| `npm.cmd run security:secrets`        | 通过；未发现仓库秘密                                                                                    |
| `git diff --check 83c8cd4`            | 通过；无尾随空白或补丁格式错误                                                                          |

## 真实供应商状态

本次未设置 `REVIEW_PROVIDER_SMOKE`、供应商 endpoint、model 或密钥，真实供应商用例按设计跳过，普通 CI 不消耗额度。可审计启用命令和所需变量名记录在 `evals/review/README.md`；报告不记录任何变量值。

## 未覆盖项与风险

- SQLite 为真实持久层并提供跨进程文件锁和原子事务，已覆盖写失败回滚与应用重启恢复；本单未做进程强杀或多进程争用压力测试。若后续迁移到 PostgreSQL，应保留当前仓储契约和 HTTP 回滚测试，并用数据库行锁实现同等一致性。
- 批准接口仍按既有契约接收 `facts`、`evaluated_at` 和 `goal_id`。本单保证 Review 和材料状态不能由客户端伪造；将事实改为从 Profile 持久化聚合读取需要独立的 Profile/API 契约工单。
- Web 覆盖实际客户端 API adapter 与真实服务端 HTTP，不包含浏览器渲染或可访问性测试；本工单没有修改产品 UI。
- 真实供应商 smoke 未执行，原因是显式开关和外部凭据均未提供；确定性 Provider 夹具和失败关闭路径已通过。
