/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层（包括 LLM / tools）。
 * 如需共享，可在应用入口集中构造 RuntimeContext 再下发使用。
 *
 * LLM 配置使用 @n0n/llm 的 ProviderConfig + LanguageModel，
 * 支持运行时依赖注入和多 provider（OpenAI / Anthropic / Google）。
 */

import type { LLMConfig } from "@n0n/llm";
import { buildLLMConfigFromEnv, createModelFromConfig } from "@n0n/llm";
import type { LanguageModel } from "ai";

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
	agent: AgentConfig;
	security: SecurityConfig;
}

// ── 从环境变量构造 ──

function parseBlockedCommands(): string[] {
	const raw = process.env.BLOCKED_COMMANDS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

/** 从环境变量构造 RuntimeContext（纯函数，无副作用） */
export function createRuntimeContext(): RuntimeContext {
	const llm = buildLLMConfigFromEnv("LLM");
	const editorLlm = buildLLMConfigFromEnv("EDITOR_LLM", llm.providerConfig);

	const model = createModelFromConfig(llm);
	const editorModel = createModelFromConfig(editorLlm);

	return {
		llm,
		model,
		editorLlm,
		editorModel,
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
