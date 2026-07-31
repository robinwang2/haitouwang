# MVP 运行手册

## 适用状态

本手册仅适用于非生产技术候选。当前 API 未挂载业务 Controller，也没有持久化、生产基础设施或正式健康端点；进程启动成功不代表业务可服务。生产运行须先清零 `infra/release/release-manifest.json` 的阻断项。

## 候选环境启动与停止

1. 按 `tooling/README.md` 使用锁文件安装依赖。
2. 可选：执行 `npm.cmd --prefix tooling run dev:up` 启动本地 PostgreSQL/Redis；当前业务闭环测试不依赖它们。
3. 执行 `npm.cmd --prefix services/api run build`。
4. API 进程可用 `npm.cmd --prefix services/api run start:api` 启动，worker 可用 `npm.cmd --prefix services/api run start:worker` 启动；它们目前只证明进程骨架可运行。
5. 停止 API/worker 进程后，执行 `npm.cmd --prefix tooling run dev:down` 停止开发依赖。不得删除卷来代替正常恢复或迁移。

## 每次发布前检查

- 候选门禁：`powershell -NoProfile -ExecutionPolicy Bypass -File infra/release/verify-release.ps1 -Mode Candidate`。
- 生产门禁：同一脚本使用 `-Mode Production`；当前预期为拒绝。
- 检查依赖审计、秘密扫描、契约、跨租户负测、人工降级和无证据不成功测试。
- 检查目标发布提交、依赖锁、迁移版本和代理协议版本完全确定。

## 未来生产观测最低要求

- API：请求率、错误率、p95/p99 延迟、鉴权拒绝和租户越权拒绝。
- Worker：队列积压、最老任务年龄、重试/死信、幂等重放和撤权后任务拒绝。
- 申请：等待确认、人工接管、提交待验证、可信证据确认及重复回执。
- 数据：数据库连接、复制/备份、outbox 延迟、对象存储失败和审计写入失败。
- 告警不得包含请求正文、简历/事实正文、Cookie、验证码、令牌或完整模型提示。

## 值班分级

- SEV-1：跨租户数据暴露、凭证进入云端/日志、未确认提交、重复提交或审计不可用。立即暂停所有辅助操作、撤销相关令牌并阻止发布。
- SEV-2：提交结果不确定率突增、队列持续积压、代理大面积离线、恢复目标可能失守。暂停受影响能力并转人工。
- SEV-3：单来源解析失败、单通知渠道失败或非关键报表延迟。保留其他能力，记录影响范围并安排修复。

## 交接信息

交接必须包含事件时间线、影响租户数量、受影响能力、当前暂停范围、最近安全检查点、待验证假设和下一动作。仅使用不可逆资源标识及安全错误码。
