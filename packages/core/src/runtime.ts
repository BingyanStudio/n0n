/**
 * RuntimeContext — 替代所有全局可变单例
 *
 * 从 app 入口构造，通过参数显式传递到各层（包括 LLM / tools）。
 * 如需共享，可在应用入口集中构造 RuntimeContext 再下发使用。
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
	/** Editor LLM 配置 — 用于影子编辑层（shadow edit）。未配置时 fallback 到 llm。 */
	editorLlm: LLMConfig;
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
	const llm: LLMConfig = {
		baseUrl: requireEnv("LLM_BASE_URL"),
		apiKey: requireEnv("LLM_API_KEY"),
		model: requireEnv("LLM_MODEL"),
		enableThinking: process.env.LLM_ENABLE_THINKING === "true",
	};

	// Editor LLM: 各字段独立 fallback 到主 LLM 配置
	const editorLlm: LLMConfig = {
		baseUrl: process.env.EDITOR_LLM_BASE_URL || llm.baseUrl,
		apiKey: process.env.EDITOR_LLM_API_KEY || llm.apiKey,
		model: process.env.EDITOR_LLM_MODEL || llm.model,
		enableThinking:
			process.env.EDITOR_LLM_ENABLE_THINKING !== undefined
				? process.env.EDITOR_LLM_ENABLE_THINKING === "true"
				: llm.enableThinking,
	};

	return {
		llm,
		editorLlm,
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
