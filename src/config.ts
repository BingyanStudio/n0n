/**
 * 全局配置 — 从环境变量读取
 */

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env: ${key}`);
	return val;
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
} as const;
