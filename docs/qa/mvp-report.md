# MVP 集成验收与发布准备报告

## 结论

非生产技术候选验收通过，生产发布不通过且已失败关闭。

M1/M2/MVP 联合端到端 19/19 通过，140 个单元测试、7 个真实 Playwright 页面集成测试、类型检查、API 构建、契约校验、五个工作区依赖审计和秘密扫描均通过。主路径、人工降级、提交不确定、跨租户权限与人工恢复均有可重复证据。

不能把当前提交批准为生产 MVP：NestJS `AppModule` 没有挂载业务 Controller/鉴权，Applications/Reporting 使用进程内存且没有生产迁移/备份恢复，数据地域、保留、RPO/RTO 等决策未完成，生产 IaC/可观测性不存在；此外上游全仓质量检查仍有 40 个格式问题和 4 个 lint 错误。这些问题超出本工单写入范围，已登记为 `REL-001` 至 `REL-005`，并由生产门禁统一阻断。

## 环境与基线

- 验收日期：2026-07-31（America/Los_Angeles）
- 分支：`studio/project/0-20`
- 集成基线：`b2b4cd64996e`
- Node.js：`v24.18.1`
- npm：`11.16.0`
- 依赖：按五个锁文件安装；所有工作区审计为 0 个已知漏洞
- Docker：执行环境未提供 `docker` 命令，因此未运行 compose 配置/启动验证

## 新增 MVP 黑盒证据

`tests/e2e/mvp/mvp.e2e.test.cjs` 仅调用编译后的 Applications 和 Reporting 公共入口，不访问内部 Map：

1. 已批准材料依次进入排队、填写和确认；本地代理预览回执保持暂停，只有显式确认和可信第三方确认编号才能进入 `submitted`。
2. 提交结果不确定时停留在 `submitted_pending_verification`；直接标成功返回 `EVIDENCE_REQUIRED`，状态不变。
3. CAPTCHA 回执进入 `manual_required`，人工包只含 URL 和材料/事实引用；恢复必须走合法状态迁移并生成新回执、重新确认。
4. 另一租户读取申请、通知或日报返回 `RESOURCE_NOT_FOUND`，列表与审计为空。
5. 发布清单保持 `production_authorized=false`；所有未解决风险都使用 `block-production-release` 控制。

## 实际命令与结果

| 命令                                                                                                    | 实际结果                                                               |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm.cmd ci --ignore-scripts`（tooling）                                                                | 通过；226 个包，0 个已知漏洞                                           |
| `npm.cmd run bootstrap`（tooling）                                                                      | 通过；agent、local-agent、web、api 均按锁文件安装，0 个已知漏洞        |
| `powershell -NoProfile -ExecutionPolicy Bypass -File infra/release/verify-release.ps1 -Mode Candidate`  | 通过；完成构建、类型、单元、契约、联合 E2E、浏览器代理和安全门禁       |
| 联合 E2E（由候选门禁执行）                                                                              | 通过；7 suites、19 tests、0 failed、0 skipped                          |
| `npm.cmd run unit`（由候选门禁执行）                                                                    | 通过；17 files、140 tests                                              |
| `npm.cmd run test:browser`（由候选门禁执行）                                                            | 通过；1 file、7 tests                                                  |
| `npm.cmd run contract`（由候选门禁执行）                                                                | 通过；OpenAPI 与 4 个契约样例有效                                      |
| `npm.cmd run security`（由候选门禁执行）                                                                | 通过；5 个工作区 0 个已知漏洞，秘密扫描退出 0                          |
| `powershell -NoProfile -ExecutionPolicy Bypass -File infra/release/verify-release.ps1 -Mode Production` | 预期拒绝；其余门禁均通过后以非零退出并列出 `REL-001` 至 `REL-005`      |
| `npm.cmd run quality`（tooling）                                                                        | 失败；上游 40 个文件不满足 Prettier，组合命令在格式阶段停止            |
| `npm.cmd run lint:code`（tooling）                                                                      | 失败；上游 `review-workflow.test.js` 有 4 个 `no-require-imports` 错误 |
| `docker --version`                                                                                      | 无法执行；当前环境没有 Docker CLI                                      |

## 安全、恢复与发布评估

- 安全：跨租户、配对令牌过期/撤销/越范围/重放、提示注入、秘密扫描、提交确认和可信证据门禁均由现有测试覆盖；没有发现依赖漏洞。当前没有真实 HTTP 鉴权边界，所以不能把模块负测外推为线上鉴权已验证。
- 人工恢复：领域状态恢复和重新确认通过；人工任务历史保留。进程恢复未通过，因为状态未持久化，进程重启会丢失业务数据。
- 部署：候选门禁可重复执行；生产模式明确非零退出。仓库只含开发 compose，不含生产部署定义。
- 迁移：当前不存在业务迁移；`infra/dev/postgres-init/001-vector.sql` 只启用开发 pgvector。首个持久化版本的前向兼容、回填、校验和回滚要求已写入迁移计划。
- 回滚：代码/能力暂停、令牌撤销、队列停止领取、证据保护和逐步恢复流程已记录；没有生产镜像/备份可供实际演练。

## 验收标准核对

- [x] MVP 公共模块主路径、无证据不成功和审计/日报可追溯测试通过。
- [x] CAPTCHA、未知/不确定结果等人工降级由代理和 MVP 测试覆盖。
- [x] 跨用户材料/事实、申请、通知、日报和代理令牌权限负测通过。
- [x] 人工接管后的合法状态恢复与重新确认测试通过。
- [x] 非生产候选发布清单、迁移计划、回滚和运行手册可执行/可审阅。
- [x] 所有发现的高危缺口均由生产门禁失败关闭，没有静默接受风险。
- [ ] 生产发布清单全部通过且高危缺口已消除：未满足，受 `REL-001`、`REL-002`、`REL-003`、`REL-005` 阻断。

因此本工单完成了允许范围内的集成验收与发布准备，但工单唯一验收标准不能签署为“全部通过”。

## 未解决问题与后续修复建议

1. 挂载契约一致的 API Controller、认证与租户上下文，补真实 HTTP/Web 端到端和跨租户测试；这是解除 `REL-001` 的前置工单。
2. 引入 PostgreSQL Repository、outbox、队列和对象存储，提供已评审迁移及生产等价备份恢复演练；解除 `REL-002`。
3. 产品负责人按原定日期确认数据地域、AI 跨境/供应商、保留周期、商业边界和 RPO/RTO，并把决定转成配置与恢复门禁；解除 `REL-003`。
4. 在对应前端/后端写入范围内修复 40 个格式问题和 4 个 lint 错误，恢复全仓 `quality`；解除 `REL-004`。
5. 增加生产 IaC、TLS、健康/就绪端点、监控告警和不可变镜像，并演练部署与回滚；解除 `REL-005`。
