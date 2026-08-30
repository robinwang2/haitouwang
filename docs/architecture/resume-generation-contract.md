# 简历生成契约（resume_mvp_contract）

> 工单：海投王 R0 / resume_mvp_contract
> 状态：契约已锁定，实现待后续工单（json_rag_adapter、jd_analysis、evidence_retrieval、
> resume_generation_orchestrator、claim_verification、resume_generation_api）逐张交付。
> 机器字段的完整约束见 `contracts/schemas/domain.schema.json`（`ResumeGeneration` 及其
> 子模型）与 `contracts/openapi/openapi.json`（`POST /v1/resume-generations`）。

## 1. 端口链与外部字段隔离

```text
JSON 文件（上传或服务端测试夹具引用）
  → RagSource.load()
  → RagRecordMapper.map()
  → EvidenceRecord[]
  → Retriever.retrieve()
  → ResumeGenerationService
       ├─ JdAnalyzer          （只读 jd_text，产出 JdAnalysis）
       ├─ ResumeGenerator     （只允许引用 Retriever 返回的 EvidenceRecord.id）
       └─ ClaimVerifier       （拒绝无有效 evidence_ids 或伪造实体/数字的 claim）
```

**硬约束：外部 JSON 字段名不得渗透到下游。** `RagSource` 读到的原始 JSON 结构只在
`RagRecordMapper` 内部可见；一旦越过 `RagRecordMapper.map()` 这条边界，代码、Prompt、
检索索引、契约响应和界面只能看到 `EvidenceRecord` 的六个稳定字段
（`id`、`kind`、`content`、`tags`、`source{type,reference}`、`metadata`）。任何试图在
`Retriever`、`ResumeGenerationService`、API 响应或前端中直接读取"那份 JSON 的字段名"的
实现都违反本契约，必须在代码评审中拒绝。

这是因为正式 JSON 格式尚未由用户提供（见 `施工计划.md` 4.1、任务 `json_schema_followup`）。
`EvidenceRecord` 是 Mapper 之后的**稳定**内部模型，不随外部格式变化；外部格式变化时只重写
`RagRecordMapper`，不触碰 `Retriever` 或生成/校验代码。`EvidenceRecord.id` 由
`RagRecordMapper` 派生（建议：对 `source.reference` 做确定性 UUID 派生，例如 UUIDv5），
不得直接复用外部 JSON 记录自带的原始 id/key——这样即使原始 JSON 用字符串、数字或嵌套路径
做主键，泄漏的也只是一个不透明标识符，不是原始字段名或取值。

`EvidenceRecord.kind` 和 `EvidenceSource.type` 目前刻意保持为开放字符串而非枚举：具体取
值分类要等正式 JSON 格式（**provisional**，`schema_version` 尚未确定，见
`contracts/schemas/domain.schema.json` 中 `EvidenceRecord`/`EvidenceSource` 的
`description`）到达后再锁定。临时测试夹具（`resume_mvp_fixtures` 工单产出）不得写入本文件
或任何 `contracts/**` 长期契约，只能保证映射出 `id`/`kind`/`content`。

## 2. 生成状态与错误码

`ResumeGenerationStatus` 只有四个取值：`pending`、`generating`、`review_required`、
`failed`。**枚举中不存在任何"已自动批准"的状态**——`review_required` 是唯一成功终态；
把结果转成正式可投递材料是 Materials 审核门禁的职责，不属于这个契约。

六种失败情形对应六个互不重叠的机器码（完整定义见
`docs/architecture/contract-conventions.md` 第 4 节错误码表和
`contracts/schemas/domain.schema.json` 的 `ErrorCode`）：

| 情形                      | 错误码                             | HTTP |
| ------------------------- | ---------------------------------- | ---: |
| RAG 源不是合法 JSON       | `RAG_SOURCE_INVALID`               |  400 |
| JD 为空白                 | `JD_TEXT_EMPTY`                    |  400 |
| JD 超过业务长度上限       | `JD_TEXT_TOO_LONG`                 |  400 |
| 召回不到相关证据          | `RESUME_EVIDENCE_NOT_FOUND`        |  422 |
| 模型调用失败/结构不可用   | `RESUME_GENERATION_FAILED`         |  500 |
| 事实引用/关键字段校验失败 | `RESUME_CLAIM_VERIFICATION_FAILED` |  422 |

`jd_text` 的 JSON Schema 故意不设 `minLength`，只设一个远高于业务阈值的技术上限
（200000 字符）。这样空白或超长的 JD 不会在请求校验层被拦成通用的
`VALIDATION_FAILED`，而是进入 `JdAnalyzer` 的业务校验并返回上表中语义明确的专用错误码。

## 3. 幂等语义

`POST /v1/resume-generations` 采用两层幂等，和申请提交（`submission_idempotency_key`，见
`contract-conventions.md` 第 5.4 节）同一模式：

1. **传输层**：`Idempotency-Key` 请求头，遵循全局约定第 5 节——按
   `(authenticated_principal, operation_id, idempotency_key)` 存储首次响应，原样重放。
2. **业务层**：请求体 `idempotency_key` 字段，作用范围是
   `(authenticated_user_id, jd_text, rag_source, preferences)` 归一化后的这一次"生成意图"。
   - 相同业务键 + 相同归一化请求 → 直接返回首次生成结果（同一个 `generation_id`），
     不重新调用模型、不重新跑一次证据检索，避免重复的模型开销和重复的事实校验副作用。
   - 相同业务键 + 不同归一化请求（`jd_text`/`rag_source`/`preferences` 任一不同）→
     `409 IDEMPOTENCY_KEY_REUSED`，不执行第二次生成。
   - 业务键的存活窗口与该资源的最大合理重试窗口一致（与其他创建类接口的幂等记录保留期
     对齐，具体数值由实现层配置，不在契约中写死）。

两层幂等的关系：请求头保护的是"同一次 HTTP 调用被网络重试"这种传输层重复；请求体
`idempotency_key` 保护的是"用户或客户端对同一份 JD+RAG 组合重复点了生成"这种业务层重复。
两者作用范围不同，缺一不可——纯头部幂等无法跨越客户端重新生成新请求 ID 的场景。

## 4. 简历结构与事实引用

`resume.sections[].claims[]` 里的每一条 `ResumeClaim` **必须**带至少一个
`evidence_ids`（`minItems: 1`），且这些 id 必须能在 `retrieved_evidence.used` 中找到
对应的 `EvidenceRecord`。`ClaimVerifier`（后续工单 `claim_verification`）在此契约基础上
做独立的事实门禁：引用不存在、公司/学校/职位/时间/数字等关键字段被篡改、或出现证据里没有
的新技能，都必须阻止该次生成进入 `review_required`，改为 `failed` +
`RESUME_CLAIM_VERIFICATION_FAILED`，不允许模型的自我声明替代这道门禁。

`warnings[].code` 覆盖四类非阻断性问题：`evidence_gap`（部分岗位要求没有对应事实）、
`low_relevance`（召回证据相关性偏低）、`pending_confirmation`（引用的证据本身尚待用户确认）、
`degraded`（生成过程发生了降级，例如模型重试后仍只能产出较保守的结果）。warning 不阻止
`review_required`，但必须在响应和界面中明显展示，交由用户判断。
