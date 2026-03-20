/**
 * LLM 配置类型 — Discriminated Union Provider Config
 *
 * 运行时依赖注入：通过 ProviderConfig 描述 provider 类型和凭据，
 * 由 createLanguageModel() 工厂函数构造 LanguageModel 实例。
 *
 * 各 provider 配置语义不同（如 Anthropic 不需要 baseUrl），
 * 使用 discriminated union 让 TS 编译器帮助检查字段有效性。
 */

/** OpenAI 原生 API 配置 */
export interface OpenAIProviderConfig {
	provider: "openai";
	apiKey: string;
	baseUrl?: string;
	model: string;
}

/** Anthropic Claude 原生 API 配置 */
export interface AnthropicProviderConfig {
	provider: "anthropic";
	apiKey: string;
	model: string;
}

/** Google Gemini 原生 API 配置 */
export interface GoogleProviderConfig {
	provider: "google";
	apiKey: string;
	model: string;
}

/** OpenAI 兼容 API 配置（第三方代理、本地模型等） */
export interface OpenAICompatibleProviderConfig {
	provider: "openai-compatible";
	apiKey: string;
	baseUrl: string;
	model: string;
	/**
	 * 代理后端的实际 provider 类型。
	 *
	 * 当通过 litellm 等代理访问 Anthropic/Google 模型时，
	 * AI SDK 的 @ai-sdk/openai provider 不会传递 provider-specific 字段
	 * （如 Anthropic 的 cache_control）。设置此字段后，
	 * 会在 fetch 层自动注入对应 provider 的缓存控制标记。
	 *
	 * 值：
	 * - "anthropic"：注入 message-level cache_control: { type: "ephemeral" }
	 * - undefined / 其他：不注入额外字段
	 */
	backendProvider?: "anthropic" | "google" | "openai";
}

/**
 * Anthropic 兼容 API 配置（第三方代理提供 Anthropic Messages 协议端点）
 *
 * 适用于 ppio 等代理的 `/anthropic` 端点，使用 @ai-sdk/anthropic SDK
 * 通过自定义 baseURL 访问。相比 openai-compatible，此路径原生支持：
 * - thinking/reasoning 流式输出（thinking_delta 事件）
 * - prompt caching（cacheControl providerOptions）
 * - 交替思考（thinking content block 回传）
 */
export interface AnthropicCompatibleProviderConfig {
	provider: "anthropic-compatible";
	apiKey: string;
	baseUrl: string;
	model: string;
}

/**
 * ProviderConfig — 统一的 LLM provider 配置
 *
 * 通过 `provider` 字段判别，各分支具有独立的字段约束。
 */
export type ProviderConfig =
	| OpenAIProviderConfig
	| AnthropicProviderConfig
	| GoogleProviderConfig
	| OpenAICompatibleProviderConfig
	| AnthropicCompatibleProviderConfig;

/**
 * LLMConfig — 运行时完整配置
 *
 * 包含 provider 配置 + 行为开关。
 * 替代旧的 { baseUrl, apiKey, model } 扁平结构。
 */
export interface LLMConfig {
	/** Provider 配置（决定使用哪个 SDK client） */
	providerConfig: ProviderConfig;
	/** 启用 thinking/reasoning 模式（deepseek、claude 等支持的模型） */
	enableThinking?: boolean;
	/** thinking 的 token 预算（默认 1024） */
	thinkingBudgetTokens?: number;
}

/**
 * 从 LLMConfig 中提取 model ID（用于 adapter 层 tag 风格选择等）
 */
export function getModelId(config: LLMConfig): string {
	return config.providerConfig.model;
}

/**
 * 从 LLMConfig 中提取 provider 类型
 */
export function getProviderType(config: LLMConfig): string {
	return config.providerConfig.provider;
}
