---
alias:
  - Thinking Cache
  - thinking 缓存
---

切换 thinking 模式对【提示词缓存】的影响。基于实验验证（详见工作日志/Thinking 缓存实验）。

## 结论

### 1. 切换 thinking 模式 → 消息级缓存失效，system+tools 缓存存活

从 thinking=true 切到 thinking=false 时：

- 消息部分缓存完全 miss，需要重新 Cache Write
- 但 system+tools 部分的缓存跨 thinking 切换存活

原因：thinking=true 时 Anthropic 自动注入约 22 token 的内部 system prompt，导致两种模式的缓存前缀长度不同，各自维护独立的缓存条目。

### 2. 关闭 thinking 后保留 thinking blocks → 浪费 input tokens

API 端会 strip thinking blocks，strip 后的 token 序列与"从未发送 thinking blocks"的序列一致。但额外传送的 thinking blocks 虽被 strip **仍然计费**（约多 15 tokens/条）。

### 3. thinking=true 时保留/剥离 thinking blocks → 都能命中前缀缓存

缓存是 prefix match，system+tools 前缀相同即可命中。区别仅在于 input_tokens 计数（保留比剥离多约 15 tokens）。

## 实际影响

如果先用 thinking=true 对话产生含 reasoning 的历史消息，再切到 thinking=false：

- 历史中的 thinking blocks 仍会被发送（当前 `anthropic-client.ts` 的行为）
- 多付 thinking block 的 input token 费用
- 消息级缓存 miss，需要重建
