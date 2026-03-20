/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层（包括 LLM / tools）。
 * 如需共享，可在应用入口集中构造 RuntimeContext 再下发使用。
 *
 * LLM 配置使用 @n0n/llm 的 ProviderConfig + LanguageModel，
 * 支持运行时依赖注入和多 provider（OpenAI / Anthropic / Google）。
 */

import type { LanguageModel } from "ai";
import type {
	LLMConfig,
	ProviderConfig,
} from "@n0n/llm";
import { createModelFromConfig, getModelId, getProviderType } from "@n0n/llm";

// ── 类型 ──

export interface AgentConfig {
	maxIterations: number;
	maxIdleRounds: number;
	defaultExecTimeout: number;
}

export interface SecurityConfig {
	blockedCommands: string[];
}

export interface RuntimeContext {
	/** 主 LLM 配置 */
	llm: LLMConfig;
	/** 主 LLM 的 LanguageModel 实例（运行时注入） */
	model: LanguageModel;
	/** Editor LLM 配置 — 用于影子编辑层（shadow edit）。未配置时 fallback 到 llm。 */
	editorLlm: LLMConfig;
	/** Editor LLM 的 LanguageModel 实例 */
	editorModel: LanguageModel;
	/** model ID — 用于 adapter 层 tag 风格选择 */
	modelId: string;
	/** provider 类型 — 用于 caching 策略判断 */
	providerType: string;
	agent: AgentConfig;
	security: SecurityConfig;
}

// ── 从环境变量构造 ──

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env: ${key}`);
	return val;
}

function parseBlockedCommands(): string[] {
	const raw = process.env.BLOCKED_COMMANDS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/**
 * 从环境变量推断 provider 类型
 *
 * 规则：
 * - 有 LLM_PROVIDER 环境变量时直接使用
 * - 根据 BASE_URL 推断：包含 anthropic → "anthropic"，包含 google → "google"
 * - 有 BASE_URL 但非已知 provider → "openai-compatible"
 * - 无 BASE_URL → "openai"
 */
function inferProvider(baseUrl?: string, explicit?: string): ProviderConfig["provider"] {
	if (explicit) {
		const valid = ["openai", "anthropic", "google", "openai-compatible"];
		if (valid.includes(explicit)) return explicit as ProviderConfig["provider"];
	}
	if (!baseUrl) return "openai";
	if (baseUrl.includes("anthropic")) return "anthropic";
	if (baseUrl.includes("google") || baseUrl.includes("gemini")) return "google";
	if (baseUrl.includes("openai.com")) return "openai";
	return "openai-compatible";
}

/** 从环境变量构造 ProviderConfig */
function buildProviderConfig(prefix: string, fallback?: ProviderConfig): ProviderConfig {
	const apiKey = process.env[`${prefix}_API_KEY`] || (fallback && "apiKey" in fallback ? fallback.apiKey : "");
	const model = process.env[`${prefix}_MODEL`] || (fallback ? fallback.model : "");
	const baseUrl = process.env[`${prefix}_BASE_URL`] || (fallback && "baseUrl" in fallback ? (fallback as { baseUrl?: string }).baseUrl : undefined);
	const provider = inferProvider(baseUrl, process.env[`${prefix}_PROVIDER`]);

	switch (provider) {
		case "openai":
			return { provider: "openai", apiKey, model, ...(baseUrl ? { baseUrl } : {}) };
		case "anthropic":
			return { provider: "anthropic", apiKey, model };
		case "google":
			return { provider: "google", apiKey, model };
		case "openai-compatible": {
			const backendProvider = process.env[`${prefix}_BACKEND_PROVIDER`] as
				| "anthropic" | "google" | "openai" | undefined;
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

/** 从环境变量构造 LLMConfig */
function buildLLMConfig(prefix: string, fallbackProvider?: ProviderConfig): LLMConfig {
	const providerConfig = buildProviderConfig(prefix, fallbackProvider);
	const enableThinkingKey = `${prefix}_ENABLE_THINKING`;
	return {
		providerConfig,
		enableThinking: process.env[enableThinkingKey] === "true",
	};
}

/** 从环境变量构造 RuntimeContext（纯函数，无副作用） */
export function createRuntimeContext(): RuntimeContext {
	const llm = buildLLMConfig("LLM");
	const editorLlm = buildLLMConfig("EDITOR_LLM", llm.providerConfig);

	const model = createModelFromConfig(llm);
	const editorModel = createModelFromConfig(editorLlm);

	return {
		llm,
		model,
		editorLlm,
		editorModel,
		modelId: getModelId(llm),
		providerType: getProviderType(llm),
		agent: {
			maxIterations: 50,
			maxIdleRounds: 5,
			defaultExecTimeout: 120,
		},
		security: {
			blockedCommands: parseBlockedCommands(),
		},
	};
}

// ── 运行时上下文全局单例 ──

let _runtime: RuntimeContext | null = null;

/** 获取当前运行时上下文（未初始化时自动从环境变量构造） */
export function getRuntime(): RuntimeContext {
	if (!_runtime) {
		_runtime = createRuntimeContext();
	}
	return _runtime;
}

/** 设置运行时上下文。各 app 入口调用。 */
export function initRuntime(runtime: RuntimeContext): void {
	_runtime = runtime;
}
