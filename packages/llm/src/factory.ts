/**
 * LLM Client 工厂函数
 *
 * 根据 LLMConfig 中的 provider 类型创建对应的 LLMClient 实例。
 * 唯一的 Client 创建入口，各 app 通过此函数构造注入。
 *
 * switch 缩窄 ProviderConfig discriminated union，
 * 将具体类型直接传入对应 Client 构造函数，避免 as 断言。
 */

import type { LLMClient } from "@n0n/types";
import { AnthropicClient } from "./anthropic-client.ts";
import type { LLMConfig } from "./config.ts";
import { GeminiClient } from "./gemini-client.ts";
import { DeepSeekClient } from "./deepseek/index.ts";
import { OpenAIClient } from "./openai-client.ts";

/**
 * 创建 LLMClient 实例
 *
 * @param config LLM 配置（含 provider 类型、凭据、行为开关）
 * @returns LLMClient 实例，闭包所有配置
 */
export function createLLMClient(config: LLMConfig): LLMClient {
	const pc = config.providerConfig;
	switch (pc.provider) {
		case "openai":
		case "openai-compatible":
			return new OpenAIClient(pc);
		case "anthropic":
			return new AnthropicClient(pc);
		case "deepseek":
			return new DeepSeekClient(pc);
		case "google":
			return new GeminiClient(pc);
	}
}
