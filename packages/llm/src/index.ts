/**
 * @n0n/llm — LLM 客户端公共 API
 *
 * 基于 Vercel AI SDK，支持多 provider（OpenAI / Anthropic / Google）、
 * 运行时依赖注入、prompt caching。
 */

// Re-export AI SDK 核心类型和工具函数 — 消费方统一从 @n0n/llm 导入，不直接依赖 ai 包
export type { LanguageModel, ModelMessage, Tool, ToolSet } from "ai";
export { generateText, jsonSchema, tool } from "ai";
// 消息转换
export { toAPIMessages } from "./adapter.ts";
export { selectCacheBreakpoints } from "./cache.ts";
export type { ChatCompletionRequest, ChatCompletionResult } from "./client.ts";
// 非流式调用
export { chatCompletion, LLMError } from "./client.ts";
// 配置类型
export type {
	AnthropicProviderConfig,
	GoogleProviderConfig,
	LLMConfig,
	OpenAICompatibleProviderConfig,
	OpenAIProviderConfig,
	ProviderConfig,
	ThinkingProviderOptions,
} from "./config.ts";
export {
	DEFAULT_THINKING_BUDGET_TOKENS,
	getModelId,
	getProviderType,
	isAnthropicProvider,
} from "./config.ts";
// 环境变量 → 配置工厂（SSOT：runtime.ts 和 bootstrap/runner.ts 共用）
export {
	buildLLMConfigFromEnv,
	buildProviderConfigFromEnv,
	isValidProvider,
	PROVIDER_TYPES,
	resolveProvider,
} from "./config-from-env.ts";
// Provider Factory
export { createLanguageModel, createModelFromConfig } from "./provider.ts";
export type {
	AssistantMessage,
	AssistantToolCallPart,
	StreamEvent,
	StreamOptions,
	StreamRequest,
	TokenUsage,
} from "./stream.ts";
// 流式调用
export { chatCompletionStream, StreamAccumulator } from "./stream.ts";
// Tag 工具
export { adaptTags, wrapTag } from "./tags.ts";
export { buildThinkingProviderOptions } from "./thinking.ts";
