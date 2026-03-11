/**
 * LLM 配置类型
 */
export interface LLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	enableThinking?: boolean;
}
