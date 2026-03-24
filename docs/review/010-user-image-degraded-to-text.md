# Review Issue #010: user_image 消息降级为纯文本占位

## 严重程度：低

## 位置
- `packages/shared/src/format-prompt.ts` (L184-188)

## 描述

`formatPrompt` 对 `user_image` 类型消息的处理：

```ts
case "user_image":
    result.push({
        role: "user",
        content: `[Image: ${msg.imagePath}] ${msg.text}`,
    });
    break;
```

图片被降级为纯文本占位符 `[Image: path]`。OpenAI 和 Anthropic 都支持在消息中传入图片（base64 或 URL），但两个 Client 的 `toOpenAIMessages` / `toAnthropicFormat` 都只处理字符串 content。

这意味着图片消息在新架构中无法正常工作 — 模型只会看到一个文件路径字符串，看不到实际图片内容。

## 影响

如果当前业务场景中没有使用图片功能，则无影响。但 DomainMessage 类型层已定义了完整的图片消息结构（`imagePath`, `focusX`, `focusY`, `scale`），说明系统设计上是支持图片的。

## 建议

在 PromptMessage 中增加多模态 content 支持（content block 数组），在各 Client 的格式转换中实现图片编码和传递。
