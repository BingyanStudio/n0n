/**
 * Thinking ProviderOptions 构造 — 根据 LLMConfig 生成 provider-specific 的 thinking 配置
 *
 * 各 provider 启用 thinking/reasoning 的方式不同：
 * - Anthropic / anthropic-compatible: providerOptions.anthropic.thinking
 * - Google: providerOptions.google.thinkingConfig
 * - OpenAI: providerOptions.openai.reasoningEffort
 * - openai-compatible: 无法通过 providerOptions 启用（AI SDK 不支持）
 */

import type { LLMConfig } from "./config.ts";

const DEFAULT_THINKING_BUDGET_TOKENS = 1024;

/**
 * 根据 LLMConfig 构造 thinking 相关的 providerOptions
 *
 * @returns providerOptions 对象，或 undefined（不启用 thinking 时）
 */
export function buildThinkingProviderOptions(config: LLMConfig): unknown {
	if (!config.enableThinking) return undefined;

	const budget = config.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
	const provider = config.providerConfig.provider;

	switch (provider) {
		case "anthropic":
		case "anthropic-compatible":
			return {
				anthropic: {
					thinking: { type: "enabled", budgetTokens: budget },
				},
			};

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
			return {
				openai: { reasoningEffort: "medium" },
			};

		case "openai-compatible":
			// openai-compatible chat completions 路径不支持 thinking providerOptions
			// 需要使用 anthropic-compatible 代替
			return undefined;
	}
}
