# 003 — Cache 断点注入逻辑分散在两个 Client 中

**初评严重度**: 🟡 中（违背 SSOT）
**二次审查**: 🟡→🟢 **降级 — 语义不同，非 SSOT 问题**
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`, `packages/llm/src/cache.ts`

## 初评描述

cache 的断点选择算法（`selectCacheBreakpoints()`）已是 SSOT，但 cache_control 的**注入方式**分散在两个 Client 中且实现不同。初评建议统一提取为 `injectCacheBreakpoints(messages, format)`。

## 二次审查：为什么注入方式不同是正确的

### 1. 注入方式的差异源于协议格式差异

| 维度 | OpenAI Client（litellm 代理） | Anthropic Client |
|------|-------------------------------|------------------|
| 消息格式 | 扁平 `{ role, content }` | 结构化 `{ role, content: ContentBlock[] }` |
| 注入方式 | 直接在 message 上加 `cache_control` | 需要将 string content 转为 content block 后在最后一个 block 上加 |
| system 处理 | 无特殊处理（system 在 messages 里） | system 拆离到请求体外，需单独注入 |
| 配额管理 | 直接取 4 个 | 需要扣除 system 已用的配额（4 - systemCacheCount） |

这些差异不是「逻辑分散」，而是**协议格式适配**——它们本该不同，因为两个 API 的消息模型根本不一样。

### 2. 断点选择是 SSOT，注入是协议适配

当前架构其实已经做对了：
- **什么位置需要缓存**（断点选择）→ `cache.ts` 的 `selectCacheBreakpoints()`，SSOT ✅
- **怎么在该位置注入缓存标记**（格式适配）→ 各 Client 内部处理，因为格式不同 ✅

如果强行统一注入逻辑，这个「统一函数」内部必然会有 `if (format === 'anthropic') ... else ...` 的分支，把 Client 内部的格式知识泄漏给了公共模块，反而**增加**了耦合。

### 3. 初评的一个合理建议

初评提到「`toAnthropicFormat()` 同时承担格式转换和缓存注入两个职责」——这个局部关注点是合理的。可以考虑在 Anthropic Client 内部将缓存注入作为 `toAnthropicFormat()` 之后的一个独立步骤，而不是混在转换函数内部。但这是 Client 内部的代码组织问题，不是跨 Client 的 SSOT 问题。

## 结论

**不建议跨 Client 提取**。断点选择的 SSOT 已经做到了。注入方式的不同是协议格式差异的正确反映，不是需要修复的重复。

可选的小改进：在 Anthropic Client 内部，将缓存注入从 `toAnthropicFormat()` 中分离出来作为后处理步骤，改善局部的关注点分离。
