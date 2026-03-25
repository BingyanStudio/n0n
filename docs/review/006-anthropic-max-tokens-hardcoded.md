# 006 — Anthropic max_tokens 硬编码，未走统一配置路径

**初评严重度**: 🟡 中（违背 SSOT）
**二次审查**: 🟡 **维持 — 具名常量化即可**
**文件**: `packages/llm/src/anthropic-client.ts`, `packages/llm/src/config.ts`

## 初评描述

Anthropic Client 中 `max_tokens` 有多处硬编码：stream 默认 8192，complete 默认 4096，thinking buffer 4096。

## 二次审查：确认问题，但范围收窄

### 1. 默认值分散确实不利于维护

- `stream()`: `this.config.maxOutputTokens ?? 8192`
- `complete()`: `this.config.maxOutputTokens ?? 4096`
- thinking 模式: `budget + 4096`

三处硬编码值分散在方法内部，修改时容易遗漏。

### 2. config.ts 的 JSDoc 已经暗示了默认值

```ts
/** 最大输出 token 数。Anthropic 默认 8192（stream）/ 4096（complete）。 */
maxOutputTokens?: number;
```

但 JSDoc 中的值和代码中的值是两个维护点——如果改了代码不改注释，就会误导。

### 3. 具名常量化即可，不需要复杂配置系统

在 `anthropic-client.ts` 头部定义文件级常量：

```ts
const ANTHROPIC_DEFAULT_STREAM_MAX_TOKENS = 8192;
const ANTHROPIC_DEFAULT_COMPLETE_MAX_TOKENS = 4096;
/** thinking 模式下输出 token 的额外 buffer（Anthropic 要求 max_tokens > budget_tokens） */
const ANTHROPIC_THINKING_OUTPUT_BUFFER = 4096;
```

不需要放到 `config.ts` 中——这些是 Anthropic Client 的实现细节，不是全局配置。

## 结论

**建议修复**。在 `anthropic-client.ts` 中定义具名常量，替换硬编码值。修复成本约 5 分钟。注意常量应留在 Client 文件内部，不必导出到 config.ts。
