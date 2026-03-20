/**
 * Provider Factory — 从 ProviderConfig 构造 AI SDK LanguageModel
 *
 * 注入边界：调用方拿到 LanguageModel 实例后，不再关心底层 provider 细节。
 * 支持运行时切换、测试 mock、多租户独立实例。
 */

import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMConfig, ProviderConfig } from "./config.ts";

/**
 * 从 ProviderConfig 创建 LanguageModel 实例
 *
 * 每次调用创建新实例，适合多租户场景（每请求独立 config）。
 * 如需复用，由调用方缓存。
 */
export function createLanguageModel(config: ProviderConfig): LanguageModel {
	switch (config.provider) {
		case "openai":
			return createOpenAI({
				apiKey: config.apiKey,
				...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
			})(config.model);

		case "anthropic":
			return createAnthropic({
				apiKey: config.apiKey,
			})(config.model);

		case "google":
			return createGoogleGenerativeAI({
				apiKey: config.apiKey,
			})(config.model);

		case "openai-compatible":
			return createOpenAI({
				apiKey: config.apiKey,
				baseURL: config.baseUrl,
				name: "openai-compatible",
			})(config.model);
	}
}

/**
 * 从完整 LLMConfig 创建 LanguageModel
 *
 * 便捷封装，等价于 createLanguageModel(config.providerConfig)。
 */
export function createModelFromConfig(config: LLMConfig): LanguageModel {
	return createLanguageModel(config.providerConfig);
}
