# Review Issue #014: Anthropic Client 在无 system 消息时传递空数组

## 严重程度：低

## 位置
- `packages/llm/src/anthropic-client.ts` (toAnthropicFormat 函数)

## 描述

`toAnthropicFormat` 中 system 的计算逻辑：

```ts
const system =
    systemParts.length === 1 && !systemParts[0]?.cache_control
        ? systemParts[0]!.text  // 1 个无缓存 → 字符串
        : systemParts;          // 其他情况 → 数组
```

当 `systemParts` 为空时（没有 system 消息），`system` 值为空数组 `[]`。这个空数组被传入 Anthropic API 的 `system` 字段。

Anthropic API 对 `system: []` 的行为未明确文档化。可能正常工作（视为无 system），也可能在某些版本中报验证错误。

另外，当 `systemParts.length > 1` 且没有 `cache_control` 时，也会传递数组格式而非更高效的字符串合并。

## 建议

添加空数组的处理：
```ts
const system = systemParts.length === 0
    ? undefined  // 或空字符串
    : systemParts.length === 1 && !systemParts[0]?.cache_control
        ? systemParts[0]!.text
        : systemParts;
```
