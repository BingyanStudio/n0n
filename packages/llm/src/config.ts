/**
 * LLM 配置类型 — Discriminated Union Provider Config
 *
 * 运行时依赖注入：通过 ProviderConfig 描述 provider 类型、凭据和行为参数，
 * 由 createLLMClient() 工厂函数构造 LLMClient 实例。
 *
 * 各 provider 的行为参数（thinking、effort 等）语义不同，
 * 因此直接放在对应的 ProviderConfig 分支中，而非抽到公共层。
 * 各 Client 只读取自己分支上的字段，不存在"这个字段对我有没有用"的歧义。
 */

import type { TagStyle } from "@n0n/types";

// ── Provider 配置 ──

interface ProviderConfigBase {
	apiKey: string;
	model: string;
	baseUrl?: string;
	/** 覆盖基于模型名推断的 XML tag 风格 */
	tagStyle?: TagStyle;
}

/** OpenAI 原生 API 配置 */
export interface OpenAIProviderConfig extends ProviderConfigBase {
	provider: "openai";
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
export interface AnthropicProviderConfig extends ProviderConfigBase {
	provider: "anthropic";
	/**
	 * 思考模式配置。设置即启用，不设置则不启用。
	 * Anthropic 要求提供明确的 budget_tokens。
	 */
	thinking?: {
		budgetTokens: number;
	};
}

/** Google Gemini API 配置（通过 OpenAI 兼容端点） */
export interface GoogleProviderConfig extends ProviderConfigBase {
	provider: "google";
	/**
	 * 思考强度。Gemini 始终内部思考，此参数控制思考内容的独立流式传输。
	 * 不设置时默认 "high"。
	 */
	thinkingEffort?: "low" | "medium" | "high";
}

/** OpenAI 兼容 API 配置（第三方代理、国产模型等） */
export interface OpenAICompatibleProviderConfig extends ProviderConfigBase {
	provider: "openai-compatible";
	baseUrl: string;
	/**
	 * 代理后端的实际 provider 类型。
	 *
	 * 当通过 litellm 等代理访问 Anthropic/Google 模型时，
	 * OpenAI 兼容协议不会传递 provider-specific 字段
	 * （如 Anthropic 的 cache_control）。设置此字段后，
	 * 会在请求层自动注入对应 provider 的缓存控制标记。
	 */
	backendProvider?: "anthropic" | "google" | "openai";
	/** 启用思考模式（国产模型大多用 enable_thinking flag） */
	enableThinking?: boolean;
}

/** DeepSeek 原生 API 配置 — 走 OpenAI 兼容协议，支持 thinking 模式 */
export interface DeepSeekProviderConfig extends ProviderConfigBase {
	provider: "deepseek";
	/** 启用思考模式（默认启用） */
	enableThinking?: boolean;
}

/**
 * ProviderConfig — 统一的 LLM provider 配置
 *
 * 通过 `provider` 字段判别，各分支具有独立的字段约束和行为参数。
 */
export type ProviderConfig =
	| OpenAIProviderConfig
	| AnthropicProviderConfig
	| GoogleProviderConfig
	| OpenAICompatibleProviderConfig
	| DeepSeekProviderConfig;

// ── LLMConfig ──

/**
 * LLMConfig — 运行时完整配置
 *
 * 行为参数已下沉到各 ProviderConfig 分支。
 * 保留此包装层，便于后续在不改动所有 Client 签名的情况下
 * 添加跨 provider 的通用行为（如 retry 策略、超时、审计日志钩子等）。
 */
export interface LLMConfig {
	/** Provider 配置（决定使用哪个 Client，含行为参数） */
	providerConfig: ProviderConfig;
}
