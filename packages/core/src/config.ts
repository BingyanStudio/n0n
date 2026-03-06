/**
 * 全局配置 — 从环境变量读取，初始化所有子包配置
 */

import { initLLMConfig } from "@n0n/llm";
import { initToolsConfig } from "@n0n/tools";

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
 * 工作流相关路径 — 统一管理，避免硬编码散布在各模块中
 */
export const paths = {
	/** 工作流根目录 */
	workflows: process.env.WORKFLOWS_DIR ?? "workflows",
	/** 任务工作流目录 */
	tasks: process.env.TASKS_DIR ?? "workflows/tasks",
	/** Agent Skills 目录 */
	skills: process.env.SKILLS_DIR ?? "workflows/skills",
	/** 定时任务配置目录 */
	schedules: process.env.SCHEDULES_DIR ?? "workflows/schedules",
	/** 记忆/知识库目录 */
	memory: process.env.MEMORY_DIR ?? "workflows/memory",
	/** 咨询结果缓存目录 */
	consultResult: process.env.CONSULT_RESULT_DIR ?? "workflows/consult-result",
	/** 历史记录目录 */
	history: process.env.HISTORY_DIR ?? "workflows/history",
} as const;

export const config = {
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
} as const;

/**
 * 初始化所有子包配置（应用启动时调用一次）
 */
export function initConfig(): void {
	initLLMConfig(config.llm);
	initToolsConfig({
		security: config.security,
		agent: config.agent,
	});
}

// 自动初始化
initConfig();
