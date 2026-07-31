# M1 集成验收报告

## 结论

**通过。** 工单要求的四类来源夹具、跨源去重、工作授权拦截和高风险拦截均已通过实际黑盒测试并留下可复现证据。

验收日期：2026-07-31  
验收分支：`studio/project/0-10`  
验收基线：`ff0d5244911457ea9282f76a9da1a509584351c1`

## 验收范围与方式

测试从编译后的领域模块公开入口执行，不调用私有函数，也不读取内部存储字段：

1. 通过公开档案服务创建求职目标和已确认事实；
2. 通过公开职位导入管线解析四类固定夹具并执行标准化、风险判断和去重；
3. 将公开档案查询返回的可用事实、去重后的职位和职位要求交给公开匹配评分入口；
4. 断言最终分数、解释、硬门和决策。

当前 `services/api/src/app.module.ts` 未挂载 HTTP Controller，因此本次黑盒边界是编译后的公开模块 API，而不是 HTTP 传输层。该限制不影响本工单列出的四项验收用例，但 HTTP 鉴权、序列化和真实 Web/API 联调尚未被本报告覆盖。

## 环境与依赖现场

- 操作系统：Microsoft Windows 11 家庭版
- Node.js：`v24.14.0`
- npm：`11.9.0`
- 依赖安装：在 `tooling` 目录执行 `npm ci --ignore-scripts` 和 `npm run bootstrap`
- 依赖检查点祖先核验：以下提交执行 `git merge-base --is-ancestor <commit> HEAD` 均返回 `0`
  - `b61a5a3ace`（海投王-0-6）
  - `1c6aee3d74`（海投王-0-7）
  - `ca4cc0c70b`（海投王-0-8）
  - `90d0f343ad`（海投王-0-9）
  - `7b77fec3c2`（海投王-0）

## 可复现命令

从仓库根目录进入 `tooling` 后执行：

```powershell
npm ci --ignore-scripts
npm run bootstrap
npm run lint:code
npm run typecheck
npm run unit
npm run contract
npm --prefix ../services/api run build
node --test ../tests/e2e/m1/m1.e2e.test.cjs
```

专项测试文件：`tests/e2e/m1/m1.e2e.test.cjs`

## 专项验收证据

| 用例                 | 实际结果                                                                                                                                                                                                                                                   | 结论 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 四类固定来源夹具     | Greenhouse、Lever、Company Careers、Manual URL 分别单独经过公开导入入口，均得到 1 条职位；主来源和 `source_refs` 类型与夹具来源一致，内容摘要均为 64 位 SHA-256                                                                                            | 通过 |
| 建档、去重和评分闭环 | 创建 1 个目标及 4 条已确认可用事实；四夹具批量导入得到 2 条唯一职位；Acme 同岗的 Careers、Greenhouse、Lever 三条记录合并为 1 条并以官网为主记录，Manual URL 职位保持独立且标记过期；合规职位评分 `100`、决策 `eligible`、7 个硬门全部 `pass`               | 通过 |
| 工作授权拦截         | 目标要求雇主赞助，职位明确 `sponsorship_unavailable`；即使其余维度完全匹配、总分仍为 `85`，`work_authorization` 硬门为 `block`，最终决策为 `blocked`，解释引用 `goal.work_authorization_rule`                                                              | 通过 |
| 高风险拦截           | 包含不安全 HTTP、申请费和 Telegram 联系方式的夹具输出 `risk_review` / `high`，理由为 `description_partial`、`insecure_posting_url`、`payment_requested`、`personal_messaging_contact`；即使维度总分为 `100`，`risk` 硬门仍为 `block`，最终决策为 `blocked` | 通过 |

专项测试实际输出摘要：

```text
tests 4
suites 1
pass 4
fail 0
cancelled 0
skipped 0
todo 0
```

## 回归与质量门禁证据

- `npm run lint:code`：通过。
- `npm run typecheck`：通过；覆盖 `apps/local-agent`、`apps/web`、`services/api`。
- `npm run unit`：通过；`7` 个测试文件、`48` 个测试全部通过。
- `npm run contract`：通过；OpenAPI 校验通过，4 个领域/事件样例通过 Schema 校验。
- M1 E2E 文件单独执行 Prettier 检查：通过。
- API 构建：通过。

完整 `npm run quality` 未全绿，失败点是全仓 Prettier 检查发现依赖检查点已有的 24 个文件未格式化，集中在 `apps/web/src/features/{dashboard,jobs,profile}/**` 与 `services/api/src/modules/matching/**`。这些文件不在本工单写入范围内，本次未修改；代码 lint、类型、单测、契约及 M1 专项验收均已分别实际通过。

## 未覆盖项与风险

1. API 的 `AppModule` 目前为空，尚无可调用的 HTTP 集成入口；后续需要单独工单挂载 Controller，并补充传输层鉴权、请求校验、错误映射和 Web/API 联调验收。
2. 全仓格式门禁会因上述 24 个上游文件失败；需要由拥有对应写入范围的后续工单统一格式化并复跑 `npm run quality`。
