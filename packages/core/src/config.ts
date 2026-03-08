/**
 * 全局配置 — 从环境变量读取，初始化所有子包配置
 */

import { resolve } from "node:path";
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
 * 工作区路径集合 — 使用显式路径配置，避免隐式全局状态。
 */
export interface WorkspacePaths {
	workspace: string;
	workflows: string;
	tasks: string;
	skills: string;
	schedules: string;
	memory: string;
	consultResult: string;
	history: string;
	temp: string;
}

export interface PathConfig {
	workspace?: string;
	workflows?: string;
	tasks?: string;
	skills?: string;
	schedules?: string;
	memory?: string;
	consultResult?: string;
	history?: string;
	temp?: string;
}

/**
 * 解析工作区路径。
 *
 * 默认保持向后兼容：未注入时仍基于当前进程工作目录与环境变量。
 */
export function resolvePaths(pathConfig: PathConfig = {}): WorkspacePaths {
	// NOTE: process.cwd() 作为 workspace 的最终 fallback，仅在未显式传入时使用。
	// 所有 app 层应显式传入 workspace，不应依赖此默认值。
	const workspace = resolve(pathConfig.workspace ?? process.cwd());
	return {
		workspace,
		workflows: resolve(
			workspace,
			pathConfig.workflows ?? process.env.WORKFLOWS_DIR ?? "workflows",
		),
		tasks: resolve(
			workspace,
			pathConfig.tasks ?? process.env.TASKS_DIR ?? "workflows/tasks",
		),
		skills: resolve(
			workspace,
			pathConfig.skills ?? process.env.SKILLS_DIR ?? "workflows/skills",
		),
		schedules: resolve(
			workspace,
			pathConfig.schedules ??
				process.env.SCHEDULES_DIR ??
				"workflows/schedules",
		),
		memory: resolve(
			workspace,
			pathConfig.memory ?? process.env.MEMORY_DIR ?? "workflows/memory",
		),
		consultResult: resolve(
			workspace,
			pathConfig.consultResult ??
				process.env.CONSULT_RESULT_DIR ??
				"workflows/consult-result",
		),
		history: resolve(
			workspace,
			pathConfig.history ?? process.env.HISTORY_DIR ?? "workflows/history",
		),
		temp: resolve(
			workspace,
			pathConfig.temp ?? process.env.TEMP_DIR ?? ".temp",
		),
	};
}

/**
 * @deprecated 旧版全局路径配置，保持向后兼容，建议逐步迁移到显式路径配置。
 */
export const legacy_paths = resolvePaths();

/** 最近一次 initConfig 解析出的路径（反映当前全局配置状态） */
let _currentPaths: WorkspacePaths = legacy_paths;

/**
 * 获取当前全局配置对应的工作区路径。
 *
 * 与 `legacy_paths`（模块加载时快照）不同，此函数返回最近一次
 * `initConfig()` 调用后的路径，能正确反映应用启动时的配置。
 */
export function getCurrentPaths(): WorkspacePaths {
	return _currentPaths;
}

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
export function initConfig(pathConfig: PathConfig = {}): WorkspacePaths {
	const resolvedPaths = resolvePaths(pathConfig);
	_currentPaths = resolvedPaths;
	initLLMConfig(config.llm);
	initToolsConfig({
		security: config.security,
		agent: config.agent,
		workspace: resolvedPaths.workspace,
		tempDir: resolvedPaths.temp,
	});
	return resolvedPaths;
}

// 自动初始化
initConfig();
