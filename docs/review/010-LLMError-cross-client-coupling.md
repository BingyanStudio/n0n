# 010 — LLMError 仅定义在 openai-client，Anthropic 复用时产生耦合

**初评严重度**: 🟢 低（违背关注点分离）
**二次审查**: 🟡 **升级 — 真正的耦合问题，修复简单**
**文件**: `packages/llm/src/openai-client.ts`, `packages/llm/src/anthropic-client.ts`, `packages/llm/src/index.ts`

## 初评描述

`LLMError` 定义在 `openai-client.ts` 中，`anthropic-client.ts` 从 OpenAI Client 导入。两个本应平行独立的实现之间产生了不必要的依赖。

## 二次审查：确认问题，升级优先级

### 1. 耦合方向错误

当前依赖关系：`anthropic-client.ts` → `openai-client.ts`

这意味着：
- 如果重命名 `openai-client.ts` 或改变其导出结构，Anthropic Client 会受影响
- 代码阅读者看到 `import { LLMError } from "./openai-client.ts"` 会困惑——为什么 Anthropic 要依赖 OpenAI？

### 2. 修复成本极低

创建 `packages/llm/src/errors.ts`，移动 `LLMError` 类。两个 Client 改为从 `errors.ts` 导入，`index.ts` 也改导出路径。总计约 5 分钟。

### 3. 可以顺带放入 `isAbortError`

如果创建了 `errors.ts`，005 中的 `isAbortError` 可以顺带移入（边际成本为零），从而一并解决 005。

## 结论

**建议修复**。创建 `errors.ts`，将 `LLMError` 和 `isAbortError` 一并提取。修复时间约 5-10 分钟，消除了两个平行 Client 之间的不必要依赖。
