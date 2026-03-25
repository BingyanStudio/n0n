# Review Issue #004: @n0n/llm index.ts 导出了无消费方的函数

## 严重程度：低

## 位置
- `packages/llm/src/index.ts`

## 描述

index.ts 导出了以下函数，但搜索全代码库无任何外部消费方：

1. **`getModelId`** — 旧架构中 agent loop 用于获取模型 ID。新架构中模型 ID 通过 `client.modelId` 获取。无外部调用。

2. **`getProviderType`** — 旧架构中 agent loop 和 adapter 用于判断 provider 类型。新架构中 provider 判断内化到各 Client。无外部调用。

3. **`isAnthropicProvider`** — 同上，无外部调用。

这些函数的注释也仍引用旧架构（`adapter.ts 的缓存断点注入`、`thinking.ts 的 providerOptions 构造`）。

## 影响

不影响运行，但增加了 @n0n/llm 的公共 API 表面积，与 Plan §4.5 的设计目标（`对外仅导出 createLLMClient + config 类型`）不符。

## 建议

- 删除这些无消费方的导出
- 如 config.ts 内部需要，保留为内部函数但不从 index.ts 导出
