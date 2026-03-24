# Review Issue #011: tool_arg_error 的 schema 字段未包含在提示词中

## 严重程度：中

## 位置
- `packages/shared/src/format-prompt.ts` (tool_arg_error 分支)
- `packages/core/src/agent/tool.ts` (L89-98)

## 描述

Plan §1.2 指出：

> `tool_arg_error` 不再携带 schema，模型失去定向修复依据

tool.ts 中已正确恢复了 `schema` 字段的填充 (L98):
```ts
schema: toolDef?.parameters as Record<string, unknown> | undefined,
```

但 `format-prompt.ts` 在将 `tool_arg_error` 转换为 PromptMessage 时，**没有包含 schema 信息**：

```ts
case "tool_arg_error":
    result.push({
        role: "tool",
        toolCallId: msg.callId,
        toolName: msg.tool,
        content: wrapTag(
            "error",
            `Invalid tool arguments: ${msg.error}`,
            modelId,
        ),
    });
    break;
```

`msg.schema` 被完全忽略。虽然 schema 字段已恢复到 DomainMessage 中，但模型实际看到的提示词里依然没有 schema 信息。

## 影响

模型收到参数错误时仍然没有 schema 参考，无法有效修复参数。恢复 schema 字段的工作只完成了一半。

## 建议

在 format-prompt 中将 schema 附加到错误消息中：
```ts
let errorContent = `Invalid tool arguments: ${msg.error}`;
if (msg.schema) {
    errorContent += `\n\nExpected schema:\n${JSON.stringify(msg.schema, null, 2)}`;
}
```
