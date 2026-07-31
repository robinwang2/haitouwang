# 领域模型

## 1. 边界与租户不变量

MVP 是共享基础设施上的多用户 SaaS，每个用户构成逻辑数据隔离边界。所有用户数据聚合都包含 `user_id`，仓储查询、缓存键、搜索/向量过滤、对象存储授权和事件消费必须带租户上下文。跨租户对象对调用方表现为不存在。

原始招聘网站登录凭证、Cookie 和验证码不属于云端领域模型，任何云端 DTO、事件、队列载荷和审计载荷都不得出现这些字段。云端只保存本地代理的设备公钥、授权状态和脱敏运行状态。

## 2. 聚合目录

| 聚合      | 聚合根与关键字段                                                                                                  | 关系/不变量                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 用户      | `User{id,email,display_name,locale,time_zone,status,version}`                                                     | 拥有目标、事实、材料、申请、代理和通知设置；`email` 仅在用户资源和受控身份域出现                                   |
| 求职目标  | `Goal{id,user_id,title_keywords,locations,employment_types,salary,work_authorization_rule,status}`                | 一个用户可有多个目标；地区/语言未决时 `locale` 可选，不推断法域                                                    |
| 事实      | `Fact{id,user_id,kind,value,scope,status,valid_from,valid_until,source,confirmed_at,version}`                     | `pending_confirmation`、`expired`、`prohibited`、越目标范围或已撤销事实不得用于匹配/生成；值保持结构化并可追溯来源 |
| 文件/材料 | `FileMetadata` 与 `Material{id,user_id,job_id,kind,status,version,file_ids,fact_citations}`                       | 文件元数据不包含文件正文或签名 URL；每个发布材料陈述必须引用允许事实；已批准版本不可原地覆写                       |
| 职位      | `Job{id,canonical_url,source,source_refs,title,company,location,employment_type,description_status,risk,status}`  | 多来源归并为一条主记录，官网来源优先；风险/过期/关键字段缺失可强制人工处理                                         |
| 评分      | `Score{id,user_id,goal_id,job_id,total,dimensions,hard_gates,decision,explanations,input_version}`                | 硬门优先于总分；维度权重固定为 25/20/15/15/10/10/5，合计 100；结果对同一输入版本确定                               |
| 评审      | `Review{id,user_id,job_id,material_ids,material_versions,status,reviewers,findings,recommendation,round}`         | `material_versions` 固定被评审材料版本；存在未关闭 `must_fix` 时不得批准；生成器和评审器配置隔离                   |
| 本地代理  | `Agent{id,user_id,device_name,public_key_thumbprint,status,scopes,last_seen_at,version}`                          | 不保存目标站点秘密；授权绑定用户、设备、公钥、受众和范围；撤权不可逆地阻止新命令                                   |
| 申请      | `Application{id,user_id,job_id,goal_id,material_ids,status,submission_idempotency_key,evidence,timeline,version}` | 一个用户对同一职位/目标的提交键唯一；没有可验证证据不得进入 `submitted`；MVP 提交前必须人工确认                    |
| 任务      | `Task{id,user_id,type,status,resource,attempt,lease,manual_reason,result_ref}`                                    | 租约绑定代理和 nonce；相同命令/回执幂等；人工任务不得由自动重试解除                                                |
| 通知      | `Notification{id,user_id,type,status,dedupe_key,channel,scheduled_at,source_ref}`                                 | `(user_id,type,dedupe_key)` 唯一；载荷只含摘要和资源引用，不含材料/邮件正文                                        |
| 面试      | `Interview{id,user_id,application_id,round,status,start_at,end_at,time_zone,meeting_uri,source}`                  | 跨时区以 UTC 时间加 IANA 时区保存；邮件低置信结果仅创建 `tentative`，需用户确认                                    |
| 分析      | `MetricDefinition` 与 `MetricPoint`                                                                               | 指标定义版本化并列出源字段、去重和时区口径；显示样本量，不输出因果结论                                             |

机器字段的完整约束见 `contracts/schemas/domain.schema.json`。

## 3. 关键关系

```text
User
 ├─ Goal ─────────────┐
 ├─ Fact ─┐           │
 ├─ File  ├─ Material ├─ Application ─ Interview
 │        └─ Score ───┤       │
 ├─ Agent ─ Task ─────┘       ├─ Notification
 └─ AuditEvent <───────────────┘

Job ─ Score
 ├─ Material
 ├─ Review
 └─ Application
```

`Review` 读取材料与事实引用但不能把 AI 输出直接写为已确认事实。`Application` 只引用已批准材料；人工任务包可引用材料、答案、风险和未决项，但不得嵌入目标网站秘密。分析从版本化事件/源记录派生，不反向修改业务聚合。

## 4. 文件元数据

`FileMetadata` 至少记录对象 ID、用户、用途、原始文件名的安全展示值、MIME、字节数、SHA-256、扫描状态、创建时间和版本。下载 URL 是短期授权结果，不持久化到元数据或事件。文件进入可用状态前必须完成类型、大小和恶意内容检查；隔离/感染文件不得被生成、上传或导出流程引用。

## 5. 删除、导出与撤权

- 用户导出覆盖事实、材料元数据、申请、面试和审计可见记录，使用机器可读版本化格式。
- 删除事件必须传播到主库、对象存储、索引、缓存和待执行队列；具体备份清除天数仍由产品基线 4.4 决策，契约不虚构期限。
- 代理或邮件授权撤销后，云端拒绝新任务并取消待执行任务；本地代理在每次领取和执行前检查授权。
- 事件和审计记录只保留删除证明所需的不可逆/非正文标识，不保留被删除的敏感内容。

## 6. 评分字段语义

| 维度          | 权重 |
| ------------- | ---: |
| 技能匹配      |   25 |
| 经历匹配      |   20 |
| 工作授权      |   15 |
| 地点/工作方式 |   15 |
| 薪资          |   10 |
| 职位类型      |   10 |
| 偏好          |    5 |

`hard_gates` 至少覆盖工作授权、黑名单、重复、地点、薪资、职位类型和真实性风险。任一阻断硬门命中时 `decision=blocked`，无论 `total` 多高都不得被模型覆盖。
