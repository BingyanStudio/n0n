# 002 — StreamRequest.promptMessages 旁路破坏了 LLMClient 抽象层

**初评严重度**: 🟡 中（违背关注点分离）
**二次审查**: 🟡 **维持 — 技术债务，但当前是合理的务实妥协**
**文件**: `packages/types/src/client.ts`, `packages/tools/src/editor-loop.ts`, `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`

## 初评描述

`StreamRequest.promptMessages` 允许调用方绕过 `formatPrompt`，直接传入已格式化消息。editor-loop 是唯一的消费方。初评认为这破坏了 LLMClient 的单一调用契约。

## 二次审查：务实妥协，暂不重构

### 1. editor-loop 的场景确实不走 DomainMessage

editor-loop 是一个**封闭的、自包含的 LLM 循环**：它自己构造 system prompt、管理工具调用历史、拼接 tool result。这些消息从未经过 DomainMessage 领域层——它们天然就是 PromptMessage 格式。

如果强制 editor-loop 走 DomainMessage → formatPrompt 路径，需要：
- 为 editor-loop 的内部工具定义新的 DomainMessage 类型（`editor_tool_result` 等）
- 在 formatPrompt 中增加 editor-loop 专用的消息处理分支
- 人为增加了一层抽象，而 editor-loop 是唯一的消费方

这就是典型的**抽象反转**——为了满足架构纯洁性，让简单场景（直接拼 PromptMessage）绕一个大弯。

### 2. `@internal` 标记是正确的防护

当前的设计用 `@internal` + JSDoc 注释明确了这个字段的使用范围。外部调用方（agent loop）从不使用它，只走 `messages: DomainMessage[]` 路径。两种调用模式虽然共存于同一接口，但使用场景清晰分离。

### 3. 长期可以考虑的改进

如果将来出现第三个需要 `promptMessages` 的调用方，那时再考虑：
- 将 `LLMClient` 拆为 `stream(StreamRequest)` + `streamRaw(RawStreamRequest)` 两个方法
- 或者让 editor-loop 使用独立的 `EditorLLMClient` wrapper

但目前只有一个消费方，过早抽象没有收益。

## 结论

**暂不行动**。当前设计是一个有明确标记的务实妥协。`@internal` 注释足以防止误用。等到有新的消费方出现时再考虑拆分接口。
