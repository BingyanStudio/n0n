/**
 * @n0n/llm — LLM Client 实现层
 *
 * 自实现 OpenAI + Anthropic 双协议，不依赖 AI SDK。
 * 唯一接触 HTTP / SSE 的地方。
 *
 * 为什么不用 Vercel AI SDK：
 * 1. 国产模型兼容 — AI SDK 的 openai provider 丢弃 delta.reasoning_content
 * 2. 错误/截断处理 — fullStream 的 error/tool-input-error 被静默忽略，finishReason 未检查
 * 3. 黑盒调试 — SSE 解析、事件映射、重试逻辑不透明，thinking 链路曾因此断裂
 * 4. prompt caching — 双路径注入无互斥保护
 *
 * 架构：LLMClient 接口定义在 @n0n/types，各协议实现在本包，通过工厂函数 + DI 注入。
 *
 * 对外仅导出：
 * - createLLMClient 工厂函数
 * - Config 类型和工厂
 * - LLMError
 */

// COMMENT: 自实现 LLM Client 而非依赖 AI SDK 是一个有远见的选择。
// 当你需要精确控制 SSE 解析、thinking 链路、缓存注入、截断处理这些细节时，
// 黑盒 SDK 的每一次升级都可能是一次无声的破坏。
// 代价是两个 Client（Anthropic + OpenAI）各约 500 行的维护成本，
// 收益是对整个 LLM 通信链路的完全可控。对于一个 agent 框架来说，这是正确的权衡。

// 配置类型
export type {
	AnthropicProviderConfig,
	GoogleProviderConfig,
	LLMConfig,
	OpenAICompatibleProviderConfig,
	OpenAIProviderConfig,
	ProviderConfig,
} from "./config.ts";
export { DEFAULT_THINKING_BUDGET_TOKENS } from "./config.ts";
// 环境变量 → 配置工厂（SSOT：runtime.ts 和 bootstrap 共用）
export {
	buildLLMConfigFromEnv,
	buildProviderConfigFromEnv,
	isValidProvider,
	PROVIDER_TYPES,
	resolveProvider,
} from "./config-from-env.ts";
// Error
export { LLMError } from "./errors.ts";
// Client 工厂
export { createLLMClient } from "./factory.ts";
// Responses API client
export { createResponsesClient } from "./responses-client.ts";
export type { ResponsesClientConfig } from "./responses-client.ts";
