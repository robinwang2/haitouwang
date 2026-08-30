# HTTP Profile 契约核验报告（HW-6）

## 结论

**通过。** 本单对 `contracts/openapi/openapi.json` 中 `/v1/goals` 与 `/v1/facts`
的定义逐条核验，确认 HW-5 已交付的 12 条真实 HTTP 栈用例覆盖范围，并新增 10 条
用例补齐契约声明、现有测试未验的缺口：token 过期、显式/越界 `page_size`、无效
`cursor`、POST 400（缺必填字段，区别于 HW-5 已覆盖的 Idempotency-Key 缺失一类）、
POST 409（Idempotency-Key 复用于不同请求体）。

验收日期：2026-08-29
验收分支：`platform/project-f359de02/HW-6`
验收基线：`33a72c7114553150c4962d2a57754bc3563463b2`

## 验收范围与方式

新增测试文件 `services/api/tests/http/profile.contract-gaps.web-api.unit.test.ts`
与 HW-5 的 `services/api/tests/profile/profile.controller.web-api.unit.test.ts`
并存，后者未被改动、未被移动。新文件同样通过真实 HTTP 栈验证：

- 用 `@nestjs/testing` 启动完整 `AppModule`（真实 `BearerAuthGuard` 鉴权中间件，
  不 mock），`overrideProvider(PROFILE_STORE)` 注入 HW-4 抽出的
  `InMemoryProfileStore`（内存实现，不需要 Docker/Postgres）；
- `app.listen(0, '127.0.0.1')` 监听随机端口，每条用例通过 `fetch` 发起真实 HTTP
  请求，断言响应状态码、响应体与 `contracts/schemas/domain.schema.json` 中的
  `Goal` / `Fact` / `ErrorEnvelope` schema；
- `services/api/tests/http/` 下无任何一处直接调用 `ProfileController` 或
  `ProfileService` 的方法。

## 已覆盖用例：HW-5（12 条，未改动）

文件：`services/api/tests/profile/profile.controller.web-api.unit.test.ts`

| #   | 用例                                                                                   |
| --- | -------------------------------------------------------------------------------------- |
| 1-4 | `GET/POST /v1/goals`、`GET/POST /v1/facts` 缺 `Authorization` 头 → 401 `AUTH_REQUIRED` |
| 5   | 签名无效的 bearer token → 401 `AUTH_REQUIRED`                                          |
| 6   | `aud` 不匹配（GET /v1/goals）→ 401，不降级为 403                                       |
| 7   | `aud` 不匹配（POST /v1/goals）→ 401，不降级为 403                                      |
| 8   | 创建并列出 goals，按认证租户隔离                                                       |
| 9   | 相同 Idempotency-Key 重放 POST /v1/goals → 返回同一 goal id，仅落 1 条记录             |
| 10  | POST /v1/goals 缺失或畸形 Idempotency-Key → 400 `VALIDATION_FAILED`                    |
| 11  | 创建并列出 facts，按认证租户隔离                                                       |
| 12  | fact 的 `scope.goal_ids` 引用另一租户的 goal → 404 `RESOURCE_NOT_FOUND`                |

## 新增用例：HW-6（10 条，本单交付）

文件：`services/api/tests/http/profile.contract-gaps.web-api.unit.test.ts`

| #   | 契约缺口                                                                                     | 用例                                                                                                      |
| --- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | token 过期（`401 Unauthorized` 响应描述含 "expired"，HW-5 只测了签名无效与 aud 不匹配）      | `GET /v1/goals` 携带 `exp` 已过期 token → 401 `TOKEN_EXPIRED`                                             |
| 2   | 同上，POST 侧                                                                                | `POST /v1/goals` 携带过期 token → 401 `TOKEN_EXPIRED`                                                     |
| 3   | `PageSize` 查询参数（契约声明但 HW-5 只断言了默认值）                                        | `GET /v1/goals?page_size=2`，3 条 goal，断言 `page.page_size===2`、`items.length===2`、`next_cursor` 非空 |
| 4   | `PageSize` 上限（契约 `maximum: 100`）                                                       | `GET /v1/goals?page_size=101` → 4xx（`400 VALIDATION_FAILED`），不是 500                                  |
| 5   | `PageSize` 下限（契约 `minimum: 1`）                                                         | `GET /v1/goals?page_size=0` → 4xx（`400 VALIDATION_FAILED`），不是 500                                    |
| 6   | `Cursor` 查询参数（契约声明但 HW-5 未单独验证非法值）                                        | `GET /v1/goals?cursor=<不存在的 id>` → 4xx（`400 VALIDATION_FAILED`），不是 500                           |
| 7   | POST 400（契约 `BadRequest`："Validation failed"，HW-5 只覆盖了 Idempotency-Key 缺失这一类） | `POST /v1/goals` 缺失必填字段 `name` → 400 `VALIDATION_FAILED`                                            |
| 8   | 同上，facts 侧                                                                               | `POST /v1/facts` 缺失必填字段 `source` → 400 `VALIDATION_FAILED`                                          |
| 9   | POST 409（契约 `Conflict`，HW-5 未覆盖）                                                     | 同一 Idempotency-Key 复用于内容不同的两次 `POST /v1/goals` → 第二次 409 `IDEMPOTENCY_KEY_REUSED`          |
| 10  | 同上，facts 侧                                                                               | 同一 Idempotency-Key 复用于内容不同的两次 `POST /v1/facts` → 第二次 409 `IDEMPOTENCY_KEY_REUSED`          |

### 每项 HTTP 验证的方法 / 路径 / 状态码 / id / 错误码

以下为实际执行捕获的真实响应（同一套 `AppModule` + `InMemoryProfileStore`
进程内启动，未使用 mock）。请求头仅记录名称，`Authorization` 的值不出现在本报告中。

| 方法 | 完整路径                                                           | 请求头（仅名称）                                                 | 响应状态码 | 响应体 `id`                                         | 响应体错误码             |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------- | --------------------------------------------------- | ------------------------ |
| GET  | `/v1/goals`                                                        | `Authorization`（过期 token）                                    | 401        | —                                                   | `TOKEN_EXPIRED`          |
| POST | `/v1/goals`                                                        | `Authorization`（过期 token）、`Content-Type`、`Idempotency-Key` | 401        | —                                                   | `TOKEN_EXPIRED`          |
| GET  | `/v1/goals?page_size=2`                                            | `Authorization`                                                  | 200        | `6c257692-e8fa-42a3-a3e8-f245627414f2`（首条 item） | —                        |
| GET  | `/v1/goals?page_size=101`                                          | `Authorization`                                                  | 400        | —                                                   | `VALIDATION_FAILED`      |
| GET  | `/v1/goals?page_size=0`                                            | `Authorization`                                                  | 400        | —                                                   | `VALIDATION_FAILED`      |
| GET  | `/v1/goals?cursor=<random-uuid, 不存在>`                           | `Authorization`                                                  | 400        | —                                                   | `VALIDATION_FAILED`      |
| POST | `/v1/goals`（缺 `name`）                                           | `Authorization`、`Content-Type`、`Idempotency-Key`               | 400        | —                                                   | `VALIDATION_FAILED`      |
| POST | `/v1/facts`（缺 `source`）                                         | `Authorization`、`Content-Type`、`Idempotency-Key`               | 400        | —                                                   | `VALIDATION_FAILED`      |
| POST | `/v1/goals`（首次，`name="First goal"`）                           | `Authorization`、`Content-Type`、`Idempotency-Key`               | 201        | `e0ff3992-3c59-4281-86ac-a1fa9aafaa2c`              | —                        |
| POST | `/v1/goals`（同 Idempotency-Key，`name="Second, different goal"`） | `Authorization`、`Content-Type`、`Idempotency-Key`               | 409        | —                                                   | `IDEMPOTENCY_KEY_REUSED` |
| POST | `/v1/facts`（首次，`value.name="TypeScript"`）                     | `Authorization`、`Content-Type`、`Idempotency-Key`               | 201        | `7c465c77-c6e3-408c-b518-60422f38be20`              | —                        |
| POST | `/v1/facts`（同 Idempotency-Key，`value.name="Go"`）               | `Authorization`、`Content-Type`、`Idempotency-Key`               | 409        | —                                                   | `IDEMPOTENCY_KEY_REUSED` |

`GET /v1/goals?page_size=2` 完整分页信息：`page.page_size=2`、
`page.next_cursor="c4e08093-cf74-4730-b262-ee1e59d858fd"`、`page.total_estimate=3`。

## 环境与依赖现场

- 操作系统：Windows 11 Home 10.0.26200
- Node.js：`v24.18.1`
- npm：`11.16.0`
- 依赖：复用工作区既有 `node_modules`（未重新 `npm ci`，本单未改动任何依赖声明）

## 命令 / 实际结果

在仓库根目录 `tooling` 下执行：

| 命令                                                                                                              | 退出码 | 实际结果                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run --config vitest.config.mjs ../services/api/tests/http/profile.contract-gaps.web-api.unit.test.ts` | 0      | `Test Files 1 passed (1)`；`Tests 10 passed (10)`                                                                                                                                                                         |
| `npm --prefix tooling run unit`                                                                                   | 0      | `Test Files 26 passed \| 3 skipped (29)`；`Tests 199 passed \| 16 skipped (215)`（基线 189 通过 + 本单新增 10 = 199，`profile.postgres-store` 与 `jobs.module.integration` 的 16 项因无 `DATABASE_URL` 跳过，与本单无关） |
| `npm --prefix tooling run lint:code`                                                                              | 0      | 无输出（0 error / 0 warning，`--max-warnings 0`）                                                                                                                                                                         |
| `npm --prefix tooling run quality`                                                                                | 0      | 依次执行 `format:check`、`lint:code`、`typecheck`（4 个子项目）、`unit`（199 passed / 16 skipped）、`contract`（`redocly lint` 通过 + 4 个领域/事件样例 Schema 校验通过）                                                 |
| `npm --prefix tooling run security:secrets`                                                                       | 0      | 无输出（未发现秘密）                                                                                                                                                                                                      |

## `git diff` 范围核验

```text
$ git status --porcelain
?? services/api/tests/http/profile.contract-gaps.web-api.unit.test.ts
```

- 未出现 `services/api/tests/profile/profile.controller.web-api.unit.test.ts`；
- 未出现任何 `services/api/src/` 下的文件；
- 未出现任何 `contracts/` 下的文件；
- 新增文件仅为 `services/api/tests/http/profile.contract-gaps.web-api.unit.test.ts`
  与本报告 `docs/qa/http-profile-report.md`，均在工单写入范围内。

## 未覆盖项与原因

1. **`profile.postgres-store.unit.test.ts` 的 5 项、`jobs.module.integration.unit.test.ts`
   的 3 项**：需要真实 Postgres（`DATABASE_URL`），本机无 Docker，工单也明确不允许
   写需要 Docker/Postgres 的测试，因此本单沿用 HW-5/HW-9 既有做法跳过，不在本单
   新增用例范围内。
2. **`GET /v1/users/me`**：`contracts/openapi/openapi.json` 未定义该路径（`/v1/goals`
   与 `/v1/facts` 是本工单范围），`ProfileController` 注释里也说明 "no persisted
   users aggregate"，因此该路径不在本单核验范围。
3. **`GET /v1/goals/{goalId}` / `GET /v1/facts/{factId}` 单资源读取**：契约中未定义
   这两个路径（与 HW-5 报告中的说明一致），本单同样不做覆盖。
4. **限流（`RATE_LIMITED`）与 5xx 类响应**：契约 `default` response 定义了通用
   `Error`，但当前 `ProfileController`/`ProfileService` 实现路径下没有可在内存
   store 上真实触发限流或未预期 5xx 的路径，未单独造用例；如需覆盖，需要专门的
   限流中间件或故障注入，超出本单"不改实现"的范围。
5. **`Idempotency-Replayed` 响应头**（契约在 `POST /v1/goals` 的 `201` 响应中声明）：
   核验了控制器实现（`profile.controller.ts`）与 header 定义
   （`components/headers/IdempotencyReplayed`），确认当前实现未设置该响应头 —
   这是契约与实现之间的既有缺口，不属于"现有测试没验的契约行为"（因为实现从未产出
   该头，写覆盖它的用例只会稳定失败）。已在下方"建议后续工单"中列出，留给拥有
   `services/api/src/` 写入权限的工单处理，本单未改动实现。

## 建议后续工单

1. 补 `POST /v1/goals` 的 `Idempotency-Replayed` 响应头实现（当前控制器重放路径
   未设置该头，与契约 `components/headers/IdempotencyReplayed` 不一致）。
2. 挂载或明确废弃 `GET /v1/users/me`：如果产品仍需要该端点，需要先在 `contracts/`
   补齐路径定义，再实现并测试；如已废弃，建议从长期规划文档中移除引用。
3. 为 `profile.postgres-store.unit.test.ts` 与 `jobs.module.integration.unit.test.ts`
   提供一个可在 CI 中启用 Postgres 的执行环境（Docker 或托管实例），使这 8 项
   跳过用例能够真正执行。
