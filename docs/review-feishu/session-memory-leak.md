# Session 内存无限增长

## 问题描述

`sessions` Map 只有新增和重置操作，没有过期清理机制。长期运行的飞书服务中，每个用户的每个 chat 都会创建一个 session，且 session 内的 `history: DomainMessage[]` 会随对话轮次持续增长，永远不会被回收。

## 实际行为

### Session 存储（`session.ts`）

```typescript
const sessions = new Map<string, FeishuSession>();
```

- `getOrCreateSession` — 只创建，不删除
- `resetSession` — 重置 history 但 session 仍在 Map 中
- `deleteSession` — 存在但**没有任何调用方**

### History 增长

每次 `runFeishuRound` 完成后，`session.history = result.history` 将完整的对话历史赋回 session。随着对话轮次增加，history 中包含：
- system messages
- user_input
- assistant_text / assistant_tool_call
- tool results（包含完整的 exec stdout 等大量文本）
- turn_feedback

一次工具调用的 exec stdout 可能就有数 KB。多轮对话后 history 可达 MB 级别。

## 为什么这是问题

1. **内存泄漏**：活跃用户的 session 永远不会被清理，服务运行数天/数周后内存持续增长
2. **History 膨胀**：每次 LLM 调用都发送完整 history，随着 history 增长，token 消耗急剧增加，API 费用上升
3. **Context 溢出**：当 history 超过模型 context window 时，LLM 调用会失败或截断
4. **无 session TTL**：用户离开后 session 永远不会被释放

## 人类评估

这个是小问题，暂时不用关心，不过可以添加todo注释说明。