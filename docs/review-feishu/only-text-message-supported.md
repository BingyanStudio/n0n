# 仅支持纯文本消息输入

## 问题描述

飞书 Bot 目前只能处理纯文本消息。用户发送图片、文件、富文本、表情回复等消息类型时，`readText` 返回空字符串，消息被静默丢弃，用户得不到任何反馈。

## 实际行为

### `readText`（`bot.ts`）

```typescript
static readText(data: FeishuMessageEventData): string {
    const raw = data?.message?.content;
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
}
```

只解析 `text` 字段。飞书的图片消息格式为 `{"image_key": "img_xxx"}`，富文本为 `{"content": [[...]]}` 等，都不含 `text` 字段。

### 消息入口（`index.ts`）

```typescript
const text = FeishuBot.readText(data);
if (!text) return;  // ← 非文本消息到这里就返回了，无任何提示
```

## 为什么这是问题

1. **用户困惑**：发送图片/文件后无任何反馈，用户以为 Bot 故障
2. **功能缺失**：无法处理用户发送的截图、文档等常见交互场景
3. **无降级提示**：至少应该回复"暂不支持该消息类型"
