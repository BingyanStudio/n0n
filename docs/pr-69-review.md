# PR #69 Review: refactor/llm-ai-sdk

> 迁移到 Vercel AI SDK，支持多 provider（OpenAI / Anthropic / Google）  
> 23 commits · 43 files · +1630 / -890 lines

## 一、总体评价

**方向正确**：从手写 OpenAI-compatible fetch 迁移到 AI SDK 是合理的工程决策，消除了大量 SSE 解析、重试、协议适配的样板代码。删除 `packages/types/src/llm.ts`（78行自维护 LLM 类型）是正确的减法。

**主要风险**：PR 体量偏大，混入了多个正交关注点（SDK 迁移、prompt caching、bootstrap 配置摘要美化、代码格式化），增加了 review 难度和回滚风险。

---

## 二、代码坏味道与具体问题

### 2.1 🔴 RuntimeContext 同时持有 config 和 model — 数据冗余

**文件**: `packages/core/src/runtime.ts`

```ts
export interface RuntimeContext {
  llm: LLMConfig;
  model: LanguageModel;         // ← 由 llm 派生
  editorLlm: LLMConfig;
  editorModel: LanguageModel;   // ← 由 editorLlm 派生
}
```

`model` 完全由 `llm` 通过 `createModelFromConfig(llm)` 派生，`editorModel` 同理。这意味着：
- 存在**数据不一致**的隐患：如果有人修改了 `llm` 但忘记重建 `model`，二者就会脱节。
- 消费方不知道该读 `runtime.llm` 还是 `runtime.model`，语义模糊。

**建议**：要么只存 config + 懒创建（`get model() { return createModelFromConfig(this.llm); }`），要么只存 model（config 从 model 反查或不暴露）。不要同时暴露同一信息的两种表示。

### 2.2 🔴 adapter.ts 中 Anthropic cache 逻辑与 provider.ts 重复

Prompt caching 的注入分散在**两个地方**：

1. **`adapter.ts`** — `toAPIMessages()` 在消息级注入 `providerOptions: { anthropic: { cacheControl } }`
2. **`provider.ts`** — `createAnthropicCacheFetch()` 通过自定义 fetch 在 HTTP 层注入 `cache_control`

adapter.ts 的注入在 AI SDK 原生 Anthropic provider 走 `/messages` API 时生效；provider.ts 的注入在 openai-compatible + litellm 代理走 `/v1/chat/completions` 时生效。

但这两条路径**没有互斥保护**：如果 `providerType === "anthropic"` 但同时走了 openai-compatible provider（配置错误时），cache_control 会被双重注入。

**建议**：统一到一处处理。可以让 adapter 层总是注入 providerOptions，由 provider 层决定是否尊重它。或者把所有 cache 逻辑收拢到 provider.ts 的 fetch wrapper 中。

### 2.3 🟡 config-from-env.ts 的 `inferProvider()` — 基于 URL 字符串猜测 provider 是脆弱的

```ts
if (baseUrl.includes("anthropic")) return "anthropic";
if (baseUrl.includes("google") || baseUrl.includes("gemini")) return "google";
```

用户完全可能有 `https://my-proxy.anthropic-mirror.internal/` 这样的地址。**字符串匹配不可靠**。

**建议**：移除 URL 推断逻辑，要求用户在需要原生 provider 时显式设置 `LLM_PROVIDER`。"openai-compatible" 作为有 baseUrl 时的默认值已经足够。

### 2.4 🟡 editor-loop.ts tool result 消息构造极度冗长

迁移后每个 tool result 都需要手写完整的 AI SDK 结构：

```ts
messages.push({
  role: "tool",
  content: [{
    type: "tool-result" as const,
    toolCallId: tc.toolCallId,
    toolName: name,
    output: { type: "text" as const, value: "..." },
  }],
});
```

这个 7 行模板在 editor-loop.ts 中重复出现 **7 次**（str_replace 成功/失败、view_file、submit、unknown tool、parse error、old_string empty），占文件 ~100 行。

**建议**：抽取一个 `makeToolResultMessage(toolCallId, toolName, text)` 辅助函数，每处调用一行搞定。

### 2.5 🟡 `chatCompletionStream` 的 StreamOptions 联合类型 — 过度设计

```ts
export type StreamOptions =
  | { signal?: AbortSignal; model: LanguageModel; config?: never }
  | { signal?: AbortSignal; model?: never; config: LLMConfig };
```

用 `never` 做互斥的 discriminated union，实际上只有两个调用点：
- `loop.ts` 传 `{ model: runtime.model }`  
- `editor-loop.ts` 传 `{ model }` （自行构造）

所有调用方都传 `model`，**没有人传 `config`**。这个 config 分支是 dead code。

**建议**：简化为 `{ signal?: AbortSignal; model: LanguageModel }`，删除 config 分支和内部的 `createModelFromConfig` fallback。

### 2.6 🟡 `getModelId()` / `getProviderType()` — 不必要的间接层

```ts
export function getModelId(config: LLMConfig): string {
  return config.providerConfig.model;
}
export function getProviderType(config: LLMConfig): string {
  return config.providerConfig.provider;
}
```

这两个函数只是 **单行属性访问**的包装。调用方写 `config.providerConfig.model` 同样清晰，且不增加认知负担。如果是为了封装"未来 model 可能不在 providerConfig 上"，那是 YAGNI。

**建议**：删除这两个工具函数，直接用属性访问。如果觉得 `providerConfig.model` 路径太长，说明 LLMConfig 的嵌套层级本身值得反思（见 2.1）。

### 2.7 🟡 `_systemCount` 未使用的变量

**文件**: `packages/llm/src/adapter.ts`

```ts
let _systemCount = 0;
// ...
case "system": {
  _systemCount++;  // ← 自增了但从未读取
```

下划线前缀暗示"故意不用"，但如果真的不用就不该声明和自增。

### 2.8 🟡 删除了连续 system 消息合并逻辑，未说明原因

旧代码有：
```ts
// 合并连续的 system 消息 — 部分模型（如 minimax）不支持多个 system 消息
```

新代码删除了这段逻辑。如果 AI SDK 内部处理了这个问题，应该在 commit message 或注释中说明。否则使用 minimax 等模型时会出现回归。

### 2.9 🟢 `test-caching.ts` 中使用 `any` 类型

```ts
const d1 = await res1.json() as any;
```

测试脚本中使用 `any` 可以接受，但最好加个 `// biome-ignore` 注释说明是测试脚本。

---

## 三、架构层面

### 3.1 依赖扩散：`ai` 包出现在 6 个 package.json 中

| 包 | 新增依赖 |
|---|---|
| `@n0n/llm` | `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` |
| `@n0n/core` | `ai` |
| `@n0n/tools` | `ai` |
| `@n0n/workflow` | `ai` |
| `apps/code` | `ai`, `@n0n/llm` |
| 根 `package.json` | `ai`, `@ai-sdk/*` (devDeps) |

`ai` 包应该只是 `@n0n/llm` 的内部实现细节。但目前 `core`、`tools`、`workflow` 都直接 `import { ... } from "ai"`，说明 AI SDK 的类型（`ModelMessage`, `ToolSet`, `LanguageModel`）泄漏到了公共 API 边界。

**建议**：让 `@n0n/llm` re-export 所有需要的 AI SDK 类型（已经做了一部分），然后让 `core` / `tools` / `workflow` 只从 `@n0n/llm` 导入，不直接依赖 `ai`。这样未来换 SDK 时只改一个包。

### 3.2 bootstrap 的 LLMConnectionTester 回调 — 正确的依赖反转

将 LLM 连通性测试从 `shared` 中抽离为回调注入是正确的做法，打破了 `shared → llm` 的循环依赖。但回调签名可以更精确：

```ts
// 当前
export type LLMConnectionTester = () => Promise<{ ok: boolean; error?: string }>;

// 建议：用 discriminated union 让类型更安全
export type LLMConnectionResult =
  | { ok: true }
  | { ok: false; error: string };
```

### 3.3 bootstrap/runner.ts 膨胀 (+170 行)

新增的配置来源追踪（`resolveConfigSources`、`formatConfigSummary`、`detectProjectEnv`）功能完整，但 runner.ts 现在超过 400 行，职责已经溢出"bootstrap 流程编排"。

**建议**：将 `resolveConfigSources` + `formatConfigSummary` 提取到 `config-report.ts`。

---

## 四、PR 拆分建议

此 PR 至少包含 4 个正交变更，建议拆分为：

1. **SDK 迁移核心**：llm/、core/agent/、types/ 变更（~15 commits）
2. **工具系统迁移**：tools/ 适配 AI SDK tool() 格式（~3 commits）
3. **Prompt caching**：adapter.ts cacheControl + provider.ts cacheFetch（~2 commits）
4. **Bootstrap 增强**：配置摘要、多 provider 支持、UI 美化（~3 commits）

---

## 五、值得肯定的设计

1. **删除 `packages/types/src/llm.ts`**：78 行自维护的 OpenAI 类型定义被 AI SDK 内置类型替代，是正确的"less code"决策。
2. **ProviderConfig 的 discriminated union**：类型安全，TS 编译器可以帮助检查各 provider 的字段完整性。
3. **`createAnthropicCacheFetch`** 思路巧妙：在 fetch 层拦截注入 cache_control，绕开了 AI SDK openai provider 不传递 providerOptions 的限制。
4. **StreamAccumulator 简化**：从 `{ id, type: "function", function: { name, arguments } }` 简化到 `{ toolCallId, toolName, input }`，消除了一层不必要的嵌套。
5. **`parseToolCalls` 直接接受 AI SDK 格式**：删除了 `toLLMToolCalls` 桥接层。

---

## 六、Review 结论

**建议：需要修改后合并（Request Changes）**

关键修改项：
- [ ] 修复 RuntimeContext 的 config/model 冗余（2.1）
- [ ] 统一 prompt caching 注入点（2.2）
- [ ] 抽取 editor-loop.ts 的 tool result 构造辅助函数（2.4）
- [ ] 简化 StreamOptions，删除未使用的 config 分支（2.5）
- [ ] 收敛 `ai` 依赖到 `@n0n/llm`（3.1）
- [ ] 删除 `_systemCount` 未使用变量（2.7）
