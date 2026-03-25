# 群聊 @mention 文本未清理

## 问题描述

飞书群聊中用户通过 @机器人 触发消息，消息 text 字段中会包含 `@_user_1` 等 mention 占位符。`bot.ts` 的 `readText` 方法直接返回原始 text，没有清理这些 mention 标记，导致 Agent 收到的用户输入包含无意义的噪声。

## 实际行为

### `readText`（`bot.ts`）

```typescript
static readText(data: FeishuMessageEventData): string {
    const raw = data?.message?.content;
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
}
```

飞书群聊中，实际收到的 `text` 可能是：

```
@_user_1 帮我创建一个每天推送天气的工作流
```

### Agent 看到的输入

```
@_user_1 帮我创建一个每天推送天气的工作流
```

`@_user_1` 对 Agent 毫无意义，可能干扰语义理解。

## 为什么这是问题

1. **输入噪声**：Agent 看到的用户意图前面带有无意义的 `@_user_1` 标记
2. **可能影响意图判断**：`isWorkflowCreateIntent` 等基于文本内容的判断可能受干扰
3. **浪费 token**：mention 标记占用 LLM context 但不提供信息

## 相关代码

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/bot.ts` `readText` | 未清理 mention 占位符 |
| `apps/feishu/src/index.ts` L106 | 直接使用 `FeishuBot.readText(data)` 的结果 |
