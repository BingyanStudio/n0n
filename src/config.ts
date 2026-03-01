/**
 * 全局配置 — 从环境变量读取
 */

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env: ${key}`);
	return val;
}

/**
 * Parse BLOCKED_COMMANDS env var (comma-separated list of command names).
 * e.g. "rm,mv,dd" → ["rm", "mv", "dd"]
 */
function parseBlockedCommands(): string[] {
	const raw = process.env.BLOCKED_COMMANDS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
}

export const config = {
	llm: {
		baseUrl: requireEnv("LLM_BASE_URL").replace(/\/+$/, ""),
		apiKey: requireEnv("LLM_API_KEY"),
		model: requireEnv("LLM_MODEL"),
	},
	agent: {
		maxIterations: 50,
		maxIdleRounds: 5,
		defaultExecTimeout: 120_000,
	},
	security: {
		blockedCommands: parseBlockedCommands(),
	},
} as const;
