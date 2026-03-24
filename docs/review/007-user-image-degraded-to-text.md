# 007 — user_image 降级为纯文本，丢失图像数据

**严重度**: 🟢 低（功能退化）
**文件**: `packages/shared/src/format-prompt.ts`

## 问题描述

`formatPrompt` 将 `user_image` 消息转换为纯文本：

```ts
case "user_image":
    result.push({
        role: "user",
        content: `[Image: ${msg.imagePath}] ${msg.text}`,
    });
    break;
```

`UserImageMessage` 中携带了 `imagePath`、`focusX`、`focusY`、`scale` 等结构化数据，但这些全部被丢弃，退化为一个文本占位符 `[Image: path]`。

## 违背原则

**关注点分离不足**：图片消息的处理不应在 format-prompt 层静默降级。如果当前不支持图像，应该明确标记或由 Client 层决定如何处理（OpenAI 支持 image_url，Anthropic 支持 base64 image）。

## 建议

1. 在 `PromptMessage` 类型中增加 image 支持（或使用 content parts 数组）
2. 由各 Client 决定如何发送图像（base64 编码/URL），不支持图像的 Client 才做降级处理
3. 如果当前确实不支持图像，至少在降级时加入一条 warning 日志
