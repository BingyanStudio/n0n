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
