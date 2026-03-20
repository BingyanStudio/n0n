/**
 * @n0n/llm — LLM 客户端公共 API
 *
 * 基于 Vercel AI SDK，支持多 provider（OpenAI / Anthropic / Google）、
 * 运行时依赖注入、prompt caching。
 */

// Provider Factory
export { createLanguageModel, createModelFromConfig } from "./provider.ts";

// 非流式调用
export { chatCompletion, LLMError } from "./client.ts";
export type { ChatCompletionRequest, ChatCompletionResult } from "./client.ts";

// 流式调用
export { chatCompletionStream, StreamAccumulator } from "./stream.ts";
export type {
	StreamEvent,
	StreamRequest,
	AssistantMessage,
} from "./stream.ts";

// 消息转换
export { toAPIMessages } from "./adapter.ts";

// 配置类型
export type {
	LLMConfig,
	ProviderConfig,
	OpenAIProviderConfig,
	AnthropicProviderConfig,
	GoogleProviderConfig,
	OpenAICompatibleProviderConfig,
} from "./config.ts";
export { getModelId, getProviderType } from "./config.ts";

// 环境变量 → 配置工厂（SSOT：runtime.ts 和 bootstrap/runner.ts 共用）
export {
	PROVIDER_TYPES,
	isValidProvider,
	inferProvider,
	buildProviderConfigFromEnv,
	buildLLMConfigFromEnv,
} from "./config-from-env.ts";

// Tag 工具
export { adaptTags, wrapTag } from "./tags.ts";

// Re-export AI SDK 核心类型（消费方可能需要）
export type { LanguageModel, ModelMessage } from "ai";
