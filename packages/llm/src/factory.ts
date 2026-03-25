/**
 * LLM Client 工厂函数
 *
 * 根据 LLMConfig 中的 provider 类型创建对应的 LLMClient 实例。
 * 唯一的 Client 创建入口，各 app 通过此函数构造注入。
 */

import type { LLMClient } from "@n0n/types";
import { AnthropicClient } from "./anthropic-client.ts";
import type { LLMConfig } from "./config.ts";
import { OpenAIClient } from "./openai-client.ts";

/**
 * 创建 LLMClient 实例
 *
 * @param config LLM 配置（含 provider 类型、凭据、行为开关）
 * @returns LLMClient 实例，闭包所有配置
 */
export function createLLMClient(config: LLMConfig): LLMClient {
	switch (config.providerConfig.provider) {
		case "openai":
		case "openai-compatible":
			return new OpenAIClient(config);
		case "anthropic":
			return new AnthropicClient(config);
		case "google":
			throw new Error(
				"Google provider not yet implemented. Use openai-compatible with a proxy instead.",
			);
	}
}
