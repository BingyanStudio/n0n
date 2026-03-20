# PR #69 Review: refactor/llm-ai-sdk

## 概述

本 PR 将 LLM 通信层从手写 OpenAI-compatible fetch 迁移到 Vercel AI SDK，支持多 provider（OpenAI / Anthropic / Google / OpenAI-compatible），并引入了 prompt caching、配置摘要显示等功能。变更涉及 31 个文件，+1545 / -811 行。

---

## 🔴 严重问题（SSOT 违规）

### 1. `ProviderConfig` 构造逻辑重复三处

**位置**：
- `packages/core/src/runtime.ts` — `inferProvider()` + `buildProviderConfig()`（L73-112）
- `packages/shared/src/bootstrap/runner.ts` — 内联 switch-case 构造 `ProviderConfig`（L341-366）
- `packages/llm/src/provider.ts` — `createLanguageModel()` 的 switch-case（L62-91，这是合理的）

`runtime.ts` 和 `runner.ts` 都各自实现了**从环境变量 → ProviderConfig** 的映射逻辑，包含重复的 switch-case 和字段拼装。如果新增一个 provider（如 `"deepseek"`），需要同步修改至少 3 处，且无编译时保护。

**建议**：将 `inferProvider()` + `buildProviderConfig()` + `buildLLMConfig()` 提取到 `@n0n/llm` 包中（如 `config-from-env.ts`），`runtime.ts` 和 `runner.ts` 都调用同一个工厂函数。

### 2. Provider 类型字面量散落 6+ 个文件

`"openai"` / `"anthropic"` / `"google"` / `"openai-compatible"` 字符串字面量出现在：
- `config.ts`（类型定义 — 这是 SSOT 源头 ✅）
- `provider.ts`（switch-case ✅ 由类型守卫保护）
- `runtime.ts`（`inferProvider` 中的硬编码列表 `["openai", "anthropic", "google", "openai-compatible"]` ❌）
- `runner.ts`（内联 switch-case ❌）
- `common-specs.ts`（`default: "openai-compatible"` — 可接受但有风险）
- `adapter.ts`（`providerType === "anthropic"` — 可接受）

`runtime.ts` L75 的 `const valid = [...]` 尤其危险：当上游 `ProviderConfig` 新增 variant 时，这里**不会**编译报错。

**建议**：在 `config.ts` 中导出一个 `PROVIDER_TYPES` 常量数组（从 discriminated union 类型推导），或导出一个 `isValidProvider()` 类型守卫函数。

### 3. `StreamToolCall` 接口与 `AssistantMessage.toolCalls` 元素类型重复定义

- `packages/core/src/agent/tool.ts` — 定义了 `StreamToolCall` 接口（L25-30）
- `packages/llm/src/stream.ts` — `AssistantMessage.toolCalls` 元素是相同结构但内联定义（L130-134）

两处的 `{ toolCallId, toolName, input }` 结构完全相同但互不引用，修改一处不会触发另一处报错。

**建议**：在 `stream.ts` 中导出 `AssistantToolCall` 类型，`tool.ts` 中的 `StreamToolCall` 直接 import 复用。

---

## 🟡 中等问题（代码坏味道）

### 4. 循环依赖：`shared ↔ llm`

- `@n0n/llm` 依赖 `@n0n/shared`（tags.ts 使用 `adaptTagsFor`、`wrapTagFor`）
- `@n0n/shared` 依赖 `@n0n/llm`（runner.ts 使用 `createModelFromConfig`、`ProviderConfig`、`LLMConfig`）

这构成**包级循环依赖**。虽然 Bun workspace 可能不会立即报错，但这违反了分层原则，且在严格的构建工具下会失败。

**建议**：`runner.ts` 中的 LLM 连通性测试不应直接调用 `@n0n/llm`，而应通过回调/接口注入。或者将 `ProviderConfig` / `LLMConfig` 类型定义下沉到 `@n0n/types`。

### 5. `editor-loop.ts` 中 `tc.input` 被 `JSON.parse` 了两次

L222 在构建 assistant 消息时：`input: JSON.parse(tc.input)` — 转成对象推入消息历史。
L231 在执行工具时：`args = JSON.parse(tc.input)` — 再次从字符串解析。

第一次 parse 的结果没被复用，且如果 L222 的 parse 成功但 L231 的 parse 失败（理论上不可能，但代码结构暗示了这种可能性），消息历史已经被污染。

**建议**：先 parse 一次存入变量，L222 和 L231 共用。

### 6. `RuntimeContext` 存在冗余派生字段

```typescript
interface RuntimeContext {
  llm: LLMConfig;
  model: LanguageModel;         // 可从 llm 派生
  modelId: string;              // 可从 llm.providerConfig.model 派生
  providerType: string;         // 可从 llm.providerConfig.provider 派生
  editorLlm: LLMConfig;
  editorModel: LanguageModel;   // 可从 editorLlm 派生
}
```

`modelId` 和 `providerType` 是 `llm.providerConfig` 的简单属性访问，缓存在 context 顶层增加了同步维护成本。`model` / `editorModel` 的缓存有性能理由（避免重复创建），但应确保与 `llm` / `editorLlm` 保持一致。

**建议**：移除 `modelId` / `providerType`，消费方直接用 `getModelId(runtime.llm)` / `getProviderType(runtime.llm)`（这两个函数已存在），或使用 getter。

### 7. `chatCompletionStream` 的 options 签名 `model? | config?` 过于灵活

```typescript
options: { signal?: AbortSignal; model?: LanguageModel; config?: LLMConfig }
```

两个可选字段都不传时运行时才报错（L66-69），编译期无法捕获。应改为 discriminated union 或使用函数重载让至少一个必填。

### 8. `chatCompletion` 的 `modelOrConfig` 参数用 `in` 运算符判别类型

```typescript
typeof modelOrConfig === "object" && "providerConfig" in modelOrConfig
```

这不是类型安全的判别方式。如果 AI SDK 某天给 LanguageModel 加了 `providerConfig` 属性，这里会静默走错分支。

**建议**：使用 `isLLMConfig(x)` 类型守卫，或改为 discriminated union wrapper（如 `{ type: "model", model } | { type: "config", config }`）。

### 9. `tool.ts` 中 `schema: {}` 硬编码空对象

旧代码从 `entry.definition.function.parameters` 读取 schema 信息传递给错误消息，迁移后直接写死 `schema: {}`，丢失了有用的调试信息。`ToolArgErrorMessage` 类型仍然声明 `schema: Record<string, unknown>`，但现在永远收到空对象。

**建议**：从 AI SDK `Tool` 的 `inputSchema` 字段提取 JSON Schema 传入，或从 `ToolArgErrorMessage` 类型中移除该字段。

---

## 🟢 轻微问题（文档/可读性）

### 10. `packages/types/src/llm.ts` 保留为空文件 + 注释

文件内容仅为一段注释，说明类型已迁移。但 `types/index.ts` 仍然 `export type * from "./llm.ts"` — 这是一个空导出。应直接删除文件和对应的 export 行，而不是留一个空壳文件"以保持不报错"。

### 11. `stream.ts` 注释 "StreamEvent 保持与旧 API 兼容" 已过时

`StreamEvent.done.finishReason` 从 `string | null` 改为 `string`（不再为 null），这是一个 breaking change。注释声称"与旧 API 兼容"不准确。

### 12. `adapter.ts` 移除了连续 system 消息合并逻辑

旧代码有 `// 合并连续的 system 消息 — 部分模型（如 minimax）不支持多个 system 消息` 逻辑，迁移后被移除。如果仍有 minimax 等模型使用，这会导致运行时错误。如果已确认不再支持此类模型，应在 PR 描述中说明。

### 13. `adapter.ts` 中 `reasoning` 字段被静默丢弃

旧代码在 `assistant_text` 和 `assistant_tool_call` 的转换中传递了 `reasoning_content`，新代码中 `assistant_text` 的转换不再传递 `reasoningText`（`AssistantModelMessage` 没有 `reasoningText` 字段）。这意味着 thinking/reasoning 内容在回传消息历史时会丢失。

### 14. `scripts/test-caching.ts` 硬编码了 API gateway URL 和模型名

```typescript
const BASE_URL = process.env.LLM_BASE_URL ?? "https://your-ai-gateway.example.com";
```

内网 URL 不应出现在公开仓库代码中。且 `"claude-sonnet-4-6"` 等模型名可能随时失效。

### 15. `common-specs.ts` 中 `LLM_BASE_URL` 的 default 改为 `""`

将 `LLM_BASE_URL` 从必填改为 `default: ""`，但 `openai-compatible` provider 需要非空 baseUrl。`findMissing()` 不会捕获这种语义错误（有 default 就跳过），可能导致运行时才发现 baseUrl 为空。

---

## 📊 总结

| 级别 | 数量 | 关键字 |
|------|------|--------|
| 🔴 严重 (SSOT) | 3 | provider 构造逻辑重复、字面量散落、StreamToolCall 重复 |
| 🟡 中等 (坏味道) | 6 | 循环依赖、double parse、冗余字段、类型不安全判别、schema 丢失 |
| 🟢 轻微 (文档) | 6 | 空文件残留、过时注释、hardcoded URL、default 语义问题 |

**整体评价**：迁移方向正确，AI SDK 的引入大幅简化了 SSE 解析和多 provider 支持。但迁移过程中引入了多处 SSOT 违规，特别是 `env → ProviderConfig` 的构造逻辑在 `runtime.ts` 和 `runner.ts` 中被重复实现。建议合并前重点修复 🔴 级别的 3 个问题。
