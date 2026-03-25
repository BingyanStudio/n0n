# 群聊 @mention 文本仍未清理

## 严重程度：低

## 问题描述

原始 review 中指出 `readText` 未清理群聊消息中的 `@_user_1` 等 mention 占位符。该 issue 文档在本分支中被删除（标记为"无效文档"），但代码实际未做任何修改，问题仍然存在。

## 当前代码

### `apps/feishu/src/bot.ts` — `readText`

```typescript
static readText(data: FeishuMessageEventData): string {
    const raw = data?.message?.content;
    if (!raw || typeof raw !== "string") return "";
    try {
        const parsed = JSON.parse(raw) as { text?: unknown };
        return typeof parsed.text === "string" ? parsed.text.trim() : "";
    } catch {
        return "";
    }
}
```

群聊中收到的 `text` 示例：`@_user_1 帮我创建一个工作流`

Agent 实际看到的输入包含无意义的 `@_user_1` 标记。

## 影响

1. 群聊场景下 Agent 输入带有噪声前缀
2. 浪费 LLM token
3. 在当前仅用于私聊（P2P）的场景下不触发，但群聊支持时会暴露

## 建议修复

飞书消息事件的 `data.message.mentions` 数组包含 mention 详情，可据此清理：

```typescript
let text = parsed.text?.trim() ?? "";
// 清理 @mention 占位符
text = text.replace(/@_user_\d+/g, "").trim();
```

## 相关文件

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/bot.ts` | `readText` 方法未清理 mention 标记 |
