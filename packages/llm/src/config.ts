/**
 * LLM 配置类型 — 由调用方注入，不直接读环境变量
 */

export interface LLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	enableThinking?: boolean;
}

let _config: LLMConfig | null = null;

/**
 * 初始化 LLM 配置（应用启动时调用一次）
 */
export function initLLMConfig(config: LLMConfig): void {
	_config = config;
}

/**
 * 获取当前 LLM 配置（未初始化时抛出）
 */
export function getLLMConfig(): LLMConfig {
	if (!_config) {
		throw new Error(
			"LLM config not initialized. Call initLLMConfig() before using LLM functions.",
		);
	}
	return _config;
}
