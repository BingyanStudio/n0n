# RFC: 移除 AI SDK，自实现 OpenAI + Anthropic 双协议

> 状态：已批准，待实施
> 预计工时：~2 天

## 目录

1. [动机](#1-动机)
2. [架构总览](#2-架构总览)
3. [核心接口定义](#3-核心接口定义)
4. [模块职责与依赖关系](#4-模块职责与依赖关系)
5. [数据流](#5-数据流)
6. [变更清单](#6-变更清单)
7. [Git 恢复确认](#7-git-恢复确认)
8. [迁移步骤](#8-迁移步骤)
9. [验证计划](#9-验证计划)

---

## 1. 动机

当前系统通过 Vercel AI SDK（`ai@^6`）与 LLM 通信。AI SDK 提供了多 provider 适配和类型安全，但作为中间层带来了以下问题：

### 1.1 国产模型兼容

AI SDK 的 openai provider 在 SSE 解析层**丢弃** `delta.reasoning_content`（国产模型的思考输出字段）。为绕过此问题，国产模型被迫配置 `provider: "anthropic"` + 代理兼容层——链路绕且脆弱，代理的 Anthropic 兼容实现本身也存在问题。

### 1.2 错误/截断处理缺失

- AI SDK `fullStream` 的 `error` / `tool-input-error` 事件在当前实现中被**静默忽略**
- `finishReason` 在 agent loop 中**完全未检查**——模型输出因 `max_tokens` 截断时，工具调用 JSON 不完整，被静默丢弃
- `tool_arg_error` 不再携带 schema，模型失去定向修复依据

### 1.3 黑盒调试负担

AI SDK 内部的 SSE 解析、事件映射、重试逻辑不透明。thinking 链路断裂已发生过一次（详见 `docs/thinking-fix-conclusion.md`），排查过程需要逐层翻 SDK 源码。

### 1.4 prompt caching 双路径

Anthropic 缓存注入分散在 `adapter.ts`（providerOptions）和 `provider.ts`（fetch wrapper）两处，无互斥保护。

## 2. 架构总览

### 核心思路

将 LLM 后端实现与业务逻辑**完全解耦**：

1. 定义 `LLMClient` 接口（在 `@n0n/types` 中），所有消费方只依赖此接口
2. 各协议实现（OpenAI / Anthropic）在 `@n0n/llm` 中，作为 `LLMClient` 的具体实现
3. Client 作为依赖注入传入，内部闭包所有配置（api key、model、base url、thinking、cache）
4. 提示词组织逻辑抽取到 `@n0n/shared/format-prompt`，作为独立纯函数模块

### 分层架构

```
┌────────────────────────────────────────────────────────┐
│  App 层 (apps/code, apps/cli, apps/feishu, apps/fairy) │
│  构造 LLMClient 实例，注入 RuntimeContext               │
└───────────────────────┬────────────────────────────────┘
                        │ 注入 LLMClient
                        ▼
┌────────────────────────────────────────────────────────┐
│  Core 层 (@n0n/core)                                   │
│  agent loop: 接收 LLMClient，调用 client.stream()      │
│  只依赖 LLMClient 接口 + StreamEvent 类型              │
├────────────────────────────────────────────────────────┤
│  Tools 层 (@n0n/tools)                                 │
│  工具注册表 + 执行器                                    │
│  editor-loop: 接收 LLMClient 参数                      │
│  工具定义使用 ToolDefinition（协议无关）                 │
└───────────────────────┬────────────────────────────────┘
                        │ 只依赖 @n0n/types 接口
                        ▼
┌────────────────────────────────────────────────────────┐
│  Types 层 (@n0n/types)                                 │
│  LLMClient 接口定义                                    │
│  DomainMessage / StreamEvent / ToolDefinition          │
│  Zod schemas (tool-args.ts, SSOT)                      │
│  ※ 纯类型，零运行时依赖                                │
├────────────────────────────────────────────────────────┤
│  Shared 层 (@n0n/shared)                               │
│  tags.ts: XML tag 风格适配（wrapTagFor, adaptTagsFor） │
│  format-prompt.ts: DomainMessage[] → PromptMessage[]   │
│  ※ 纯函数，只依赖 types + tags                         │
└────────────────────────────────────────────────────────┘
                        ▲
                        │ Client 内部 import（可选）
                        │
┌────────────────────────────────────────────────────────┐
│  LLM 实现层 (@n0n/llm)                                 │
│  openai-client.ts:     implements LLMClient            │
│  anthropic-client.ts:  implements LLMClient            │
│  createLLMClient(config): 工厂函数（唯一导出）          │
│  ※ 唯一接触 HTTP/SSE 的地方，ai 包全部删除             │
└────────────────────────────────────────────────────────┘
```

**关键变化**：`@n0n/core` 和 `@n0n/tools` **不再依赖 `@n0n/llm`**。它们只依赖 `@n0n/types` 中的 `LLMClient` 接口。依赖反转完成。

## 3. 核心接口定义

### 3.1 LLMClient 接口

定义在 `@n0n/types` 中。所有消费方（agent loop、editor-loop、rag）只依赖此接口。

```ts
/**
 * LLM Client 抽象接口
 *
 * 所有 provider 细节（api key、model、base url、thinking、cache）
 * 全部闭包在实现内部。消费方只看到这个接口。
 */
export interface LLMClient {
  /**
   * 流式调用 — agent loop / editor-loop 使用
   *
   * 接受 DomainMessage[]（领域消息），内部完成：
   * 1. 提示词组织（DomainMessage → PromptMessage，via format-prompt）
   * 2. 协议格式化（PromptMessage → API 消息格式）
   * 3. SSE 解析 → StreamEvent 映射
   */
  stream(request: StreamRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;

  /**
   * 非流式调用 — RAG 等简单场景使用
   *
   * 接受裸消息（不经过 DomainMessage 领域层）
   */
  complete(request: CompleteRequest): Promise<CompleteResponse>;

  /**
   * LLM 模型标识（只读）
   *
   * 如 "claude-3.5-sonnet"、"deepseek-chat"
   * 用途：makeToolkit 构建 exec 工具描述时需要 tag 风格
   * 这是接口唯一暴露的属性
   */
  readonly modelId: string;
}
```

### 3.2 请求/响应类型

```ts
/** 流式请求 — 走 DomainMessage 领域层 */
export interface StreamRequest {
  messages: DomainMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
}

/** 非流式请求 — 简单场景，裸消息 */
export interface CompleteRequest {
  messages: SimpleMessage[];
  temperature?: number;  // 调用方语义覆盖（如 rag 需要 temperature: 0）
}

export interface SimpleMessage {
  role: "system" | "user";
  content: string;
}

/** 非流式响应 */
export interface CompleteResponse {
  text: string;
}
```

### 3.3 StreamEvent

```ts
export type StreamEvent =
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments: string }
  | { type: "done"; finishReason: string; usage: TokenUsage | null }
  | { type: "error"; error: string };  // 新增：错误事件不再静默吞掉
```

### 3.4 ToolDefinition

协议无关的工具定义格式。各 Client 内部转换为各自的 API 格式。

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
}
```

### 3.5 PromptMessage

提示词组织的输出格式。`format-prompt` 模块的产物，Client 内部消费。

```ts
export type PromptMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning?: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface ToolCallPart {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}
```

## 4. 模块职责与依赖关系

### 4.1 `@n0n/types` — 纯类型层

**职责**：定义所有接口契约，零运行时代码。

| 模块 | 内容 |
|------|------|
| `domain.ts` | DomainMessage 判别联合（SSOT） |
| `tool-args.ts` | Zod schemas（工具参数 SSOT） |
| `client.ts`（新增） | `LLMClient` 接口、`StreamEvent`、`ToolDefinition`、`PromptMessage`、`TokenUsage` |
| `renderer.ts` | Renderer 接口 |

**依赖**：无（纯类型）

### 4.2 `@n0n/shared` — 共享工具层

**职责**：纯函数工具模块，被多个包共享。

| 模块 | 内容 | 依赖 |
|------|------|------|
| `tags.ts` | XML tag 风格适配（`wrapTagFor`、`adaptTagsFor`、`detectTagStyle`） | 无 |
| `format-prompt.ts`（新增） | `DomainMessage[]` + `modelId` → `PromptMessage[]` | `@n0n/types`（DomainMessage、PromptMessage）、`tags.ts` |
| `bootstrap/` | 交互式配置引导 | — |

**`format-prompt.ts` 的职责**（从当前 `adapter.ts` 拆出）：
- `wrapTag("stdout", content, model)` 等 tool result 格式化
- `adaptTags(msg.content, model)` 系统消息 tag 适配
- `buildUserInputContent(msg, model)` 用户输入上下文拼接
- `mergeConsecutiveSystem(messages)` 连续 system 消息合并
- idle_nudge / reminder:due / submit:rejected 等文本生成

**不包含**：协议消息格式构造、prompt caching 注入——这些属于 Client 内部。

### 4.3 `@n0n/tools` — 工具层

**职责**：工具注册表 + 执行器。

| 模块 | 依赖变化 |
|------|----------|
| `write/edit/exec/reminder/submit.ts` | `tool()` + `jsonSchema()` → `ToolDefinition` 格式 |
| `editor-loop.ts` | `LLMConfig` → 接收 `LLMClient` 参数 |
| `index.ts` | `ToolEntry.definition: Tool` → `ToolDefinition` |

**依赖**：`@n0n/types`（ToolDefinition、DomainMessage）。**不再依赖 `@n0n/llm`**。

### 4.4 `@n0n/core` — Agent 循环层

**职责**：驱动 LLM + 工具调用循环。

| 模块 | 依赖变化 |
|------|----------|
| `agent/loop.ts` | 删除 `toAPIMessages` / `getModelId` / `getProviderType` / `buildThinkingProviderOptions` 导入。改为 `client.stream()` |
| `agent/tool.ts` | 恢复 `ToolArgErrorMessage.schema` 填充 |
| `runtime.ts` | `model: LanguageModel` → `client: LLMClient`；`editorModel` → `editorClient: LLMClient` |

**依赖**：`@n0n/types`（LLMClient 接口）。**不再依赖 `@n0n/llm`**。

### 4.5 `@n0n/llm` — LLM Client 实现层

**职责**：`LLMClient` 接口的具体实现。唯一接触 HTTP / SSE 的地方。

| 模块 | 职责 |
|------|------|
| `openai-client.ts`（新建） | OpenAI Chat Completions SSE 解析、消息格式转换、重试、`reasoning_content` 国产扩展 |
| `anthropic-client.ts`（新建） | Anthropic Messages API SSE 解析、content block 处理、thinking、cache 注入 |
| `config.ts` | `LLMConfig` / `ProviderConfig` 定义（保留） |
| `config-from-env.ts` | 环境变量 → config（保留） |
| `index.ts` | 导出 `createLLMClient(config)` 工厂函数 |

**内部调用链**：
```
client.stream(request)
  → import { formatPrompt } from "@n0n/shared/format-prompt"
  → promptMessages = formatPrompt(request.messages, this.modelId)
  → apiMessages = this.toAPIFormat(promptMessages)  // 协议格式化（内部方法）
  → this.sendSSE(apiMessages) → parse → yield StreamEvent
```

**依赖**：`@n0n/types`（接口）、`@n0n/shared`（format-prompt、tags）。**`ai` / `@ai-sdk/*` 全部删除**。

**对外导出**：
```ts
// @n0n/llm 的公共 API（仅此而已）
export { createLLMClient } from "./factory.ts";
export type { LLMConfig, ProviderConfig } from "./config.ts";
export { buildLLMConfigFromEnv } from "./config-from-env.ts";
```

### 4.6 依赖关系图

```
@n0n/types ◄──────── @n0n/shared (format-prompt, tags)
    ▲                      ▲
    │                      │ (Client 内部 import format-prompt)
    │                      │
    ├── @n0n/core          │
    ├── @n0n/tools         │
    └── @n0n/llm ──────────┘
            ▲
            │ (app 入口构造 Client)
        Apps (code/cli/feishu/fairy)
```

**关键**：`core` 和 `tools` **不依赖 `llm`**。依赖箭头单向向下。

## 5. 数据流

### 5.1 Agent Loop 主流程（流式）

```
用户输入
  ↓
DomainMessage[] (历史消息, SSOT)
  ↓
agent/loop.ts: client.stream({ messages, tools, toolChoice: "auto" })
  ↓
LLMClient.stream() 内部:
  ├─ format-prompt(messages, modelId) → PromptMessage[]
  ├─ toAPIFormat(promptMessages, tools) → 协议消息 (OpenAI/Anthropic)
  ├─ HTTP POST → SSE 流
  └─ SSE 解析 → yield StreamEvent
  ↓
agent/loop.ts:
  ├─ StreamAccumulator.push(event) — 累积完整消息
  ├─ renderer.thinkingToken / contentToken / toolCallArgChunk — 即时上屏
  └─ event.type === "done" → 检查 finishReason
  ↓
parseToolCalls(acc.toMessage()) → ToolCallRecord[]
  ↓
executeToolStream(tc) → ToolResult → push to DomainMessage[]
  ↓
下一轮循环
```

### 5.2 Editor Loop（流式，独立 Client）

```
edit 工具调用 (intent + file path)
  ↓
editor-loop.ts: editorClient.stream({ messages, tools: EDITOR_TOOLS, toolChoice: "required" })
  ↓
(同上流程，使用独立的 editorClient)
  ↓
str_replace / view_file / submit → 返回编辑结果
```

### 5.3 RAG（非流式）

```
query + candidates
  ↓
rag.ts: client.complete({ messages: [system, user], temperature: 0 })
  ↓
LLMClient.complete() 内部:
  ├─ 裸消息直接转为 API 格式（不经过 format-prompt）
  ├─ HTTP POST → JSON 响应
  └─ 提取 text
  ↓
{ text: "..." }
```

### 5.4 工具定义流转

```
tool-args.ts (Zod Schema, SSOT)
  ↓ 构建时：Zod → JSON Schema
tools/*.ts (ToolDefinition: { name, description, parameters })
  ↓ 传入 client.stream()
Client 内部 (ToolDefinition → 协议格式):
  ├─ OpenAI: { type: "function", function: { name, description, parameters } }
  └─ Anthropic: { name, description, input_schema }
```

## 6. 变更清单

### 6.1 不需要改动的文件

| 文件 | 理由 |
|------|------|
| `packages/types/src/tool-args.ts` | Zod schema SSOT，完全不动 |
| `packages/llm/src/cache.ts` | 断点选择算法，不依赖 AI SDK |
| `packages/shared/src/tags.ts` | 纯字符串处理 |
| `packages/llm/src/config-from-env.ts` | 环境变量解析，不依赖 AI SDK |
| Renderer 接口和实现 | 只消费 StreamEvent，接口不变 |

### 6.2 新增文件

| 文件 | 职责 |
|------|------|
| `packages/types/src/client.ts` | `LLMClient` 接口、`StreamEvent`、`ToolDefinition`、`PromptMessage`、`TokenUsage`、`StreamAccumulator` |
| `packages/shared/src/format-prompt.ts` | `DomainMessage[]` + `modelId` → `PromptMessage[]`。从当前 `adapter.ts` 拆出提示词组织逻辑 |
| `packages/llm/src/openai-client.ts` | OpenAI Chat Completions 实现。SSE 解析从 git `3892541~1` 恢复 + 增强 |
| `packages/llm/src/anthropic-client.ts` | Anthropic Messages API 实现。新写 |

### 6.3 修改文件

| 文件 | 改动 |
|------|------|
| `packages/types/src/domain.ts` | 恢复 `ToolArgErrorMessage.schema` 字段 |
| `packages/types/src/index.ts` | 导出新增类型 |
| `packages/shared/src/index.ts` | 导出 `format-prompt` |
| `packages/tools/src/write.ts` | `tool()` + `jsonSchema()` → `ToolDefinition` 格式 |
| `packages/tools/src/edit.ts` | 同上 |
| `packages/tools/src/exec.ts` | 同上 |
| `packages/tools/src/reminder.ts` | 同上 |
| `packages/tools/src/submit.ts` | 同上 |
| `packages/tools/src/editor-loop.ts` | 接收 `LLMClient` 替代 `LLMConfig`。工具定义改为 `ToolDefinition`。保留所有功能增量 |
| `packages/tools/src/index.ts` | `ToolEntry.definition` 类型改为 `ToolDefinition` |
| `packages/tools/src/config.ts` | `LLMConfig` → `LLMClient` |
| `packages/core/src/agent/loop.ts` | 删除 llm 导入，改为 `client.stream()` |
| `packages/core/src/agent/tool.ts` | 恢复 `ToolArgErrorMessage.schema` 填充 |
| `packages/core/src/runtime.ts` | `model: LanguageModel` → `client: LLMClient` |
| `packages/llm/src/index.ts` | 只导出 `createLLMClient` + config 类型 |
| `packages/llm/src/config.ts` | 删除 `import { JSONValue } from "ai"` |
| `apps/code/src/index.ts` | 连通性测试改用 `client.stream()` |
| 各 app 入口 | 构造 LLMClient 注入 runtime |

### 6.4 删除文件

| 文件 | 理由 |
|------|------|
| `packages/llm/src/stream.ts` | 拆分到 openai-client / anthropic-client 内部 |
| `packages/llm/src/client.ts` | 同上 |
| `packages/llm/src/provider.ts` | 不再需要 AI SDK provider 工厂 |
| `packages/llm/src/thinking.ts` | thinking 配置内化到各 Client |
| `packages/llm/src/adapter.ts` | 提示词逻辑迁移到 `format-prompt`，协议格式化内化到 Client |
| `packages/llm/src/tags.ts` | 转发层，Client 直接用 `@n0n/shared/tags` |

### 6.5 删除依赖

从所有 `package.json` 中移除：
- `ai`
- `@ai-sdk/openai`
- `@ai-sdk/anthropic`
- `@ai-sdk/google`

## 7. Git 恢复确认

以下文件涉及从 git `3892541~1`（AI SDK 迁移前）恢复代码。已逐文件对比确认内容差异。

### ✅ 可安全恢复（内容一致）

| 文件 | 恢复内容 | 确认结果 |
|------|----------|----------|
| `tools/src/write.ts` | 工具定义格式回退 | 描述文本 ✅ 一致，参数字段 ✅ 一致 |
| `tools/src/edit.ts` | 工具定义格式回退 | 描述文本 ✅ 一致，参数字段 ✅ 一致 |
| `tools/src/exec.ts` | 工具定义格式回退 | 描述文本 ✅ 一致，参数字段 ✅ 一致 |
| `tools/src/submit.ts` | 工具定义格式回退 | 描述文本 ✅ 一致，参数字段 ✅ 一致 |
| `llm/src/stream.ts` | OpenAI SSE 解析核心逻辑 | 可恢复，在此基础上增强 |
| `llm/src/client.ts` | OpenAI 非流式 fetch + 重试 | 可恢复 |

### ⚠️ 不能直接恢复（有功能增量，需在当前版本基础上修改）

| 文件 | 新增功能 |
|------|----------|
| `tools/src/editor-loop.ts` | `expected_matches` 参数、`view_file` 行号范围、`countOccurrences`、`getReplacementContext`、`toolResult` 辅助函数、结构化评分 feedback。**+153 行功能代码** |
| `llm/src/adapter.ts` | `injectAnthropicCacheBreakpoints`（缓存断点）、`mergeConsecutiveSystem`（system 合并）、`buildUserInputContent`（用户输入构建）。**+103 行** |
| `tools/src/reminder.ts` | 描述文本有微小差异 |

## 8. 迁移步骤

按依赖顺序自底向上，每步独立可验证。

### Step 1: 类型层（@n0n/types）

1. 新建 `packages/types/src/client.ts`，定义 `LLMClient`、`StreamEvent`（含新增 `error` 事件）、`ToolDefinition`、`PromptMessage`、`SimpleMessage`、`TokenUsage`、`StreamAccumulator`、`CompleteRequest`、`CompleteResponse`、`StreamRequest`
2. 在 `domain.ts` 恢复 `ToolArgErrorMessage.schema` 字段
3. 更新 `index.ts` 导出

**验证**：`bun run typecheck` 通过（新类型只是新增，不破坏现有代码）

### Step 2: 提示词组织模块（@n0n/shared）

1. 新建 `packages/shared/src/format-prompt.ts`
2. 从当前 `packages/llm/src/adapter.ts` 迁移以下逻辑：
   - `formatExecResult` / `formatWriteResult` / `formatEditResult` / `toolResultToContent`
   - `buildUserInputContent`
   - `mergeConsecutiveSystem`
   - 所有 `wrapTag` / `adaptTags` 调用
3. 函数签名：`formatPrompt(messages: DomainMessage[], modelId: string): PromptMessage[]`
4. 更新 `index.ts` 导出

**验证**：单元测试——输入 DomainMessage[]，断言输出 PromptMessage[] 的 role 和 content 正确

### Step 3: OpenAI Client（@n0n/llm）

1. 新建 `packages/llm/src/openai-client.ts`
2. 从 git `3892541~1:packages/llm/src/stream.ts` 恢复 SSE 解析核心
3. 封装为 `class OpenAIClient implements LLMClient`
4. 内部闭包：apiKey、baseUrl、model、tag 风格
5. `stream()` 实现：调用 `formatPrompt()` → 转 OpenAI 消息格式 → fetch SSE → 解析 → yield StreamEvent
6. `complete()` 实现：从 git 恢复非流式 fetch + 重试
7. 增强：
   - `finishReason` 传递到 `StreamEvent.done`
   - `delta.reasoning_content` 处理（国产模型支持）
   - error 事件：SSE 解析错误 → yield `{ type: "error", error }`

**验证**：用 DeepSeek / GPT 模型端到端测试流式输出和工具调用

### Step 4: Anthropic Client（@n0n/llm）

1. 新建 `packages/llm/src/anthropic-client.ts`
2. 实现 Anthropic Messages API SSE 解析，映射到 `StreamEvent`：
   - `content_block_start(type=text)` + `content_block_delta(text_delta)` → `StreamEvent.content`
   - `content_block_start(type=thinking)` + `content_block_delta(thinking_delta)` → `StreamEvent.thinking`
   - `content_block_start(type=tool_use)` + `content_block_delta(input_json_delta)` → `StreamEvent.tool_call_delta`
   - `message_delta(stop_reason)` → `StreamEvent.done`
3. 消息格式转换：`PromptMessage[]` → Anthropic 格式（system 拆离、content blocks 构造）
4. prompt caching：`cache.ts` 选择断点 → 注入 `cache_control: { type: "ephemeral" }`（单路径）
5. thinking 配置：构造请求时注入 `thinking` 参数

**验证**：用 Claude 模型端到端测试流式输出、thinking、prompt caching

### Step 5: 工厂函数 + 导出（@n0n/llm）

1. 新建 `packages/llm/src/factory.ts`：
   ```ts
   export function createLLMClient(config: LLMConfig): LLMClient {
     switch (config.providerConfig.provider) {
       case "openai":
       case "openai-compatible":
         return new OpenAIClient(config);
       case "anthropic":
         return new AnthropicClient(config);
       case "google":
         throw new Error("Google provider not yet implemented");
     }
   }
   ```
2. 重写 `index.ts`：只导出 `createLLMClient`、config 类型、`buildLLMConfigFromEnv`
3. 删除旧文件：`stream.ts`、`client.ts`、`provider.ts`、`thinking.ts`、`adapter.ts`、`tags.ts`

**验证**：`bun run typecheck` 通过

### Step 6: 工具定义回退（@n0n/tools）

1. 5 个主工具（write/edit/exec/reminder/submit）：`tool()` + `jsonSchema()` → `ToolDefinition` 格式
2. `editor-loop.ts`：
   - 参数 `editorLlm: LLMConfig` → `editorClient: LLMClient`
   - 内部工具定义 `EDITOR_TOOL_SET: ToolSet` → `EDITOR_TOOLS: ToolDefinition[]`
   - 删除 `createModelFromConfig` 调用
   - 保留所有功能增量（expected_matches、行号范围、feedback 等）
3. `index.ts`：`ToolEntry.definition: Tool` → `ToolDefinition`
4. 删除所有 `import { tool, jsonSchema } from "@n0n/llm"` 和 `import type { Tool, ToolSet, ModelMessage } from "@n0n/llm"`

**验证**：`bun run typecheck` 通过

### Step 7: Agent Loop 适配（@n0n/core）

1. `runtime.ts`：
   - `model: LanguageModel` → `client: LLMClient`
   - `editorModel: LanguageModel` → `editorClient: LLMClient`
   - `createRuntimeContext()` 内部调用 `createLLMClient(config)`
2. `agent/loop.ts`：
   - 删除 `toAPIMessages`、`getModelId`、`getProviderType`、`buildThinkingProviderOptions`、`chatCompletionStream` 导入
   - 改为 `for await (const event of runtime.client.stream({ messages, tools, toolChoice }))`
   - `modelId` 从 `runtime.client.modelId` 获取
   - 新增：`acc.finishReason === "length"` 时截断恢复逻辑
3. `agent/tool.ts`：恢复 `ToolArgErrorMessage.schema` 填充

**验证**：完整 agent loop 端到端测试

### Step 8: Apps 入口适配

1. 各 app 的 `createRuntimeContext()` 调用自动适配（Step 7 已改内部实现）
2. `apps/code/src/index.ts` 连通性测试：改用 `client.stream()` 测试
3. 删除所有 `package.json` 中的 `ai` / `@ai-sdk/*` 依赖

**验证**：各 app 启动正常，bootstrap 连通性测试通过

## 9. 验证计划

### 9.1 协议验证

| 场景 | 模型 | 验证点 |
|------|------|--------|
| OpenAI 流式 | GPT-4o | 流式 content + tool_call_delta 正常上屏 |
| OpenAI thinking | DeepSeek | `reasoning_content` 正确映射到 `StreamEvent.thinking` |
| Anthropic 流式 | Claude 3.5 Sonnet | content_block_delta 正确映射 |
| Anthropic thinking | Claude (thinking) | thinking_delta 正确映射 |
| Anthropic cache | Claude | token usage 中 `cacheReadTokens` > 0 |

### 9.2 错误/边界场景

| 场景 | 方法 | 预期 |
|------|------|------|
| 截断恢复 | 设置低 `maxOutputTokens` 触发 `finishReason: "length"` | 工具调用 JSON 被 best-effort 修复，不静默丢弃 |
| API 错误 | 使用无效 API key | `StreamEvent.error` 事件产出，agent 不崩溃 |
| 网络中断 | 流式过程中断开网络 | 错误被捕获，不是 unhandled rejection |
| 工具参数错误 | 模型传入不合法参数 | `tool_arg_error` 携带 schema，模型获得修复指引 |
| 内容过滤 | 触发 `finishReason: "content-filter"` | 明确告知用户 |

### 9.3 功能回归

| 场景 | 验证点 |
|------|--------|
| editor-loop | expected_matches、view_file 行号范围、结构化 feedback 正常 |
| prompt caching | Anthropic 缓存断点正确注入，无双路径问题 |
| tag 风格 | DeepSeek 模型使用 `<\|DSML\|tag>` 格式 |
| system 合并 | 连续 system 消息正确合并 |
| bootstrap | 连通性测试走通 |
| Ctrl+C 中断 | abort signal 正确传递，流式输出干净终止 |
