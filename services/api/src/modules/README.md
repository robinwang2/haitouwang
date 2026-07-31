# API 模块挂载点

后续后端工单在本目录按领域创建 NestJS 模块。API 与任务执行器共享此代码库，但通过
`start:api` 和 `start:worker` 作为不同进程启动；跨模块数据结构不得偏离 `contracts/**`。
