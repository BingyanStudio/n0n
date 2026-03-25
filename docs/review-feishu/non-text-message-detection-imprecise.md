# 非文本消息判断不精确

## 严重程度：低

## 问题描述

修复"仅支持纯文本消息"问题时，当 `readText` 返回空字符串就发送"暂不支持"提示。但 `readText` 返回空字符串有多种原因，不全是非文本消息。

## 问题代码

### `apps/feishu/src/index.ts`

```typescript
const text = FeishuBot.readText(data);
if (!text) {
    // 非文本消息（图片、文件等）暂不支持，发送提示
    if (ctx.senderOpenId) {
        const card = buildTextCard("暂不支持", "目前仅支持文本消息，图片、文件等类型暂不支持。", "grey");
        await bot.createCardMessage(ctx, card);
    }
    return;
}
```

### `readText` 返回空字符串的情况

| 情况 | 是否应提示"暂不支持" |
|------|------|
| 图片消息 (`{"image_key": "..."}`) | ✅ 正确 |
| 文件消息 | ✅ 正确 |
| 富文本消息 (`post` 类型) | ✅ 正确 |
| 用户发送空白文本 (`{"text": "  "}`) | ❌ 不应提示"暂不支持"，应提示"请输入内容" |
| content 字段 JSON 格式异常 | ❌ 不应提示"暂不支持" |

## 影响

用户发送空白文本时收到"目前仅支持文本消息"的误导性提示。实际频率较低，影响有限。

## 建议修复

通过 `data.message.message_type` 区分消息类型，而非依赖 `readText` 返回值：

```typescript
const messageType = data?.message?.message_type;
const text = FeishuBot.readText(data);

if (messageType !== "text") {
    // 非文本消息类型
    await bot.createCardMessage(ctx, buildTextCard("暂不支持", "...", "grey"));
    return;
}
if (!text) {
    // 文本消息但内容为空
    return;
}
```

## 相关文件

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/index.ts` | 消息分发入口 |
| `apps/feishu/src/bot.ts` | `readText` 静态方法 |
