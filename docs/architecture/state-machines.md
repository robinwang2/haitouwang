# 状态机与迁移门禁

## 1. 通用规则

1. 状态只允许按本文件列出的边迁移；未知状态或非法边返回 `409 STATE_TRANSITION_INVALID`。
2. 每次迁移必须携带预期资源版本、`Idempotency-Key`、操作者和原因，并在同一事务写业务记录、时间线及审计/outbox。
3. 同一幂等键的完全相同迁移返回首次结果；异参复用返回 `409 IDEMPOTENCY_KEY_REUSED`。
4. `deleted`、`revoked`、`submitted`、`rejected`、`offer` 等终态不得通过普通更新回退；确有纠错需要时创建带审计的新版本或专用纠错事件。

## 2. 申请状态机

```text
draft -> materials_ready -> approved -> queued -> filling
filling -> awaiting_confirmation -> submitted_pending_verification
submitted_pending_verification -> submitted
submitted_pending_verification -> manual_required
filling|awaiting_confirmation -> manual_required
queued|filling|awaiting_confirmation|manual_required -> cancelled
manual_required -> filling|awaiting_confirmation
submitted -> interview|rejected|offer|withdrawn
interview -> interview|rejected|offer|withdrawn
offer -> withdrawn
```

门禁：

- `materials_ready -> approved`：所有材料已批准且无未关闭 `must_fix`。
- `filling -> awaiting_confirmation`：表单已填充并生成预览；未知必填题、验证码、测评、视频、电子签名、法律/身份问题、工作授权歧义或页面结构不确定时改走 `manual_required`。
- `awaiting_confirmation -> submitted_pending_verification`：必须有当前用户针对该申请、命令和预览版本签发的一次性确认；MVP 中没有确认绝不可提交。
- `submitted_pending_verification -> submitted`：必须存在至少一种可验证证据：第三方确认编号，或包含时间、目标域名和成功判定的脱敏证据引用。仅有“点击成功”或超时不得视为提交成功。
- 无法确认结果时保持 `submitted_pending_verification` 或进入 `manual_required`，不得自动重试提交。

## 3. 其他状态机

### 事实

```text
pending_confirmation -> active|rejected|deleted
active -> expired|revoked|deleted
expired -> active|deleted
rejected|revoked -> deleted
```

只有用户确认或受信规则可令事实进入 `active`；`expired -> active` 必须创建新版本并重新确认。`prohibited` 是使用策略状态，只能删除，不能转为可用事实。

### 材料

```text
draft -> generating -> review_required
generating -> failed
review_required -> draft|approved|rejected
approved -> superseded
failed -> generating|rejected
```

批准后内容不可原地修改；编辑产生新 `draft` 版本并将旧版本 `superseded`。

### 评审

```text
queued -> running
running -> requires_changes|needs_human|approved|rejected|failed
requires_changes -> queued
failed -> queued|needs_human
```

达到循环上限、证据冲突、模型不可用或未知高风险问题时进入 `needs_human`，不得无限自动循环。

### 职位

```text
discovered -> normalized|risk_review|removed
normalized -> active|risk_review|expired
risk_review -> active|removed|expired
active -> risk_review|expired|removed
expired -> active|removed
```

`expired -> active` 只在来源重新验证有效且产生新版本后允许。

### 本地代理与配对会话

```text
PairingSession: issued -> claimed -> confirmed
PairingSession: issued|claimed -> expired|revoked
Agent: unpaired -> pairing -> online
Agent: pairing -> unpaired|revoked
Agent: online -> offline|revoked
Agent: offline -> online|revoked
```

`revoked` 为终态；重新连接必须新建代理授权，不复活旧代理 ID。

### 任务

```text
queued -> leased -> running
leased -> queued|expired|cancelled
running -> succeeded|failed|requires_human|cancelled
failed -> queued|requires_human|cancelled
requires_human -> queued|cancelled
```

租约到期可回到 `queued`，但申请提交类任务只有在已证明没有发生提交时才可重试；证据不确定必须进入 `requires_human`。

### 通知

```text
pending -> sent|failed|suppressed
failed -> pending|suppressed
```

相同去重键不得产生第二次发送；退订、静默时段或数据已删除时进入 `suppressed`。

### 面试

```text
tentative -> confirmed|cancelled
confirmed -> rescheduled|completed|cancelled
rescheduled -> confirmed|rescheduled|completed|cancelled
```

邮件推断只能创建 `tentative`；用户或高置信受控规则确认后才进入 `confirmed`。

## 4. 人工降级原因

稳定原因枚举为：

`captcha`、`assessment`、`video_interview`、`electronic_signature`、`unknown_required_field`、`legal_or_identity_question`、`work_authorization_ambiguous`、`page_structure_changed`、`submission_result_uncertain`、`credential_required`、`policy_blocked`、`evidence_conflict`。

进入人工降级时必须记录资源、原因、恢复所需动作和不含秘密的证据引用。不得记录题目答案中的敏感正文、Cookie、验证码或登录凭证。
