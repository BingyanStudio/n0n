/**
 * LLM 配置类型 — Discriminated Union Provider Config
 *
 * 运行时依赖注入：通过 ProviderConfig 描述 provider 类型和凭据，
 * 由 createLLMClient() 工厂函数构造 LLMClient 实例。
 *
 * 各 provider 配置语义不同（如 Google 不需要 baseUrl），
 * 使用 discriminated union 让 TS 编译器帮助检查字段有效性。
 */

// ── 常量 ──

/** thinking 模式默认 token 预算 — SSOT：common-specs.ts 和各 Client 共用此值 */
export const DEFAULT_THINKING_BUDGET_TOKENS = 1024;

// ── Provider 配置 ──

/** OpenAI 原生 API 配置 */
export interface OpenAIProviderConfig {
	provider: "openai";
	apiKey: string;
	baseUrl?: string;
	model: string;
}

/**
 * Anthropic Claude API 配置（原生 + 兼容代理）
 *
 * 通过自实现 Anthropic Messages API Client 直接通信。
 * 当 baseUrl 存在时，通过自定义 baseURL 访问第三方代理。
 * 原生支持：
 * - thinking/reasoning 流式输出（thinking_delta 事件）
 * - prompt caching（cache_control 注入）
 * - 交替思考（thinking content block 回传）
 */
export interface AnthropicProviderConfig {
	provider: "anthropic";
	apiKey: string;
	/** 自定义 API 地址。留空则使用 Anthropic 官方 API。 */
	baseUrl?: string;
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
	 * OpenAI 兼容协议不会传递 provider-specific 字段
	 * （如 Anthropic 的 cache_control）。设置此字段后，
	 * 会在请求层自动注入对应 provider 的缓存控制标记。
	 *
	 * 值：
	 * - "anthropic"：注入 message-level cache_control: { type: "ephemeral" }
	 * - undefined / 其他：不注入额外字段
	 */
	backendProvider?: "anthropic" | "google" | "openai";
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

// ── LLMConfig ──

/**
 * LLMConfig — 运行时完整配置
 *
 * 包含 provider 配置 + 行为开关。
 * 替代旧的 { baseUrl, apiKey, model } 扁平结构。
 */
export interface LLMConfig {
	/** Provider 配置（决定使用哪个 Client） */
	providerConfig: ProviderConfig;
	/** 启用 thinking/reasoning 模式（deepseek、claude 等支持的模型） */
	enableThinking?: boolean;
	/** thinking 的 token 预算（默认 DEFAULT_THINKING_BUDGET_TOKENS） */
	thinkingBudgetTokens?: number;
}

// ── 辅助函数（内部使用） ──

/**
 * 从 LLMConfig 中提取 model ID
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

/**
 * 判断 provider 是否属于 Anthropic 系 — SSOT 判定函数
 *
 * 各 Client 内部的缓存断点注入、thinking 配置等依赖此判定。
 */
export function isAnthropicProvider(providerType: string): boolean {
	return providerType === "anthropic";
}
