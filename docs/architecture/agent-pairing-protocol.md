# 云端与本地代理配对协议

## 1. 目标和边界

协议覆盖一次性配对、短期范围令牌、命令领取/回执、心跳、撤权、重放保护、显式提交确认和脱敏审计。目标招聘网站的用户名、密码、Cookie、session storage 和验证码始终留在用户设备的专用浏览器配置中，不得发送给云端。

Web 用户会话、代理控制凭证和目标站点浏览器会话使用不同存储、受众和生命周期。代理控制令牌不得注入 Playwright 页面上下文；目标站点 Cookie 不得进入代理 API 客户端。

## 2. 参与方与密钥

- **Web 用户**：通过正常 SaaS 身份会话发起和确认配对。
- **云端控制面**：签发一次性配对材料、验证设备证明、发放范围令牌并编排任务。
- **本地代理**：首次启动时生成不可导出的设备密钥对；私钥保存在操作系统受限密钥存储，云端只保存公钥及其指纹。
- **目标网站浏览器**：独立的本地 Playwright profile，只与目标网站通信。

配对短码用于人工核对，不是长期凭证。配对秘密、授权码、access token、refresh token 和提交确认 nonce 都不得进入普通日志、遥测或崩溃报告。

## 3. 一次性配对

1. 已认证用户调用 `POST /v1/agent-pairing-sessions`，云端生成 `pairing_session_id`、高熵 `pairing_secret`、签名 challenge、短显示码和最长 10 分钟的 `expires_at`。响应只显示一次秘密。
2. 用户把配对 URI 交给本地代理。代理校验 URI 的云端来源，生成设备密钥，调用 `POST /v1/agent-pairing-sessions/{id}:claim`，提交配对秘密、设备公钥、对 `session_id + challenge` 的设备签名和有限设备元数据。
3. 云端常量时间比较秘密，校验 challenge 签名、到期和未消费状态，将会话置为 `claimed`，并在已登录 Web 页面显示设备名、公钥指纹和短码。失败统一返回 `PAIRING_CODE_INVALID`，不泄露具体哪一项错误。
4. 用户在 Web 端显式确认后调用 `POST .../{id}:confirm`。云端将会话置为 `confirmed`，绑定 `user_id + agent_id + public_key_thumbprint`，返回一次性 authorization code。
5. 代理用设备私钥签名请求并通过 `POST /v1/agent-tokens` 交换 authorization code。云端签发最长 5 分钟的 access token 和可撤销、设备绑定的轮换 refresh token。后续同一端点用于 refresh token 轮换；旧 refresh token 一经轮换立即失效，复用旧 token 视为窃取并撤销整个授权族。

配对 session、pairing secret、authorization code 和 challenge 均一次性消费。所有重复消费都由消费记录拒绝；安全相关重复返回 `409 REPLAY_DETECTED`，合法 HTTP 重试则通过 `Idempotency-Key` 返回首次响应。

## 4. 代理令牌声明

access token 至少包含：

| 声明 | 约束 |
|---|---|
| `iss` | 云端控制面固定签发者 |
| `sub` | `agent_id` |
| `tenant_id` / `user_id` | 与代理绑定用户一致 |
| `aud` | 固定 `local-agent-control` |
| `scope` | `agent:commands:claim`、`agent:receipts:write`、`agent:heartbeat:write` 的最小集合 |
| `iat` / `nbf` / `exp` | 短期有效，允许的时钟偏差不超过 60 秒 |
| `jti` | 全局唯一；敏感操作保留消费记录 |
| `cnf` | 设备公钥指纹，要求请求持有证明 |
| `authorization_version` | 与云端当前授权版本相等；撤权后递增 |

每个代理请求还包含签名时间、请求 nonce 和请求体摘要。云端校验 TLS、令牌签名/受众/范围/时效、设备持有证明、授权版本和 nonce；任一失败均不执行业务动作。

## 5. 任务领取与回执

1. 代理长轮询 `POST /v1/agents/{agent_id}/commands:claim`。云端只返回绑定该用户/设备且范围允许的单个命令。
2. 命令包含 `command_id`、稳定业务 `idempotency_key`、一次性 `nonce`、`issued_at`、`expires_at`、目标资源引用、允许动作和签名；不得包含登录凭证、Cookie、验证码或任意脚本。
3. 代理验证签名、用户、设备、受众、到期、nonce 和本地授权状态，再用 `accepted` 回执获取租约。已消费命令返回首次回执，绝不重复执行。
4. 代理按状态发送 `started`、`paused`、`completed`、`rejected` 回执。每个回执有独立序号和幂等键；服务端唯一约束为 `(agent_id, command_id, receipt_sequence)`。
5. `completed` 只携带结构化结果、第三方确认编号或脱敏证据对象引用。截图须先在本地遮盖秘密；禁止上传浏览器 profile、Cookie、验证码、密码字段或完整页面存储。

领取租约默认 60 秒，可由心跳续租，但不得超过命令 `expires_at`。网络断开后，提交结果不确定的任务不得重新点击提交，必须回执 `manual_intervention_required/submission_result_uncertain`。

## 6. 提交确认

MVP 自动化等级 1 下，填写完成后必须停在 `awaiting_confirmation`：

1. 代理上报预览摘要和 `preview_hash`，不上传秘密字段。
2. 用户在 Web 端查看风险、未决项和预览后显式确认。
3. 云端签发最长 2 分钟、绑定 `user_id + agent_id + application_id + command_id + preview_hash` 的一次性 confirmation token。
4. 代理在点击提交前最后一次验证 token、授权与页面哈希，并原子消费 confirmation token。

任何页面变化、未知问题、验证码、测评、视频、电子签名、法律/身份问题或工作授权歧义都使旧确认失效并进入人工接管。普通“继续”或开关操作不能代替此次高风险确认。

## 7. 心跳、撤权和恢复

- 代理每 30 秒调用 heartbeat，报告版本、能力、授权状态、当前命令 ID 和脱敏健康状态；不得上传页面正文。
- 连续 90 秒无心跳标记 `offline`，不立即撤权；租约按自身到期规则回收。
- 用户撤权、退出设备或账户删除时，云端递增 `authorization_version`、撤销 refresh token 族、拒绝新 token/命令、取消待执行任务并发布 `authorization.revoked.v1`。
- 本地代理在下一次网络交互和每次命令执行前检查撤权。检测到撤权后停止队列、清除云端控制令牌；目标站点本地 profile 的删除由用户明确操作，不上传清理内容。
- 恢复离线代理可使用仍有效的轮换 refresh token；已撤权代理必须重新配对并获得新的 `agent_id`。

## 8. 拒绝与审计

过期、撤销、错误受众、错误设备、越范围、签名错误、重复 `jti`/nonce 分别映射到稳定错误码，但外部响应不暴露密钥或令牌内容。安全审计记录代理 ID、公钥指纹、动作、结果、稳定原因、请求/关联 ID 和源网络的受控摘要；不记录配对秘密、令牌、authorization code、Cookie、验证码或页面正文。

成功、拒绝和人工降级事件样例分别见：

- `contracts/examples/application-submitted.event.json`
- `contracts/examples/agent-command-rejected.event.json`
- `contracts/examples/application-manual-intervention.event.json`
