/**
 * Thinking ProviderOptions 构造 — 根据 LLMConfig 生成 provider-specific 的 thinking 配置
 *
 * 各 provider 启用 thinking/reasoning 的方式不同：
 * - Anthropic: providerOptions.anthropic.thinking
 * - Google: providerOptions.google.thinkingConfig
 * - OpenAI: providerOptions.openai.reasoningEffort（固定 "medium"，不受 budgetTokens 影响）
 * - openai-compatible: 无法通过 providerOptions 启用（AI SDK 不支持）
 */

import {
	DEFAULT_THINKING_BUDGET_TOKENS,
	isAnthropicProvider,
	type LLMConfig,
	type ThinkingProviderOptions,
} from "./config.ts";

/**
 * 根据 LLMConfig 构造 thinking 相关的 providerOptions
 *
 * @returns providerOptions 对象（ThinkingProviderOptions），或 undefined（不启用 thinking 时）
 */
export function buildThinkingProviderOptions(
	config: LLMConfig,
): ThinkingProviderOptions | undefined {
	if (!config.enableThinking) return undefined;

	const budget = config.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
	const provider = config.providerConfig.provider;

	if (isAnthropicProvider(provider)) {
		return {
			anthropic: {
				thinking: { type: "enabled", budgetTokens: budget },
			},
		};
	}

	switch (provider) {
		case "google":
			return {
				google: {
					thinkingConfig: {
						includeThoughts: true,
						thinkingBudget: budget,
					},
				},
			};

		case "openai":
			// OpenAI reasoning models 使用 reasoningEffort 而非 token 预算。
			// 目前固定 "medium"；如需可配置，应在 LLMConfig 中新增 reasoningEffort 字段。
			return {
				openai: { reasoningEffort: "medium" },
			};

		case "openai-compatible":
			// openai-compatible chat completions 路径不支持 thinking providerOptions，
			// 需要使用 anthropic provider（配置 baseUrl）代替。
			return undefined;
	}
}
