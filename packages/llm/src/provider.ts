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
import type { LLMConfig, OpenAICompatibleProviderConfig, ProviderConfig } from "./config.ts";

/**
 * 为 litellm + Anthropic 后端创建自定义 fetch。
 *
 * AI SDK 的 @ai-sdk/openai 在序列化消息时会丢弃 providerOptions，
 * 但 litellm 需要 message-level cache_control 才能触发 Anthropic 的 prompt caching。
 *
 * 此函数创建一个 fetch wrapper，在请求发出前拦截 body，
 * 为 system message 和第一条 user message 注入 cache_control: { type: "ephemeral" }。
 */
function createAnthropicCacheFetch(): typeof globalThis.fetch {
	const baseFetch = globalThis.fetch;
	const cacheFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		if (init?.body && typeof init.body === "string") {
			try {
				const body = JSON.parse(init.body);
				// AI SDK openai provider 使用 "input"（Responses API）或 "messages"（Chat Completions API）
				const msgArray = body.input ?? body.messages;
				if (Array.isArray(msgArray)) {
					let userCount = 0;
					for (const msg of msgArray) {
						if (msg.role === "system") {
							msg.cache_control = { type: "ephemeral" };
						} else if (msg.role === "user") {
							userCount++;
							if (userCount === 1) {
								msg.cache_control = { type: "ephemeral" };
							}
						}
					}
					init = { ...init, body: JSON.stringify(body) };
				}
			} catch {
				// JSON 解析失败，保持原样
			}
		}
		return baseFetch(input, init);
	};
	// AI SDK FetchFunction 类型需要 fetch 签名，用 as any 绕过 Bun 的 preconnect 额外属性
	return cacheFetch as unknown as typeof globalThis.fetch;
}

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

		case "openai-compatible": {
			const provider = createOpenAI({
				apiKey: config.apiKey,
				baseURL: config.baseUrl,
				name: "openai-compatible",
				...(config.backendProvider === "anthropic"
					? { fetch: createAnthropicCacheFetch() }
					: {}),
			});
			// 使用 .chat() 强制走 Chat Completions API（/v1/chat/completions），
			// 而不是默认的 Responses API（/v1/responses）。
			// litellm 等代理对 Chat Completions API 的 cache_control 支持更完善。
			return provider.chat(config.model);
		}
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
