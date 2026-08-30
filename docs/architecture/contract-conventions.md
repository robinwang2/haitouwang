# 契约约定

- 工单：海投王-0-3
- 契约版本：1.0.0
- OpenAPI：3.1.0
- JSON Schema：Draft 2020-12

## 1. 规范文件与所有权

| 文件                                              | 用途                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `contracts/openapi/openapi.json`                  | 云端 Web API 与云地代理 API                                         |
| `contracts/schemas/domain.schema.json`            | 领域对象、枚举和公共值对象                                          |
| `contracts/events/event.schema.json`              | 版本化事件信封和事件载荷                                            |
| `contracts/examples/*.event.json`                 | 成功、拒绝、人工降级事件样例                                        |
| `docs/architecture/domain-model.md`               | 聚合、关系、不变量和字段语义                                        |
| `docs/architecture/state-machines.md`             | 合法状态迁移和迁移门禁                                              |
| `docs/architecture/agent-pairing-protocol.md`     | 云端与本地代理配对、领取、回执、心跳、撤权协议                      |
| `docs/architecture/resume-generation-contract.md` | JSON RAG → EvidenceRecord → 生成 端口链、外部字段隔离约束、幂等语义 |

`contracts/**` 是跨模块机器契约的唯一来源。实现层不得私自放宽枚举、必填字段、状态迁移或安全约束；需要变更时先修改契约并完成兼容性评审。

## 2. 版本策略

1. HTTP 主版本放在路径中，例如 `/v1`。同一主版本内只允许向后兼容变更：新增可选字段、新增端点或新增不改变既有含义的错误码。
2. 删除/重命名字段、收紧既有字段、改变状态含义或幂等语义属于破坏性变更，必须发布 `/v2`。废弃端点至少保留一个发布周期，并返回 `Deprecation` 与 `Sunset` 响应头。
3. 事件类型以 `.v1` 结尾；载荷的破坏性变更发布新的事件类型，不原地改写旧类型。消费者必须忽略未知可选字段，但必须拒绝未知主版本。
4. JSON Schema 的 `$id` 是稳定标识；发布后不以不同内容复用相同 `$id`。

## 3. 标识、时间和并发控制

- 资源标识均为 UUID；对外不得暴露数据库自增键。
- 时间均为 RFC 3339 `date-time` UTC 值；用户时区单独使用 IANA 时区名保存。
- 可变资源包含大于等于 1 的 `version`。更新请求使用 `If-Match` 或请求体中的预期版本；不匹配返回 `409 CONFLICT`。
- `request_id` 标识单次 HTTP 请求，`correlation_id` 串联一次业务流程，`causation_id` 指向直接触发当前事件的请求或事件。

## 4. 错误约定

所有非 2xx 响应使用 `ErrorEnvelope`，至少包含稳定机器码 `error.code`、安全的人类可读信息、`request_id`、`correlation_id`、`retryable`。不得在错误正文或日志中包含 Authorization、Cookie、验证码、原始凭证、简历/邮件正文或完整模型提示。

| HTTP | 稳定错误码                                                                          | 使用条件                                                                                       |
| ---: | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
|  400 | `VALIDATION_FAILED`, `CREDENTIAL_DATA_FORBIDDEN`                                    | 格式/字段错误；请求携带禁止上云的凭证类字段                                                    |
|  401 | `AUTH_REQUIRED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`                                   | 未认证、令牌过期或已撤权                                                                       |
|  403 | `FORBIDDEN`, `TOKEN_SCOPE_INSUFFICIENT`                                             | 跨租户、越范围或策略拒绝                                                                       |
|  404 | `RESOURCE_NOT_FOUND`                                                                | 资源不存在，跨租户查询同样返回该码以避免枚举                                                   |
|  409 | `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `STATE_TRANSITION_INVALID`, `REPLAY_DETECTED` | 版本/唯一性冲突、幂等键异参复用、非法迁移、重放                                                |
|  412 | `PRECONDITION_REQUIRED`, `EVIDENCE_REQUIRED`                                        | 缺少用户确认或可验证提交证据                                                                   |
|  422 | `MANUAL_INTERVENTION_REQUIRED`, `PAIRING_CODE_INVALID`                              | 必须人工接管；一次性配对材料无效                                                               |
|  429 | `RATE_LIMITED`                                                                      | 限流，附 `Retry-After`                                                                         |
|  422 | `RESUME_EVIDENCE_NOT_FOUND`, `RESUME_CLAIM_VERIFICATION_FAILED`                     | 简历生成请求合法，但无相关证据可用或事实校验未通过，不得进入 `review_required`                 |
|  400 | `RAG_SOURCE_INVALID`, `JD_TEXT_EMPTY`, `JD_TEXT_TOO_LONG`                           | JSON RAG 源不是合法 JSON、JD 为空白或超过业务长度上限；业务层校验，不依赖 JSON Schema 结构限制 |
|  500 | `INTERNAL_ERROR`                                                                    | 未分类服务错误；正文不暴露内部堆栈                                                             |
|  500 | `RESUME_GENERATION_FAILED`                                                          | 简历生成模型调用失败或返回不可用的结构化结果；`retryable=true`                                 |

人工降级不是可自动重试的普通失败。返回 `MANUAL_INTERVENTION_REQUIRED` 时，`retryable=false`，并给出稳定 `manual_reason`；只有用户解决问题或显式恢复流程后才可创建新尝试。

## 5. 幂等约定

1. 所有创建、动作、代理领取/回执接口接受 `Idempotency-Key`。格式为 16–128 个可打印 ASCII 字符，调用方在同一业务意图的重试中必须复用。
2. 服务端按 `(authenticated_principal, operation_id, idempotency_key)` 保存请求规范化哈希、最终状态码和响应，至少覆盖该业务最大重试窗口。相同键和相同请求返回首次结果并带 `Idempotency-Replayed: true`。
3. 相同键但请求哈希不同返回 `409 IDEMPOTENCY_KEY_REUSED`；不得执行第二次副作用。
4. 申请提交另有稳定业务键 `submission_idempotency_key` 和数据库唯一约束。HTTP 幂等记录、命令 `jti`/nonce 消费记录与业务唯一约束是三层独立防护。简历生成同样采用双层：`Idempotency-Key` 头是传输层重试保护，请求体 `idempotency_key` 是按 `(用户, jd_text, rag_source, preferences)` 归一化的业务级去重键；语义细节见 `docs/architecture/resume-generation-contract.md`。
5. 对进行中的首次请求，重复调用返回同一 `202` 资源位置或等待首次结果，不并发执行。

## 6. 分页约定

- 列表端点统一使用不透明游标 `cursor` 和 `page_size`，默认 25，范围 1–100。
- 响应使用 `PageMeta`：`page_size`、可空 `next_cursor`、可选 `total_estimate`。调用方不得解析、构造或长期保存游标。
- 服务端必须使用稳定排序 `(sort_key, id)`；游标绑定租户、过滤条件、排序和契约主版本。绑定不匹配视为 `VALIDATION_FAILED`。
- `next_cursor=null` 表示没有下一页。列表重复读取允许因并发写入产生新项，但同一资源不得在一个游标链中重复。

## 7. 审计约定

所有状态变化、授权/撤权、配对、事实确认/撤销、材料批准/拒绝、自动化开关、代理命令、人工接管、申请提交和数据导出/删除都必须写入追加式审计事件。审计事件至少包含：

- `event_id`、`occurred_at`、`actor`、`action`、`resource`、`outcome`；
- `tenant_id`、`request_id`、`correlation_id`，适用时包含 `causation_id`；
- 变更前后状态或允许字段名列表，不记录敏感正文；
- 拒绝时记录稳定 `reason_code`；幂等重放记录首次事件引用，不复制业务副作用。

审计写入和业务变更使用同一事务或事务性 outbox。审计失败时高风险业务变更不得静默成功。普通应用日志不能替代审计日志。

## 8. 校验命令

标准工具应从仓库根目录执行：

```text
npx --yes @redocly/cli lint contracts/openapi/openapi.json
npx --yes --package=ajv-cli@5 --package=ajv-formats ajv validate --spec=draft2020 --all-errors -c ajv-formats -s contracts/schemas/domain.schema.json -d contracts/examples/domain-smoke.json
npx --yes --package=ajv-cli@5 --package=ajv-formats ajv validate --spec=draft2020 --all-errors -c ajv-formats -s contracts/events/event.schema.json -d "contracts/examples/*.event.json"
```

OpenAPI 校验器需支持 OpenAPI 3.1；JSON Schema 校验器需使用 Draft 2020-12。平台骨架工单应把等价命令固化到 CI。
