/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层（包括 LLM / tools）。
 * 如需共享，可在应用入口集中构造 RuntimeContext 再下发使用。
 *
 * LLM 配置使用 @n0n/llm 的 ProviderConfig + LLMConfig，
 * LLMClient 实例通过 getter 懒创建并缓存，保证与 config 始终一致。
 */

import { buildLLMConfigFromEnv, createLLMClient } from "@n0n/llm";
import type { LLMConfig } from "@n0n/llm";
import type { LLMClient } from "@n0n/types";

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
	readonly llm: LLMConfig;
	/** 主 LLM Client 实例（由 llm 配置懒创建，缓存） */
	readonly client: LLMClient;
	/** Editor LLM 配置 — 用于影子编辑层（shadow edit）。未配置时 fallback 到 llm。 */
	readonly editorLlm: LLMConfig;
	/** Editor LLM Client 实例（由 editorLlm 配置懒创建，缓存） */
	readonly editorClient: LLMClient;
	readonly agent: AgentConfig;
	readonly security: SecurityConfig;
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

/**
 * 从环境变量构造 RuntimeContext（纯函数，无副作用）
 *
 * LLMClient 实例通过 getter 懒创建并缓存，
 * 消除 config 与 client 的数据冗余和不一致隐患。
 */
export function createRuntimeContext(): RuntimeContext {
	const llm = buildLLMConfigFromEnv("LLM");
	const editorLlm = buildLLMConfigFromEnv("EDITOR_LLM", llm.providerConfig);

	let _client: LLMClient | null = null;
	let _editorClient: LLMClient | null = null;

	return {
		llm,
		get client() {
			if (!_client) _client = createLLMClient(llm);
			return _client;
		},
		editorLlm,
		get editorClient() {
			if (!_editorClient) _editorClient = createLLMClient(editorLlm);
			return _editorClient;
		},
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
