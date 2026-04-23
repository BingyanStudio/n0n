# Thinking 模式切换对缓存的影响 — 实验记录

> 结论词条：【Thinking 模式与缓存】
> 实验脚本：`docs/claude-caching/experiment-thinking-cache.ts`

## 实验数据

| 实验 | 场景 | cache_read | cache_write | 结论 |
|------|------|-----------|-------------|------|
| A-R1 | thinking=true，首次 | 0 | 12459 | 写入缓存 |
| A-R2 | thinking=true，重复 | **12459** | 0 | 完美命中 |
| B-R1 | thinking=true，建立缓存 | 12459 | 0 | 已有缓存 |
| B-R2 | thinking=**false**，保留 thinking blocks | **0** | **12437** | **完全 miss，重新写入** |
| B-R3 | thinking=false，剥离 thinking blocks | **12437** | 0 | 命中 R2 的缓存 |
| C-R1 | thinking=true | 12459 | 0 | |
| C-R2 | thinking=**false**，不同消息 | **12437** | 0 | **system+tools 缓存存活** |
| D-R2a | thinking=true，保留 thinking blocks | 12459 | 0 | 命中前缀 |
| D-R2b | thinking=true，剥离 thinking blocks | 12459 | 0 | 同样命中前缀 |

## 关键观察

**12459 vs 12437 的差异**：thinking=true 时 Anthropic 自动注入约 22 token 的内部 system prompt，两种模式各自维护独立的缓存条目。

**实验 B（R2 → R3）**：API 的 strip 操作是确定性的，strip 后的结果等价于手动剥离。但额外传 thinking blocks 浪费 input tokens（364 vs 349，多 15 tokens），这些 tokens 虽被 strip 但仍计费。

**实验 D（R2a vs R2b）**：thinking=true 时保留/剥离 thinking blocks 都能命中前缀缓存（prefix match），区别仅在 input_tokens 计数。

## 结论

已提取至【Thinking 模式与缓存】词条。
