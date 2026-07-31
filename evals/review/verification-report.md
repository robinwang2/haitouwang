# 材料评审门禁与评测验证报告

验证日期：2026-07-31  
工单：海投王-0-22

## 覆盖范围

- 真实 `AppModule` + Nest HTTP listener：批准接口不读取客户端租户身份，覆盖未登录 401、缺少审批权限 403、跨租户资源 404、合法审批者 200。
- 服务端批准不变量：从服务端 Review 存储读取聚合，校验 Review 存在、租户和材料绑定、`approved + approve`、无 open must-fix、证据版本未过期和材料状态允许。
- 一致性：材料 current/history、Review 和审计共用同步事务快照；模拟 material 已写而审计未写时完整回滚，随后只记录完整的 transaction-failed 审计。批准、拒绝及其门禁失败均有稳定 reason code。
- Web/API 联调：Web `MaterialReviewApi` 经真实 HTTP 完成“查看 Review → 关闭 must-fix → 批准 → 查询审计”。测试未直接调用编译后的领域模块来完成被验证流程；仅通过应用容器预置租户夹具和不透明测试 token。
- Provider Adapter：受控 HTTP server 覆盖 timeout、429、畸形 JSON、非预期文本、缺字段、数据最小化和日志脱敏；Provider 异常由 Review engine 失败关闭为 reviewer unavailable。
- 黄金样本：固定规范化 finding 文案、完整有序证据引用（含版本）和 finding 状态；更新流程见 `evals/review/README.md`。

## Provider 重试、错误和用户提示

| 情况 | 行为 | 稳定分类 | 用户可见结果 |
| --- | --- | --- | --- |
| 单次请求超时 | 立即失败，不隐式延长 | `PROVIDER_TIMEOUT` | 供应商超时，批准保持阻塞 |
| HTTP 429 | 最多重试一次，遵守但限制 `Retry-After`，默认上限 1 秒 | `PROVIDER_RATE_LIMITED` | 供应商繁忙，稍后重试 |
| 非 JSON/非预期文本 | 不尝试从自由文本猜测结果 | `PROVIDER_MALFORMED_RESPONSE` | 输出不可读，批准保持阻塞 |
| JSON 缺字段/字段非法 | schema-shaped 校验失败 | `PROVIDER_INVALID_RESPONSE` | 缺少或含非法评审字段，批准保持阻塞 |
| 其他非 2xx/网络错误 | 不重试 | `PROVIDER_UPSTREAM_ERROR` | 供应商不可用，批准保持阻塞 |

## 外部数据策略

- 仅发送限长并脱敏的职位标题、职位状态/风险、材料文本、材料检查摘要和匹配要求。
- 邮箱、电话和形似 secret/token/password/API key 的内容在发送前替换；材料正文上限 4,000 字符，标题/技能等字段单独限长。
- 不发送 `user_id`、Profile facts、source records、原始文件或本地凭据；payload 声明 retention requested 为 false。
- Adapter 不提供正文持久化路径。结构化日志仅含 reviewer、attempt、HTTP status 和稳定错误码，不含 URL 查询秘密、认证头、请求或响应正文。
- 真实供应商只在 `REVIEW_PROVIDER_SMOKE=1` 且 endpoint/key/model 全部安全注入时运行；单次调用、10 秒上限、不重试，只输出无敏感信息的结果摘要。

## 实际命令证据

命令均在仓库的 `tooling` 目录执行，除特别注明外。

| 命令 | 结果 |
| --- | --- |
| `npm.cmd ci --ignore-scripts` | 通过；tooling 226 个包，0 vulnerability |
| `npm.cmd run bootstrap` | 通过；local-agent/web/api 按锁文件安装，均为 0 vulnerability |
| `npm.cmd run quality` | 通过；format check 0、lint 0、三个 workspace typecheck 通过、12 个测试文件通过、102 tests passed、1 real-provider smoke skipped、OpenAPI/Schema/examples 全部有效 |
| `npm.cmd run eval:review` | 通过；2 个评测文件，29 tests passed，1 real-provider smoke skipped |
| `npm.cmd run build`（`services/api`） | 通过；TypeScript build 成功 |
| `npm.cmd run security:secrets` | 通过；未发现仓库秘密 |

首次读取已集成检查点时，实际基线是 3 个 Prettier 文件和 0 个 ESLint 错误（与工单背景中的“30 个格式、4 个 lint”计数不一致）；本次最终 `format:check` 和 `lint:code` 均为 0。

## 真实供应商状态

本次未设置 `REVIEW_PROVIDER_SMOKE`、供应商 endpoint、model 或密钥，真实供应商用例按设计跳过，普通 CI 不消耗额度。可审计启用命令和所需变量名记录在 `evals/review/README.md`；报告不记录任何变量值。

## 未覆盖项与风险

- 当前仓库材料模块的既有持久化实现是进程内 Map；本单在同一存储边界实现并验证了原子快照/回滚和版本历史一致性。未来接入 PostgreSQL 时，应以数据库 transaction + row/version lock 替换该实现，并复用当前事务契约测试。
- 当前不透明 token registry 是应用装配层的身份提供者接口与 HTTP 测试夹具，不是生产 JWT/OIDC 签发器；生产部署须接入平台身份服务，但批准接口已只信任认证主体，不接受正文伪造租户。
- Web 覆盖的是实际客户端 API adapter 与真实服务端 HTTP 的联调，不包含浏览器渲染/可访问性测试；本工单没有修改产品 UI。
- 真实供应商 smoke 未执行，原因是显式开关和外部凭据均未提供；确定性 Provider 夹具和失败关闭路径已全部通过。
