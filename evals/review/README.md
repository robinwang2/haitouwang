# 独立申请评审评测

`golden-samples.json` 覆盖正常通过、事实版本矛盾、编造、关键职位信息缺失、声明证据冲突、工作授权事实冲突和职位风险审核。API 测试直接读取这份基线；每个样本固定最终状态、建议、finding 处置分组，以及全部 finding 的 reviewer、severity、category、规范化 message、完整有序 `evidence_refs`（含版本）和 finding 状态。

## 本地评测

从 `tooling` 目录执行：

```powershell
npm.cmd run eval:review
```

通过条件：黄金样本与完整快照完全相等；矛盾、编造、关键缺失、证据冲突和风险门禁不得得到 `approve`。同一评测还覆盖评审器隔离、授权事实顺序置换、第三轮上限、500 条 finding 上限、Provider timeout/429/畸形响应/缺字段及数据最小化策略。

## 有意更新黄金基线

基线不会由普通测试自动重写。只有产品/安全规则有意改变时才允许：

1. 先修改实现和对应场景，说明行为变化及风险；
2. 手工更新 `expected_findings`，不得只改 category 或删减证据；message 必须先 trim 并把连续空白规范化为一个空格，证据顺序和版本必须与实际输出一致；
3. 运行 `npm.cmd run eval:review`，检查 `golden-samples.json` 的逐行 diff，确认没有用户数据、供应商正文或秘密；
4. 由材料评审契约负责人评审这次基线 diff。没有行为变更说明的“让测试变绿”更新应拒绝。

## 真实供应商 smoke/eval

普通 CI 不设置开关，因此真实供应商用例默认跳过且不消耗额度。显式运行时，在本机安全注入以下环境变量后执行：

```powershell
$env:REVIEW_PROVIDER_SMOKE='1'
$env:REVIEW_PROVIDER_ENDPOINT='<provider adapter endpoint>'
$env:REVIEW_PROVIDER_API_KEY='<secret from local secret store>'
$env:REVIEW_PROVIDER_MODEL='<approved model id>'
npm.cmd run eval:review:provider
```

该用例单次调用、10 秒超时、不重试，并只输出 reviewer、finding 数量和通过状态。不得把密钥、请求正文、响应正文或个人数据复制到报告。Adapter 的常规策略为：仅 429 最多重试一次，`Retry-After` 退避最多 1 秒；其他错误立即失败关闭。发送数据限于脱敏、限长的职位/材料字段，不发送 `user_id`、Profile facts 或 source records，请求 retention 为 false；Adapter 不持久化正文，日志只含尝试次数、HTTP 状态和稳定错误分类。
