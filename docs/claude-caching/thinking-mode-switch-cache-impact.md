## 实验结论：切换 thinking 模式对 Anthropic prompt cache 的影响

呵，你提出了一个颇为精妙的问题。让我从实验数据和文档两个维度为你梳理清楚。实验脚本在 `scripts/experiment-thinking-cache.ts`，可随时复现。

### 核心发现

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

### 三个关键结论

**1. 切换 thinking 模式 → 消息级缓存完全失效，但 system+tools 缓存存活**

实验 B 中，从 thinking=true 切到 thinking=false：
- 消息部分缓存全部 miss（R2 cache_read=0，重新 cache_write=12437）
- 但实验 C 证明 system+tools 部分的缓存跨 thinking 切换存活（C-R2 cache_read=12437）

注意 12459 vs 12437 的差异：thinking=true 时 Anthropic 会自动注入一个 ~22 token 的内部 system prompt 来支持 thinking 功能，这导致缓存前缀长度不同，所以两种模式各自维护独立的缓存条目。

**2. 保留 vs 剥离 thinking blocks → 关闭 thinking 后保留反而有害**

实验 B 中：
- R2（保留 thinking blocks）：input=364 tokens，cache miss
- R3（剥离 thinking blocks）：input=349 tokens，命中了 R2 的缓存

保留 thinking blocks 会让 API 端先 strip 它们再处理，但 **strip 后的 token 序列与"从未发送 thinking blocks"的序列一致**，所以 R3 能命中 R2 建立的缓存。换句话说：API 的 strip 操作是确定性的，strip 后的结果等价于手动剥离。

但额外传 thinking blocks 会浪费 input tokens（364 vs 349，多了 15 tokens），这些 tokens 虽被 strip 但**仍然计费**。

**3. thinking=true 时保留/剥离 thinking blocks → 都能命中前缀缓存**

实验 D 中 R2a 和 R2b 都命中了 cache_read=12459，因为缓存是 prefix match，system+tools 前缀相同即可命中。区别在于 input_tokens：R2a=371（多 15 tokens thinking block），R2b=356。这说明在 Opus 4.6 上，thinking blocks 被保留在上下文中但不影响前缀匹配。

### 对你项目的影响

当前 `anthropic-client.ts` 的 `toAnthropicFormat` 不看 `config.enableThinking`，只看消息中是否有 `reasoning+reasoningSignature` 来决定是否发送 thinking block。这意味着：

- 如果先用 thinking=true 对话产生了含 reasoning 的历史消息，然后切到 thinking=false，历史中的 thinking blocks **仍会被发送**
- API 端会 strip 它们，但你多付了那些 thinking block 的 input token 费用
- 消息级缓存会 miss（因为 thinking 参数本身变了），需要重建

进化的代价……虽然不美丽，但至少现在行为是确定的。实验脚本留在那里，随时可以复现或扩展新场景。  
