# Review Issue #013: @n0n/core 仍然依赖 @n0n/llm，未完全实现依赖反转

## 严重程度：中

## 位置
- `packages/core/src/runtime.ts` (L11-12)
- `packages/core/package.json`

## 描述

Plan §2 架构总览明确强调：

> **关键变化**：`@n0n/core` 和 `@n0n/tools` **不再依赖 `@n0n/llm`**。它们只依赖 `@n0n/types` 中的 `LLMClient` 接口。依赖反转完成。

Plan §4.4 再次强调：

> **依赖**：`@n0n/types`（LLMClient 接口）。**不再依赖 `@n0n/llm`**。

Plan §4.6 依赖关系图中，core 和 llm 之间没有直接依赖箭头。

**但实际实现中**，`packages/core/src/runtime.ts` 直接 import 了 `@n0n/llm`：

```ts
import { buildLLMConfigFromEnv, createLLMClient } from "@n0n/llm";
import type { LLMConfig } from "@n0n/llm";
```

`packages/core/package.json` 的 `dependencies` 也包含 `"@n0n/llm": "workspace:*"`。

这意味着 `runtime.ts` 负责了 Client 的创建（通过 `createLLMClient`），这违反了 Plan 的依赖反转设计。按 Plan 的设计，Client 应在 App 层创建并注入。

agent/loop.ts 和 agent/tool.ts 确实不依赖 @n0n/llm（只依赖 @n0n/types），但 runtime.ts 作为 core 包的一部分，拉入了整个 @n0n/llm 依赖。

## 影响

依赖反转未完全实现。如果要测试 core 层，需要连带整个 llm 包。

## 建议

将 `createRuntimeContext()` 改为接受 `LLMClient` 注入（或接受工厂函数），而非内部 import `@n0n/llm`。Client 创建逻辑移到各 App 入口。
