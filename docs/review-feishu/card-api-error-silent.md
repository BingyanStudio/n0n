# 卡片 API 错误被静默吞噬

## 问题描述

`FeishuConversation` 中所有卡片更新操作通过 `enqueue` 串行化，错误处理仅 `console.error` 后静默继续。如果卡片创建失败（如 API 限流、网络超时），后续所有操作都会在 `cardEntityId = null` 的状态下执行，全部变为空操作。

## 实际行为

### 错误处理（`conversation.ts`）

```typescript
private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err) => {
        console.error("[feishu] card update failed:", err);
        // ← 错误被吞噬，后续 task 继续执行
    });
}
```

### 故障链

1. `initStreamingCard` 失败 → `cardEntityId` 为 null
2. 后续所有 `flushCard`/`streamText` 检查 `if (!this.cardEntityId) return` → 静默跳过
3. 用户看不到任何输出（Agent 在执行但卡片没更新）
4. 最终 `finish` 也静默失败 → 用户永远看不到结果

### 无重试机制

所有 API 调用（`createCardEntity`、`updateCardEntity`、`streamCardElementContent` 等）都没有重试逻辑。飞书 API 有 rate limit（卡片更新 10次/秒），高频更新时容易触发限流。

## 为什么这是问题

1. **用户无反馈**：Agent 正在执行任务但用户看到卡片停留在"初始化..."，无法得知进度
2. **无降级策略**：CardKit 流式卡片失败后没有降级为普通消息的机制
3. **不可诊断**：只有 `console.error`，没有结构化错误追踪

## 相关代码

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/conversation.ts` L191-193 | `enqueue` 静默吞错误 |
| `apps/feishu/src/conversation.ts` L116-133 | `initStreamingCard` 无重试 |
| `apps/feishu/src/conversation.ts` L136-148 | `flushCard` 在 cardEntityId=null 时静默跳过 |

## 人类评估

这属于代码鲁棒性问题，大部分情况下正常，可以添加todo注释，暂时不修复

// TODO