/**
 * @n0n/llm — LLM Client 实现层
 *
 * 自实现 OpenAI + Anthropic 双协议，不依赖 AI SDK。
 * 唯一接触 HTTP / SSE 的地方。
 *
 * 对外仅导出：
 * - createLLMClient 工厂函数
 * - Config 类型和工厂
 * - LLMError
 */

// 配置类型
export type {
	AnthropicProviderConfig,
	GoogleProviderConfig,
	LLMConfig,
	OpenAICompatibleProviderConfig,
	OpenAIProviderConfig,
	ProviderConfig,
} from "./config.ts";
export { DEFAULT_THINKING_BUDGET_TOKENS } from "./config.ts";
// 环境变量 → 配置工厂（SSOT：runtime.ts 和 bootstrap 共用）
export {
	buildLLMConfigFromEnv,
	buildProviderConfigFromEnv,
	isValidProvider,
	PROVIDER_TYPES,
	resolveProvider,
} from "./config-from-env.ts";
// Error
export { LLMError } from "./errors.ts";
// Client 工厂
export { createLLMClient } from "./factory.ts";
