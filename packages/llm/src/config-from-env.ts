/**
 * 从环境变量构造 ProviderConfig / LLMConfig — SSOT 工厂函数
 *
 * runtime.ts 和 bootstrap/runner.ts 都调用此模块，
 * 避免重复实现 env → ProviderConfig 的映射逻辑。
 *
 * 新增 provider 时只需修改：
 * 1. config.ts 中的 ProviderConfig union（类型）
 * 2. provider.ts 中的 createLanguageModel switch（实例化）
 * 3. 本文件的 buildProviderConfigFromEnv switch（env 映射）
 * — TS exhaustive check 会在遗漏时编译报错。
 */

import type { LLMConfig, ProviderConfig } from "./config.ts";

/** 所有合法的 provider 类型 — 从 ProviderConfig union 推导 */
export const PROVIDER_TYPES: readonly ProviderConfig["provider"][] = [
	"openai",
	"anthropic",
	"google",
	"openai-compatible",
] as const;

/** 类型守卫：判断字符串是否为合法的 provider 类型 */
export function isValidProvider(
	value: string,
): value is ProviderConfig["provider"] {
	return (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * 从环境变量解析 provider 类型
 *
 * 不做基于 URL 的模糊推断 — 非严格映射的自动判断本质上不稳定，
 * provider 类型必须由用户显式配置决定。
 *
 * 规则：
 * - 有显式 provider 值且合法时直接使用
 * - 无显式 provider 时，默认 "openai"
 */
export function resolveProvider(explicit?: string): ProviderConfig["provider"] {
	if (explicit && isValidProvider(explicit)) {
		return explicit;
	}
	return "openai";
}

/**
 * 从环境变量前缀构造 ProviderConfig
 *
 * @param prefix 环境变量前缀（如 "LLM" → 读 LLM_API_KEY、LLM_MODEL 等）
 * @param fallback 回退配置（如 EDITOR_LLM 回退到主 LLM）
 */
export function buildProviderConfigFromEnv(
	prefix: string,
	fallback?: ProviderConfig,
): ProviderConfig {
	const apiKey =
		process.env[`${prefix}_API_KEY`] || (fallback ? fallback.apiKey : "");
	const model =
		process.env[`${prefix}_MODEL`] || (fallback ? fallback.model : "");
	const baseUrl =
		process.env[`${prefix}_BASE_URL`] ||
		(fallback && "baseUrl" in fallback
			? (fallback as { baseUrl?: string }).baseUrl
			: undefined);
	const provider = resolveProvider(process.env[`${prefix}_PROVIDER`]);

	switch (provider) {
		case "openai":
			return {
				provider: "openai",
				apiKey,
				model,
				...(baseUrl ? { baseUrl } : {}),
			};
		case "anthropic":
			return {
				provider: "anthropic",
				apiKey,
				model,
				...(baseUrl ? { baseUrl } : {}),
			};
		case "google":
			return { provider: "google", apiKey, model };
		case "openai-compatible": {
			const backendProvider = process.env[`${prefix}_BACKEND_PROVIDER`] as
				| "anthropic"
				| "google"
				| "openai"
				| undefined;
			return {
				provider: "openai-compatible",
				apiKey,
				model,
				baseUrl: baseUrl ?? "",
				...(backendProvider ? { backendProvider } : {}),
			};
		}
	}
}

/**
 * 从环境变量前缀构造 LLMConfig
 *
 * @param prefix 环境变量前缀（如 "LLM"）
 * @param fallbackProvider 回退 ProviderConfig
 */
export function buildLLMConfigFromEnv(
	prefix: string,
	fallbackProvider?: ProviderConfig,
): LLMConfig {
	const providerConfig = buildProviderConfigFromEnv(prefix, fallbackProvider);
	const budgetRaw = process.env[`${prefix}_THINKING_BUDGET_TOKENS`];
	const budgetTokens = budgetRaw ? Number.parseInt(budgetRaw, 10) : undefined;
	return {
		providerConfig,
		enableThinking: process.env[`${prefix}_ENABLE_THINKING`] === "true",
		...(budgetTokens !== undefined && !Number.isNaN(budgetTokens)
			? { thinkingBudgetTokens: budgetTokens }
			: {}),
	};
}
