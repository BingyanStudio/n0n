/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层。
 * 当前阶段仍保留 init/get 全局方式（LLM / tools），
 * 后续 PR 2-3 会逐步将 llm/tools 也改为显式传递。
 */

// ── 类型 ──

export interface LLMConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	enableThinking: boolean;
}

export interface AgentConfig {
	maxIterations: number;
	maxIdleRounds: number;
	defaultExecTimeout: number;
}

export interface SecurityConfig {
	blockedCommands: string[];
}

export interface RuntimeContext {
	llm: LLMConfig;
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

/** 从环境变量构造 RuntimeContext（纯函数，无副作用） */
export function createRuntimeContext(): RuntimeContext {
	return {
		llm: {
			baseUrl: requireEnv("LLM_BASE_URL"),
			apiKey: requireEnv("LLM_API_KEY"),
			model: requireEnv("LLM_MODEL"),
			enableThinking: process.env.LLM_ENABLE_THINKING === "true",
		},
		agent: {
			maxIterations: 50,
			maxIdleRounds: 5,
			defaultExecTimeout: 120_000,
		},
		security: {
			blockedCommands: parseBlockedCommands(),
		},
	};
}
