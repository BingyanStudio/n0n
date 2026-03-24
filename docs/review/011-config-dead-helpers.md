# 011 — config.ts 中 getModelId/getProviderType/isAnthropicProvider 未被使用

**严重度**: 🟢 低（死代码）
**文件**: `packages/llm/src/config.ts`

## 问题描述

`config.ts` 末尾定义了三个辅助函数：

```ts
export function getModelId(config: LLMConfig): string {
    return config.providerConfig.model;
}

export function getProviderType(config: LLMConfig): string {
    return config.providerConfig.provider;
}

export function isAnthropicProvider(providerType: string): boolean {
    return providerType === "anthropic";
}
```

全局搜索发现这三个函数未在任何地方被导入或调用。在新架构中：
- `modelId` 通过 `LLMClient.modelId` 属性暴露
- provider 类型由工厂函数 `createLLMClient` 内部 switch 处理
- `isAnthropicProvider` 的判定已内化到各 Client 内部

## 违背原则

**死代码**：这些函数是旧架构的残留。虽然注释说"内部使用"，但实际已没有消费方。

## 建议

删除这三个函数，保持 `config.ts` 只做类型定义和常量声明。如果将来需要，可以重新添加。
