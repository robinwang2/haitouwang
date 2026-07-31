# MVP 部署计划

## 当前结论

`release-manifest.json` 将当前产物标记为 `non-production-validation`，生产发布未获授权。候选验证可以执行，任何生产变更必须先清零清单中的发布阻断项；禁止把 `infra/dev/compose.yaml` 或其开发占位配置用于生产。

## 候选验证

在仓库根目录、依赖已按锁文件安装后执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra/release/verify-release.ps1 -Mode Candidate
```

脚本按顺序验证 API 构建、全仓类型、单元、契约、M1/M2/MVP 端到端、本地代理浏览器集成和安全扫描。任一命令非零即停止。

生产门禁可用下列命令复核；在阻断项存在时它应以非零退出，且不得触发任何外部部署：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File infra/release/verify-release.ps1 -Mode Production
```

## 未来生产部署顺序

只有 `production_authorized=true` 且 `blockers=[]` 后才能执行：

1. 冻结发布提交，保存镜像不可变摘要、契约版本和迁移版本。
2. 验证生产配置引用秘密管理器，且没有使用开发默认值；确认数据地域、保留和 AI 跨境策略。
3. 备份主数据库并执行恢复抽检；确认 Redis/BullMQ 的重复消费策略和对象存储版本保护。
4. 在预发布环境执行向前迁移、API/worker 部署、HTTP 鉴权与跨租户烟测、本地代理配对和一次人工确认申请演练。
5. 先部署向后兼容的数据迁移，再部署 API、worker、Web；本地代理必须保持协议主版本兼容。
6. 观察错误率、队列积压、人工降级率、重复回执和审计写入；达到回滚阈值立即按运行手册回滚。

## 发布证据归档

归档发布提交、清单快照、命令输出、审批人、部署时间、迁移前后版本、备份恢复证据、烟测租户和回滚判定。不得归档请求正文、简历内容、Cookie、验证码或令牌。
