## domain message 设计

domain message 是 agent 内部的核心数据结构，它只应该存储还原完整事件的必要信息，**不应该包含任何提示词相关的字段**（比如 role、content），而应该是一个纯粹的数据记录（data record）。

每一种 DomainMessage 都应该是一个完整的、语义明确的数据结构，不应该有可选参数（optional parameter）。如果某些字段在特定情况下不适用，应该通过 严格的类型设计（比如 discriminated union）来表达，而不是使用 `string | null` 这样的妥协。

最终由 adapter 层负责将这些 DomainMessage 转换成适合 LLM 的提示词格式（prompt format）。这样可以保持数据结构的清晰和一致，同时也让提示词的设计更加灵活，不受数据结构的限制。


## 例子

错误的设计：
```typescript
	// 注入到期提醒
	for (const r of due) {
		messages.push({
			type: "user_text",
			content: `⏰ REMINDER: ${r.content}\n\n⚠️ You MUST set a new reminder (with updated progress) in your next tool call response.`,
		});
	}
```

这里将数据和提示词设计混在了一起，导致 DomainMessage 既包含了事件信息（r.content），又包含了提示词信息（⏰ REMINDER: ...）。这样的设计会使得 DomainMessage 的结构变得混乱，不利于维护和扩展。

正确的设计：
```typescript
    // 注入到期提醒
    for (const r of due) {
        messages.push({
            type: "reminder:due",
            content: r.content,
        });
    }
```

```typescript
// in domain to prompt adapter
case "reminder:due":
    return {
        role: "user",
        content: `⏰ REMINDER: ${message.content}\n\n⚠️ You MUST set a new reminder (with updated progress) in your next tool call response.`,
    };
```

## 优势

1. **清晰的职责分离**：DomainMessage 只负责存储事件数据，而提示词的设计完全由 adapter 层负责。这种职责分离使得代码更清晰，易于维护。
2. **更好的可扩展性**：当需要添加新的事件类型时，只需要定义新的 DomainMessage 类型，而不需要修改现有的提示词设计。这使得系统更容易扩展和适应变化。
3. **可持久化和可重放**：由于 DomainMessage 是一个纯粹的数据结构，它可以很容易地被持久化（比如存储在数据库中）或者重放（比如在测试中模拟事件）。这对于调试和测试非常有帮助。