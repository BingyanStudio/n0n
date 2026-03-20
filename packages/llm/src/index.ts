/**
 * @n0n/llm — LLM 客户端公共 API
 *
 * 基于 Vercel AI SDK，支持多 provider（OpenAI / Anthropic / Google）、
 * 运行时依赖注入、prompt caching。
 */

// Re-export AI SDK 核心类型（消费方可能需要）
export type { LanguageModel, ModelMessage } from "ai";
// 消息转换
export { toAPIMessages } from "./adapter.ts";
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
} from "./config.ts";
export { getModelId, getProviderType } from "./config.ts";
// 环境变量 → 配置工厂（SSOT：runtime.ts 和 bootstrap/runner.ts 共用）
export {
	buildLLMConfigFromEnv,
	buildProviderConfigFromEnv,
	inferProvider,
	isValidProvider,
	PROVIDER_TYPES,
} from "./config-from-env.ts";
// Provider Factory
export { createLanguageModel, createModelFromConfig } from "./provider.ts";
export type {
	AssistantMessage,
	AssistantToolCallPart,
	StreamEvent,
	StreamOptions,
	StreamRequest,
} from "./stream.ts";
// 流式调用
export { chatCompletionStream, StreamAccumulator } from "./stream.ts";
// Tag 工具
export { adaptTags, wrapTag } from "./tags.ts";
