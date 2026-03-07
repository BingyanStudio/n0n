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
 * Workspace 路径集合 — 每个 workspace 实例拥有独立的目录结构
 */
export interface WorkspacePaths {
	/** workspace 根目录 */
	root: string;
	/** 任务工作流目录 */
	tasks: string;
	/** Agent Skills 目录 */
	skills: string;
	/** 定时任务配置目录 */
	schedules: string;
	/** 记忆/知识库目录 */
	memory: string;
	/** 咨询结果缓存目录 */
	consultResult: string;
	/** 历史记录目录 */
	history: string;
	/** 临时文件目录（exec 临时脚本等，进程退出时清理） */
	temp: string;
}

/**
 * 根据 workspace 根目录生成完整路径集合
 */
export function resolvePaths(workspace: string): WorkspacePaths {
	return {
		root: workspace,
		tasks: `${workspace}/tasks`,
		skills: `${workspace}/skills`,
		schedules: `${workspace}/schedules`,
		memory: `${workspace}/memory`,
		consultResult: `${workspace}/consult-result`,
		history: `${workspace}/history`,
		temp: `${workspace}/.temp`,
	};
}

/** 默认路径（向后兼容，供未迁移的调用方使用） */
export const defaultPaths: WorkspacePaths = resolvePaths(
	process.env.WORKFLOWS_DIR ?? ".runtime/workflows",
);

/**
 * @deprecated 使用 resolvePaths(workspace) 代替。将在清理阶段移除。
 */
export const paths = defaultPaths;

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
		tempDir: defaultPaths.temp,
	});
}

// 自动初始化
initConfig();
