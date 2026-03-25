# 011 — config.ts 中 getModelId/getProviderType/isAnthropicProvider 未被使用

**初评严重度**: 🟢 低（死代码）
**二次审查**: 🟢 **维持 — 直接删除**
**文件**: `packages/llm/src/config.ts`

## 初评描述

三个辅助函数全局搜索无消费方，是旧架构残留。

## 二次审查：确认可以安全删除

### 1. 验证结果

- `getModelId` — 被 `LLMClient.modelId` 属性替代
- `getProviderType` — 被 `createLLMClient` 工厂内部的 switch 替代
- `isAnthropicProvider` — 被各 Client 内部的直接比较替代

三者均无消费方。

### 2. 删除是无风险操作

这些函数没有被导出到 `index.ts`（检查确认），即使被导出，tree-shaking 也会在构建时消除。但显式删除更好——避免后续开发者误以为这些是可用的 API。

## 结论

**建议删除**。无风险，约 2 分钟。保持 `config.ts` 职责清晰：类型定义 + 常量声明。
