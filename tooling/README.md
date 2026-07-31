# 工程骨架与质量门禁

统一命令位于本目录，应用和服务各自持有运行时依赖。新增功能模块放进现有
`apps/*` 或 `services/*` 包即可，不需要修改仓库根目录配置。

## 前置条件

- Node.js 24 LTS（CI 固定为 24.18.1）和 npm 11+
- Docker Engine 与 Docker Compose v2（仅本地依赖命令需要）

## 干净环境初始化

在仓库根目录执行：

```bash
cd tooling
npm ci --ignore-scripts
npm run bootstrap
```

`bootstrap` 会发现 `apps/*/package.json` 和 `services/*/package.json`，并对每个包执行
锁文件安装。Playwright 浏览器不会在此阶段下载；本地代理功能工单应按其所需浏览器
显式安装。

## 验收命令

```bash
npm run lint
npm run typecheck
npm run unit
npm run contract
```

四项可用 `npm run quality` 顺序执行。CI 还会执行：

```bash
npm run infra:validate
npm run security
```

`contract` 使用 Redocly 校验 OpenAPI 3.1，并使用 Ajv Draft 2020-12 校验领域与事件
Schema 及所有契约样例。`security` 对每个锁文件执行 `npm audit`，并用 Secretlint
扫描允许写入的工程目录。

## 本地依赖

示例配置只包含本机开发占位值，不可用于生产。启动 PostgreSQL + pgvector 和 Redis：

```bash
npm run dev:up
```

停止依赖：

```bash
npm run dev:down
```

如需覆盖端口或本地密码，把 `infra/dev/.env.example` 复制为 `infra/dev/.env`，在本机
修改后使用对应的 `docker compose --env-file` 命令；`.env` 已被忽略，禁止提交真实秘密。
