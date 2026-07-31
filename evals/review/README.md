# 独立申请评审黄金评测

`golden-samples.json` 固定覆盖正常通过、事实版本矛盾、编造、关键职位信息缺失和证据冲突。API 单元测试直接读取该文件，因此样本与实现回归使用同一份期望结果。

从仓库根目录重复运行：

```powershell
Set-Location tooling
npm run unit -- --run ../services/api/tests/review/review.engine.unit.test.ts
```

通过条件：全部黄金样本得到声明的状态、建议、finding 类别和处理分组；其中矛盾、编造、关键缺失与证据冲突不得得到 `approve`。评测不设置或读取单一总分，最终建议完全由开放 finding、证据冲突、评审器可用性和轮次门禁导出。
