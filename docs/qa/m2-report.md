# M2 集成与 AI 评测报告

## 结论

M2 专项验收通过。事实到材料人工批准的主路径、6 个可追溯黄金样本、提示注入、跨用户越权、评审模型不可用、证据冲突和三轮修订上限均经过实际、可重复执行的黑盒测试。M2 专项最终结果为 10/10 通过、0 跳过；M1+M2 联合端到端结果为 14/14 通过、0 跳过。

项目级 `typecheck`、106 个单元测试、契约校验和 API 构建通过。全仓 `quality` 未通过，原因是依赖检查点已有的 30 个文件不满足 Prettier；单独执行 `lint:code` 还发现上游 `apps/web/src/features/review/review-workflow.test.js` 的 4 个 CommonJS import 违反 lint 规则。两组失败均已在下文完整列出，未修改范围外文件掩盖失败。

## 环境与集成基线

- 验收时间：2026-07-31（America/Los_Angeles）
- 分支：`studio/project/0-15`
- 验收基线：`f5b5aefc6f1a`
- 操作系统：Microsoft Windows NT 10.0.26200.0
- Node.js：`v24.18.1`
- npm：`11.16.0`
- 依赖安装：`tooling` 中执行 `npm ci --ignore-scripts`，随后执行 `npm run bootstrap`；均通过，审计结果为 0 个已知漏洞
- 依赖检查点：`74dc11af3a`、`fc3843cce5`、`ce8e2bede2`、`7b77fec3c2` 的 `git merge-base --is-ancestor <commit> HEAD` 均返回 0

隔离工作区首次在安装依赖前执行 API 构建，因缺少 `@types/node` 失败。按仓库锁文件完成安装后重新构建通过；该环境准备失败没有被计为代码通过。

## 测试范围与方法

测试从编译后的公开模块入口调用 Profile、Jobs、Materials 和 Review，不访问私有函数或内部 Map：

1. 经 Profile 公共服务创建目标和 3 条用户确认事实，再经公开查询取得目标范围内可用事实。
2. 经职位导入公共管线解析完整职位，并明确传入技能、经历和工作授权要求。
3. 经 Materials 公共服务生成带事实版本引用的材料；第一轮独立评审识别重复语言，受限修订代理移除冗余事实后第二轮通过。
4. 四个评审器使用互异的 reviewer configuration，且均与 generator configuration 隔离。
5. 仅在最终评审建议为 `approve` 后调用显式材料批准；断言版本历史和审计依次为创建、修订、批准。
6. 固定黄金夹具保存输入事实、预期 finding 类别/处理分组和最终处置；测试逐条验证 claim 引用、finding 证据引用和最终 disposition。

测试不调用外部模型。当前实现声明的 generator 和 reviewers 均为内部确定性配置；模型故障用抛错的独立 reviewer 替身注入真实拒绝路径，验证系统不会伪造成功或继续自动修订。

## 实际命令与结果

除特别说明外，命令从仓库根目录执行。

| 命令                                                                                                                                                     | 实际结果                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `node --version`                                                                                                                                         | 通过；`v24.18.1`                                                                                               |
| `npm.cmd --version`                                                                                                                                      | 通过；`11.16.0`                                                                                                |
| `cd tooling; npm.cmd ci --ignore-scripts`                                                                                                                | 通过；安装 226 个包，0 个已知漏洞                                                                              |
| `cd tooling; npm.cmd run bootstrap`                                                                                                                      | 通过；按锁文件安装 local-agent、web、api 依赖，均为 0 个已知漏洞                                               |
| `cd services/api; npm.cmd run build`（依赖安装前）                                                                                                       | 失败；`TS2688`，缺少 Node 类型定义；安装锁定依赖后消失                                                         |
| `cd services/api; npm.cmd run build`（依赖安装后最终执行）                                                                                               | 通过                                                                                                           |
| `node --test tests/e2e/m2/m2.e2e.test.cjs`                                                                                                               | 通过；3 suites、10 tests、0 failed、0 skipped、0 todo                                                          |
| `node --test tests/e2e/m1/m1.e2e.test.cjs tests/e2e/m2/m2.e2e.test.cjs`                                                                                  | 通过；4 suites、14 tests、0 failed、0 skipped、0 todo                                                          |
| `npx.cmd prettier --config tooling/.prettierrc.json --check tests/e2e/m2/m2.e2e.test.cjs tests/e2e/m2/fixtures/golden-samples.json docs/qa/m2-report.md` | 通过；全部目标文件符合格式                                                                                     |
| `cd tooling; npm.cmd run typecheck`                                                                                                                      | 通过；local-agent、web、api 均通过                                                                             |
| `cd tooling; npm.cmd run unit`                                                                                                                           | 通过；12 files、106 tests 全部通过                                                                             |
| `cd tooling; npm.cmd run contract`                                                                                                                       | 通过；OpenAPI 和 4 个契约样例有效                                                                              |
| `cd tooling; npm.cmd run lint:code`                                                                                                                      | 失败；上游 `review-workflow.test.js` 有 4 个 `no-require-imports` 错误                                         |
| `cd tooling; npm.cmd run quality`                                                                                                                        | 失败；在 `format:check` 阶段发现上游 30 个文件未格式化，后续子命令未由该组合命令执行；它们已用上表独立命令执行 |

最终 M2 专项输出摘要：

```text
tests 10
suites 3
pass 10
fail 0
cancelled 0
skipped 0
todo 0
```

## 黄金样本追溯结果

黄金夹具位于 `tests/e2e/m2/fixtures/golden-samples.json`。每个样本固定保存输入 fact ID、场景、预期评审状态、recommendation、finding 类别、处理 bucket 和最终 disposition；执行时同时断言所有 verified claim 至少引用一个夹具事实，所有 finding 的 `evidence_refs` 可解析到本次输入的 fact、material 或 job。

| 样本                       | 输入事实/变体                             | finding 与处理                               | 最终处置                                                     | 结果 |
| -------------------------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ | ---- |
| `golden-pass`              | 已确认 TypeScript                         | 无 finding                                   | `approval_candidate`                                         | 通过 |
| `golden-contradiction`     | 引用不存在的事实版本                      | `fact_contradiction` → `must_fix`            | `blocked`                                                    | 通过 |
| `golden-fabrication`       | claim 添加虚构 Kubernetes 经历            | `fabricated_claim` → `must_fix`              | `blocked`                                                    | 通过 |
| `golden-critical-missing`  | 职位描述标记为缺失                        | `critical_job_data_missing` → `human_review` | `human_review`                                               | 通过 |
| `golden-evidence-conflict` | 同一 claim 引用 TypeScript 与 Rust 冲突值 | `evidence_conflict` → `human_review`         | `human_review`                                               | 通过 |
| `golden-prompt-injection`  | 不可信指令要求无证据编造经历              | `critical_claim_unconfirmed` → `must_fix`    | `blocked`；材料不可发布且批准抛出 `MATERIAL_NOT_PUBLISHABLE` | 通过 |

## 安全降级证据

- 矛盾与编造：均产生开放 `must_fix` finding，recommendation 为 `revise`，不得进入批准候选。
- 关键缺失：职位正文缺失产生 `critical_job_data_missing`，直接进入人工审核。
- 提示注入：注入载荷只能成为 `pending_confirmation` 声明，不能进入 verified claim；材料校验产生 `PENDING_CONFIRMATION` 阻断项，显式批准失败。
- 越权访问：其他用户显式选择事实生成材料、读取已有材料、用他人材料发起评审分别以 `RESOURCE_NOT_FOUND` 或 `VALIDATION_FAILED` 拒绝。
- 模型不可用：任一独立 reviewer 抛错会生成带 material 证据的 `reviewer_unavailable`，状态为 `needs_human`，自动修订次数为 0。
- 证据冲突：冲突事实不按顺序猜测，生成 `evidence_conflict` 并转人工。
- 修订上限：持续的可自动修订 finding 只允许两次修订、三轮评审；第三轮生成 `revision_round_limit` 并转人工。

## 验收标准核对

- [x] `tests/e2e/m2/**` 覆盖事实到批准材料主路径，并重复执行通过。
- [x] 黄金样本可追溯到输入事实、finding 证据和最终处置。
- [x] 矛盾、编造、关键缺失、提示注入和越权用例均被阻断或进入人工审核。
- [x] 模型故障、证据冲突和修订轮次达到上限时安全降级。
- [x] 本报告记录实际命令、环境、通过/失败结果和剩余风险。
- [x] M2 专项及单元测试无跳过；项目级已知失败和未覆盖边界均在本报告明示。

## 剩余风险与未覆盖边界

1. 当前 API `AppModule` 未挂载 M2 HTTP Controller，主路径通过编译后的公共领域模块完成；因此 HTTP 鉴权、DTO 序列化、持久化事务和 Web/API 联调尚未覆盖。当前没有外部提交入口，风险按集成缺口记录；待 Controller/持久化接入后必须补独立工单的传输层和真实端到端测试。
2. 生产外部 AI 供应商仍未启用和选型。本次验证的是当前内部确定性 generator/reviewer 以及 reviewer 抛错的安全降级，不代表任何未来供应商的保留、跨境、限流或响应格式已经验证。
3. Materials 的公开 `approve` 方法本身不接收 Review 聚合或批准令牌；本次闭环由调用方在 review 为 `approve` 后显式批准。待应用编排层出现时，必须把“最终 review 无开放阻断项”做成服务端不可绕过的事务门禁，并补直接绕过负测。在尚无 HTTP Controller/提交入口的当前里程碑中，该项是明确的后续集成风险，不是未说明的线上高危暴露。
4. 全仓 `quality` 仍受 30 个上游格式问题阻断，`lint:code` 仍受上游 review workflow 测试的 4 个规则错误阻断；本工单无权修改这些文件。M2 新增文件的定向格式检查、API 构建、类型、单元、契约和联合 E2E 均已分别通过。

## 建议后续工单

1. 在拥有 `apps/web/src/features/review/**` 和既有前端模块写权限的工单中统一修复 30 个 Prettier 差异及 4 个 lint 错误，恢复全仓 `npm run quality` 绿灯。
2. API Controller、持久化和认证接入后，增加真实 HTTP 跨租户、并发版本冲突、review-to-approval 原子门禁及 Web/API 浏览器端到端测试。
3. 外部 AI 供应商决策完成后，用受控测试账户补真实 provider 的注入、超时、限流、畸形响应、数据最小化和不可用降级评测。
