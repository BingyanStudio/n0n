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
	| OpenAICompatibleProviderConfig;

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
